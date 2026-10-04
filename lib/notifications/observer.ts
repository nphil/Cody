import { describeEngineError } from "../error-text";
import type { EngineEvent, EngineSession } from "../harness/types";
import { getEngineSession } from "../harness/engine-sessions";
import { readPermissionOptions } from "../permission-request";
import { assistantReplyText, replyAsksUser } from "../reply-question";
import { readSessionHeader } from "../session-reader";
import { asString, isRecord } from "../type-guards";
import {
  answerOfferForPermission,
  answerOfferForUiRequest,
  buildBody,
  buildTitle,
  clipChars,
  projectTag,
  questionExcerpt,
  replyExcerpt,
  singleLine,
  summarizePermission,
  summarizeUiRequest,
} from "./compose";
import type { NotificationEventId } from "./catalog";
import { sendNotification, type NotificationDraft, type SentNotification } from "./dispatch";
import { noteTerminalTurn } from "./quota-watch";

/**
 * Turns one chat's stream of frames into notifications.
 *
 * The observer sees exactly what a connected browser would — a session offers
 * it a separate channel (`observeEvents`) that is deliberately NOT a listener,
 * because a listener keeps a child alive and routes host tools to a page that
 * may not exist — and decides, frame by frame, what is worth a phone's
 * attention. It knows nothing about ntfy, accounts or settings: it emits
 * drafts, and lib/notifications/dispatch.ts decides who gets each one.
 *
 * Per chat it remembers a run (agent_start to a terminal agent_end), the last
 * reply, how the last reply stopped, and which notifications are still waiting
 * for an answer (so they can be taken down when the request is settled).
 *
 * Frames that never reach an observer, on purpose: the time-zone question, the
 * refusal guard's raw dialog, auto-approved tool prompts and the hidden
 * per-prompt time line are all consumed before a session emits anything.
 */

/** What the observer needs to know about a session; read afresh each time, since ids change on fork and move. */
export interface ObservedSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

export interface ObserverDeps {
  now: () => number;
  send: (draft: NotificationDraft) => SentNotification | null;
  /** Called at the end of every run: the quota watcher reads usage soon after a turn. */
  noteTurnEnd: () => void;
  describe: (session: ObservedSession, liveTitle: string | null, firstPrompt: string | null) => { chatTitle: string; project: string | null };
}

export interface SessionObserver {
  handle(event: EngineEvent): void;
  /** The session closed: take down everything still waiting for an answer. */
  close(): void;
}

/** A fallback is announced at most this often per chat. */
export const FALLBACK_COALESCE_MS = 2 * 60 * 1000;
/** More than this many unanswered requests in one chat is a runaway; the oldest notification is taken down. */
const MAX_PENDING_PER_SESSION = 50;
const MAX_REMEMBERED_SUBAGENTS = 64;
const UNTITLED = "Untitled chat";

/**
 * The chat's name: the live title, the file's, the engine index's — and for a
 * chat so new it has not been named yet (the namer runs after the first reply),
 * the opening words of the first message, so the notification still says
 * WHICH chat rather than "Untitled chat".
 */
function describeSession(session: ObservedSession, liveTitle: string | null, firstPrompt: string | null): { chatTitle: string; project: string | null } {
  let chatTitle = liveTitle?.trim() || null;
  try {
    if (!chatTitle && session.sessionFile) chatTitle = readSessionHeader(session.sessionFile)?.title?.trim() || null;
    if (!chatTitle) chatTitle = getEngineSession(session.sessionId)?.title.trim() || null;
  } catch {
    // A title is a nicety; a notification without one is still a notification.
  }
  return { chatTitle: chatTitle ?? firstPrompt ?? UNTITLED, project: projectTag(session.cwd) };
}

const DEFAULT_DEPS: ObserverDeps = {
  now: Date.now,
  send: (draft) => sendNotification(draft),
  noteTurnEnd: noteTerminalTurn,
  describe: describeSession,
};

/** The text of an ACP assistant message: `{type:"message_end", content:[{type:"text", text}]}`, with no role or wrapper. */
function acpMessageText(event: EngineEvent): string | null {
  if (!Array.isArray(event.content)) return null;
  const parts = event.content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
  return parts.join("\n");
}

function describeError(raw: string): { aborted: boolean; refusal: boolean; text: string } {
  const described = describeEngineError(raw);
  return {
    aborted: described.kind === "aborted",
    refusal: described.kind === "refusal",
    text: described.provider ? `${described.provider}: ${described.detail}` : described.detail,
  };
}

/** The first line of a user message, short enough to stand in for a chat title. */
function promptPreview(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join(" ")
      : "";
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "");
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

export function createSessionObserver(session: ObservedSession, overrides: Partial<ObserverDeps> = {}): SessionObserver {
  const deps: ObserverDeps = { ...DEFAULT_DEPS, ...overrides };

  /** Notifications still waiting for an answer, by request: the handle that takes each down. */
  const pending = new Map<string, SentNotification | null>();
  const finishedSubagents = new Set<string>();
  let closed = false;
  let liveTitle: string | null = null;
  let firstPrompt: string | null = null;

  // The run in flight. `runId` only moves forward at a run's start, so "did I
  // already say this about THIS run" stays answerable after the run has ended
  // (a late frame must not announce a run twice).
  let runId = 0;
  let runActive = false;
  let runStartedAt: number | null = null;
  let lastText: string | null = null;
  let lastStopReason: string | null = null;
  let lastErrorMessage: string | null = null;
  let stoppedByUser = false;
  let waitingRunId = -1;
  let errorRunId = -1;
  let refusalRunId = -1;
  let refusalKey: string | null = null;
  let lastFallbackAt: number | null = null;

  function make(event: NotificationEventId, body: string, extra: Partial<NotificationDraft> = {}): NotificationDraft {
    const { chatTitle, project } = deps.describe(session, liveTitle, firstPrompt);
    return {
      event,
      // Read now: the id moves with a fork or a session-file move.
      sessionId: session.sessionId,
      title: buildTitle(event, chatTitle),
      body: buildBody(body),
      tags: project ? [project] : [],
      ...extra,
    };
  }

  function retract(requestKey: string): void {
    const handle = pending.get(requestKey);
    if (handle === undefined) return;
    pending.delete(requestKey);
    handle?.clear();
  }

  function retractAll(): void {
    for (const key of [...pending.keys()]) retract(key);
  }

  /** Send a notification that is waiting on an answer, once per request, and remember how to take it down. */
  function sendPending(requestKey: string, draft: NotificationDraft): void {
    if (pending.has(requestKey)) return;
    if (pending.size >= MAX_PENDING_PER_SESSION) {
      const oldest = pending.keys().next();
      if (!oldest.done) retract(oldest.value);
    }
    pending.set(requestKey, deps.send({ ...draft, requestKey }));
  }

  /**
   * The end of a run, as the owner should hear it: "waiting for your reply" when
   * the reply asked something — or, for a recipient who switched that off,
   * "reply finished". `asked` is the wrapper's own verdict (its todo-pause
   * notice), which is trusted over this observer's copy of the reply.
   */
  function sendReplyEnded(now: number, asked = false): void {
    const text = lastText ?? "";
    const runMs = runStartedAt === null ? 0 : now - runStartedAt;
    const finished = make("finished", replyExcerpt(text) || "The agent finished.", { runMs });
    if (asked || (text !== "" && replyAsksUser(text))) {
      waitingRunId = runId;
      deps.send(make("waiting", text === "" ? "The agent is waiting for your reply." : questionExcerpt(text), { fallback: finished }));
    } else {
      deps.send(finished);
    }
  }

  function sendError(text: string): void {
    errorRunId = runId;
    deps.send(make("error", text));
  }

  function onUiRequest(event: EngineEvent): void {
    if (event.method === "cancel") {
      const target = asString(event.targetId);
      if (target) retract(target);
      return;
    }
    const requestId = asString(event.id);
    const summary = summarizeUiRequest(event);
    if (!requestId || !summary) return;
    const offer = answerOfferForUiRequest(event);
    sendPending(requestId, make(summary.event, summary.body, offer ? { offer } : {}));
  }

  function onPermissionRequest(event: EngineEvent): void {
    const requestId = asString(event.requestId);
    // A request with nothing clickable is not shown in the browser either.
    if (!requestId || readPermissionOptions(event.options).length === 0) return;
    const offer = answerOfferForPermission(event);
    sendPending(requestId, make("approval", summarizePermission(event), offer ? { offer } : {}));
  }

  function onRefusalDecision(event: EngineEvent): void {
    const decision = isRecord(event.decision) ? event.decision : null;
    if (!decision) {
      if (refusalKey) retract(refusalKey);
      refusalKey = null;
      return;
    }
    const key = `refusal:${asString(decision.id) ?? "pending"}`;
    if (refusalKey && refusalKey !== key) retract(refusalKey);
    refusalKey = key;
    refusalRunId = runId;
    const from = asString(decision.fromModel);
    sendPending(key, make("question", `${from ? `${from} declined this request.` : "The model declined this request."} Open the chat to choose how to continue.`));
  }

  function onAgentStart(now: number): void {
    // A non-terminal agent_end (a "steer now" hand-off) leaves the run open, so
    // the start that follows continues it rather than beginning another.
    if (runActive) return;
    runActive = true;
    runId += 1;
    runStartedAt = now;
    lastText = null;
    lastStopReason = null;
    lastErrorMessage = null;
    stoppedByUser = false;
  }

  function onMessageEnd(event: EngineEvent): void {
    const message = event.message;
    if (isRecord(message) && message.role === "assistant") {
      // omp: the reply text, how it stopped, and — when it failed — why.
      const text = assistantReplyText(event);
      if (text !== null) lastText = text;
      const reason = asString(message.stopReason);
      if (reason !== undefined) {
        lastStopReason = reason;
        lastErrorMessage = reason === "error" ? (asString(message.errorMessage) ?? null) : null;
      }
      return;
    }
    if (isRecord(message) && message.role === "user") {
      if (firstPrompt === null) firstPrompt = promptPreview(message.content);
      return;
    }
    // ACP: no role, no wrapper, no stop reason (that arrives on agent_end).
    const text = acpMessageText(event);
    if (text !== null) lastText = text;
  }

  /** The end of a run that is really the end: say what became of it, once. */
  function onTerminalAgentEnd(event: EngineEvent): void {
    const now = deps.now();
    const wasActive = runActive;
    runActive = false;
    if (!wasActive) return; // A duplicate end, or one for a run this observer never saw begin.
    deps.noteTurnEnd();

    const acpStop = asString(event.stopReason);
    // The user pressed Stop, or the engine says it was cancelled. Not news.
    if (stoppedByUser || lastStopReason === "aborted" || acpStop === "cancelled") return;
    if (waitingRunId === runId || errorRunId === runId) return;

    let failure: string | null = null;
    if (lastStopReason === "error") failure = lastErrorMessage ?? "The model returned an error.";
    else if (acpStop === "error") failure = lastErrorMessage ?? "The agent stopped with an error.";
    else if (acpStop === "refusal") failure = "The agent declined to answer this prompt.";
    if (failure !== null) {
      const described = describeError(failure);
      if (described.aborted) return;
      // The refusal question already told the owner; a second message saying
      // the same thing in other words is noise.
      if (described.refusal && refusalRunId === runId) return;
      sendError(described.text);
      return;
    }
    sendReplyEnded(now);
  }

  function onNotice(event: EngineEvent): void {
    const reason = asString(event.reason);
    if (reason === "awaiting_reply") {
      if (waitingRunId !== runId) sendReplyEnded(deps.now(), true);
    } else if (reason === "engine_exit") {
      sendError("The engine for this chat stopped unexpectedly.");
    } else if (event.level === "error") {
      // An ACP turn that fails says so in a notice, then ends with stopReason
      // "error" and no text of its own.
      const message = asString(event.message);
      if (message) lastErrorMessage = singleLine(message);
    }
  }

  function onFallback(event: EngineEvent): void {
    const now = deps.now();
    if (lastFallbackAt !== null && now - lastFallbackAt < FALLBACK_COALESCE_MS) return;
    lastFallbackAt = now;
    const from = asString(event.from);
    const to = asString(event.to);
    const reason = asString(event.reason);
    const switched = from && to ? `Switched from ${from} to ${to}.` : "The engine switched to a backup model.";
    deps.send(make("fallback", reason ? `${switched}\nReason: ${singleLine(reason)}` : switched));
  }

  function onSubagent(event: EngineEvent): void {
    const payload = event.payload;
    if (!isRecord(payload)) return;
    const status = payload.status;
    if (status !== "completed" && status !== "failed" && status !== "aborted") return;
    const id = asString(payload.id);
    if (id) {
      if (finishedSubagents.has(id)) return;
      if (finishedSubagents.size >= MAX_REMEMBERED_SUBAGENTS) {
        const oldest = finishedSubagents.values().next();
        if (!oldest.done) finishedSubagents.delete(oldest.value);
      }
      finishedSubagents.add(id);
    }
    const name = asString(payload.agent)?.trim() || "A subagent";
    const outcome = status === "completed" ? "finished" : status === "failed" ? "failed" : "was stopped";
    const description = asString(payload.description);
    deps.send(make("subagent", `${name} ${outcome}.${description ? `\n${clipChars(singleLine(description), 200)}` : ""}`));
  }

  return {
    handle(event) {
      if (closed) return;
      switch (event.type) {
        case "agent_start":
          onAgentStart(deps.now());
          break;
        case "agent_end":
          // A pause inside a run (omp hands a steer over this way) is not the end.
          if (event.isTerminal !== false) onTerminalAgentEnd(event);
          break;
        case "message_end":
          onMessageEnd(event);
          break;
        case "extension_ui_request":
          onUiRequest(event);
          break;
        case "permission_request":
          onPermissionRequest(event);
          break;
        case "permission_resolved":
          retract(asString(event.requestId) ?? "");
          break;
        case "cody_ui_request_resolved":
          retract(asString(event.id) ?? "");
          break;
        case "cody_ui_requests_cleared":
          retractAll();
          break;
        case "cody_refusal_decision":
          onRefusalDecision(event);
          break;
        case "cody_run_stopped":
          if (runActive) stoppedByUser = true;
          break;
        case "notice":
          onNotice(event);
          break;
        case "retry_fallback_applied":
          onFallback(event);
          break;
        case "subagent_lifecycle":
          onSubagent(event);
          break;
        case "session_info_update": {
          const title = asString(event.title)?.trim();
          if (title) liveTitle = title;
          break;
        }
        default:
          // Everything else — token deltas above all — is not ours, and costs nothing.
          break;
      }
    },
    close() {
      if (closed) return;
      // Their dialogs died with the child: nothing can answer them any more.
      retractAll();
      closed = true;
    },
  };
}

/**
 * Start notifying for a live session. Sidebar chats never do (they are a side
 * panel, not work). An engine whose session has no observer channel is skipped.
 * The observer is removed, and everything it still had waiting taken down, when
 * the session closes — however it closes.
 */
export function observeSessionForNotifications(session: EngineSession, options: { kind?: "sidebar" } = {}): void {
  if (options.kind === "sidebar" || typeof session.observeEvents !== "function") return;
  const observer = createSessionObserver(session);
  const stop = session.observeEvents((event) => observer.handle(event));
  session.onClose(() => {
    stop();
    observer.close();
  });
}
