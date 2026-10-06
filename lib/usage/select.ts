import type { UsageAccount, UsageAccountService, UsageInUseBasis, UsageSessionAccount, UsageWindow } from "./types";

/**
 * Picking the binding constraint.
 *
 * An account can report half a dozen overlapping windows and the user only
 * cares about the one that will actually stop them next. Exhaustion first — a
 * refused window stops the model now, whatever its term — then the shortest
 * span: the current 5 hours are what this turn spends against, and a fuller
 * week is context, not the gauge. Only then the fullest window, then the one
 * that clears soonest — a window with no known reset is the least useful
 * answer, so it loses every tie.
 */

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

/** One ranked account for a provider, alongside the windows that actually
 * constrain the given model and the single window binding it, if any. */
export interface ProviderAccountRank {
  account: UsageAccount;
  /** This account's windows that constrain the given model, most binding first. */
  windows: UsageWindow[];
  state: UsageAccountService;
  /** windows[0], or null when the account has nothing applicable. */
  binding: UsageWindow | null;
  /** On the `in_use` entry only: what that answer rests on. */
  basis?: UsageInUseBasis;
}

/** What is known about which account is actually taking requests. */
export interface AccountEvidence {
  /** The account a conversation's latest reply was served by (omp's
   *  `credential_pin`, resolved by `/api/usage?session=`). Strongest evidence. */
  inUseAccountId?: string | null;
  /** With no conversation in scope, fall back to the account that most
   *  recently served a live request anywhere (`lastServedAt`). A conversation
   *  that has not used the provider must NOT use this: omp routes a fresh
   *  session by quota headroom, not by what another session last used. */
  recent?: boolean;
}

/**
 * What one conversation's recorded account says about a provider: the account
 * that served its latest reply, or — when omp recorded a pin Cody cannot match
 * — only that the provider WAS used, so the account that most recently served
 * a request stands in. A provider the conversation never used is no evidence
 * at all: omp routes a fresh conversation by quota headroom, so another
 * conversation's account says nothing here. Shared by the composer ring and
 * by scheduled messages, which must name the same account the ring does.
 */
export function evidenceFromSessionAccount(entry: UsageSessionAccount | null | undefined): AccountEvidence {
  if (!entry) return {};
  return entry.accountId ? { inUseAccountId: entry.accountId } : { recent: true };
}

/**
 * Every account serving one provider, in the order a person should read them:
 * the one **in use**, then healthy **standby** siblings (by headroom — the
 * order omp would rotate to), then **limited** (earliest reset first), then
 * **disabled**.
 *
 * Which account is in use is the ENGINE's fact, not something to infer from
 * utilization. omp keeps a conversation on the account that served it (it is
 * session-sticky, and Anthropic's prompt cache is per account); ranking by
 * lowest utilization picks the idle sibling precisely because the account in
 * use is the one burning quota. So the in-use account comes from `evidence`
 * (see `AccountEvidence`), and headroom only decides it when there is none —
 * which is also how omp itself routes a conversation's first request.
 *
 * Evidence naming a limited or disabled account is overruled: omp will not
 * send the next request there, so it is shown as what it is and the in-use
 * slot goes to the account omp will actually rotate onto.
 *
 * `modelId` scopes which windows count as each account's binding window;
 * omit it (or pass `""`) to rank by provider-level (untiered) windows only.
 */
export function rankProviderAccounts(
  accounts: UsageAccount[],
  provider: string,
  modelId?: string,
  evidence: AccountEvidence = {},
): ProviderAccountRank[] {
  const normalizedProvider = normalize(provider);
  if (!normalizedProvider) return [];
  const scopeModelId = typeof modelId === "string" ? modelId : "";

  const entries = (accounts ?? [])
    .filter(
      (account): account is UsageAccount => Boolean(account) && normalize(account.provider) === normalizedProvider,
    )
    .map((account, index) => {
      const windows = (account.windows ?? [])
        .filter((window): window is UsageWindow => Boolean(window) && windowConstrainsModel(window, scopeModelId))
        .sort(compareBinding);
      return { account, windows, binding: windows[0] ?? null, index };
    });

  // Disabled always sorts last, whatever it reports; a live rank never has
  // windows to weigh it against anyway (omp-usage.ts gives it windows: []).
  const disabled = entries.filter((entry) => Boolean(entry.account.disabled));
  const live = entries.filter((entry) => !entry.account.disabled);
  const limited = live.filter((entry) => entry.binding?.state === "exhausted");
  const measured = live.filter((entry) => entry.binding !== null && entry.binding.state !== "exhausted");
  // An account with nothing applicable to this model is not limited — no
  // reported window means no reported constraint — but it is also not
  // evidence of anything, so real telemetry on a sibling always outranks a
  // guess: it sorts after every measured account.
  const unmeasured = live.filter((entry) => entry.binding === null);

  measured.sort((a, b) => {
    const utilA = toUtilization(a.binding!.utilization);
    const utilB = toUtilization(b.binding!.utilization);
    return utilA !== utilB ? utilA - utilB : a.index - b.index;
  });
  unmeasured.sort((a, b) => a.index - b.index);
  limited.sort((a, b) => {
    const resetA = toResetTime(a.binding?.resetsAt ?? null);
    const resetB = toResetTime(b.binding?.resetsAt ?? null);
    return resetA !== resetB ? resetA - resetB : a.index - b.index;
  });

  const usable = [...measured, ...unmeasured];
  let inUse: (typeof usable)[number] | undefined;
  let basis: UsageInUseBasis = "expected";
  if (evidence.inUseAccountId) {
    inUse = usable.find((entry) => entry.account.id === evidence.inUseAccountId);
    if (inUse) basis = "session";
  } else if (evidence.recent) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const entry of usable) {
      const servedAt = entry.account.lastServedAt ? Date.parse(entry.account.lastServedAt) : Number.NaN;
      if (Number.isFinite(servedAt) && servedAt > latest) {
        latest = servedAt;
        inUse = entry;
      }
    }
    if (inUse) basis = "recent";
  }
  inUse ??= usable[0];

  const ranked: ProviderAccountRank[] = [];
  if (inUse) ranked.push({ account: inUse.account, windows: inUse.windows, binding: inUse.binding, state: "in_use", basis });
  for (const entry of usable) {
    if (entry !== inUse) ranked.push({ account: entry.account, windows: entry.windows, binding: entry.binding, state: "standby" });
  }
  for (const { account, windows, binding } of limited) ranked.push({ account, windows, binding, state: "limited" });
  for (const { account, windows, binding } of disabled) ranked.push({ account, windows, binding, state: "disabled" });
  return ranked;
}

/**
 * The windows that actually constrain one model, most binding first, read off
 * the account that model's requests are going to (see `rankProviderAccounts`).
 *
 * Quota is per provider, so a model is only ever limited by the account that
 * serves it: a spent quota on another provider says nothing about whether
 * this model can run. No account for the provider means no answer at all
 * (null) — the caller must say "no quota reported" rather than borrow another
 * provider's numbers.
 *
 * With several accounts, the honest gauge is the one in use: a sibling's
 * numbers are not being charged. When every account is limited, the one that
 * frees up first is returned, so the gauge reads "spent" and says when.
 *
 * Returns a matched account with an empty `windows` list when the provider
 * reports quota but none of it applies to this model.
 */
export function selectWindowsForModel(
  accounts: UsageAccount[],
  model: ModelRef | null | undefined,
  evidence: AccountEvidence = {},
): { account: UsageAccount; windows: UsageWindow[] } | null {
  const provider = normalize(model?.provider);
  if (!provider) return null;
  const modelId = typeof model?.modelId === "string" ? model.modelId : "";
  const top = rankProviderAccounts(accounts, provider, modelId, evidence)[0];
  return top ? { account: top.account, windows: top.windows } : null;
}

/** The one window that will stop this model next, or null when none applies. */
export function selectBindingWindowForModel(
  accounts: UsageAccount[],
  model: ModelRef | null | undefined,
  evidence: AccountEvidence = {},
): { account: UsageAccount; window: UsageWindow } | null {
  const match = selectWindowsForModel(accounts, model, evidence);
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
 * A reported tier always scopes a window to its own models. OMP can mark a
 * tiered bucket shared too, so that flag must not erase the explicit scope and
 * charge it to another model. Untiered windows bind the whole account.
 */
function windowConstrainsModel(window: UsageWindow, modelId: string): boolean {
  const tier = typeof window.tier === "string" ? window.tier.trim() : "";
  return !tier || modelMatchesTier(modelId, tier);
}

function isMoreBinding(candidate: UsageWindow, incumbent: UsageWindow): boolean {
  return compareBinding(candidate, incumbent) < 0;
}

/** Sort comparator for the ranking above: most binding first, ties left in the
 * order encountered so the ring and the popover always name the same window. */
function compareBinding(a: UsageWindow, b: UsageWindow): number {
  // Only exhaustion outranks the term. A warning refuses nothing, so it must
  // not drag the gauge off the short window the turn is actually spending.
  const refusedA = a.state === "exhausted" ? 1 : 0;
  const refusedB = b.state === "exhausted" ? 1 : 0;
  if (refusedA !== refusedB) return refusedB - refusedA;

  const spanA = toWindowSpan(a.windowMs);
  const spanB = toWindowSpan(b.windowMs);
  if (spanA !== spanB) return spanA - spanB;

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

/** Unknown spans sort last: a window that will not say how long it lasts
 * cannot claim to be the near-term one. */
function toWindowSpan(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY;
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
