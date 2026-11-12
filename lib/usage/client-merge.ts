import { LAST_GOOD_MAX_AGE_MS } from "./last-good";
import type { UsageSnapshot } from "./types";

/**
 * What the browser keeps when a poll of /api/usage comes back.
 *
 * The server already keeps its last good reading through a failed read (see
 * cache.ts), but the browser has its own gap: a poll that lands while the
 * server has nothing to give (a restarting server, a first read that failed)
 * answers `available: false`, and replacing the numbers on screen with that
 * turns a good reading into "no data". So a good reading on screen is only
 * ever replaced by a newer good reading; a failed one marks it `stale`, and
 * says when the attempt failed, instead of erasing it.
 */
export function mergeUsageRead(
  previous: UsageSnapshot | null | undefined,
  next: UsageSnapshot | null | undefined,
  now: number = Date.now(),
): UsageSnapshot | null {
  if (!next) return previous ?? null;
  if (next.available) return next;
  if (!previous?.available) return next;
  const readAt = Date.parse(previous.fetchedAt);
  // A reading too old to describe the present is not worth keeping on screen.
  if (Number.isFinite(readAt) && now - readAt > LAST_GOOD_MAX_AGE_MS) return next;
  return {
    ...previous,
    stale: true,
    refreshFailed: previous.refreshFailed ?? { at: new Date(now).toISOString(), reason: next.reason?.trim() || "the usage read failed" },
  };
}
