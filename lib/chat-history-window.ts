import type { AgentMessage } from "./types";

/**
 * The bounded working set of the ACTIVE chat: the messages the browser holds
 * for one branch, a contiguous slice of it (older pages the reader asked for,
 * the live tail, or both), plus the cursors that name the slice's edges.
 *
 * Everything here is pure so it can be tested without a DOM. The hook owns the
 * one React state that holds a {@link HistoryWindow} and applies these as
 * functional updates, so a live append and a page landing can never overwrite
 * each other.
 *
 * Vocabulary:
 *  - ATTACHED: the window reaches the live end (`newerCursor === null`). Live
 *    messages append to it and old ones are dropped from the head to stay under
 *    the cap.
 *  - DETACHED: the reader navigated away from the live end. Live messages do
 *    not append (they are flagged `liveAhead`); "Jump to latest" re-attaches.
 *  - PERSISTED: messages from the head that the server has, and that a cursor
 *    can therefore address. Messages after them are live-only (streamed or
 *    optimistic) and have no identity yet.
 *
 * Nothing is ever dropped silently: whichever end loses messages gets a cursor
 * so the reader can load them back.
 */

/** Hard cap on messages held; trimming settles at {@link TRIM_TO}. */
export const WINDOW_MAX_MESSAGES = 300;
/** Approximate retained text bytes of the window (see {@link estimateMessageBytes}). */
export const WINDOW_MAX_BYTES = 6 * 1024 * 1024;
/** Trimming settles at this fraction of the cap so it is not repeated per append. */
const TRIM_TO = 0.75;
/** Messages kept on each side of the reader's own message when trimming. */
export const READER_MARGIN = 12;

export interface HistoryMeta {
  /** Oldest held message's identity iff older messages exist on the server. */
  olderCursor: string | null;
  /** Newest held message's identity iff newer messages exist (the window is detached). */
  newerCursor: string | null;
  /**
   * Engines without entry ids address a message by `m:<absoluteIndex>`; this is
   * the absolute index of `messages[0]`. null for an omp session (entry ids).
   */
  engineStart: number | null;
  /** Leading messages the server has. Always <= messages.length. */
  persisted: number;
  /** Messages on the whole branch at the last server answer, if it said. */
  totalMessages: number | null;
  /** Live messages completed while detached; they are on the server, not here. */
  liveAhead: boolean;
  /** Net messages added (+) or removed (-) at the head, ever. The reader's anchor index follows it. */
  shift: number;
  /** Bumped whenever the whole window is replaced; position memory is then void. */
  epoch: number;
}

export interface HistoryWindow {
  messages: AgentMessage[];
  /** Parallel to the first `persisted` messages (empty for an engine). */
  entryIds: string[];
  meta: HistoryMeta;
}

/** The fields of a server context this module reads. Cursors are absent on a legacy full response. */
export interface WindowContext {
  messages: AgentMessage[];
  entryIds?: string[];
  olderCursor?: string | null;
  newerCursor?: string | null;
  totalMessages?: number;
  olderCount?: number;
}

export function emptyWindow(epoch = 0): HistoryWindow {
  return {
    messages: [],
    entryIds: [],
    meta: {
      olderCursor: null,
      newerCursor: null,
      engineStart: null,
      persisted: 0,
      totalMessages: null,
      liveAhead: false,
      shift: 0,
      epoch,
    },
  };
}

/** A window straight from a server context (a tail page, a branch, or a legacy full response). */
export function windowFromContext(context: WindowContext, epoch: number): HistoryWindow {
  const messages = context.messages;
  const entryIds = context.entryIds ?? [];
  const paged = context.totalMessages !== undefined;
  const engine = paged && entryIds.length === 0 && messages.length > 0;
  return {
    messages,
    entryIds,
    meta: {
      olderCursor: context.olderCursor ?? null,
      newerCursor: context.newerCursor ?? null,
      engineStart: engine ? context.olderCount ?? 0 : null,
      persisted: engine ? messages.length : Math.min(entryIds.length, messages.length),
      totalMessages: context.totalMessages ?? null,
      liveAhead: false,
      shift: 0,
      epoch,
    },
  };
}

/** True when the window does not reach the live end of the branch. */
export function isDetached(window: HistoryWindow): boolean {
  return window.meta.newerCursor !== null;
}

/** Cursor identity of message `index`, or undefined when it is live-only. */
export function idAt(window: HistoryWindow, index: number): string | undefined {
  if (index < 0 || index >= window.meta.persisted) return undefined;
  const { engineStart } = window.meta;
  return engineStart === null ? window.entryIds[index] : `m:${engineStart + index}`;
}

const byteCache = new WeakMap<object, number>();

/**
 * Approximate retained bytes of a message: the length of its text, thinking,
 * image data and tool input. Oversized blocks arrive as stubs whose size is a
 * few dozen characters (`lazyChars` says how much the server withheld; that is
 * deliberately not counted, it is not held here). Cached per message object.
 */
export function estimateMessageBytes(message: AgentMessage): number {
  const cached = byteCache.get(message);
  if (cached !== undefined) return cached;
  let bytes = 64;
  const content: unknown = "content" in message ? message.content : undefined;
  if (typeof content === "string") {
    bytes += content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) bytes += blockBytes(block);
  }
  if ("details" in message) bytes += inputBytes(message.details, 3);
  byteCache.set(message, bytes);
  return bytes;
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** Text held under a tool call's input, summed without serializing it (a write's whole file is one string). */
function inputBytes(value: unknown, depth: number): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object" || depth <= 0) return 0;
  let bytes = 0;
  for (const child of Object.values(value)) bytes += inputBytes(child, depth - 1);
  return bytes;
}

function blockBytes(block: unknown): number {
  if (block === null || typeof block !== "object") return 0;
  let bytes = 0;
  if ("text" in block) bytes += textLength(block.text);
  if ("thinking" in block) bytes += textLength(block.thinking);
  if ("data" in block) bytes += textLength(block.data);
  if ("source" in block && block.source !== null && typeof block.source === "object" && "data" in block.source) {
    bytes += textLength(block.source.data);
  }
  const input = "arguments" in block ? block.arguments : "input" in block ? block.input : undefined;
  return bytes + inputBytes(input, 3);
}

export function estimateWindowBytes(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageBytes(message);
  return total;
}

export type PageResult = HistoryWindow | "stale" | "invalid";

/**
 * Prepend the page that answered `before=<requested>`. "stale": the window's
 * older edge is no longer `requested` (it was replaced or trimmed since the
 * request went out). "invalid": the page does not line up with the window.
 */
export function prependPage(window: HistoryWindow, page: WindowContext, requested: string): PageResult {
  const { meta } = window;
  if (meta.olderCursor !== requested) return "stale";
  const pageIds = page.entryIds ?? [];
  const engine = meta.engineStart !== null;
  let keep: number[];
  if (engine) {
    if (page.olderCount === undefined || page.olderCount + page.messages.length !== meta.engineStart) return "invalid";
    keep = page.messages.map((_, index) => index);
  } else {
    if (pageIds.length !== page.messages.length) return "invalid";
    const held = new Set(window.entryIds);
    keep = [];
    for (let index = 0; index < pageIds.length; index += 1) if (!held.has(pageIds[index])) keep.push(index);
  }
  if (page.messages.length > 0 && keep.length === 0) return "invalid";
  const messages = [...keep.map((index) => page.messages[index]), ...window.messages];
  return {
    messages,
    entryIds: engine ? window.entryIds : [...keep.map((index) => pageIds[index]), ...window.entryIds],
    meta: {
      ...meta,
      olderCursor: keep.length === 0 ? null : page.olderCursor ?? null,
      engineStart: engine ? (meta.engineStart as number) - keep.length : null,
      persisted: meta.persisted + keep.length,
      totalMessages: page.totalMessages ?? meta.totalMessages,
      shift: meta.shift + keep.length,
    },
  };
}

/**
 * Append the page that answered `after=<requested>`. Reaching the live end
 * (`newerCursor` null) re-attaches the window.
 */
export function appendPage(window: HistoryWindow, page: WindowContext, requested: string): PageResult {
  const { meta } = window;
  if (meta.newerCursor !== requested) return "stale";
  const pageIds = page.entryIds ?? [];
  const engine = meta.engineStart !== null;
  let keep: number[];
  if (engine) {
    if (page.olderCount === undefined || page.olderCount !== meta.engineStart! + meta.persisted) return "invalid";
    keep = page.messages.map((_, index) => index);
  } else {
    if (pageIds.length !== page.messages.length) return "invalid";
    const held = new Set(window.entryIds);
    keep = [];
    for (let index = 0; index < pageIds.length; index += 1) if (!held.has(pageIds[index])) keep.push(index);
  }
  if (page.messages.length > 0 && keep.length === 0) return "invalid";
  // Detached windows hold no live-only messages, so persisted === length.
  return {
    messages: [...window.messages, ...keep.map((index) => page.messages[index])],
    entryIds: engine ? window.entryIds : [...window.entryIds, ...keep.map((index) => pageIds[index])],
    meta: {
      ...meta,
      newerCursor: keep.length === 0 ? null : page.newerCursor ?? null,
      persisted: meta.persisted + keep.length,
      totalMessages: page.totalMessages ?? meta.totalMessages,
      liveAhead: (keep.length === 0 || page.newerCursor == null) ? false : meta.liveAhead,
    },
  };
}

export type TailOutcome = "replaced" | "merged" | "detached";

/**
 * A tail that covers everything held replaces it, but the reader keeps their
 * place: same epoch, and the head grew by however many messages now sit above
 * what they held, so their anchor index follows.
 */
function coverTail(window: HistoryWindow, tail: HistoryWindow): HistoryWindow {
  const first = window.meta.engineStart !== null
    ? window.meta.engineStart - (tail.meta.engineStart ?? 0)
    : tail.entryIds.indexOf(window.entryIds[0]);
  if (first < 0) return tail;
  return { ...tail, meta: { ...tail.meta, epoch: window.meta.epoch, shift: window.meta.shift + first } };
}

/**
 * Fold a freshly fetched TAIL window into the one the reader holds. A reader
 * who is not following keeps the older pages they loaded: when the tail
 * overlaps (or touches) the held range the two are joined, so nothing the
 * reader scrolled to disappears under them. When the tail has moved on past
 * the held range (a gap) the held window is kept, detached, and `liveAhead`
 * says there is more. A following reader, or an empty window, just takes the
 * tail.
 */
export function mergeTail(
  window: HistoryWindow,
  tail: HistoryWindow,
  reading: boolean,
): { window: HistoryWindow; outcome: TailOutcome } {
  const replaced = { window: tail, outcome: "replaced" as const };
  const { meta } = window;
  if (!reading || meta.persisted === 0 || isDetached(window)) return replaced;
  if (tail.meta.persisted === 0) return replaced;

  // Where the tail's first message sits in the held persisted range.
  let at: number;
  if (meta.engineStart !== null) {
    if (tail.meta.engineStart === null) return replaced;
    const rel = tail.meta.engineStart - meta.engineStart;
    if (rel < 0) return { window: coverTail(window, tail), outcome: "replaced" }; // the tail starts earlier: it covers what is held
    at = rel <= meta.persisted ? rel : -1;
  } else {
    if (tail.meta.engineStart !== null) return replaced;
    at = window.entryIds.indexOf(tail.entryIds[0]);
    if (at < 0) {
      // Not found: either the tail swallowed the whole held range, or it moved past it.
      const last = window.entryIds[meta.persisted - 1];
      if (tail.entryIds.includes(last)) return { window: coverTail(window, tail), outcome: "replaced" };
    }
  }

  if (at < 0) {
    return {
      window: {
        messages: window.messages.slice(0, meta.persisted),
        entryIds: window.entryIds.slice(0, meta.persisted),
        meta: { ...meta, newerCursor: idAt(window, meta.persisted - 1) ?? null, liveAhead: true, totalMessages: tail.meta.totalMessages ?? meta.totalMessages },
      },
      outcome: "detached",
    };
  }

  return {
    window: {
      messages: [...window.messages.slice(0, at), ...tail.messages],
      entryIds: meta.engineStart !== null ? window.entryIds : [...window.entryIds.slice(0, at), ...tail.entryIds],
      meta: {
        ...meta,
        olderCursor: at > 0 ? meta.olderCursor : tail.meta.olderCursor,
        newerCursor: null,
        persisted: at + tail.meta.persisted,
        totalMessages: tail.meta.totalMessages ?? meta.totalMessages,
        liveAhead: false,
      },
    },
    outcome: "merged",
  };
}

/**
 * Keep a window honest after a change to its messages:
 *  - detached: live-only messages cannot be shown (they would sit under a gap),
 *    so they are removed and `liveAhead` is raised;
 *  - over the cap: drop from the end farthest from the reader (the head when
 *    following), keeping {@link READER_MARGIN} messages around the reader, and
 *    point the matching cursor at the new edge so the dropped messages stay one
 *    click away. A tail can only be cut where the new last message has an
 *    identity; otherwise the head is cut instead.
 * `reader` is the index of the message the reader is looking at, or null when
 * they follow the live end.
 */
export function enforceWindow(
  window: HistoryWindow,
  reader: number | null,
  limits: { maxMessages: number; maxBytes: number } = { maxMessages: WINDOW_MAX_MESSAGES, maxBytes: WINDOW_MAX_BYTES },
): HistoryWindow {
  let current = window;
  if (isDetached(current) && current.messages.length > current.meta.persisted) {
    current = {
      ...current,
      messages: current.messages.slice(0, current.meta.persisted),
      meta: { ...current.meta, liveAhead: true },
    };
  }
  const count = current.messages.length;
  if (count <= 1) return current;
  let bytes = estimateWindowBytes(current.messages);
  if (count <= limits.maxMessages && bytes <= limits.maxBytes) return current;

  const targetCount = Math.max(2, Math.floor(limits.maxMessages * TRIM_TO));
  const targetBytes = limits.maxBytes * TRIM_TO;
  const { persisted } = current.meta;
  let head = 0;
  let tail = 0; // messages dropped from the end
  const readerIndex = reader === null ? null : Math.min(Math.max(reader, 0), count - 1);

  while (count - head - tail > 1 && (count - head - tail > targetCount || bytes > targetBytes)) {
    const first = head;
    const last = count - 1 - tail;
    let dropHead: boolean;
    if (readerIndex === null) {
      dropHead = true;
    } else {
      const headRoom = readerIndex - READER_MARGIN - first;
      const tailRoom = last - (readerIndex + READER_MARGIN);
      const canHead = headRoom > 0 && first + 1 < persisted;
      const canTail = tailRoom > 0 && last - 1 < persisted && last - 1 >= 0;
      if (!canHead && !canTail) break;
      dropHead = canHead && (!canTail || headRoom >= tailRoom);
    }
    if (dropHead) {
      if (head + 1 >= persisted) break; // the new oldest must be addressable
      bytes -= estimateMessageBytes(current.messages[first]);
      head += 1;
    } else {
      if (last - 1 >= persisted || last - 1 < 0) break; // the new newest must be addressable
      bytes -= estimateMessageBytes(current.messages[last]);
      tail += 1;
    }
  }
  if (head === 0 && tail === 0) return current;

  const keepEnd = count - tail;
  const meta = current.meta;
  const droppedLive = tail > 0 && count > persisted;
  const next: HistoryWindow = {
    messages: current.messages.slice(head, keepEnd),
    entryIds: meta.engineStart !== null ? current.entryIds : current.entryIds.slice(head, Math.min(keepEnd, current.entryIds.length)),
    meta: {
      ...meta,
      olderCursor: head > 0 ? idAt(current, head) ?? meta.olderCursor : meta.olderCursor,
      newerCursor: tail > 0 ? idAt(current, keepEnd - 1) ?? meta.newerCursor : meta.newerCursor,
      engineStart: meta.engineStart === null ? null : meta.engineStart + head,
      persisted: Math.min(persisted, keepEnd) - head,
      liveAhead: meta.liveAhead || droppedLive,
      shift: meta.shift - head,
    },
  };
  return next;
}

/** Per-role message counts of live-only messages, plus the live-only slice itself. */
export function liveOnlyMessages(window: HistoryWindow): AgentMessage[] {
  return window.messages.slice(window.meta.persisted);
}

/** Live-only messages tolerated before the tail is re-read from disk to give them ids. */
export const LIVE_ONLY_MAX_MESSAGES = 64;
/** ...or this many retained bytes of them: a few huge outputs are as heavy as many small messages. */
export const LIVE_ONLY_MAX_BYTES = 1024 * 1024;

/**
 * Whether the messages past `persisted` (live-only: no entry id, so neither
 * trimmable nor loadable back) have grown past what the window should carry.
 * Either too many of them or too many bytes.
 */
export function liveOnlyUnderPressure(messages: readonly AgentMessage[], persisted: number): boolean {
  if (messages.length - persisted > LIVE_ONLY_MAX_MESSAGES) return true;
  let bytes = 0;
  for (let index = persisted; index < messages.length; index += 1) {
    bytes += estimateMessageBytes(messages[index]);
    if (bytes > LIVE_ONLY_MAX_BYTES) return true;
  }
  return false;
}
