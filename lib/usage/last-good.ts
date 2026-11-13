import { READING_OUTDATED_AFTER_MS, newestReadingTime, readingTimeOf, withoutElapsedWindows } from "./reading-age";
import type { UsageAccount, UsageSnapshot } from "./types";

/**
 * A usage read is a photograph, and the camera sometimes fails: `omp usage`
 * times out, the provider's own usage endpoint rate-limits one login, the
 * engine restarts mid-read. What the UI must NOT do then is replace a real
 * reading with "no data" (an empty gauge reads as 0% used), or quietly drop
 * the one account the read happened to skip.
 *
 * Three rules, all pure so the cache and the tests share them:
 *
 * 1. A FAILED read keeps serving the last good reading, marked `stale` with
 *    `refreshFailed` (see `reserveLastGood`) — for a few hours, after which
 *    the numbers say nothing about the present and "unavailable" is honest.
 * 2. A SUCCESSFUL read that does not mention an account the previous one had
 *    carries that account forward for a short while, its windows labelled
 *    with the reading they come from (see `carryForwardMissingAccounts`).
 * 3. A login's numbers never go back in time: a read whose report for a
 *    login was measured BEFORE the one already held for it does not replace
 *    that one (see `carryForwardMissingAccounts`).
 *
 * Every bound counts the age of the MEASUREMENT (`UsageAccount.measuredAt`,
 * omp's own per-report time), never the moment Cody happened to read omp: omp
 * re-serves the report it last saved for a login whose live fetch keeps
 * failing, so a snapshot Cody read a minute ago can hold a reading from last
 * week — and Claude's usage endpoint answers bursts with HTTP 429, so the same
 * login can come back live in one read and from the saved report of days ago
 * in the next. Only when a reading carries no time of its own does Cody's read
 * time stand in. What is shown as CURRENT is a separate, shorter rule — see
 * reading-age.ts (`READING_OUTDATED_AFTER_MS`).
 */

/** How long a reading may stand in for failed refreshes, counted from the
 *  newest measurement in it. */
export const LAST_GOOD_MAX_AGE_MS = 6 * 60 * 60_000;

/** How long an account a newer read skipped is still shown from the older one:
 *  the same half hour after which any reading stops being presented as current. */
export const CARRY_FORWARD_MAX_AGE_MS = READING_OUTDATED_AFTER_MS;

/** A real reading, and when the cache took it. */
export interface GoodReading {
  snapshot: UsageSnapshot;
  readAt: number;
}

/**
 * What to serve when the newest read FAILED (`failed` is the unavailable
 * snapshot the read produced): the last good reading, flagged stale, or the
 * failure itself when there is nothing recent enough to stand in. "Recent
 * enough" counts from the newest measurement in the reading — else, for an
 * engine that prints none, from when Cody took it.
 */
export function reserveLastGood(last: GoodReading | null | undefined, failed: UsageSnapshot, now: number): UsageSnapshot {
  if (!last || !last.snapshot.available) return failed;
  if (now - (newestReadingTime(last.snapshot) ?? last.readAt) > LAST_GOOD_MAX_AGE_MS) return failed;
  return {
    ...last.snapshot,
    stale: true,
    refreshFailed: { at: new Date(now).toISOString(), reason: failed.reason?.trim() || "the usage read failed" },
  };
}

function accountKey(account: UsageAccount): string {
  return `${account.provider}\u0000${account.id}`;
}

/**
 * `account` with the report of `earlier` when that report was measured after
 * the one `account` carries; otherwise `account` itself. Only the facts that
 * belong to a report move (its windows, time, unmetered flag, idle gates and
 * saved-reset balance): the identity, the routing policy and when the login
 * last served a request stay what the newest read said. A login the newest
 * read lists as signed out or disabled is never replaced — that is a state,
 * not a measurement. Compares only the reports' own times: no time on either
 * side means no claim.
 */
function neverOlder(earlier: UsageAccount | undefined, account: UsageAccount): UsageAccount {
  if (!earlier || earlier.disabled || account.disabled) return account;
  const earlierAt = typeof earlier.measuredAt === "string" ? Date.parse(earlier.measuredAt) : Number.NaN;
  const accountAt = typeof account.measuredAt === "string" ? Date.parse(account.measuredAt) : Number.NaN;
  if (!Number.isFinite(earlierAt) || !Number.isFinite(accountAt) || earlierAt <= accountAt) return account;
  const merged: UsageAccount = { ...account, windows: earlier.windows ?? [], unlimited: earlier.unlimited, measuredAt: earlier.measuredAt };
  if (earlier.inactiveGates) merged.inactiveGates = earlier.inactiveGates;
  else delete merged.inactiveGates;
  if (earlier.resetCredits) merged.resetCredits = earlier.resetCredits;
  else delete merged.resetCredits;
  return merged;
}

/**
 * `fresh` (a successful read) plus every account the previous good reading had
 * that `fresh` did not report, for at most `CARRY_FORWARD_MAX_AGE_MS`. An
 * account that is in `fresh` — measured or listed as signed out — is always the
 * newest word on it, so a login that genuinely ended is never hidden; the one
 * exception is a report measured earlier than the one already held for that
 * login (`neverOlder`).
 */
export function carryForwardMissingAccounts(
  previous: GoodReading | null | undefined,
  fresh: UsageSnapshot,
  now: number,
): UsageSnapshot {
  if (!fresh.available || !previous || !previous.snapshot.available) return fresh;
  const earlier = new Map(previous.snapshot.accounts.map((account) => [accountKey(account), account]));
  let changed = false;
  const accounts = fresh.accounts.map((account) => {
    const kept = neverOlder(earlier.get(accountKey(account)), account);
    if (kept !== account) changed = true;
    return kept;
  });
  const present = new Set(fresh.accounts.map(accountKey));
  const carried: UsageAccount[] = [];
  for (const account of previous.snapshot.accounts) {
    if (present.has(accountKey(account)) || account.disabled) continue;
    // The reading's own time, which survives being carried more than once, so
    // an account the engine keeps skipping ages out instead of being refreshed
    // forever. A reading with no time of its own counts from when Cody took
    // the earlier read.
    const readAt = readingTimeOf(account) ?? previous.readAt;
    if (now - readAt > CARRY_FORWARD_MAX_AGE_MS) continue;
    const live = withoutElapsedWindows(account, now);
    if ((live.windows ?? []).length === 0) continue;
    carried.push({ ...live, windowsStaleSince: new Date(readAt).toISOString() });
  }
  if (!changed && carried.length === 0) return fresh;
  return { ...fresh, accounts: [...accounts, ...carried] };
}
