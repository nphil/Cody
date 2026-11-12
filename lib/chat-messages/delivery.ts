import { createCheckpoint } from "../checkpoints";
import { checkDiskForNewTurn, commandStartsNewWork } from "../disk/gate";
import { EngineCommandError } from "../harness/errors";
import type { EngineSession } from "../harness/types";
import { clipChars, singleLine } from "../notifications/compose";
import { getRpcSession, unrestorableModelOf } from "../rpc-manager";
import { acquireSession, isSessionUnavailableError } from "../session-acquire";
import { getSessionEntries, resolveSessionPath } from "../session-reader";
import { ownerTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import { chatMessageHeader, chatMessageText } from "./header";
import { unansweredChatMessages } from "./registry";
import {
  CHAT_MESSAGE_LIMITS,
  clientMessageIdForChatMessage,
  type ChatMessageRecord,
  type ChatMessageUrgency,
} from "./types";

/**
 * Handing one chat's message to another chat — the path the composer's own
 * send takes (`POST /api/agent/[id]`), minus the request.
 *
 * `next_step` is the composer's steer: a `prompt` with `streamingBehavior:
 * "steer"`, which the chat's wrapper sends straight to the engine, so a running
 * turn reads it at its next step instead of at its end (an idle chat simply
 * starts a turn on it). `after_turn` is the follow-up the scheduled messages
 * use, held by Cody until the turn ends. The chat may have no live child (it
 * idled out, or the server just restarted): `acquireSession` starts one as the
 * scheduler does, in the owner's zone, because nobody is typing.
 *
 * What came of the send is not kept here: the target wrapper's own delivery
 * ledger and the transcript say it (`chatMessageProgress`), so a status read
 * never disagrees with what the chat actually did.
 */

/** The composer's steer / follow-up for the urgency the sender chose: the one place that mapping lives. */
export function streamingBehaviorOf(urgency: ChatMessageUrgency): "steer" | "followUp" {
  return urgency === "next_step" ? "steer" : "followUp";
}

/**
 * Why a send to this chat must not start now: the disk gate (lib/disk/gate.ts).
 * A steer into a turn that is already running adds no new turn and goes
 * through, exactly as the composer's does; everything else would begin work and
 * is refused while a disk is nearly full. Null when the send may go ahead.
 */
export function deliveryRefusal(toSessionId: string, urgency: ChatMessageUrgency): string | null {
  const live = getRpcSession(toSessionId);
  const running = live?.isAlive() === true && live.isRunning();
  if (!commandStartsNewWork({ type: "prompt", streamingBehavior: streamingBehaviorOf(urgency) }, running)) return null;
  return checkDiskForNewTurn()?.message ?? null;
}

/** What the sender is told when the chat did not take its message: plain words, never an engine's internals. */
function failureText(error: unknown): string {
  if (isSessionUnavailableError(error)) {
    return error.reason === "sidebar" ? "A sidebar chat cannot receive messages." : "That chat no longer exists.";
  }
  const unrestorable = unrestorableModelOf(error);
  if (unrestorable) {
    return `That chat used ${unrestorable.provider}/${unrestorable.modelId}, which is no longer available. Someone has to open it and pick another model before it can read messages.`;
  }
  switch (error instanceof EngineCommandError ? error.code : undefined) {
    case "session_busy":
      return "That chat's engine runs one turn at a time and is working right now, so it cannot hold a message for later. Send it again when the turn is over.";
    case "unsupported":
      return "That chat's engine cannot take a message while it is working. Send it again when the turn is over.";
    case "session_idle":
    case "steering_failed":
      return "That chat's turn ended just as the message arrived. Send it again.";
    default:
      break;
  }
  const message = error instanceof Error ? error.message : String(error);
  return clipChars(singleLine(message), 300) || "The chat did not accept the message.";
}

/** The label of the workspace snapshot taken before the message is read: who it came from and how it starts. */
function checkpointLabel(record: ChatMessageRecord, body: string): string {
  return singleLine(`From chat "${record.fromTitle || "untitled chat"}": ${body}`);
}

async function handOver(
  session: EngineSession,
  record: ChatMessageRecord,
  text: string,
  behavior: "steer" | "followUp",
  timeZone: string,
): Promise<void> {
  const clientMessageId = clientMessageIdForChatMessage(record.id);
  try {
    await session.send({ type: "prompt", message: text, streamingBehavior: behavior, clientMessageId, timeZone });
  } catch (error) {
    // An engine that runs one turn at a time (the ACP ones) refuses a prompt
    // mid-turn; where it takes steering, a next-step message goes in that way.
    if (record.urgency !== "next_step" || !(error instanceof EngineCommandError) || error.code !== "session_busy") throw error;
    await session.send({ type: "steer", message: text, clientMessageId });
  }
}

/** The ledger row for one id on a live session: `available: false` for an engine that keeps no ledger (ACP), `row: null` when it holds none (restarted, or settled over an hour ago). */
function readLedger(
  session: object,
  clientMessageId: string,
): { available: false } | { available: true; row: { status: string; held: boolean; error?: string } | null } {
  if (!("getDeliveryLedger" in session) || typeof session.getDeliveryLedger !== "function") return { available: false };
  const read = session.getDeliveryLedger;
  const rows: unknown = read.call(session, [clientMessageId]);
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!isRecord(first) || typeof first.status !== "string") return { available: true, row: null };
  return {
    available: true,
    row: { status: first.status, held: first.held === true, ...(typeof first.error === "string" ? { error: first.error } : {}) },
  };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

/** Clock slack between this process and the engine's own timestamps. */
const TRANSCRIPT_SLACK_MS = 5_000;
/** A sanity bound on the walk back through a transcript; the age cut below normally ends it far sooner. */
const TRANSCRIPT_MAX_USER_MESSAGES = 5_000;

/**
 * Is the message in the chat's conversation? The header carries the delivery id,
 * so a copy that reached the transcript is found by it. Null when there is no
 * transcript to look in (an engine that keeps its own history, a deleted chat).
 */
async function inTranscript(record: ChatMessageRecord): Promise<boolean | null> {
  try {
    const file = await resolveSessionPath(record.toSessionId);
    if (!file) return null;
    const entries = getSessionEntries(file);
    const marker = `ref ${record.id}]`;
    let seen = 0;
    for (let index = entries.length - 1; index >= 0 && seen < TRANSCRIPT_MAX_USER_MESSAGES; index -= 1) {
      const entry = entries[index];
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      seen += 1;
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && at < record.createdAt - TRANSCRIPT_SLACK_MS) return false;
      if (userText(entry.message.content).includes(marker)) return true;
    }
    return false;
  } catch {
    // A transcript that cannot be read proves nothing either way.
    return null;
  }
}

/** Where one message stands with the chat it was sent to. */
export type ChatMessagePhase =
  | "sending" // handed to Cody's delivery; the chat's engine has not taken it yet
  | "held" // Cody holds it until the chat's current turn ends (`after_turn`)
  | "queued" // in the chat's engine, read at its next step (`next_step`)
  | "started" // the chat's agent began a turn on it
  | "delivered" // the chat's agent has read it
  | "failed" // never reached the chat, or the engine rejected it
  | "withdrawn" // taken back before it was read
  | "lost"; // accepted, but the engine stopped or restarted before reading it

export interface ChatMessageProgress {
  phase: ChatMessagePhase;
  /** Why, for `failed`. */
  error?: string;
}

const ENGINE_LOST = "The chat's engine stopped before it read this message.";

/**
 * Where a message stands now, read from the chat's own delivery ledger and,
 * when the engine no longer has a row for it (it restarted, or the row aged
 * out an hour after settling), from the chat's transcript. An engine with no
 * ledger (ACP) takes a message as a turn or a steer and has no queue to wait
 * in, so accepted means read.
 */
export async function chatMessageProgress(record: ChatMessageRecord): Promise<ChatMessageProgress> {
  if (record.state === "failed") return { phase: "failed", error: record.error };
  if (record.state === "sending") return { phase: "sending" };
  const session = getRpcSession(record.toSessionId);
  if (session?.isAlive()) {
    const ledger = readLedger(session, clientMessageIdForChatMessage(record.id));
    if (!ledger.available) return { phase: "delivered" };
    switch (ledger.row?.status) {
      case "queued":
        return { phase: ledger.row.held ? "held" : "queued" };
      case "started":
        return { phase: "started" };
      case "delivered":
        return { phase: "delivered" };
      case "withdrawn":
        return { phase: "withdrawn" };
      case "failed":
        return { phase: "failed", error: ledger.row.error ?? ENGINE_LOST };
      default:
        break;
    }
  }
  return (await inTranscript(record)) === false ? { phase: "lost" } : { phase: "delivered" };
}

/**
 * This message is an answer from `answer.from` to `answer.to`: whatever `to`
 * sent `from` that `from` has by now read is answered. A message `from` has not
 * read yet is not — it cannot be what this answers.
 */
async function markAnswered(answer: ChatMessageRecord): Promise<void> {
  for (const earlier of unansweredChatMessages(answer.toSessionId, answer.fromSessionId)) {
    const { phase } = await chatMessageProgress(earlier);
    if (phase === "started" || phase === "delivered") {
      earlier.repliedAt = answer.createdAt;
      earlier.replyId = answer.id;
    }
  }
}

/** Never rejects: the record says how it went. */
async function deliver(record: ChatMessageRecord, body: string): Promise<void> {
  try {
    const timeZone = ownerTimeZone(record.toSessionId);
    const session = await acquireSession(record.toSessionId, timeZone);
    const behavior = streamingBehaviorOf(record.urgency);
    const text = chatMessageText(chatMessageHeader({ id: record.fromSessionId, title: record.fromTitle }, record.id), body);
    // The safety net the composer's own prompt gets, and like its steer, none for a steer into a running turn: it exists to interrupt, the workspace is mid-edit, and it must not wait on a workspace scan first. Never allowed to hold the message back.
    if (!(session.isRunning() && behavior === "steer")) await createCheckpoint(session.cwd, checkpointLabel(record, body)).catch(() => null);
    await handOver(session, record, text, behavior, timeZone);
    record.state = "accepted";
    record.acceptedAt = Date.now();
    await markAnswered(record).catch(() => undefined);
  } catch (error) {
    record.state = "failed";
    record.error = failureText(error);
  }
}

let ackWaitMs: number = CHAT_MESSAGE_LIMITS.ackWaitMs;

/** Test hook: how long a send waits for the chat's engine to take the message. `null` puts the real bound back. */
export function configureChatDeliveryForTests(options: { ackWaitMs?: number } | null): void {
  ackWaitMs = options?.ackWaitMs ?? CHAT_MESSAGE_LIMITS.ackWaitMs;
}

/**
 * Hand the message to its chat, and wait only for the chat's ENGINE to take it
 * (a live one in a moment, a cold one while it starts) — never for the chat to
 * read or answer it. When the engine is slower than the bound the record stays
 * `sending` and the delivery carries on in the background, settling the record
 * whenever it finishes.
 */
export async function sendChatMessage(record: ChatMessageRecord, body: string): Promise<void> {
  const delivery = deliver(record, body);
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ackWaitMs);
  });
  try {
    await Promise.race([delivery, bound]);
  } finally {
    clearTimeout(timer);
  }
}
