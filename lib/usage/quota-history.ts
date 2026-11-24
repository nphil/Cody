import fs from "node:fs";
import path from "node:path";

import { getAgentDir } from "../omp/paths";
import { READING_OUTDATED_AFTER_MS } from "./reading-age";
import type { UsageSnapshot } from "./types";

/**
 * A small, bounded history of how far each account's quota windows have been
 * used, kept in Cody's own data dir so the tokens one percent of a window costs
 * can be worked out later (`calibrateQuota`, quota-calibration.ts). No screen
 * reads it: it exists so the numbers are there when someone asks.
 *
 * One JSON line per change, per account window:
 *   `{t, p, a, c, w, u, r}` = measured-at (epoch ms), provider, account id,
 *   omp credential row id (or null), window id, percent used, reset time
 *   (epoch ms, or null).
 *
 * What gets written: only a FRESH reading (omp measured it within
 * `READING_OUTDATED_AFTER_MS`, which `measuredAt` says; a carried-over or
 * out-of-date account is never recorded) that is NEWER than the last one kept
 * for that window AND differs from it (a different percentage, or a reset time
 * more than a minute apart). omp re-serves its last saved report for a login
 * whose live fetch failed, so an unchanged reading must not become a new line.
 *
 * Bounds (housekeeping prunes hourly, `pruneQuotaHistory`): nothing older than
 * 90 days, and at most `QUOTA_HISTORY_MAX_BYTES` (newest lines kept). Between
 * prunes appending stops at twice that size, so a busy hour cannot grow it
 * without bound either.
 *
 * State lives on `globalThis` because Next.js reloads modules in dev: a
 * per-module map would forget what was already written and append duplicates.
 */

export interface QuotaPoint {
  /** When omp measured it, epoch ms. */
  t: number;
  /** Provider id ("anthropic"). */
  p: string;
  /** Account id within the provider (`UsageAccount.id`). */
  a: string;
  /** omp's credential row id, when known; what token rows are matched on. */
  c: number | null;
  /** Window id ("anthropic:5h", "anthropic:7d:opus"). */
  w: string;
  /** Percent of the window used, 0-100. */
  u: number;
  /** When the window resets, epoch ms, or null when none was reported. */
  r: number | null;
}

export const QUOTA_HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
export const QUOTA_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
/** A reset time that moves by less than this is the same reset, reported with rounding. */
const RESET_TOLERANCE_MS = 60_000;
/** A reading dated this far ahead of Cody's clock is not believed. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
/** How much of the file's end is read to learn what was written last, after a restart. */
const TAIL_BYTES = 256 * 1024;
const FILE_NAME = "cody-quota-history.jsonl";

declare global {
  var __codyQuotaHistoryLast: Map<string, Map<string, QuotaPoint>> | undefined;
}

export function quotaHistoryFile(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

function isPoint(value: unknown): value is QuotaPoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.t === "number" && Number.isFinite(point.t) &&
    typeof point.p === "string" && typeof point.a === "string" && typeof point.w === "string" &&
    typeof point.u === "number" && Number.isFinite(point.u) &&
    (point.c === null || typeof point.c === "number") &&
    (point.r === null || (typeof point.r === "number" && Number.isFinite(point.r)))
  );
}

/** The points in a history file's text, oldest first. A line that is not a point (a torn write, an older format) is skipped. */
export function parseQuotaHistory(text: string): QuotaPoint[] {
  const points: QuotaPoint[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPoint(parsed)) points.push(parsed);
    } catch {
      // A torn last line after a crash: nothing to recover from it.
    }
  }
  return points.sort((a, b) => a.t - b.t);
}

/** Everything the history holds (optionally from `sinceMs` on), oldest first; empty when there is no file. */
export function readQuotaHistory(options: { file?: string; sinceMs?: number } = {}): QuotaPoint[] {
  let text: string;
  try {
    text = fs.readFileSync(options.file ?? quotaHistoryFile(), "utf8");
  } catch {
    return [];
  }
  const points = parseQuotaHistory(text);
  return options.sinceMs === undefined ? points : points.filter((point) => point.t >= options.sinceMs!);
}

function windowKey(point: Pick<QuotaPoint, "p" | "a" | "w">): string {
  return `${point.p}\u0000${point.a}\u0000${point.w}`;
}

/** What was last written, per file, per window. Learned from the end of the file the first time it is needed. */
function lastWritten(file: string): Map<string, QuotaPoint> {
  const all = (globalThis.__codyQuotaHistoryLast ??= new Map());
  let last = all.get(file);
  if (last) return last;
  last = new Map();
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      for (const point of parseQuotaHistory(buffer.toString("utf8"))) last.set(windowKey(point), point);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No file yet: nothing was written.
  }
  all.set(file, last);
  return last;
}

function changed(previous: QuotaPoint | undefined, next: QuotaPoint): boolean {
  if (!previous) return true;
  if (next.t <= previous.t) return false;
  if (next.u !== previous.u) return true;
  if ((next.r === null) !== (previous.r === null)) return true;
  return next.r !== null && previous.r !== null && Math.abs(next.r - previous.r) > RESET_TOLERANCE_MS;
}

/** The fresh, changed readings of `snapshot` as points, in snapshot order. Pure apart from reading what was last written. */
function freshPoints(snapshot: UsageSnapshot, readAt: number, last: Map<string, QuotaPoint>): QuotaPoint[] {
  const out: QuotaPoint[] = [];
  if (!snapshot.available) return out;
  for (const account of snapshot.accounts ?? []) {
    if (account.disabled || account.outdated || account.windowsStaleSince || account.unlimited) continue;
    const measured = typeof account.measuredAt === "string" ? Date.parse(account.measuredAt) : readAt;
    if (!Number.isFinite(measured) || readAt - measured > READING_OUTDATED_AFTER_MS || measured - readAt > FUTURE_TOLERANCE_MS) continue;
    for (const window of account.windows ?? []) {
      // A "block" window is omp refusing a credential, not a measurement.
      if (window.source === "block" || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      const point: QuotaPoint = {
        t: measured,
        p: account.provider,
        a: account.id,
        c: account.credentialId ?? null,
        w: window.id,
        u: Math.round(Math.min(100, Math.max(0, window.utilization)) * 100) / 100,
        r: Number.isFinite(reset) ? reset : null,
      };
      // Two windows of one account never share an id, but a duplicate within one reading must not be written twice.
      const key = windowKey(point);
      if (!changed(last.get(key), point)) continue;
      last.set(key, point);
      out.push(point);
    }
  }
  return out;
}

/**
 * Append what is new in `snapshot` (the engine's reading, taken at `readAt`).
 * Returns how many lines were written. Never throws: a history that cannot be
 * written must not break the usage read that feeds the composer.
 */
export function recordQuotaReadings(snapshot: UsageSnapshot, readAt: number = Date.now(), file: string = quotaHistoryFile()): number {
  try {
    const last = lastWritten(file);
    const before = new Map(last);
    const points = freshPoints(snapshot, readAt, last);
    if (points.length === 0) return 0;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        // First write.
      }
      if (size > QUOTA_HISTORY_MAX_BYTES * 2) throw new Error("quota history is over its size limit until the next prune");
      fs.appendFileSync(file, `${points.map((point) => JSON.stringify(point)).join("\n")}\n`);
    } catch (error) {
      // Not written, so not remembered as written: the next reading tries again.
      last.clear();
      for (const [key, point] of before) last.set(key, point);
      throw error;
    }
    return points.length;
  } catch {
    return 0;
  }
}

export interface QuotaPruneResult {
  kept: number;
  dropped: number;
}

/**
 * Keep the history inside its bounds: drop points older than `maxAgeMs`, then
 * the oldest ones until the file fits `maxBytes`. Rewrites the file only when
 * something goes (temp file + rename, so a crash never leaves half a history).
 */
export function pruneQuotaHistory(
  now: number = Date.now(),
  options: { file?: string; maxAgeMs?: number; maxBytes?: number } = {},
): QuotaPruneResult {
  const file = options.file ?? quotaHistoryFile();
  const maxAgeMs = options.maxAgeMs ?? QUOTA_HISTORY_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? QUOTA_HISTORY_MAX_BYTES;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kept: 0, dropped: 0 };
  }
  const lines = text.split("\n").filter(Boolean);
  const cutoff = now - maxAgeMs;
  let kept = parseQuotaHistory(text).filter((point) => point.t >= cutoff);
  const lineOf = (point: QuotaPoint) => JSON.stringify(point);
  let bytes = kept.reduce((sum, point) => sum + Buffer.byteLength(lineOf(point)) + 1, 0);
  let from = 0;
  while (bytes > maxBytes && from < kept.length) {
    bytes -= Buffer.byteLength(lineOf(kept[from])) + 1;
    from += 1;
  }
  kept = kept.slice(from);
  const dropped = lines.length - kept.length;
  if (dropped === 0 && text.endsWith("\n")) return { kept: kept.length, dropped: 0 };
  try {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, kept.length > 0 ? `${kept.map(lineOf).join("\n")}\n` : "");
    fs.renameSync(temp, file);
  } catch {
    return { kept: lines.length, dropped: 0 };
  }
  // What was last written may have been pruned away; learn it again from the file.
  globalThis.__codyQuotaHistoryLast?.delete(file);
  return { kept: kept.length, dropped };
}
