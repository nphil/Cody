/**
 * The plain words the quota popover uses for the account facts omp 18.8.5 -
 * 18.19 added to `omp usage --json`: the routing policy an account carries,
 * a 5-hour gate that has not started counting, money and credit amounts, and
 * what a saved reset is worth (when it expires, which limits it clears).
 *
 * Pure and free of React: the translator is injected, so the popover, a notice
 * and a test all build the same sentence. Every helper returns null rather than
 * an empty string when there is nothing true to say, so a caller never renders
 * a blank line.
 */
import type { UsageAccount, UsageAccountPolicy, UsageWindowAmount } from "./types";

export type CopyTranslate = (key: string, vars?: Record<string, string | number>) => string;

/** A saved reset that expires within this long earns the "Expires soon" badge.
 *  omp's own status line flags one from 24 hours out; Cody is deliberately a
 *  little earlier, so the owner has a day to act on it. */
export const EXPIRES_SOON_MS = 48 * 3_600_000;

const FIVE_HOURS_MS = 18_000_000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 15 -> "15", 12.5 -> "12.5", 70.04 -> "70". */
function percentText(value: number): string {
  return String(Number(value.toFixed(1)));
}

/* ───────────────────────────── routing policy ───────────────────────────── */

export interface PolicyCopy {
  /** One short line: "Priority 2 · Keeps 15% in reserve · eligible". */
  line: string;
  /** The same facts as full sentences, for a tooltip. */
  detail: string;
}

const POLICY_STATE_LINE_KEYS: Record<UsageAccountPolicy["state"], string> = {
  eligible: "usage.policyEligible",
  "inside-reserve": "usage.policyInsideReserve",
  exhausted: "usage.policyExhausted",
  unknown: "usage.policyUnknown",
};

const POLICY_STATE_DETAIL_KEYS: Record<UsageAccountPolicy["state"], string> = {
  eligible: "usage.policyEligibleDetail",
  "inside-reserve": "usage.policyInsideReserveDetail",
  exhausted: "usage.policyExhaustedDetail",
  unknown: "usage.policyUnknownDetail",
};

/**
 * Whether any account of `provider` carries a non-zero priority. A priority of
 * 0 is omp's default and says nothing on its own, but next to a sibling with
 * priority 2 it says "used after that one", so the line then names it.
 */
export function providerUsesPriority(accounts: readonly Pick<UsageAccount, "provider" | "policy">[], provider: string): boolean {
  return accounts.some((account) => {
    const priority = finite(account.policy?.priority);
    return account.provider === provider && priority !== null && priority !== 0;
  });
}

/**
 * omp's routing policy for one login (`auth.accountPolicies`), in plain words.
 * Returns null when it carries nothing worth a line: the default priority, no
 * reserve, and a state of "eligible" or "unknown".
 */
export function describeAccountPolicy(
  policy: UsageAccountPolicy | null | undefined,
  t: CopyTranslate,
  options: { showPriority?: boolean } = {},
): PolicyCopy | null {
  if (!policy) return null;
  const priority = finite(policy.priority);
  const reserve = finite(policy.reservePct);
  const reclaim = finite(policy.reclaimAbovePct);
  const remaining = finite(policy.remainingPct);
  const state = policy.state in POLICY_STATE_LINE_KEYS ? policy.state : "unknown";
  const namesPriority = priority !== null && (priority !== 0 || options.showPriority === true);
  const namesReserve = reserve !== null && reserve > 0;
  if (!namesPriority && !namesReserve && (state === "eligible" || state === "unknown")) return null;

  const line = [
    namesPriority ? t("usage.policyPriority", { n: priority as number }) : null,
    namesReserve ? t("usage.policyReserve", { pct: percentText(reserve as number) }) : null,
    t(POLICY_STATE_LINE_KEYS[state]),
  ].filter(Boolean).join(" · ");

  const detail = [
    namesPriority ? t("usage.policyPriorityDetail", { n: priority as number }) : null,
    namesReserve ? t("usage.policyReserveDetail", { pct: percentText(reserve as number) }) : null,
    namesReserve && policy.reserveSource === "override" ? t("usage.policyReserveOwn") : null,
    namesReserve && policy.reserveSource === "global" ? t("usage.policyReserveGlobal") : null,
    reclaim !== null ? t("usage.policyReclaimDetail", { pct: percentText(reclaim) }) : null,
    t(POLICY_STATE_DETAIL_KEYS[state]),
    remaining !== null ? t("usage.policyRemaining", { pct: percentText(remaining) }) : null,
  ].filter(Boolean).join(" ");

  return { line, detail };
}

/* ───────────────────────── the 5-hour window not started ───────────────────────── */

/**
 * A Claude account with no session open reports no 5-hour window at all: the
 * window starts counting with the next message. omp 18.19 says so
 * (`inactiveSharedGates: ["5h"]`); an older engine just leaves the bar out.
 * True only when the gate is named AND no 5-hour window was reported, so a
 * stale gate list never hides a bar that is really there.
 */
export function isFiveHourIdle(account: Pick<UsageAccount, "inactiveGates" | "windows">): boolean {
  const gates = account.inactiveGates;
  if (!Array.isArray(gates) || !gates.some((gate) => typeof gate === "string" && gate.trim().toLowerCase() === "5h")) return false;
  return !(account.windows ?? []).some((window) => (
    Boolean(window) && (window.windowMs === FIVE_HOURS_MS || /(^|:)5h$/i.test(window.id ?? ""))
  ));
}

/* ─────────────────────────── money and credit amounts ─────────────────────────── */

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, kind: "plain" | "whole-usd" | "cents-usd"): Intl.NumberFormat {
  const key = `${locale}|${kind}`;
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = kind === "plain"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          currencyDisplay: "narrowSymbol",
          minimumFractionDigits: kind === "whole-usd" ? 0 : 2,
          maximumFractionDigits: kind === "whole-usd" ? 0 : 2,
        });
    formatterCache.set(key, cached);
  }
  return cached;
}

function formatAmountNumber(value: number, unit: string, locale: string): string {
  if (unit !== "usd") return formatter(locale, "plain").format(value);
  // "$10", not "$10.00" — but "$3.20", never "$3.2".
  return formatter(locale, Number.isInteger(value) ? "whole-usd" : "cents-usd").format(value);
}

/**
 * What a money or credit meter measured, next to its percentage: "$3.20 of $10"
 * (a LiteLLM key budget), "40 of 100 credits" (a Codex spend cap). Null for a
 * plain percentage window, and for an amount the engine left empty.
 */
export function describeWindowAmount(
  amount: UsageWindowAmount | null | undefined,
  locale: string,
  t: CopyTranslate,
): string | null {
  if (!amount) return null;
  const used = finite(amount.used);
  const limit = finite(amount.limit);
  if (used === null && limit === null) return null;
  const unit = typeof amount.unit === "string" ? amount.unit.trim().toLowerCase() : "";
  const unitWord = unit === "usd" || unit === "" ? null : unit === "credits" ? t("usage.unitCredits") : unit;
  const withUnit = (text: string) => (unitWord ? `${text} ${unitWord}` : text);
  if (used !== null && limit !== null) {
    return t("usage.amountOf", { used: formatAmountNumber(used, unit, locale), limit: withUnit(formatAmountNumber(limit, unit, locale)) });
  }
  if (used !== null) return t("usage.amountUsed", { used: withUnit(formatAmountNumber(used, unit, locale)) });
  return t("usage.amountLimit", { limit: withUnit(formatAmountNumber(limit as number, unit, locale)) });
}

/* ───────────────────────────── saved-reset credits ───────────────────────────── */

export type CreditExpiryState = "later" | "soon" | "past";

/** How close a saved reset is to expiring; null when the engine gave no usable date. */
export function creditExpiryState(expiresAt: string | null | undefined, now: number): CreditExpiryState | null {
  if (typeof expiresAt !== "string") return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left <= 0) return "past";
  return left <= EXPIRES_SOON_MS ? "soon" : "later";
}

const SIX_DAYS_MS = 6 * 86_400_000;

/**
 * When a saved reset ends, written so it cannot be misread. A clock time or a
 * weekday is clear only close to now ("18:20", "Sun 09:00"); a credit that has
 * weeks left would read as "Tue 00:00", which says nothing about WHICH Tuesday,
 * so anything further out than six days is a plain date ("Sep 15").
 */
export function formatCreditDate(iso: string | null | undefined, locale: string, now: number): string | null {
  if (typeof iso !== "string") return null;
  const at = new Date(iso);
  const time = at.getTime();
  if (!Number.isFinite(time)) return null;
  if (at.toDateString() === new Date(now).toDateString()) return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (Math.abs(time - now) < SIX_DAYS_MS) return at.toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return at.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Window words in omp's limit ids: Claude says `5h` / `7d`, Codex `primary` / `secondary`. */
const CLEARED_WINDOW_KEYS: Record<string, string> = {
  "5h": "usage.clearsWindow5h",
  primary: "usage.clearsWindow5h",
  "7d": "usage.clearsWindowWeekly",
  secondary: "usage.clearsWindowWeekly",
};

/** `anthropic:7d:fable` -> "Fable weekly"; null for an id this build does not know. */
function clearedLimitPhrase(limitId: string, t: CopyTranslate): string | null {
  const parts = limitId.trim().toLowerCase().split(":").slice(1).filter(Boolean);
  const windowIndex = parts.findIndex((part) => part in CLEARED_WINDOW_KEYS);
  if (windowIndex < 0) return null;
  const windowText = t(CLEARED_WINDOW_KEYS[parts[windowIndex]!]!);
  const tier = parts.filter((_, index) => index !== windowIndex).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  return tier ? t("usage.clearsTier", { tier, window: windowText }) : windowText;
}

/**
 * What a saved reset clears, from the limit ids omp lists on the credit:
 * "Clears: 5-hour, weekly, and Fable weekly". Ids it cannot name are left out;
 * null when none could be named, so a credit that says nothing shows nothing.
 */
export function describeCreditClears(clears: readonly string[] | null | undefined, locale: string, t: CopyTranslate): string | null {
  if (!Array.isArray(clears)) return null;
  const phrases: string[] = [];
  for (const id of clears) {
    if (typeof id !== "string") continue;
    const phrase = clearedLimitPhrase(id, t);
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  if (phrases.length === 0) return null;
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(phrases);
  return t("usage.creditClears", { list });
}
