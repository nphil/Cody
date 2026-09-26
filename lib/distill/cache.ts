import { readFileSync } from "fs";
import path from "path";
import { getDistillCacheDir, writeJsonAtomic } from "./config";
import { isRecord } from "../type-guards";
import type { DistillKind, DistillVerbosity } from "./prompts";

/**
 * Summaries that are worth keeping, one file per session.
 *
 * A distill costs a model call, and a FINISHED entry never changes: the
 * summary of a reply the user scrolls past twice should be paid for once.
 * Only final summaries of an identified entry are stored — a live thinking
 * block is rewritten every few hundred milliseconds and caching it would be
 * caching noise.
 *
 * Cody state again (lib/distill/config.ts explains why): the engine's session
 * files are its own format and are rewritten by it, so nothing Cody derives
 * from them may live inside them.
 */

export interface DistillCacheEntry {
  text: string;
  model: string;
  /** Epoch ms; also the eviction order. */
  at: number;
}

/**
 * Enough for every entry of a long session at more than one verbosity, small
 * enough that the file stays a quick read on every request.
 */
export const MAX_CACHE_ENTRIES = 400;

/** Session ids come from the engine and end up in a file name. Anything that
 * is not a plain id is simply not cached — there is no safe way to spell a
 * path separator in one, and refusing beats sanitizing into a collision. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** The cache key, exactly as the API contract spells it. `plain` is its own
 * segment (not folded into `verbosity`) so a plain-language summary and a
 * technical one for the same block never collide — see
 * lib/distill-preferences.ts's `plainLanguage`. */
export function distillCacheKey(
  entryId: string,
  blockIndex: number | undefined,
  kind: DistillKind,
  verbosity: DistillVerbosity | undefined,
  plain: boolean,
): string {
  return `${entryId}:${blockIndex ?? "-"}:${kind}:${verbosity ?? "-"}:${plain ? "plain" : "-"}`;
}

function cachePath(sessionId: string): string | null {
  if (!SAFE_ID_RE.test(sessionId) || sessionId === "." || sessionId === "..") return null;
  return path.join(getDistillCacheDir(), `${sessionId}.json`);
}

function readAll(sessionId: string): Record<string, DistillCacheEntry> {
  const file = cachePath(sessionId);
  if (!file) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Missing, unreadable or corrupt all mean "nothing cached yet".
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.entries)) return {};
  const entries: Record<string, DistillCacheEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!isRecord(value)) continue;
    const { text, model, at } = value;
    if (typeof text !== "string" || typeof model !== "string" || typeof at !== "number") continue;
    entries[key] = { text, model, at };
  }
  return entries;
}

/** A previously stored summary, or null. */
export function readDistillCache(sessionId: string, key: string): DistillCacheEntry | null {
  return readAll(sessionId)[key] ?? null;
}

/** Store one summary, evicting the oldest once the session is at its cap. */
export function writeDistillCache(sessionId: string, key: string, entry: DistillCacheEntry): void {
  const file = cachePath(sessionId);
  if (!file) return;
  const entries = readAll(sessionId);
  entries[key] = entry;
  const keys = Object.keys(entries);
  if (keys.length > MAX_CACHE_ENTRIES) {
    // Oldest first, and the entry just written is the newest, so it survives.
    keys.sort((a, b) => entries[a].at - entries[b].at);
    for (const stale of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete entries[stale];
  }
  try {
    writeJsonAtomic(file, { version: 1, entries });
  } catch {
    // A cache that cannot be written is a slower feature, not a broken one.
  }
}
