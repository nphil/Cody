import type { UsageAccount, UsageSnapshot } from "./types";

/**
 * How old a quota reading is, and when it stops being the present.
 *
 * `omp usage --json` prints the report it has for each login, and omp keeps
 * re-serving the LAST report it saved for a login whose live fetch fails —
 * Claude's usage endpoint answers bursts with HTTP 429, and a damaged
 * `agent.db` can leave a login's saved report frozen for days. Each report
 * carries its own `fetchedAt`, and that — not the moment Cody asked omp — is
 * the age of the numbers. Everything here works from that per-account time.
 *
 * Pure and clock-free (`now` is always passed in), so the server cache, the
 * browser's merge and the tests all apply the same rule.
 */

/** How long a reading may stand as "current". Past this it is shown as out of
 *  date, with its age. omp's own cache is 5 minutes and Cody reads it every
 *  60-90 s, so a healthy account is never near this; half an hour is several
 *  failed refreshes in a row, which is when the number stops being trustworthy. */
export const READING_OUTDATED_AFTER_MS = 30 * 60_000;

/** When omp measured this account's windows, in epoch ms, or null when it is
 *  unknown. `measuredAt` is the report's own time; `windowsStaleSince` is the
 *  fallback for a carried-over account that predates it. Unknown means "no
 *  claim": an account with no recorded time is never called out of date. */
export function readingTimeOf(account: Pick<UsageAccount, "measuredAt" | "windowsStaleSince">): number | null {
  for (const candidate of [account.measuredAt, account.windowsStaleSince]) {
    const at = typeof candidate === "string" ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** The newest measurement across every account that has one, or null when none
 *  does. A snapshot is as current as its freshest account. */
export function newestReadingTime(snapshot: Pick<UsageSnapshot, "accounts">): number | null {
  let newest: number | null = null;
  for (const account of snapshot.accounts ?? []) {
    if (!account || account.disabled) continue;
    const at = readingTimeOf(account);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** Whether this account's reading is too old to present as current. A disabled
 *  login carries no reading, an unlimited one has nothing to age, and an
 *  account with no recorded time makes no claim. */
export function isReadingOutdated(account: UsageAccount, now: number): boolean {
  if (account.disabled || account.unlimited) return false;
  const at = readingTimeOf(account);
  return at !== null && now - at > READING_OUTDATED_AFTER_MS;
}

/** The account with every window whose reset has passed removed: those meters
 *  started over, so the old percentage would claim usage that is gone. */
export function withoutElapsedWindows(account: UsageAccount, now: number): UsageAccount {
  const windows = (account.windows ?? []).filter((window) => {
    if (!window?.resetsAt) return true;
    const at = Date.parse(window.resetsAt);
    return !Number.isFinite(at) || at > now;
  });
  return windows.length === (account.windows ?? []).length ? account : { ...account, windows };
}

/**
 * The snapshot with every outdated account marked `outdated` and stripped of
 * the windows that have since reset. What remains on such an account is only
 * what was last known — a lower bound for a window still running — and the
 * account may end up with no window at all, which every reader treats as "no
 * current reading" (never as "unmetered", never as 0%).
 *
 * Returns the same object when nothing changes, so a caller can compare by
 * identity. Accounts without a recorded reading time are left alone.
 */
export function withOutdatedReadings(snapshot: UsageSnapshot, now: number): UsageSnapshot {
  if (!snapshot.available) return snapshot;
  let changed = false;
  const accounts = (snapshot.accounts ?? []).map((account) => {
    if (!account) return account;
    // An account already marked still loses windows that have reset since the
    // mark was made, so re-applying later never resurrects a spent meter.
    if (account.outdated !== true && !isReadingOutdated(account, now)) return account;
    const live = withoutElapsedWindows(account, now);
    if (live === account && account.outdated === true) return account;
    changed = true;
    return { ...live, outdated: true as const };
  });
  return changed ? { ...snapshot, accounts } : snapshot;
}
