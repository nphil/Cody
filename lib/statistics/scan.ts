/**
 * Reads usage out of omp transcript lines.
 *
 * Three line types carry usage, and a survey of every transcript on a real
 * install found no others:
 *  - an assistant `message`: one model call, with its tokens and cost;
 *  - `model_usage`: omp's own helper calls (memory extraction, auto-thinking
 *    and unexpected-stop judges), which are NOT assistant messages;
 *  - a `compaction` made by OpenAI's remote compactor, which records tokens but
 *    no cost (the Anthropic one records nothing).
 *
 * Transcripts are big (a single chat can pass 20 MB) and mostly text that is not
 * usage, so a line is sniffed by its leading `{"type":"..."` and only parsed when
 * it can contribute. The caller hands in a window of bytes and gets back how
 * many it fully consumed; a line without its newline yet is left for next time.
 */

import { asCount, asNumber, asString, isRecord } from "../type-guards";
import {
  WORKER_ADVISOR,
  WORKER_BACKGROUND,
  WORKER_COMPACTION,
  WORKER_ENGINE_PREFIX,
  WORKER_MAIN,
  WORKER_SIDEBAR,
  WORKER_SUBAGENT,
  WORKER_SUBAGENT_PREFIX,
  type FileEntry,
  type SourceKind,
} from "./types";

/** One call's counters and the cost omp recorded for each. */
export interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  /** 0 when omp recorded no price for the call. */
  costTotal: number;
}

/** One model call, ready to be filed under a day/provider/model/worker row. */
export interface UsageRecord {
  /** When the call finished (ms). */
  ts: number;
  /** Transcript entry id; '' for jobs that have none. */
  id: string;
  provider: string;
  model: string;
  worker: string;
  usage: RawUsage;
  /** A real assistant message, so eligible for the expensive-turn list. */
  turn: boolean;
  /** The line holds tokens only, so a cost may be worked out from the model's learnt price. */
  estimate: boolean;
}

/** Where a day's usage came from when a line does not say: not a provider omp could name. */
export const UNKNOWN_LABEL = "unknown";

/** `"role":"assistant"` is the first key of a message; this much of the line is searched for it. */
const ROLE_WINDOW_BYTES = 900;
const TYPE_PREFIX = Buffer.from('{"type":"');
const ASSISTANT_NEEDLE = Buffer.from('"role":"assistant"');
const REMOTE_COMPACTION_NEEDLE = Buffer.from("openaiRemoteCompaction");

/** Reads a transcript `usage` object. Null when `value` is not one. */
export function readUsage(value: unknown): RawUsage | null {
  if (!isRecord(value)) return null;
  const cost = isRecord(value.cost) ? value.cost : {};
  const usage: RawUsage = {
    input: asCount(value.input),
    output: asCount(value.output),
    cacheRead: asCount(value.cacheRead),
    cacheWrite: asCount(value.cacheWrite),
    costInput: asCount(cost.input),
    costOutput: asCount(cost.output),
    costCacheRead: asCount(cost.cacheRead),
    costCacheWrite: asCount(cost.cacheWrite),
    costTotal: asCount(cost.total),
  };
  if (usage.costTotal <= 0) usage.costTotal = usage.costInput + usage.costOutput + usage.costCacheRead + usage.costCacheWrite;
  return usage;
}

export function usageTokens(usage: RawUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** What each kind of transcript file does. A subagent's type is added on top. */
const FILE_WORKERS: Record<SourceKind, string> = {
  main: WORKER_MAIN,
  sidebar: WORKER_SIDEBAR,
  advisor: WORKER_ADVISOR,
  subagent: WORKER_SUBAGENT,
  oneshot: WORKER_BACKGROUND,
};

/** The worker a call belongs to, decided by where its transcript sits. */
export function workerForFile(file: Pick<FileEntry, "kind" | "agent">): string {
  return file.kind === "subagent" && file.agent ? `${WORKER_SUBAGENT_PREFIX}${file.agent}` : FILE_WORKERS[file.kind];
}

function lineType(buf: Buffer, start: number, end: number): string {
  const from = start + TYPE_PREFIX.length;
  if (end - from < 2 || buf.compare(TYPE_PREFIX, 0, TYPE_PREFIX.length, start, from) !== 0) return "";
  const stop = buf.indexOf(0x22, from);
  if (stop === -1 || stop >= end || stop - from > 24) return "";
  return buf.toString("latin1", from, stop);
}

function parseLine(buf: Buffer, start: number, end: number): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8", start, end));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function entryTime(entry: Record<string, unknown>, message?: Record<string, unknown>): number {
  const iso = Date.parse(asString(entry.timestamp) ?? "");
  if (!Number.isNaN(iso)) return iso;
  return asNumber(message?.timestamp) ?? asNumber(entry.timestamp) ?? 0;
}

/**
 * A fork or branch starts with a copy of its parent's history, and that history
 * is already counted from the parent's own transcript. Only entries written
 * after the fork's header belong to the fork.
 */
function isCopiedHistory(file: FileEntry, ts: number): boolean {
  return file.forked && ts < file.headerTs;
}

function scanMessage(buf: Buffer, start: number, end: number, file: FileEntry, emit: (record: UsageRecord) => void): void {
  const head = buf.subarray(start, Math.min(end, start + ROLE_WINDOW_BYTES));
  if (!head.includes(ASSISTANT_NEEDLE)) return;
  const entry = parseLine(buf, start, end);
  const message = entry && isRecord(entry.message) ? entry.message : null;
  if (!entry || !message || message.role !== "assistant") return;
  const usage = readUsage(message.usage);
  if (!usage) return;
  const provider = asString(message.provider) || UNKNOWN_LABEL;
  const model = asString(message.model) || UNKNOWN_LABEL;
  // Remembered even for copied history: a compaction later in this file belongs
  // to the model that was answering when it ran.
  file.lastModel[provider] = model;
  const ts = entryTime(entry, message);
  if (ts <= 0 || isCopiedHistory(file, ts) || usageTokens(usage) + usage.costTotal === 0) return;
  emit({ ts, id: asString(entry.id) ?? "", provider, model, worker: workerForFile(file), usage, turn: true, estimate: false });
}

function scanModelUsage(buf: Buffer, start: number, end: number, file: FileEntry, emit: (record: UsageRecord) => void): void {
  const entry = parseLine(buf, start, end);
  if (!entry) return;
  const usage = readUsage(entry.usage);
  const ts = entryTime(entry);
  if (!usage || ts <= 0 || isCopiedHistory(file, ts) || usageTokens(usage) + usage.costTotal === 0) return;
  // "memory:extract" and "memory" are one job; the tail is detail, not a kind of work.
  const purpose = (asString(entry.purpose) ?? "").split(":")[0] || UNKNOWN_LABEL;
  emit({
    ts,
    id: asString(entry.id) ?? "",
    provider: asString(entry.provider) || UNKNOWN_LABEL,
    model: asString(entry.model) || UNKNOWN_LABEL,
    worker: `${WORKER_ENGINE_PREFIX}${purpose}`,
    usage,
    turn: false,
    estimate: false,
  });
}

function scanCompaction(buf: Buffer, start: number, end: number, file: FileEntry, emit: (record: UsageRecord) => void): void {
  if (!buf.subarray(start, end).includes(REMOTE_COMPACTION_NEEDLE)) return;
  const entry = parseLine(buf, start, end);
  const preserve = entry && isRecord(entry.preserveData) ? entry.preserveData : null;
  const remote = preserve && isRecord(preserve.openaiRemoteCompaction) ? preserve.openaiRemoteCompaction : null;
  const raw = remote && isRecord(remote.usage) ? remote.usage : null;
  if (!entry || !remote || !raw) return;
  const ts = entryTime(entry);
  if (ts <= 0 || isCopiedHistory(file, ts)) return;
  // OpenAI counts cached tokens inside inputTokens; here they are a counter of their own.
  const cached = Math.min(asCount(raw.cachedInputTokens), asCount(raw.inputTokens));
  const usage: RawUsage = {
    input: asCount(raw.inputTokens) - cached,
    output: asCount(raw.outputTokens),
    cacheRead: cached,
    cacheWrite: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };
  if (usageTokens(usage) === 0) return;
  const provider = asString(remote.provider) || UNKNOWN_LABEL;
  emit({
    ts,
    id: asString(entry.id) ?? "",
    provider,
    model: file.lastModel[provider] ?? UNKNOWN_LABEL,
    worker: WORKER_COMPACTION,
    usage,
    turn: false,
    estimate: true,
  });
}

function scanHeader(buf: Buffer, start: number, end: number, file: FileEntry): void {
  const entry = parseLine(buf, start, end);
  if (!entry) return;
  const ts = Date.parse(asString(entry.timestamp) ?? "");
  if (!Number.isNaN(ts)) file.headerTs = ts;
  const cwd = asString(entry.cwd);
  if (cwd) file.cwd = cwd;
  file.forked = Boolean(asString(entry.parentSession));
  // A chat is named by its own header. A subagent or advisor header names a
  // session of its own, which is not the chat it works for.
  const id = asString(entry.id);
  if (id && (file.kind === "main" || file.kind === "sidebar")) file.chat = id;
}

/**
 * `model_change` names the model that will answer next as `provider/model`. A
 * compaction can run before that model has sent a message of its own, and
 * would otherwise be filed under an unknown model. Only the default role
 * counts: other roles name models that never answer in this transcript.
 */
function scanModelChange(buf: Buffer, start: number, end: number, file: FileEntry): void {
  const entry = parseLine(buf, start, end);
  const role = entry ? asString(entry.role) : undefined;
  const model = entry ? asString(entry.model) : undefined;
  if (!model || (role && role !== "default")) return;
  const cut = model.indexOf("/");
  if (cut > 0 && cut < model.length - 1) file.lastModel[model.slice(0, cut)] = model.slice(cut + 1);
}

function scanSessionInit(buf: Buffer, start: number, end: number, file: FileEntry): void {
  const entry = parseLine(buf, start, end);
  const agent = entry ? asString(entry.agent) : undefined;
  if (agent) file.agent = agent;
}

/**
 * Folds every complete line of `buf` into `file` (header facts) and `emit`
 * (usage). Returns the bytes consumed: up to and including the last newline, so
 * a half-written final line is read again next pass.
 */
export function scanChunk(buf: Buffer, file: FileEntry, emit: (record: UsageRecord) => void): number {
  let pos = 0;
  while (pos < buf.length) {
    const newline = buf.indexOf(0x0a, pos);
    if (newline === -1) break;
    if (newline - pos > TYPE_PREFIX.length + 2) {
      switch (lineType(buf, pos, newline)) {
        case "message":
          scanMessage(buf, pos, newline, file, emit);
          break;
        case "model_usage":
          scanModelUsage(buf, pos, newline, file, emit);
          break;
        case "compaction":
          scanCompaction(buf, pos, newline, file, emit);
          break;
        case "model_change":
          scanModelChange(buf, pos, newline, file);
          break;
        case "session":
          scanHeader(buf, pos, newline, file);
          break;
        case "session_init":
          scanSessionInit(buf, pos, newline, file);
          break;
      }
    }
    pos = newline + 1;
  }
  return pos;
}
