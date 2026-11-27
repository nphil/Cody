/**
 * Server-side history paging for GET /api/sessions/[id] and
 * GET /api/sessions/[id]/context.
 *
 * A long chat's whole branch is megabytes of JSON, and the page only needs the
 * messages at the bottom of the screen. With `?page=1` the routes return a
 * WINDOW of the branch and hand back cursors to walk the rest from the disk
 * file, which stays the authority (the browser keeps no copy it must trust).
 * Without `page=1` nothing changes: legacy consumers still get the whole branch.
 *
 * Request (all optional, only read when `page=1`):
 *  - `before=<id>`  the page strictly OLDER than that message (exclusive).
 *  - `after=<id>`   the page strictly NEWER than that message (exclusive).
 *    Neither: the tail (the newest messages). Both: 400.
 *  - `limit=<n>`    most messages in the page (default 80, 1..200).
 *  - `bytes=<n>`    approximate JSON budget of the page (default 512 KiB,
 *    16 KiB..4 MiB).
 *
 * A message is never dropped for being big: the page ALWAYS holds at least one
 * message, however large, and otherwise grows only while it stays inside both
 * the count and the byte budget. What does not fit is reachable by the cursor.
 *
 * Identities are the omp session-entry ids in `context.entryIds`. An engine
 * with no entry ids (a turn-based, non-omp engine) has no stable id per message,
 * but its turn log is append-only, so a message's absolute index is stable:
 * its cursor is `m:<index>` and its `entryIds` stay empty (see
 * {@link engineCursorId}).
 */

import type { AgentMessage, AssistantMessage, SessionContext, SessionEntry } from "./types";
import { aggregateMessageUsage, countEditRejections, emptyUsageTotals, type UsageTotals } from "./session-usage";
import { isRecord } from "./type-guards";

export const HISTORY_PAGE_DEFAULT_LIMIT = 80;
export const HISTORY_PAGE_MAX_LIMIT = 200;
export const HISTORY_PAGE_DEFAULT_BYTES = 512 * 1024;
export const HISTORY_PAGE_MIN_BYTES = 16 * 1024;
export const HISTORY_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Per message, on top of its JSON: its entry id and the array slots. */
const PER_MESSAGE_OVERHEAD_BYTES = 96;

export type HistoryPageAnchor =
  | { kind: "tail" }
  | { kind: "before"; id: string }
  | { kind: "after"; id: string };

export interface HistoryPageRequest {
  anchor: HistoryPageAnchor;
  limit: number;
  bytes: number;
}

export type HistoryPageParse =
  | { page: null }
  | { page: HistoryPageRequest }
  | { error: { code: "history_cursor_conflict"; message: string } };

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

/** `page=1` opts in; anything else is the legacy full response. */
export function parseHistoryPage(params: URLSearchParams): HistoryPageParse {
  if (params.get("page") !== "1") return { page: null };
  const before = params.get("before");
  const after = params.get("after");
  if (before && after) {
    return { error: { code: "history_cursor_conflict", message: "Send either before or after, not both" } };
  }
  const anchor: HistoryPageAnchor = before ? { kind: "before", id: before } : after ? { kind: "after", id: after } : { kind: "tail" };
  return {
    page: {
      anchor,
      limit: clampInt(params.get("limit"), HISTORY_PAGE_DEFAULT_LIMIT, 1, HISTORY_PAGE_MAX_LIMIT),
      bytes: clampInt(params.get("bytes"), HISTORY_PAGE_DEFAULT_BYTES, HISTORY_PAGE_MIN_BYTES, HISTORY_PAGE_MAX_BYTES),
    },
  };
}

/** Totals of the WHOLE branch, so a windowed response still reports the full history. */
export interface HistoryStats {
  /** Every message on the branch, crash rows included (what `messages.length` was). */
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: number;
  /** Assistant-message usage only; `modelUsage` (billed non-message calls) stays its own top-level field. */
  usage: UsageTotals;
  /** Failed edits by the engine's reason (`countEditRejections`); empty when none. */
  editRejections: Record<string, number>;
  /** Per provider/model assistant turns and tokens, in first-seen order. */
  modelTurns: HistoryModelTurns[];
  /** The newest assistant message's usage and model, for the context meter when the window holds none. */
  latestAssistant: { provider: string; model: string; usage?: AssistantMessage["usage"] } | null;
}

export interface HistoryModelTurns {
  provider: string;
  modelId: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function computeHistoryStats(messages: readonly AgentMessage[]): HistoryStats {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let toolCalls = 0;
  let latest: AssistantMessage | undefined;
  const byModel = new Map<string, HistoryModelTurns>();
  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    else if (message.role === "toolResult") toolResults += 1;
    else if (message.role === "assistant") {
      assistantMessages += 1;
      latest = message;
      if (Array.isArray(message.content)) {
        for (const block of message.content) if (block?.type === "toolCall") toolCalls += 1;
      }
      // Some imported or interrupted assistant turns carry no model identity.
      // They count as messages, but do not belong to a model breakdown row.
      if (!message.provider || !message.model) continue;
      const key = `${message.provider}\u0000${message.model}`;
      const row = byModel.get(key) ?? {
        provider: message.provider,
        modelId: message.model,
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      row.turns += 1;
      row.input += message.usage?.input ?? 0;
      row.output += message.usage?.output ?? 0;
      row.cacheRead += message.usage?.cacheRead ?? 0;
      row.cacheWrite += message.usage?.cacheWrite ?? 0;
      byModel.set(key, row);
    }
  }
  return {
    totalMessages: messages.length,
    userMessages,
    assistantMessages,
    toolResults,
    toolCalls,
    usage: messages.length === 0 ? emptyUsageTotals() : aggregateMessageUsage(messages),
    editRejections: countEditRejections(messages),
    modelTurns: [...byModel.values()],
    latestAssistant: latest ? { provider: latest.provider, model: latest.model, usage: latest.usage } : null,
  };
}

/** The window fields a paged `context` adds to {@link SessionContext}. */
export interface HistoryPageFields {
  /** Oldest loaded message's identity iff older messages exist, else null. */
  olderCursor: string | null;
  /** Newest loaded message's identity iff newer messages exist (the page is not the tail), else null. */
  newerCursor: string | null;
  /** Messages on the whole branch. */
  totalMessages: number;
  /** Messages older / newer than the loaded window. */
  olderCount: number;
  newerCount: number;
  /** Approximate JSON bytes of the loaded messages. */
  windowBytes: number;
}

export type PagedSessionContext = SessionContext & HistoryPageFields;

/** The id a cursor for message `index` carries: its entry id, or `m:<index>` for an engine with none. */
export function engineCursorId(index: number): string {
  return `m:${index}`;
}

/** Index of a cursor in the branch, or -1 when it names nothing on it. */
function indexOfCursor(id: string, entryIds: readonly string[], total: number, engine: boolean): number {
  if (engine) {
    const match = /^m:(\d+)$/.exec(id);
    if (!match) return -1;
    const index = Number(match[1]);
    return index < total ? index : -1;
  }
  return entryIds.indexOf(id);
}

function messageBytes(message: AgentMessage): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(message);
  } catch {
    json = undefined;
  }
  return (json === undefined ? 0 : Buffer.byteLength(json)) + PER_MESSAGE_OVERHEAD_BYTES;
}

export type HistoryWindow =
  | { ok: true; start: number; end: number; bytes: number }
  | { ok: false; code: "history_cursor_not_found" };

/**
 * Choose `[start, end)` of a branch of `total` messages. `engine`: the branch
 * has no entry ids and cursors are `m:<index>`.
 */
export function chooseHistoryWindow(
  messages: readonly AgentMessage[],
  entryIds: readonly string[],
  request: HistoryPageRequest,
  engine: boolean,
): HistoryWindow {
  const total = messages.length;
  const { anchor, limit, bytes: budget } = request;
  let bytes = 0;
  let count = 0;
  const fits = (size: number) => count === 0 || (count < limit && bytes + size <= budget);

  if (anchor.kind === "after") {
    const at = indexOfCursor(anchor.id, entryIds, total, engine);
    if (at === -1) return { ok: false, code: "history_cursor_not_found" };
    let end = at + 1;
    while (end < total) {
      const size = messageBytes(messages[end]);
      if (!fits(size)) break;
      bytes += size;
      count += 1;
      end += 1;
    }
    return { ok: true, start: at + 1, end, bytes };
  }

  let end = total;
  if (anchor.kind === "before") {
    end = indexOfCursor(anchor.id, entryIds, total, engine);
    if (end === -1) return { ok: false, code: "history_cursor_not_found" };
  }
  let start = end;
  while (start > 0) {
    const size = messageBytes(messages[start - 1]);
    if (!fits(size)) break;
    bytes += size;
    count += 1;
    start -= 1;
  }
  return { ok: true, start, end, bytes };
}

/**
 * Window a full branch context. Everything that is not the message list (model,
 * thinking level, todo phases, goal) is the branch's CURRENT state and passes
 * through untouched.
 */
export function pageSessionContext<C extends SessionContext>(
  context: C,
  request: HistoryPageRequest,
  options: { engine?: boolean } = {},
): { context: C & HistoryPageFields } | { error: "history_cursor_not_found" } {
  const engine = options.engine === true;
  const total = context.messages.length;
  const window = chooseHistoryWindow(context.messages, context.entryIds, request, engine);
  if (!window.ok) return { error: window.code };
  const { start, end } = window;
  const idAt = (index: number) => (engine ? engineCursorId(index) : context.entryIds[index]);
  return {
    context: {
      ...context,
      messages: context.messages.slice(start, end),
      entryIds: engine ? [] : context.entryIds.slice(start, end),
      olderCursor: start > 0 && end > start ? idAt(start) ?? null : null,
      newerCursor: end < total && end > start ? idAt(end - 1) ?? null : null,
      totalMessages: total,
      olderCount: start,
      newerCount: total - end,
      windowBytes: window.bytes,
    },
  };
}

const TREE_LABEL_CHARS = 80;
const TREE_LABEL_BLOCKS = 3;

/** A tree entry cut down to what the branch navigator reads: identity, type
 *  and, for a message, its role with a short text preview. */
function slimTreeEntry(entry: SessionEntry): SessionEntry {
  const slim: Record<string, unknown> = {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };
  if (entry.type === "message" && isRecord(entry.message)) {
    const { role, content } = entry.message as { role?: unknown; content?: unknown };
    let preview: unknown = "";
    if (typeof content === "string") {
      preview = content.slice(0, TREE_LABEL_CHARS);
    } else if (Array.isArray(content)) {
      const blocks: Array<{ type: "text"; text: string }> = [];
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          blocks.push({ type: "text", text: block.text.slice(0, TREE_LABEL_CHARS) });
          if (blocks.length >= TREE_LABEL_BLOCKS) break;
        }
      }
      preview = blocks;
    }
    slim.message = { role, content: preview };
  }
  return slim as unknown as SessionEntry;
}

/** The preview of `info.firstMessage` in a paged response: no client reads more, and the first prompt can be megabytes. */
export const HISTORY_FIRST_MESSAGE_PREVIEW_CHARS = 200;
const TREE_NODE_LABEL_CHARS = 200;

/**
 * Cut every projected tree node down to what the branch navigator reads, in
 * place. The nodes must be a projection's own clones (projectTreeForResponse),
 * never the cached parse.
 *
 *  - Entries shrink to a label (message bodies made the tree weigh as much as
 *    the transcript beside it) and node labels are capped.
 *  - A chain's `compressedEntryIds` has one id per entry of the chain, so a
 *    long linear branch grew the tree with EVERY message. It becomes
 *    `compressedCount`, and the ids stay only when `leafId` sits inside that
 *    chain (as just `[leafId]`), because that is the one membership the
 *    navigator asks about to mark the active path.
 */
export function slimTreeForPage<T extends {
  entry: SessionEntry;
  children: T[];
  label?: string;
  compressedEntryIds?: string[];
  compressedCount?: number;
}>(nodes: T[], leafId: string | null): T[] {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.entry = slimTreeEntry(node.entry);
    if (typeof node.label === "string" && node.label.length > TREE_NODE_LABEL_CHARS) {
      node.label = node.label.slice(0, TREE_NODE_LABEL_CHARS);
    }
    const chain = node.compressedEntryIds;
    if (chain && chain.length > 0) {
      node.compressedCount = chain.length;
      if (leafId !== null && chain.includes(leafId)) node.compressedEntryIds = [leafId];
      else delete node.compressedEntryIds;
    }
    for (const child of node.children) stack.push(child);
  }
  return nodes;
}
