import type { UsageAccount, UsageWindow, UsageWindowState } from "./types";

/**
 * Picking the binding constraint.
 *
 * An account can report half a dozen overlapping windows and the user only
 * cares about the one that will actually stop them next. That is the most
 * severe state first (an exhausted window blocks work even at a lower
 * percentage than a busy one), then the fullest window, then the one that
 * clears soonest — a window with no known reset is the least useful answer, so
 * it loses every tie.
 */

const STATE_RANK: Record<UsageWindowState, number> = { exhausted: 2, warning: 1, ok: 0 };

export function selectBindingWindow(
  accounts: UsageAccount[],
): { account: UsageAccount; window: UsageWindow } | null {
  let best: { account: UsageAccount; window: UsageWindow } | null = null;
  for (const account of accounts ?? []) {
    for (const window of account?.windows ?? []) {
      if (!window) continue;
      if (best === null || isMoreBinding(window, best.window)) best = { account, window };
    }
  }
  return best;
}

function isMoreBinding(candidate: UsageWindow, incumbent: UsageWindow): boolean {
  const candidateRank = STATE_RANK[candidate.state] ?? 0;
  const incumbentRank = STATE_RANK[incumbent.state] ?? 0;
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;

  const candidateUsed = toUtilization(candidate.utilization);
  const incumbentUsed = toUtilization(incumbent.utilization);
  if (candidateUsed !== incumbentUsed) return candidateUsed > incumbentUsed;

  const candidateReset = toResetTime(candidate.resetsAt);
  const incumbentReset = toResetTime(incumbent.resetsAt);
  if (candidateReset !== incumbentReset) return candidateReset < incumbentReset;

  // Fully tied: the first window encountered keeps the slot, so repeated calls
  // over the same snapshot always name the same window.
  return false;
}

function toUtilization(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Missing or unparseable resets sort last. */
function toResetTime(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}
