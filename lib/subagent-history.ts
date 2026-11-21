// Subagent transcript reading for Cody.
//
// omp writes each subagent's session transcript to the PARENT session's
// sibling artifacts directory: `<session-dir>/<subagent-id>.jsonl` (plus
// `<id>.md` outputs and `<id>.<tool>.log` artifact spills), readable after a
// page reload without the live RPC registry (get_subagent_messages is
// registry-gated and rejects unknown session files).

import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs";
import type { Dirent, Stats } from "fs";
import { basename, dirname, join } from "path";
import { entryToUiMessage, isDeferrableToolResultImage } from "./session-reader";
import { parseJsonlLenient, readBlobRefSync } from "./omp/session-files";
import type { SubagentTranscriptPage } from "./subagent-types";
import type { AgentMessage, SessionEntry } from "./types";
import { isRecord } from "./type-guards";
import { addUsageTotals, aggregateMessageUsage, aggregateModelUsage, emptyUsageTotals, type UsageTotals } from "./session-usage";

/** Sibling artifacts directory for a parent session file. */
export function siblingDirForSession(sessionFilePath: string): string {
  return join(dirname(sessionFilePath), basename(sessionFilePath, ".jsonl"));
}

/** User supplied task names are permissive, but remain one safe filesystem
 * component: no separators/control characters/traversal and a bounded UTF-8
 * filename length. */
export const MAX_SUBAGENT_ID_BYTES = 255;

export function isSafeSubagentId(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes(String.fromCharCode(92))) return false;
  if ([...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) return false;
  return Buffer.byteLength(value, "utf8") <= MAX_SUBAGENT_ID_BYTES;
}

/** Subagent transcript path for a roster id within a parent session. */
export function subagentTranscriptPath(sessionFilePath: string, subagentId: string): string {
  if (!isSafeSubagentId(subagentId)) throw new Error("Invalid subagent id");
  return join(siblingDirForSession(sessionFilePath), `${subagentId}.jsonl`);
}

/**
 * Resolve a subagent artifact (`.jsonl` transcript or `.md` completion) inside
 * the parent session's sibling artifacts dir, with symlink confinement:
 * the candidate's REAL path must land directly inside the REAL artifacts dir
 * and be a regular file. Returns the real path (readable target) or null.
 */
export function resolveSubagentArtifact(
  sessionFilePath: string,
  subagentId: string,
  extension: ".jsonl" | ".md",
): string | null {
  if (!isSafeSubagentId(subagentId)) return null;
  let realDir: string;
  try {
    realDir = realpathSync(siblingDirForSession(sessionFilePath));
  } catch {
    return null;
  }
  const candidate = join(realDir, `${subagentId}${extension}`);
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return null;
  }
  if (dirname(realCandidate) !== realDir) return null;
  try {
    if (!statSync(realCandidate).isFile()) return null;
  } catch {
    return null;
  }
  return realCandidate;
}

/** Bytes of whole lines per page. A page is never padded past this, except to
 * carry ONE line that is itself larger (see MAX_SUBAGENT_TRANSCRIPT_LINE_BYTES). */
export const SUBAGENT_TRANSCRIPT_PAGE_BYTES = 256 * 1024;

/** Most JSONL lines in one page, however small they are. */
export const SUBAGENT_TRANSCRIPT_PAGE_LINES = 200;

/** Largest single line read into memory. A longer line is stepped over with a
 * boundary scan and shown as one placeholder row. */
export const MAX_SUBAGENT_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;

/** Longest string the UI renders from one message field before it is cut. */
export const MAX_SUBAGENT_MESSAGE_TEXT_CHARS = 64 * 1024;

/** Longest base64 payload kept inline; bigger images become a text note. */
export const MAX_SUBAGENT_INLINE_IMAGE_CHARS = 512 * 1024;

/** Largest custom-message `details` (shown behind a toggle as JSON) kept. */
export const MAX_SUBAGENT_CUSTOM_DETAILS_CHARS = 64 * 1024;

/** How deep into a tool call's `input` strings are looked for. */
const MAX_TOOL_INPUT_DEPTH = 6;

/** Bytes per read while hunting for a newline. Nothing is retained. */
const LINE_SCAN_CHUNK_BYTES = 64 * 1024;

// Provider-side blobs that ride on persisted blocks and are never rendered
// (`thinkingSignature` alone is over half of a real assistant line).
const PROVIDER_BLOCK_KEYS = ["thinkingSignature", "textSignature", "thoughtSignature"] as const;

/** Cut `text` to the display limit, never splitting a surrogate pair, and say
 * how much was left out. Returns the same string when it already fits. */
function cutText(text: string): string {
  if (text.length <= MAX_SUBAGENT_MESSAGE_TEXT_CHARS) return text;
  let cut = MAX_SUBAGENT_MESSAGE_TEXT_CHARS;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  const moreKb = Math.max(1, Math.round((text.length - cut) / 1024));
  return `${text.slice(0, cut)}\n\n… truncated (${moreKb} KB more not shown)`;
}

/** Copy of `value` with every over-long string cut; `value` itself when
 * nothing was. Never mutates its input. */
function cutDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return cutText(value);
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = cutDeep(value[i], depth - 1);
      if (next !== value[i]) out ??= value.slice();
      if (out) out[i] = next;
    }
    return out ?? value;
  }
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const next = cutDeep(record[key], depth - 1);
    if (next !== record[key]) {
      out ??= { ...record };
      out[key] = next;
    }
  }
  return out ?? value;
}

/** `src` with `patch` applied and `drop` keys removed; `src` when neither changes anything. */
function rebuild<T extends Record<string, unknown>>(src: T, patch: Record<string, unknown>, drop: readonly string[]): T {
  const dropped = drop.filter((key) => key in src);
  if (dropped.length === 0 && Object.keys(patch).length === 0) return src;
  const out: Record<string, unknown> = { ...src, ...patch };
  for (const key of dropped) delete out[key];
  return out as T;
}

function imageOmittedNote(block: Record<string, unknown>): { type: "text"; text: string } | null {
  const source = isRecord(block.source) ? block.source : undefined;
  const data = typeof block.data === "string" ? block.data : typeof source?.data === "string" ? source.data : "";
  if (data.length <= MAX_SUBAGENT_INLINE_IMAGE_CHARS) return null;
  const mime = typeof block.mimeType === "string" ? block.mimeType : typeof source?.media_type === "string" ? source.media_type : "";
  const kb = Math.round((data.length * 3) / 4 / 1024);
  return { type: "text", text: `[image omitted: ${mime ? `${mime}, ` : ""}~${kb} KB]` };
}

function slimBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  switch (block.type) {
    case "text":
    case "thinking": {
      const field = block.type === "text" ? "text" : "thinking";
      const cut = cutDeep(block[field], 0); // only strings are ever cut at depth 0
      return rebuild(block, cut !== block[field] ? { [field]: cut } : {}, PROVIDER_BLOCK_KEYS);
    }
    case "toolCall": {
      const input = cutDeep(block.input, MAX_TOOL_INPUT_DEPTH);
      return rebuild(block, input !== block.input ? { input } : {}, PROVIDER_BLOCK_KEYS);
    }
    case "image":
      return imageOmittedNote(block) ?? block;
    default:
      return block;
  }
}

/** String content is cut; block arrays are slimmed block by block. The same
 * reference comes back when nothing changed. */
function slimContent(content: unknown): unknown {
  if (typeof content === "string") return cutText(content);
  if (!Array.isArray(content)) return content;
  let out: unknown[] | null = null;
  for (let i = 0; i < content.length; i++) {
    const next = slimBlock(content[i]);
    if (next !== content[i]) out ??= content.slice();
    if (out) out[i] = next;
  }
  return out ?? content;
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Bound one transcript message before it is serialized to the browser: drop
 * provider blobs the UI never renders, cut over-long rendered strings with a
 * visible marker, and replace huge inline images with a note. Pure — the input
 * is never mutated and is returned as-is when nothing needs cutting.
 */
export function slimSubagentMessage(message: AgentMessage): AgentMessage {
  const msg = message as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const drop: string[] = [];
  const patchText = (key: string) => {
    const value = msg[key];
    if (typeof value === "string" && value.length > MAX_SUBAGENT_MESSAGE_TEXT_CHARS) patch[key] = cutText(value);
  };
  switch (msg.role) {
    case "assistant":
      drop.push("providerPayload");
      break;
    case "toolResult": {
      if (isRecord(msg.details)) {
        const detailsPatch: Record<string, unknown> = {};
        for (const key of ["patch", "diff"] as const) {
          const value = msg.details[key];
          if (typeof value === "string" && value.length > MAX_SUBAGENT_MESSAGE_TEXT_CHARS) detailsPatch[key] = cutText(value);
        }
        if (Object.keys(detailsPatch).length > 0) patch.details = { ...msg.details, ...detailsPatch };
      }
      break;
    }
    case "custom":
      if (msg.details !== undefined && jsonChars(msg.details) > MAX_SUBAGENT_CUSTOM_DETAILS_CHARS) drop.push("details");
      break;
    case "bashExecution":
      patchText("output");
      patchText("command");
      return rebuild(msg, patch, drop) as unknown as AgentMessage;
    case "user":
    case "developer":
      break;
    default:
      return message;
  }
  const content = slimContent(msg.content);
  if (content !== msg.content) patch.content = content;
  return rebuild(msg, patch, drop) as unknown as AgentMessage;
}

// Scratch space for range reads, reused across calls. The reader is
// synchronous and decodes every line to a string before returning, so one
// buffer of each kind is safe to share.
let pageBuffer: Buffer | null = null;
let scanBuffer: Buffer | null = null;

function readExact(fd: number, buffer: Buffer, length: number, position: number): void {
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buffer, got, length - got, position + got);
    if (n === 0) throw new Error("transcript ended while it was being read");
    got += n;
  }
}

/** Index of the last `\n` strictly before `pos`, or -1. Scans backward in
 * fixed chunks and keeps nothing, however far the previous newline is. */
function lastNewlineBefore(fd: number, pos: number): number {
  const scan = (scanBuffer ??= Buffer.allocUnsafe(LINE_SCAN_CHUNK_BYTES));
  let end = pos;
  while (end > 0) {
    const start = Math.max(0, end - LINE_SCAN_CHUNK_BYTES);
    readExact(fd, scan, end - start, start);
    const at = scan.lastIndexOf(0x0a, end - start - 1);
    if (at >= 0) return start + at;
    end = start;
  }
  return -1;
}

/** Index of the first `\n` in `[pos, limit)`, or -1. Chunked, retains nothing. */
function firstNewlineFrom(fd: number, pos: number, limit: number): number {
  const scan = (scanBuffer ??= Buffer.allocUnsafe(LINE_SCAN_CHUNK_BYTES));
  let start = pos;
  while (start < limit) {
    const len = Math.min(LINE_SCAN_CHUNK_BYTES, limit - start);
    readExact(fd, scan, len, start);
    const at = scan.subarray(0, len).indexOf(0x0a);
    if (at >= 0) return start + at;
    start += len;
  }
  return -1;
}

/** Start of the line containing byte `pos` (`pos` itself when it already starts one). */
function lineStartAtOrBefore(fd: number, pos: number): number {
  return pos <= 0 ? 0 : lastNewlineBefore(fd, pos) + 1;
}

/** One decoded line; `text` is null for a line too large to read. */
interface TranscriptLine {
  offset: number;
  end: number;
  text: string | null;
}

/** The line `[start, end)` — `end` just past its `\n` — read whole, or marked
 * unread when it exceeds the line cap. */
function readSingleLine(fd: number, start: number, end: number): TranscriptLine {
  const length = end - start;
  if (length > MAX_SUBAGENT_TRANSCRIPT_LINE_BYTES) return { offset: start, end, text: null };
  const buffer = length <= SUBAGENT_TRANSCRIPT_PAGE_BYTES + 1
    ? (pageBuffer ??= Buffer.allocUnsafe(SUBAGENT_TRANSCRIPT_PAGE_BYTES + 1))
    : Buffer.allocUnsafe(length);
  readExact(fd, buffer, length, start);
  return { offset: start, end, text: buffer.toString("utf8", 0, length - 1) };
}

/** Whole lines from `start` (a line start) that fit one page, at least one. */
function readLinesForward(fd: number, start: number, endByte: number): TranscriptLine[] {
  const buffer = (pageBuffer ??= Buffer.allocUnsafe(SUBAGENT_TRANSCRIPT_PAGE_BYTES + 1));
  const windowLength = Math.min(SUBAGENT_TRANSCRIPT_PAGE_BYTES, endByte - start);
  readExact(fd, buffer, windowLength, start);
  const view = buffer.subarray(0, windowLength);
  const lines: TranscriptLine[] = [];
  let pos = 0;
  while (lines.length < SUBAGENT_TRANSCRIPT_PAGE_LINES) {
    const newline = view.indexOf(0x0a, pos);
    if (newline < 0) break;
    lines.push({ offset: start + pos, end: start + newline + 1, text: view.toString("utf8", pos, newline) });
    pos = newline + 1;
  }
  if (lines.length === 0) {
    // The first line is longer than the window: find its end past the window.
    const newline = firstNewlineFrom(fd, start + windowLength, endByte);
    if (newline < 0) throw new Error("transcript line has no terminator");
    lines.push(readSingleLine(fd, start, newline + 1));
  }
  return lines;
}

/** Whole lines ending at `end` (a line start, > 0) that fit one page, at least
 * one, oldest first. The line-count cap keeps the lines closest to `end`. */
function readLinesBackward(fd: number, end: number): TranscriptLine[] {
  const buffer = (pageBuffer ??= Buffer.allocUnsafe(SUBAGENT_TRANSCRIPT_PAGE_BYTES + 1));
  const windowStart = Math.max(0, end - SUBAGENT_TRANSCRIPT_PAGE_BYTES);
  // One byte before the window says whether the window starts on a line start.
  const base = windowStart > 0 ? windowStart - 1 : 0;
  readExact(fd, buffer, end - base, base);
  const view = buffer.subarray(0, end - base);
  const lines: TranscriptLine[] = [];
  let lineEnd = end;
  while (lines.length < SUBAGENT_TRANSCRIPT_PAGE_LINES && lineEnd > 0) {
    const before = lineEnd - 2 - base; // last byte before this line's own `\n`
    const newline = before >= 0 ? view.lastIndexOf(0x0a, before) : -1;
    let start: number;
    if (newline >= 0) start = base + newline + 1;
    else if (base === 0) start = 0;
    else break; // this line begins before the window
    lines.push({ offset: start, end: lineEnd, text: view.toString("utf8", start - base, lineEnd - 1 - base) });
    lineEnd = start;
  }
  if (lines.length === 0) {
    lines.push(readSingleLine(fd, lastNewlineBefore(fd, end - 1) + 1, end));
  }
  return lines.reverse();
}

function formatLineSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/** Mints the URL one deferred tool-result image is fetched from: the byte
 *  `offset` of the line it sits on, that line's entry id, and its index among
 *  the entry's images. */
export type SubagentImageUrl = (offset: number, entryId: string, index: number) => string;

const SAFE_ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;

function lineToMessage(line: TranscriptLine, imageUrl?: SubagentImageUrl): AgentMessage | null {
  if (line.text === null) {
    return {
      role: "custom",
      customType: "Entry omitted",
      content: `… entry too large to display (${formatLineSize(line.end - line.offset)})`,
      display: true,
    };
  }
  if (line.text.length === 0) return null;
  try {
    const entry: unknown = JSON.parse(line.text);
    if (!isRecord(entry)) return null;
    // Tool-result images are deferred exactly like the main chat's (blob refs
    // and big inline base64 never ride in the page): each becomes a url-source
    // block the media route resolves. An entry without a usable id cannot be
    // addressed, so it keeps the default shape.
    const entryId = typeof entry.id === "string" && SAFE_ENTRY_ID.test(entry.id) ? entry.id : null;
    const message = entryToUiMessage(
      entry as unknown as SessionEntry,
      imageUrl && entryId
        ? { deferToolResultImages: true, toolResultImageUrl: (id, index) => imageUrl(line.offset, id, index) }
        : {},
    );
    return message ? slimSubagentMessage(message) : null;
  } catch {
    // A corrupt or torn line is skipped, never fatal.
    return null;
  }
}

/**
 * One page of a subagent transcript, read from `sessionFilePath` by byte range
 * without ever loading the whole file. Every page is whole JSONL lines, so each
 * returned `fromByte` / `nextByte` is a valid cursor.
 *
 * - forward (default): lines from `fromByte` (aligned down to a line start;
 *   past EOF restarts at 0 with `reset`).
 * - `before`: the page that ENDS at `fromByte` (aligned down to a line start).
 * - `tail`: the newest page, ending at the last complete line; `fromByte` is ignored.
 *
 * `imageUrl` defers tool-result images (see `lineToMessage`); without it they stay as the file has them.
 *
 * A trailing line without its `\n` is still being written and is never
 * returned. Never throws: an unreadable file yields an empty page.
 */
export function readSubagentTranscriptPage(
  sessionFilePath: string,
  fromByte = 0,
  options: { tail?: boolean; before?: boolean; imageUrl?: SubagentImageUrl } = {},
): SubagentTranscriptPage {
  const normalized = typeof fromByte === "number" && Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
  const empty: SubagentTranscriptPage = {
    sessionFile: sessionFilePath,
    fromByte: normalized,
    nextByte: normalized,
    reset: false,
    messages: [],
    hasEarlier: false,
  };
  let fd: number | undefined;
  try {
    fd = openSync(sessionFilePath, "r");
    const totalBytes = fstatSync(fd).size;
    const endByte = totalBytes === 0 ? 0 : lastNewlineBefore(fd, totalBytes) + 1;
    let reset = false;
    let pageFrom: number;
    let pageTo: number;
    let lines: TranscriptLine[];
    if (options.tail || options.before) {
      pageTo = options.tail ? endByte : lineStartAtOrBefore(fd, Math.min(normalized, totalBytes));
      lines = pageTo > 0 ? readLinesBackward(fd, pageTo) : [];
      pageFrom = lines.length > 0 ? lines[0].offset : pageTo;
    } else {
      let start = normalized;
      if (start > totalBytes) {
        start = 0;
        reset = true;
      }
      pageFrom = lineStartAtOrBefore(fd, start);
      lines = pageFrom < endByte ? readLinesForward(fd, pageFrom, endByte) : [];
      pageTo = lines.length > 0 ? lines[lines.length - 1].end : pageFrom;
    }
    const messages: AgentMessage[] = [];
    const offsets: number[] = [];
    for (const line of lines) {
      const message = lineToMessage(line, options.imageUrl);
      if (!message) continue;
      messages.push(message);
      offsets.push(line.offset);
    }
    return {
      sessionFile: sessionFilePath,
      fromByte: pageFrom,
      nextByte: pageTo,
      reset,
      messages,
      offsets,
      totalBytes,
      endByte,
      hasEarlier: pageFrom > 0,
    };
  } catch {
    return empty;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The one tool-result image a deferred url points at. */
export interface SubagentTranscriptImage {
  bytes: Buffer;
  mime: string;
}

/**
 * Bytes of tool-result image `index` of the entry `entryId` on the line that
 * starts at byte `offset` — what the deferred url minted by
 * `readSubagentTranscriptPage({ imageUrl })` addresses. Reads ONLY that line
 * (a few KB when the image is a blob ref), never the file. `index` counts with
 * `isDeferrableToolResultImage`, the predicate the deferral used. Null when
 * anything does not line up: offset not a line start or past the last complete
 * line, a different entry id, a line over the line cap, no such image, or a
 * blob that is gone. Never throws.
 */
export function readSubagentTranscriptImage(
  sessionFilePath: string,
  offset: number,
  entryId: string,
  index: number,
): SubagentTranscriptImage | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(index) || index < 0 || !SAFE_ENTRY_ID.test(entryId)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(sessionFilePath, "r");
    const totalBytes = fstatSync(fd).size;
    if (offset >= totalBytes) return null;
    if (offset > 0) {
      // The cursor must name a line start, or the bytes after it are no entry.
      const previous = (scanBuffer ??= Buffer.allocUnsafe(LINE_SCAN_CHUNK_BYTES));
      readExact(fd, previous, 1, offset - 1);
      if (previous[0] !== 0x0a) return null;
    }
    const newline = firstNewlineFrom(fd, offset, totalBytes);
    if (newline < 0) return null; // still being written
    const line = readSingleLine(fd, offset, newline + 1);
    if (line.text === null) return null;
    const entry: unknown = JSON.parse(line.text);
    if (!isRecord(entry) || entry.type !== "message" || entry.id !== entryId || !isRecord(entry.message)) return null;
    const content = entry.message.content;
    if (entry.message.role !== "toolResult" || !Array.isArray(content)) return null;
    const block = content.filter(isDeferrableToolResultImage)[index] as
      | { data?: unknown; mimeType?: unknown; source?: { data?: unknown; media_type?: unknown } }
      | undefined;
    const data = typeof block?.data === "string" ? block.data : block?.source?.data;
    if (typeof data !== "string" || data.length === 0) return null;
    const mime = block?.mimeType ?? block?.source?.media_type;
    const bytes = data.startsWith("blob:sha256:") ? readBlobRefSync(data) : Buffer.from(data, "base64");
    if (!bytes || bytes.length === 0) return null;
    return { bytes, mime: typeof mime === "string" ? mime : "image/png" };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Usage recovered from a parent session's subagent transcripts, plus how many
 * transcripts contributed — zero tells "no subagent ran" apart from "their
 * transcripts reported nothing".
 */
export interface SubagentTranscriptUsage extends UsageTotals {
  transcripts: number;
}

/** A child's own children land in `<parent-dir>/<child-id>/`, so the walk
 *  covers a few generations of orchestration without being unbounded. */
const MAX_SUBAGENT_USAGE_DEPTH = 4;
/** Transcripts tracked for incremental re-scanning (one entry per file). */
const MAX_USAGE_SCAN_CACHE_ENTRIES = 1024;

interface TranscriptUsageScan {
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line already accounted for. */
  offset: number;
  totals: UsageTotals;
}

declare global {
  var __ompSubagentUsageCache: Map<string, TranscriptUsageScan> | undefined;
}

// Transcripts are append-only, so a re-scan reads only what was appended since
// the last one. Without this, every roster refresh during an orchestration
// would re-parse every child transcript from byte zero.
function getTranscriptUsageCache(): Map<string, TranscriptUsageScan> {
  if (!globalThis.__ompSubagentUsageCache) globalThis.__ompSubagentUsageCache = new Map();
  return globalThis.__ompSubagentUsageCache;
}

/** Bytes held in memory at once while accounting for a transcript. The dialog's
 *  cap bounds a whole transcript because it materializes messages for display;
 *  accounting only needs a sliding window, so an arbitrarily long transcript
 *  costs time rather than memory — and is never skipped, which would put back
 *  the very under-count this accounting exists to remove. */
const USAGE_SCAN_WINDOW_BYTES = 4 * 1024 * 1024;

/** Account for every COMPLETE line in `[from, to)`, one bounded window at a
 *  time. A transcript being appended to right now ends mid-line; that line is
 *  left for the next scan instead of being parsed half-written. */
function scanTranscriptRange(
  filePath: string,
  from: number,
  to: number,
): { totals: UsageTotals; consumed: number } {
  if (to <= from) return { totals: emptyUsageTotals(), consumed: 0 };
  let totals = emptyUsageTotals();
  let consumed = 0;
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(to - from, USAGE_SCAN_WINDOW_BYTES));
    while (from + consumed < to) {
      const length = Math.min(to - from - consumed, buffer.length);
      const read = readSync(fd, buffer, 0, length, from + consumed);
      if (read <= 0) break;
      const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
      // No newline in a full window means one JSONL line is longer than the
      // window: skip past it rather than stalling on it forever. Lines are one
      // message each, so this can only lose a single outsized message.
      if (lastNewline < 0) {
        if (read < length || from + consumed + read >= to) break;
        consumed += read;
        continue;
      }
      // Each window starts on a line boundary, so its bytes decode without the
      // offset skew that slicing the decoded string would introduce.
      const entries = parseJsonlLenient<SessionEntry>(buffer.subarray(0, lastNewline + 1).toString("utf8"));
      const messages = entries
        .map((entry) => entryToUiMessage(entry, {}))
        .filter((message): message is AgentMessage => message !== null);
      totals = addUsageTotals(totals, aggregateMessageUsage(messages), aggregateModelUsage(entries));
      consumed += lastNewline + 1;
    }
  } finally {
    closeSync(fd);
  }
  return { totals, consumed };
}

function transcriptUsage(filePath: string): UsageTotals | null {
  let stat: Stats;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cache = getTranscriptUsageCache();
  const cached = cache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.totals;
  }
  // A file that shrank below what was already counted was replaced rather than
  // appended to, so it is re-read from the start — the alternative is a total
  // that keeps a vanished turn's tokens forever.
  const resume = cached && stat.size >= cached.offset ? cached : null;
  const from = resume ? resume.offset : 0;
  // No size cap here on purpose: accounting reads a sliding window, so a
  // transcript larger than the dialog can display still contributes its tokens.
  const scan = scanTranscriptRange(filePath, from, stat.size);
  const totals = resume ? addUsageTotals(resume.totals, scan.totals) : scan.totals;
  cache.delete(filePath);
  cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, offset: from + scan.consumed, totals });
  while (cache.size > MAX_USAGE_SCAN_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return totals;
}

/**
 * Sum the usage every subagent transcript in a parent session's sibling
 * artifacts dir recorded — the only place those tokens exist, and the half of
 * an orchestrated session's account that the session walk skips.
 *
 * Deliberately NOT sourced from the parent's `task` toolResult rollups: those
 * are display values for these very events, so adding them double-counts.
 */
export function sumSubagentTranscriptUsage(sessionFilePath: string): SubagentTranscriptUsage {
  let combined = emptyUsageTotals();
  let transcripts = 0;
  const pending: Array<{ dir: string; depth: number }> = [{ dir: siblingDirForSession(sessionFilePath), depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    let dirents: Dirent[];
    try {
      dirents = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      // Neither isDirectory() nor isFile() is true for a symlink, so a link
      // planted in the artifacts dir cannot pull a file from outside it into
      // the session's accounting.
      if (dirent.isDirectory()) {
        if (next.depth < MAX_SUBAGENT_USAGE_DEPTH) pending.push({ dir: join(next.dir, dirent.name), depth: next.depth + 1 });
        continue;
      }
      if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) continue;
      const totals = transcriptUsage(join(next.dir, dirent.name));
      if (!totals) continue;
      transcripts += 1;
      combined = addUsageTotals(combined, totals);
    }
  }
  return { ...combined, transcripts };
}

/** Cap on completion bytes materialized for the dialog (final outputs are small). */
export const MAX_SUBAGENT_COMPLETION_BYTES = 1024 * 1024;

/**
 * Read a subagent's final output — the `<id>.md` sibling artifact omp writes
 * when the task settles. Returns null when no output file exists yet (still
 * running, aborted before producing output, or the session predates it).
 * Output files can exceed the transcript cap, so the read is bounded.
 */
/**
 * Read a subagent's final output artifact (`<id>.md`) from an ALREADY-RESOLVED
 * path (the route confines via resolveSubagentArtifact first — reading the raw
 * derived path here would reopen a symlink swapped after the check). Reads at
 * most MAX_SUBAGENT_COMPLETION_BYTES bytes, trimming a trailing incomplete
 * UTF-8 sequence before decoding.
 */
export function readCompletionArtifact(
  outputFile: string,
): { completion: string; truncated: boolean } | null {
  let size: number;
  try {
    size = statSync(outputFile).size;
  } catch {
    return null;
  }
  if (size <= 0) return null;
  const truncated = size > MAX_SUBAGENT_COMPLETION_BYTES;
  const readBytes = Math.min(size, MAX_SUBAGENT_COMPLETION_BYTES);
  const fd = openSync(outputFile, "r");
  try {
    const buffer = Buffer.alloc(readBytes);
    const bytesRead = readSync(fd, buffer, 0, readBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    // Trim a trailing INCOMPLETE UTF-8 sequence before decoding. A complete
    // multibyte char may also end in continuation bytes, so walk back over the
    // trailing continuations to the lead and keep the char only when its full
    // width fits inside the buffer.
    let end = slice.length;
    let trailing = 0;
    while (end - trailing > 0 && (slice[end - 1 - trailing] & 0xc0) === 0x80) trailing += 1;
    const leadPos = end - 1 - trailing;
    if (leadPos >= 0) {
      const lead = slice[leadPos];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (leadPos + need > slice.length) end = leadPos;
    } else {
      // Continuation bytes with no lead at the tail — garbage.
      end = 0;
    }
    return { completion: slice.subarray(0, end).toString("utf8"), truncated };
  } finally {
    closeSync(fd);
  }
}
