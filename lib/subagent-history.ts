// On-disk subagent history + transcript reading for Cody.
//
// omp writes each subagent's session transcript to the PARENT session's
// sibling artifacts directory: `<session-dir>/<subagent-id>.jsonl` (plus
// `<id>.md` outputs and `<id>.<tool>.log` artifact spills). The parent's task
// toolResult `details` persist `progress: AgentProgress[]` and
// `results: SingleResult[]` snapshots, so the roster can be recovered after a
// page reload without the live RPC registry (get_subagent_messages is
// registry-gated and rejects unknown session files).

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs";
import type { Dirent, Stats } from "fs";
import { basename, dirname, join } from "path";
import { getSessionEntries, entryToUiMessage } from "./session-reader";
import { parseJsonlLenient } from "./omp/session-files";
import { parseSubagentProgress } from "./subagent-types";
import type { SubagentHistoryEntry, SubagentHistoryResult, SubagentAgentSource, SubagentTranscriptPage } from "./subagent-types";
import type { AgentMessage, SessionEntry } from "./types";
import { asNumber, asString, isRecord } from "./type-guards";
import { taskResultStructuredOutput, taskResultUsageCost } from "./task-result-details";
import { addUsageTotals, aggregateMessageUsage, emptyUsageTotals, type UsageTotals } from "./session-usage";

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

function asAgentSource(value: unknown): SubagentAgentSource | undefined {
  return value === "bundled" || value === "user" || value === "project" ? value : undefined;
}

function progressStatusToRoster(status: string | undefined): SubagentHistoryEntry["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "started";
}

function resultStatus(value: Record<string, unknown>): SubagentHistoryEntry["status"] {
  if (value.aborted === true) return "aborted";
  if (typeof value.error === "string" && value.error) return "failed";
  if (typeof value.exitCode === "number") return value.exitCode === 0 ? "completed" : "failed";
  return "started";
}

/**
 * Recover the subagent roster from a parent session file. Walks task
 * toolResults, merging `progress` (live-snapshot fields) with `results`
 * (settled per-subagent telemetry), then resolves sibling transcript files.
 */
export function extractSubagentHistory(sessionFilePath: string): SubagentHistoryEntry[] {
  let entries: SessionEntry[];
  try {
    entries = getSessionEntries(sessionFilePath);
  } catch {
    return [];
  }

  const byId = new Map<string, SubagentHistoryEntry>();
  const upsert = (entry: SubagentHistoryEntry) => {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      return;
    }
    byId.set(entry.id, { ...existing, ...entry, result: entry.result ?? existing.result });
  };

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const message = entry.message as { toolName?: unknown; details?: unknown };
    if (message.toolName !== "task") continue;
    const details = isRecord(message.details) ? message.details : {};
    const progressArr = Array.isArray(details.progress) ? details.progress : [];
    const resultsArr = Array.isArray(details.results) ? details.results : [];
    const asyncInfo = isRecord(details.async) ? details.async : undefined;

    for (const raw of progressArr) {
      const progress = parseSubagentProgress(raw);
      if (!progress?.id) continue;
      upsert({
        id: progress.id,
        agent: progress.agent ?? "subagent",
        agentSource: progress.agentSource,
        status: progressStatusToRoster(progress.status),
        task: progress.task,
        assignment: progress.assignment,
        description: progress.description,
        index: progress.index ?? 0,
        lastIntent: progress.lastIntent,
        toolCount: progress.toolCount,
        requests: progress.requests,
        tokens: progress.tokens,
        contextTokens: progress.contextTokens,
        contextWindow: progress.contextWindow,
        cost: progress.cost,
        durationMs: progress.durationMs,
        modelOverride: progress.modelOverride,
        modelRole: progress.modelRole,
        resolvedModel: progress.resolvedModel,
        resolvedModelIsFallback: progress.resolvedModelIsFallback,
        retryFailure: progress.retryFailure,
        transcriptAvailable: false,
      });
    }

    for (const raw of resultsArr) {
      if (!isRecord(raw)) continue;
      const id = asString(raw.id);
      if (!id) continue;
      const prior = byId.get(id);
      const result: SubagentHistoryResult = {};
      const exitCode = asNumber(raw.exitCode);
      if (exitCode !== undefined) result.exitCode = exitCode;
      // NOTE: `output`/`stderr` are deliberately NOT copied — the roster route
      // must stay telemetry-only (task outputs can be ~500KB per agent).
      if (raw.truncated === true) result.truncated = true;
      const cost = asNumber(raw.cost) ?? taskResultUsageCost(raw.usage);
      if (cost !== undefined) result.cost = cost;
      const structured = taskResultStructuredOutput(raw.structuredOutput);
      if (structured !== undefined) result.structuredOutput = structured;
      const error = asString(raw.error);
      if (error !== undefined) result.error = error;
      if (raw.aborted === true) result.aborted = true;
      const abortReason = asString(raw.abortReason);
      if (abortReason !== undefined) result.abortReason = abortReason;
      const outputPath = asString(raw.outputPath);
      if (outputPath !== undefined) result.outputPath = outputPath;
      const patchPath = asString(raw.patchPath);
      if (patchPath !== undefined) result.patchPath = patchPath;
      const branchName = asString(raw.branchName);
      if (branchName !== undefined) result.branchName = branchName;
      const retryFailure = isRecord(raw.retryFailure)
        ? {
            attempt: asNumber(raw.retryFailure.attempt) ?? 0,
            errorMessage: asString(raw.retryFailure.errorMessage) ?? "",
          }
        : prior?.retryFailure;
      upsert({
        id,
        agent: asString(raw.agent) ?? prior?.agent ?? "subagent",
        agentSource: asAgentSource(raw.agentSource) ?? prior?.agentSource,
        status: resultStatus(raw),
        task: asString(raw.task) ?? prior?.task,
        assignment: asString(raw.assignment) ?? prior?.assignment,
        description: asString(raw.description) ?? prior?.description,
        index: asNumber(raw.index) ?? prior?.index ?? 0,
        lastIntent: asString(raw.lastIntent) ?? prior?.lastIntent,
        toolCount: asNumber(raw.toolCount) ?? prior?.toolCount,
        requests: asNumber(raw.requests) ?? prior?.requests,
        tokens: asNumber(raw.tokens) ?? prior?.tokens,
        contextTokens: asNumber(raw.contextTokens) ?? prior?.contextTokens,
        contextWindow: asNumber(raw.contextWindow) ?? prior?.contextWindow,
        cost: asNumber(raw.cost) ?? taskResultUsageCost(raw.usage) ?? prior?.cost,
        durationMs: asNumber(raw.durationMs) ?? prior?.durationMs,
        modelOverride: typeof raw.modelOverride === "string" || Array.isArray(raw.modelOverride) ? raw.modelOverride : prior?.modelOverride,
        modelRole: asString(raw.modelRole) ?? prior?.modelRole,
        resolvedModel: asString(raw.resolvedModel) ?? prior?.resolvedModel,
        resolvedModelIsFallback: typeof raw.resolvedModelIsFallback === "boolean" ? raw.resolvedModelIsFallback : prior?.resolvedModelIsFallback,
        retryFailure,
        transcriptAvailable: false,
        result: Object.keys(result).length > 0 ? result : undefined,
      });
    }

    // Detached async spawns can persist with an empty results[] while still
    // running — async.jobId still names the agent.
    if (asyncInfo) {
      const jobId = asString(asyncInfo.jobId);
      if (jobId && !byId.has(jobId)) {
        upsert({
          id: jobId,
          agent: "task",
          status: asyncInfo.state === "completed" ? "completed" : asyncInfo.state === "failed" ? "failed" : "started",
          index: byId.size,
          transcriptAvailable: false,
        });
      }
    }
  }

  // Resolve sibling transcript files and async/detached markers.
  const dir = siblingDirForSession(sessionFilePath);
  const detachedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const message = entry.message as { toolName?: unknown; details?: unknown };
    if (message.toolName !== "task") continue;
    const details = isRecord(message.details) ? message.details : {};
    const asyncInfo = isRecord(details.async) ? details.async : undefined;
    const jobId = asyncInfo ? asString(asyncInfo.jobId) : undefined;
    if (jobId) detachedIds.add(jobId);
  }
  const roster = [...byId.values()];
  for (const entry of roster) {
    if (detachedIds.has(entry.id)) entry.detached = true;
    const candidate = join(dir, `${entry.id}.jsonl`);
    const available = existsSync(candidate);
    if (available) {
      entry.sessionFile = candidate;
      entry.transcriptAvailable = true;
    }
  }
  // File-walk order IS chronological: task toolResults land in the parent
  // session in completion order, and within one call progress[] is already
  // index-ordered. Sorting by `index` here would interleave turns (the index
  // restarts at 0 for every task call), scrambling "most recent" downstream.
  return roster;
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

function lineToMessage(line: TranscriptLine): AgentMessage | null {
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
    const message = entryToUiMessage(entry as unknown as SessionEntry, {});
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
 * A trailing line without its `\n` is still being written and is never
 * returned. Never throws: an unreadable file yields an empty page.
 */
export function readSubagentTranscriptPage(
  sessionFilePath: string,
  fromByte = 0,
  options: { tail?: boolean; before?: boolean } = {},
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
      const message = lineToMessage(line);
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
      totals = addUsageTotals(totals, aggregateMessageUsage(messages));
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
