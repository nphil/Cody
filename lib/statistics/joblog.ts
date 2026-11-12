/**
 * The usage log of Cody's own background jobs (chat titles, Distill, the plan
 * keeper, the onboarding planner, web research).
 *
 * These run `omp -p --no-session`, so the engine keeps no transcript of them and
 * their tokens exist nowhere else. `lib/model-plan/one-shot.ts` hands each
 * finished assistant message to `recordOneShotUsage` (./oneshot), which appends a
 * line here; the indexer folds the lines into the same index the chat
 * transcripts feed. This file is only the format and the append.
 */

import fs from "node:fs";
import path from "node:path";
import { asNumber, asString, isRecord } from "../type-guards";
import { readUsage, UNKNOWN_LABEL, usageTokens, type RawUsage } from "./scan";

/** Which kind of background job made a call; this is what the page shows as the worker. */
export type OneShotPurpose = "title" | "distill" | "plan-keeper" | "planner" | "research";

export interface OneShotUsageTag {
  purpose: OneShotPurpose;
  /** The chat the job worked for, when it had one. Decides whose usage it is. */
  sessionId?: string;
}

export interface JobLogEntry {
  /** When the call finished (ms). */
  ts: number;
  purpose: string;
  /** '' for a job that belongs to no chat. */
  chat: string;
  provider: string;
  model: string;
  usage: RawUsage;
}

const LOG_PREFIX = "oneshot-";
const LOG_NAME_RE = /^oneshot-(\d{4})-(\d{2})\.jsonl$/;

/** `oneshot-2026-11.jsonl`: one log per UTC month, so old ones can be deleted whole. */
export function jobLogName(ts: number): string {
  return `${LOG_PREFIX}${new Date(ts).toISOString().slice(0, 7)}.jsonl`;
}

/** Whether `name` is a job log, and if so the first day of the month it holds. */
export function jobLogMonth(name: string): string | null {
  const match = LOG_NAME_RE.exec(name);
  return match ? `${match[1]}-${match[2]}-01` : null;
}

/** An assistant message from omp's json mode as a log entry, or null when it reported no usage. */
export function toJobLogEntry(tag: OneShotUsageTag, message: unknown, ts: number): JobLogEntry | null {
  if (!isRecord(message)) return null;
  const usage = readUsage(message.usage);
  if (!usage || usageTokens(usage) + usage.costTotal === 0) return null;
  return {
    ts,
    purpose: tag.purpose,
    chat: tag.sessionId ?? "",
    provider: asString(message.provider) || UNKNOWN_LABEL,
    model: asString(message.model) || UNKNOWN_LABEL,
    usage,
  };
}

/** One log line back into an entry; null for anything that is not one. */
export function parseJobLogLine(line: string): JobLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ts = asNumber(parsed.ts);
  const purpose = asString(parsed.purpose);
  const usage = readUsage(parsed.usage);
  if (!ts || ts <= 0 || !purpose || !usage) return null;
  return {
    ts,
    purpose,
    chat: asString(parsed.chat) ?? "",
    provider: asString(parsed.provider) || UNKNOWN_LABEL,
    model: asString(parsed.model) || UNKNOWN_LABEL,
    usage,
  };
}

/** Appends one entry to its month's log in `dir`. Throws on I/O failure; the caller decides what that means. */
export function appendJobLog(dir: string, entry: JobLogEntry): void {
  const { usage } = entry;
  const line = JSON.stringify({
    ts: entry.ts,
    purpose: entry.purpose,
    chat: entry.chat,
    provider: entry.provider,
    model: entry.model,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: { input: usage.costInput, output: usage.costOutput, cacheRead: usage.costCacheRead, cacheWrite: usage.costCacheWrite, total: usage.costTotal },
    },
  });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, jobLogName(entry.ts)), `${line}\n`, { mode: 0o600 });
}
