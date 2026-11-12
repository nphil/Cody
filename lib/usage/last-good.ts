import type { UsageAccount, UsageSnapshot } from "./types";

/**
 * A usage read is a photograph, and the camera sometimes fails: `omp usage`
 * times out, the provider's own usage endpoint rate-limits one login, the
 * engine restarts mid-read. What the UI must NOT do then is replace a real
 * reading with "no data" (an empty gauge reads as 0% used), or quietly drop
 * the one account the read happened to skip.
 *
 * Two rules, both pure so the cache and the tests share them:
 *
 * 1. A FAILED read keeps serving the last good reading, marked `stale` with
 *    `refreshFailed` (see `reserveLastGood`) — for a few hours, after which
 *    the numbers say nothing about the present and "unavailable" is honest.
 * 2. A SUCCESSFUL read that does not mention an account the previous one had
 *    carries that account forward for a short while, its windows labelled
 *    with the reading they come from (see `carryForwardMissingAccounts`).
 */

/** How long a reading may stand in for failed refreshes. */
export const LAST_GOOD_MAX_AGE_MS = 6 * 60 * 60_000;

/** How long an account a newer read skipped is still shown from the older one. */
export const CARRY_FORWARD_MAX_AGE_MS = 30 * 60_000;

/** A real reading, and when the cache took it. */
export interface GoodReading {
  snapshot: UsageSnapshot;
  readAt: number;
}

/**
 * What to serve when the newest read FAILED (`failed` is the unavailable
 * snapshot the read produced): the last good reading, flagged stale, or the
 * failure itself when there is nothing recent enough to stand in.
 */
export function reserveLastGood(last: GoodReading | null | undefined, failed: UsageSnapshot, now: number): UsageSnapshot {
  if (!last || !last.snapshot.available || now - last.readAt > LAST_GOOD_MAX_AGE_MS) return failed;
  return {
    ...last.snapshot,
    stale: true,
    refreshFailed: { at: new Date(now).toISOString(), reason: failed.reason?.trim() || "the usage read failed" },
  };
}

function accountKey(account: UsageAccount): string {
  return `${account.provider}\u0000${account.id}`;
}

/** The account with every window whose reset has passed removed: those meters
 * started over, so the old percentage would claim usage that is gone. */
function withoutElapsedWindows(account: UsageAccount, now: number): UsageAccount {
  const windows = (account.windows ?? []).filter((window) => {
    if (!window?.resetsAt) return true;
    const at = Date.parse(window.resetsAt);
    return !Number.isFinite(at) || at > now;
  });
  return windows.length === (account.windows ?? []).length ? account : { ...account, windows };
}

/**
 * `fresh` (a successful read) plus every account the previous good reading had
 * that `fresh` did not report, for at most `CARRY_FORWARD_MAX_AGE_MS`. An
 * account that is in `fresh` — measured or listed as signed out — is always the
 * newest word on it, so a login that genuinely ended is never hidden.
 */
export function carryForwardMissingAccounts(
  previous: GoodReading | null | undefined,
  fresh: UsageSnapshot,
  now: number,
): UsageSnapshot {
  if (!fresh.available || !previous || !previous.snapshot.available) return fresh;
  const present = new Set(fresh.accounts.map(accountKey));
  const carried: UsageAccount[] = [];
  for (const account of previous.snapshot.accounts) {
    if (present.has(accountKey(account)) || account.disabled) continue;
    // Carried more than once keeps its ORIGINAL reading time, so an account
    // the engine keeps skipping ages out instead of being refreshed forever.
    const since = account.windowsStaleSince ? Date.parse(account.windowsStaleSince) : previous.readAt;
    const readAt = Number.isFinite(since) ? since : previous.readAt;
    if (now - readAt > CARRY_FORWARD_MAX_AGE_MS) continue;
    const live = withoutElapsedWindows(account, now);
    if ((live.windows ?? []).length === 0) continue;
    carried.push({ ...live, windowsStaleSince: new Date(readAt).toISOString() });
  }
  return carried.length === 0 ? fresh : { ...fresh, accounts: [...fresh.accounts, ...carried] };
}
