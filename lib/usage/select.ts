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

/** One model the user can have selected, in the shape the model list reports. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/**
 * The windows that actually constrain one model, most binding first.
 *
 * Quota is per provider, so a model is only ever limited by the account that
 * serves it: a spent quota on another provider says nothing about whether this
 * model can run. No account for the provider means no answer at all (null) —
 * the caller must say "no quota reported" rather than borrow another
 * provider's numbers.
 *
 * Returns a matched account with an empty `windows` list when the provider
 * reports quota but none of it applies to this model.
 */
export function selectWindowsForModel(
  accounts: UsageAccount[],
  model: ModelRef | null | undefined,
): { account: UsageAccount; windows: UsageWindow[] } | null {
  const provider = normalize(model?.provider);
  if (!provider) return null;
  const modelId = typeof model?.modelId === "string" ? model.modelId : "";

  let best: { account: UsageAccount; windows: UsageWindow[] } | null = null;
  for (const account of accounts ?? []) {
    if (!account || normalize(account.provider) !== provider) continue;
    const windows = (account.windows ?? [])
      .filter((window): window is UsageWindow => Boolean(window) && windowConstrainsModel(window, modelId))
      .sort(compareBinding);
    // Two subscriptions can serve one provider, and only one of them is paying
    // for this turn; the tighter one is the honest thing to show. Ranking on
    // the windows that survive filtering (not on every window the account
    // reports) keeps an account whose binding window belongs to another tier
    // from shadowing a sibling that really does constrain this model.
    if (best === null || isMoreBindingAccount(windows, best.windows)) best = { account, windows };
  }
  return best;
}

/** The one window that will stop this model next, or null when none applies. */
export function selectBindingWindowForModel(
  accounts: UsageAccount[],
  model: ModelRef | null | undefined,
): { account: UsageAccount; window: UsageWindow } | null {
  const match = selectWindowsForModel(accounts, model);
  const window = match?.windows[0];
  return match && window ? { account: match.account, window } : null;
}

/**
 * Whether a tier-scoped window covers a given model.
 *
 * The tier has to appear in the model id as a whole token — delimited by
 * non-alphanumerics or the ends of the string — so "opus" matches
 * "claude-opus-4-5" but not "claude-opusx". Substring matching would quietly
 * charge one model's quota against an unrelated model whose name happens to
 * contain the tier.
 */
export function modelMatchesTier(modelId: string, tier: string): boolean {
  const haystack = normalize(modelId);
  const needle = normalize(tier);
  if (!haystack || !needle) return false;

  for (let from = 0; ; from = from + 1) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (!isAlphanumericAt(haystack, at - 1) && !isAlphanumericAt(haystack, at + needle.length)) return true;
    from = at;
  }
}

/**
 * A window applies unless it is scoped to some other model's tier: shared
 * windows and untiered windows bind every model on the account, while a tiered
 * one binds only its own models. Showing a spent "weekly (opus)" ring to
 * someone typing at a sonnet model is the exact confusion this rules out.
 */
function windowConstrainsModel(window: UsageWindow, modelId: string): boolean {
  if (window.shared === true) return true;
  const tier = typeof window.tier === "string" ? window.tier.trim() : "";
  if (!tier) return true;
  return modelMatchesTier(modelId, tier);
}

/** Accounts rank by their own binding window; one that constrains this model
 * at all outranks one that reports nothing applicable. */
function isMoreBindingAccount(candidate: UsageWindow[], incumbent: UsageWindow[]): boolean {
  const candidateBinding = candidate[0];
  const incumbentBinding = incumbent[0];
  if (!candidateBinding) return false;
  if (!incumbentBinding) return true;
  return isMoreBinding(candidateBinding, incumbentBinding);
}

function isMoreBinding(candidate: UsageWindow, incumbent: UsageWindow): boolean {
  return compareBinding(candidate, incumbent) < 0;
}

/** Sort comparator for the ranking above: most binding first, ties left in the
 * order encountered so the ring and the popover always name the same window. */
function compareBinding(a: UsageWindow, b: UsageWindow): number {
  const rankA = STATE_RANK[a.state] ?? 0;
  const rankB = STATE_RANK[b.state] ?? 0;
  if (rankA !== rankB) return rankB - rankA;

  const usedA = toUtilization(a.utilization);
  const usedB = toUtilization(b.utilization);
  if (usedA !== usedB) return usedB - usedA;

  const resetA = toResetTime(a.resetsAt);
  const resetB = toResetTime(b.resetsAt);
  if (resetA !== resetB) return resetA - resetB;

  // Fully tied: the first window encountered keeps the slot, so repeated calls
  // over the same snapshot always name the same window.
  return 0;
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

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isAlphanumericAt(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false;
  const code = value.charCodeAt(index);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}
