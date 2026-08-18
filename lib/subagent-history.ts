// On-disk subagent history + transcript reading for Cody.
//
// omp writes each subagent's session transcript to the PARENT session's
// sibling artifacts directory: `<session-dir>/<subagent-id>.jsonl` (plus
// `<id>.md` outputs and `<id>.<tool>.log` artifact spills). The parent's task
// toolResult `details` persist `progress: AgentProgress[]` and
// `results: SingleResult[]` snapshots, so the roster can be recovered after a
// page reload without the live RPC registry (get_subagent_messages is
// registry-gated and rejects unknown session files).

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "fs";
import type { Dirent, Stats } from "fs";
import { basename, dirname, join } from "path";
import { getSessionEntries, entryToUiMessage } from "./session-reader";
import { parseJsonlLenient } from "./omp/session-files";
import { parseSubagentProgress } from "./subagent-types";
import type { SubagentHistoryEntry, SubagentHistoryResult, SubagentAgentSource } from "./subagent-types";
import type { AgentMessage, SessionEntry } from "./types";
import { asNumber, asString, isRecord } from "./type-guards";
import { taskResultStructuredOutput, taskResultUsageCost } from "./task-result-details";
import { addUsageTotals, aggregateMessageUsage, emptyUsageTotals, type UsageTotals } from "./session-usage";

/** Sibling artifacts directory for a parent session file. */
export function siblingDirForSession(sessionFilePath: string): string {
  return join(dirname(sessionFilePath), basename(sessionFilePath, ".jsonl"));
}

/** Subagent transcript path for a roster id within a parent session. */
export function subagentTranscriptPath(sessionFilePath: string, subagentId: string): string {
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
  return roster.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
}

/** Cap on transcript bytes materialized for the dialog (files are small). */
export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/** Bytes read per page call — the total cap above bounds the file, this
 * bounds the per-response window so large transcripts are delivered
 * incrementally instead of serialized whole. */
export const SUBAGENT_TRANSCRIPT_PAGE_BYTES = 256 * 1024;

export interface SubagentTranscriptPage {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: AgentMessage[];
  error?: string;
  /** Full file size — lets the dialog hide Load more once fully read. */
  totalBytes?: number;
}

/**
 * Byte-window transcript paging mirroring omp's readRpcSubagentTranscript:
 * parse complete lines from `fromByte`, return UI messages + nextByte.
 */
export function readSubagentTranscriptPage(sessionFilePath: string, fromByte = 0): SubagentTranscriptPage {
  const empty: SubagentTranscriptPage = {
    sessionFile: sessionFilePath,
    fromByte: typeof fromByte === "number" && Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0,
    nextByte: typeof fromByte === "number" && Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0,
    reset: false,
    messages: [],
  };
  let size: number;
  try {
    size = statSync(sessionFilePath).size;
  } catch {
    return empty;
  }
  let startByte = empty.fromByte;
  let reset = false;
  if (startByte > size) {
    startByte = 0;
    reset = true;
  }
  if (size > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
    return { ...empty, fromByte: startByte, nextByte: startByte, reset, error: "Subagent transcript exceeds the readable size limit" };
  }
  const endByte = Math.min(size, startByte + SUBAGENT_TRANSCRIPT_PAGE_BYTES);
  let body: string;
  try {
    // Slice the BYTE buffer, not the decoded string: `startByte` is a UTF-8
    // offset, while string indices are UTF-16 code units — slicing the string
    // misaligns every later page once non-ASCII text precedes the offset.
    body = readFileSync(sessionFilePath).subarray(startByte, endByte).toString("utf8");
  } catch {
    return { ...empty, fromByte: startByte, nextByte: startByte, reset };
  }
  const lastNewline = body.lastIndexOf("\n");
  const completeText = lastNewline >= 0 ? body.slice(0, lastNewline + 1) : "";
  const entries = completeText.length > 0 ? parseJsonlLenient<SessionEntry>(completeText) : [];
  const messages = entries
    .map((entry) => entryToUiMessage(entry, {}))
    .filter((message): message is AgentMessage => message !== null);
  let nextByte = startByte + Buffer.byteLength(completeText, "utf8");
  // Guarantee forward progress: when the window ends mid-line and more
  // content remains, the partial line has no newline to complete it — skip
  // it instead of returning the same offset forever.
  if (nextByte === startByte && endByte < size) nextByte = endByte;
  return { sessionFile: sessionFilePath, fromByte: startByte, nextByte, reset, messages, totalBytes: size };
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
