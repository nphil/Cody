import { isUsageWarning } from "../format";
import { isSignedOutCause } from "./credential-health";
import { constrainingWindows, modelMatchesTier } from "./quota-tiers";
import type { UsageAccount, UsageAccountService, UsageInUseBasis, UsageSessionAccount, UsageWindow } from "./types";

// The tier matcher lives with the other scoping rules (quota-tiers.ts); it is
// re-exported here because callers and tests have always imported it from the
// selection module.
export { modelMatchesTier };

/**
 * Picking the binding constraint.
 *
 * An account can report half a dozen overlapping windows and ranking has to
 * name the one that will actually stop the next request. Exhaustion first — a
 * refused window stops the model now, whatever its term — then the shortest
 * span: the current 5 hours are what this turn spends against, and a fuller
 * week is context. Only then the fullest window, then the one that clears
 * soonest — a window with no known reset is the least useful answer, so it
 * loses every tie.
 *
 * This is the order of RANKING and ROUTING (`rankProviderAccounts`,
 * availability, blackouts, a scheduled message's wait). Which window a gauge
 * shows is a different question: see `selectRingWindow`.
 */
export function selectBindingWindow(
  accounts: UsageAccount[],
): { account: UsageAccount; window: UsageWindow } | null {
  return selectBest(accounts, compareBinding);
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
 * **signed out** (the login ended), then any other **disabled**.
 *
 * Which account is in use is the ENGINE's fact, not something to infer from
 * utilization. omp keeps a conversation on the account that served it (it is
 * session-sticky, and Anthropic's prompt cache is per account); ranking by
 * lowest utilization picks the idle sibling precisely because the account in
 * use is the one burning quota. So the in-use account comes from `evidence`
 * (see `AccountEvidence`), and headroom only decides it when there is none —
 * which is also how omp itself routes a conversation's first request.
 *
 * Evidence naming a limited, signed-out or disabled account is overruled: omp
 * will not send the next request there, so it is shown as what it is and the
 * in-use slot goes to the account omp will actually rotate onto.
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
      const windows = constrainingWindows(account.windows, account.provider, scopeModelId).sort(compareBinding);
      return { account, windows, binding: windows[0] ?? null, index };
    });

  // Unusable accounts always sort last, whatever they report; a live rank
  // never has windows to weigh them against anyway (omp-usage.ts gives them
  // windows: []). One whose login ended reads before the plain disabled ones:
  // it is the only kind the owner can bring back by signing in again.
  const unusable = entries.filter((entry) => Boolean(entry.account.disabled));
  const signedOut = unusable.filter((entry) => isSignedOutCause(entry.account.disabled?.cause));
  const disabled = unusable.filter((entry) => !signedOut.includes(entry));
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
  for (const { account, windows, binding } of signedOut) ranked.push({ account, windows, binding, state: "signed_out" });
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
 * Picking the window the RING shows: the one that most threatens the model.
 *
 * The binding order above answers "what clears first, what does the next
 * request spend against" — right for ranking and routing, wrong for a gauge. A
 * calm 5-hour window at 3% must not hide a week at 95%, so the ring reads:
 *
 *   1. a refused window (exhausted), whatever its term;
 *   2. otherwise any window painted at the warning colour or worse — the very
 *      test `usageToneColor` applies (`isUsageWarning`: engine state `warning`,
 *      or 70% and up) — the fullest first;
 *   3. otherwise nothing is worrying, and the binding order stands: the short
 *      window this turn spends against.
 *
 * Ties inside a step fall to the binding order, so one snapshot always names
 * one window. Display only: never decide where a request goes with this.
 */
export function selectRingWindow(
  accounts: UsageAccount[],
): { account: UsageAccount; window: UsageWindow } | null {
  return selectBest(accounts, compareRingChoice);
}

/** One account's windows in the order the ring reads them: the window it shows
 * first, then the rest, most worrying first. A new array; the input is untouched. */
export function rankWindowsForRing(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows.filter(Boolean).sort(compareRingChoice);
}

function selectBest(
  accounts: UsageAccount[],
  compare: (a: UsageWindow, b: UsageWindow) => number,
): { account: UsageAccount; window: UsageWindow } | null {
  let best: { account: UsageAccount; window: UsageWindow } | null = null;
  for (const account of accounts ?? []) {
    for (const window of account?.windows ?? []) {
      if (!window) continue;
      if (best === null || compare(window, best.window) < 0) best = { account, window };
    }
  }
  return best;
}

/** How much a window worries the ring, most first. */
const RING_REFUSED = 2;
const RING_WORRYING = 1;
const RING_CALM = 0;

function ringWorry(window: UsageWindow): number {
  if (window.state === "exhausted") return RING_REFUSED;
  return isUsageWarning(toPercent(window.utilization), window.state) ? RING_WORRYING : RING_CALM;
}

/** Sort comparator for the ring's pick: see `selectRingWindow`. */
function compareRingChoice(a: UsageWindow, b: UsageWindow): number {
  const worryA = ringWorry(a);
  const worryB = ringWorry(b);
  if (worryA !== worryB) return worryB - worryA;
  // Two worrying windows go by how full they are, the number the ring draws;
  // two refused ones and two calm ones keep the binding order.
  if (worryA === RING_WORRYING) {
    const fullA = toPercent(a.utilization);
    const fullB = toPercent(b.utilization);
    if (fullA !== fullB) return fullB - fullA;
  }
  return compareBinding(a, b);
}

/** Sort comparator for the binding order (see `selectBindingWindow`): most
 * binding first, ties left in the order encountered so a snapshot always names
 * the same window. */
function compareBinding(a: UsageWindow, b: UsageWindow): number {
  // Only exhaustion outranks the term. A warning refuses nothing, so ranking
  // and routing must not drag off the short window the turn is actually
  // spending (the ring's own pick does weigh it: `selectRingWindow`).
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

/** The percentage a bar draws: finite and within 0-100, like `clampQuotaPercent`. */
function toPercent(value: number): number {
  return Math.max(0, Math.min(100, toUtilization(value)));
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

