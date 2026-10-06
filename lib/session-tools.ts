/**
 * Cross-session awareness, as read-only tools any engine session can call.
 *
 * One conversation frequently needs to know what another one is doing — "is
 * the migration session still running", "what did the other tab conclude" —
 * and Cody is the only party that can answer: an engine's own agent hub sees
 * nothing but its own subagents, while Cody holds the live child registry and
 * every transcript on disk.
 *
 * Three tools, deliberately snapshot-only:
 *   list_sessions   — what exists, which are running, when they last moved
 *   session_status  — one session's live phase plus its newest message
 *   read_session    — a condensed transcript, paged
 *
 * Nothing here blocks waiting for another session to finish. A tool that
 * waited would tie up the caller's own turn on a run it cannot influence, so
 * "poll it" is a call the model repeats when it wants to, not a promise this
 * module makes.
 *
 * Ownership is a security boundary, not a convenience filter: every listing
 * goes through filterSessionsForUser (a bulk canAccessSession over the sidecar
 * owners file) so an inaccessible session's id or title is never enumerated,
 * and every single-target read re-checks canAccessSession immediately before
 * touching the file. A blocked target and a missing one answer the identical
 * text — never a distinguishable "you may not see this".
 *
 * Results are plain text, bounded, and report their own continuation offset:
 * the sidebar's 4B models read prose and cannot afford a wall of it, and a
 * frontier model loses nothing by the same discipline.
 */

import { canAccessSession, filterSessionsForUser, getSessionOwner } from "./auth/session-owners";
import type { UserRecord } from "./auth/users";
import type { HostToolDefinition } from "./pi-types";
import { buildSessionContext, getSessionEntries, listAllSessions, resolveSessionPath } from "./session-reader";
import { clampForSidebar, resultCharBudget, type ClampedResult } from "./sidebar-context-budget";
import { formatToolTime } from "./tool-time";
import type { AgentMessage, SessionInfo } from "./types";

/** The phase flags a live child reports without an RPC round trip. Asking the
 * other child directly would mean awaiting a process that may be wedged — the
 * one thing a status call must never do. */
export interface SessionLivePhase {
  running: boolean;
  streaming: boolean;
  promptRunning: boolean;
  bashRunning: boolean;
  compacting: boolean;
}

/** What a caller's host-tool dispatch supplies to every handler here. */
export interface SessionToolContext {
  /** Acting account; null when auth is off, which (like canAccessSession) sees everything. */
  user: UserRecord | null;
  /** Session used when a call omits `session` — normally the caller's own. */
  defaultSessionId: string | null;
  /**
   * Ids with a live engine process (rpc-manager.ts's registry — this module
   * never imports it, to avoid a wiring cycle). Omitted -> state reads
   * "unknown" rather than guessing "idle".
   */
  runningSessionIds?: ReadonlySet<string>;
  /** Per-session phase flags, same source and same caveat. */
  livePhases?: ReadonlyMap<string, SessionLivePhase>;
  /**
   * Chars one result may occupy. Omitted -> the sidebar's own budget, which
   * assumes the SMALLEST supported window: safe everywhere, at the cost of an
   * extra page on a large model.
   */
  charBudget?: number;
  /**
   * The caller's session has no recorded owner on an instance that HAS
   * accounts, so it may only see other unowned sessions. Without this an
   * unowned session (pre-accounts, or terminal-created) would resolve to
   * `user: null` and see every account's conversations.
   */
  restrictToUnowned?: boolean;
  /** IANA zone of the message the agent is answering; times in results are written in it. Omitted or invalid -> the server's zone. */
  timeZone?: string;
}

export type SessionToolArgs = Record<string, unknown>;

/** Always resolves to plain text — success or a short human-readable failure —
 * so a caller's dispatch needs no try/catch of its own. */
export type SessionToolHandler = (args: SessionToolArgs, ctx: SessionToolContext) => Promise<string>;

/** Structurally a HostToolDefinition, plus the handler. */
export type SessionToolDefinition = HostToolDefinition & { handler: SessionToolHandler };

export const SESSION_NOT_FOUND = "Session not found.";
const MAX_SESSION_LIST = 50;
const MAX_CANDIDATES_SHOWN = 10;
/** Per-message cap inside a condensed transcript — smaller than a whole
 * result's budget so one long message cannot crowd out the rest of a page. */
const PER_MESSAGE_CHAR_CAP = 400;

export function sessionToolBudget(ctx: SessionToolContext): number {
  return ctx.charBudget && ctx.charBudget > 0 ? Math.floor(ctx.charBudget) : resultCharBudget(undefined);
}

/** Append a machine-readable continuation line only when the clamp actually
 * cut something, so a model can act on it without parsing prose. */
export function withPagingHint(clamped: ClampedResult, requestedOffset: number): string {
  if (clamped.truncated) {
    const remaining = Math.max(0, clamped.totalChars - (clamped.nextOffset ?? clamped.totalChars));
    return `${clamped.text}\n[truncated, ${remaining} chars remain \u2014 call again with offset=${clamped.nextOffset}]`;
  }
  if (clamped.text.length === 0 && requestedOffset > 0) return "(end of content)";
  return clamped.text;
}

export function numberArg(args: SessionToolArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringArg(args: SessionToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Every session this caller may see, newest first. */
async function visibleSessions(ctx: SessionToolContext): Promise<SessionInfo[]> {
  const scoped = filterSessionsForUser(await listAllSessions(), ctx.user);
  const allowed = ctx.restrictToUnowned
    ? scoped.filter((session) => getSessionOwner(session.id) === null)
    : scoped;
  return [...allowed].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

/** May this caller see (and, for the scheduling tools, act on) this session? Ownership is the boundary: another account's chat, or an owned chat asked about by an unowned caller, is refused. */
export function mayRead(sessionId: string, ctx: SessionToolContext): boolean {
  if (!canAccessSession(sessionId, ctx.user)) return false;
  return !ctx.restrictToUnowned || getSessionOwner(sessionId) === null;
}

type Resolution = { id: string } | { candidates: string } | null;

/**
 * A `session` argument to one session: an exact id first, then a
 * case-insensitive substring of the NAME.
 *
 * More than one name match returns the candidate list instead of picking one.
 * Guessing which conversation the user meant and then reporting on it is a far
 * worse failure than asking, because nothing downstream can tell it happened.
 */
function resolveTarget(query: string | undefined, sessions: SessionInfo[], ctx: SessionToolContext): Resolution {
  if (!query) return ctx.defaultSessionId ? { id: ctx.defaultSessionId } : null;
  if (sessions.some((session) => session.id === query)) return { id: query };
  const needle = query.trim().toLowerCase();
  const matches = sessions.filter((session) => (session.name ?? "").toLowerCase().includes(needle));
  if (matches.length > 1) return { candidates: formatCandidates(query, matches) };
  return matches.length === 1 ? { id: matches[0].id } : null;
}

function formatCandidates(query: string, matches: SessionInfo[]): string {
  const shown = matches.slice(0, MAX_CANDIDATES_SHOWN);
  const lines = [
    `Multiple sessions match "${query}"; pass the exact id:`,
    ...shown.map((session) => `${session.id} | ${session.name ?? "(untitled)"} | ${session.cwd}`),
  ];
  if (matches.length > MAX_CANDIDATES_SHOWN) {
    lines.push(`\u2026 ${matches.length - MAX_CANDIDATES_SHOWN} more matches not shown.`);
  }
  return lines.join("\n");
}

function formatState(id: string, ctx: SessionToolContext): string {
  if (!ctx.runningSessionIds) return "unknown";
  return ctx.runningSessionIds.has(id) ? "running" : "idle";
}

/** What a running session is doing right now, in the engine's own terms. */
function formatPhase(id: string, ctx: SessionToolContext): string {
  const phase = ctx.livePhases?.get(id);
  if (!phase) return ctx.runningSessionIds?.has(id) ? "running" : "no live process";
  if (phase.compacting) return "compacting its context";
  if (phase.bashRunning) return "running a shell command";
  if (phase.streaming) return "streaming a reply";
  if (phase.promptRunning) return "working on a turn (between model calls)";
  return "idle with a live process";
}

async function listSessions(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const sessions = await visibleSessions(ctx);
  const workspace = stringArg(args, "workspace");
  const filtered = workspace
    ? sessions.filter((session) => session.cwd === workspace || session.projectRoot === workspace)
    : sessions;
  const onlyRunning = args.running === true;
  const shown = onlyRunning ? filtered.filter((session) => ctx.runningSessionIds?.has(session.id)) : filtered;
  if (shown.length === 0) return onlyRunning ? "(no running sessions)" : "(no sessions)";

  const capped = shown.slice(0, MAX_SESSION_LIST);
  const lines = capped.map((session) =>
    `${session.id} | ${session.name ?? "(untitled)"} | ${session.cwd} | ${formatState(session.id, ctx)} | ${formatToolTime(session.modified, ctx.timeZone)}`
  );
  if (shown.length > MAX_SESSION_LIST) {
    lines.push(`\u2026 ${shown.length - MAX_SESSION_LIST} more not shown; narrow with workspace.`);
  }
  return lines.join("\n");
}

/**
 * One session's live phase plus its newest message — the "what is it doing"
 * answer. With no `session` argument it reports every running session, which
 * is the question that actually gets asked.
 */
async function sessionStatus(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const sessions = await visibleSessions(ctx);
  const query = stringArg(args, "session");
  if (!query) {
    const running = sessions.filter((session) => ctx.runningSessionIds?.has(session.id));
    if (running.length === 0) return "No session has a live engine process right now.";
    const reports = await Promise.all(running.slice(0, MAX_SESSION_LIST).map((session) => statusLine(session, ctx)));
    return reports.join("\n\n");
  }

  const resolved = resolveTarget(query, sessions, ctx);
  if (resolved === null) return SESSION_NOT_FOUND;
  if ("candidates" in resolved) return resolved.candidates;
  const target = sessions.find((session) => session.id === resolved.id);
  if (!target || !mayRead(resolved.id, ctx)) return SESSION_NOT_FOUND;
  return statusLine(target, ctx);
}

async function statusLine(session: SessionInfo, ctx: SessionToolContext): Promise<string> {
  const header = `${session.name ?? "(untitled)"} | ${session.id}`;
  const lines = [
    header,
    `state: ${formatState(session.id, ctx)} \u2014 ${formatPhase(session.id, ctx)}`,
    `folder: ${session.cwd}`,
    `last activity: ${formatToolTime(session.modified, ctx.timeZone)}`,
  ];
  const latest = await newestMessage(session.id);
  if (latest) lines.push(`latest: ${latest}`);
  return lines.join("\n");
}

/** The newest condensed message, so a status is about content and not only
 * flags. Best effort: a session whose file is not written yet has none. */
async function newestMessage(sessionId: string): Promise<string | null> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  try {
    const messages = buildSessionContext(getSessionEntries(filePath)).messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const line = renderCondensedMessage(messages[index]);
      if (!line) continue;
      const clamped = clampForSidebar(line, PER_MESSAGE_CHAR_CAP);
      return clamped.truncated ? `${clamped.text}\u2026` : clamped.text;
    }
  } catch {
    // An unreadable or half-written file is not a status failure.
  }
  return null;
}

/** User/assistant text and tool NAMES only — never a tool's arguments or its
 * result content, and never any other message kind (toolResult, custom,
 * bashExecution, developer, pythonExecution, fileMention): those carry
 * arbitrarily large or sensitive payloads a condensed transcript must not
 * surface. */
function renderCondensedMessage(message: AgentMessage): string | null {
  if (message.role === "user") {
    const text = extractText(message.content).trim();
    return text ? `User: ${text}` : null;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
      else if (block.type === "toolCall") parts.push(`[tool: ${block.toolName}]`);
    }
    return parts.length ? `Assistant: ${parts.join(" ")}` : null;
  }
  return null;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

/**
 * A tool's `session` argument as ONE chat this caller may act on, or the text
 * to answer with instead (not found, or the candidate list when a title matches
 * several). The default — the caller's own chat — is not in the listing until
 * its file exists, so membership is required only for a resolved OTHER chat;
 * the ownership gate applies to every id either way. Shared with the scheduling
 * tools, which must refuse a chat its owner cannot reach exactly as reading does.
 */
export async function resolveSessionArgument(query: string | undefined, ctx: SessionToolContext): Promise<{ id: string } | { text: string }> {
  const sessions = await visibleSessions(ctx);
  const resolved = resolveTarget(query, sessions, ctx);
  if (resolved === null) return { text: SESSION_NOT_FOUND };
  if ("candidates" in resolved) return { text: resolved.candidates };
  const listed = sessions.some((session) => session.id === resolved.id);
  if ((!listed && resolved.id !== ctx.defaultSessionId) || !mayRead(resolved.id, ctx)) return { text: SESSION_NOT_FOUND };
  return { id: resolved.id };
}

async function readSession(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const target = await resolveSessionArgument(stringArg(args, "session"), ctx);
  if ("text" in target) return target.text;
  const targetId = target.id;

  const filePath = await resolveSessionPath(targetId);
  if (!filePath) return SESSION_NOT_FOUND;

  const messages = buildSessionContext(getSessionEntries(filePath)).messages;
  const tail = numberArg(args, "tail");
  const source = tail && tail > 0 ? messages.slice(-Math.floor(tail)) : messages;

  const rendered: string[] = [];
  for (const message of source) {
    const line = renderCondensedMessage(message);
    if (!line) continue;
    const clamped = clampForSidebar(line, PER_MESSAGE_CHAR_CAP);
    rendered.push(clamped.truncated ? `${clamped.text}\u2026` : clamped.text);
  }
  if (rendered.length === 0) return "(no messages)";
  rendered.reverse(); // newest first

  const offset = numberArg(args, "offset") ?? 0;
  return withPagingHint(clampForSidebar(rendered.join("\n\n"), sessionToolBudget(ctx), { offset }), offset);
}

/** Schemas stay one short sentence with minimal args: these ride in every
 * session's tool list, including the sidebar's own tight schema budget. */
export const SESSION_AWARENESS_TOOLS: SessionToolDefinition[] = [
  {
    name: "list_sessions",
    description: "List recent chat sessions: id, title, folder, running state, last activity.",
    parameters: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Only sessions whose folder matches this path." },
        running: { type: "boolean", description: "Only sessions with a live engine process." },
      },
    },
    handler: listSessions,
  },
  {
    name: "session_status",
    description: "What a chat session is doing right now — live phase plus its newest message. Omit `session` for every running one.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id or title; omit for all running sessions." },
      },
    },
    handler: sessionStatus,
  },
  {
    name: "read_session",
    description: "Read a condensed transcript of a chat session by id or title: messages and tool names only.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id or title; omit for this session." },
        tail: { type: "number", description: "Only the most recent N messages." },
        offset: { type: "number", description: "Resume from a prior truncated result's offset." },
      },
    },
    handler: readSession,
  },
];

export const SESSION_AWARENESS_TOOL_NAMES: readonly string[] = SESSION_AWARENESS_TOOLS.map((tool) => tool.name);
