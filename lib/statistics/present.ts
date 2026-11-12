/**
 * How the Statistics page words its numbers: money, token counts, shares,
 * changes against the period before, and the human name of every node of the
 * ring tree. Pure — the page hands in its translator and locale, so a test can
 * check the wording of a figure without a browser.
 *
 * The server sends keys and numbers only (a worker id, a project path, a chat
 * id); every sentence and every "price unknown" is made here, in the viewer's
 * language.
 */

import { OTHER_KEY, SLUG_PREFIX, type BillingKind, type PeriodInfo, type StatNode } from "./types";
import { parseWorker } from "./workers";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export type TranslatePlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Intl formatters are costly to build and a table asks for hundreds of figures, so each kind is built once per language. */
const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, name: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${name}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

const USD_BASE: Intl.NumberFormatOptions = { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" };

/** Dollars. Whole dollars from $1,000 up, cents below it, and "<$0.01" for a real but tiny amount. */
export function formatUsd(value: number, locale: string): string {
  const cents = numberFormat(locale, "usd2", { ...USD_BASE, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!Number.isFinite(value) || value <= 0) return cents.format(0);
  if (value < 0.005) return `<${cents.format(0.01)}`;
  if (value >= 1000) return numberFormat(locale, "usd0", { ...USD_BASE, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
  return cents.format(value);
}

/** "1.2M" in English, "120万" in Japanese: the language's own short form for a big count. */
export function formatTokens(value: number, locale: string): string {
  return numberFormat(locale, "compact", { notation: "compact", maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0);
}

/** The exact count with the locale's separators, for a tooltip. */
export function formatCount(value: number, locale: string): string {
  return numberFormat(locale, "count", {}).format(Number.isFinite(value) ? value : 0);
}

/** A share of a whole, 0 to 1. One decimal below 10%, whole percent above, "<0.1%" for a sliver. */
export function formatShare(ratio: number, locale: string): string {
  const whole = numberFormat(locale, "pct0", { style: "percent", maximumFractionDigits: 0 });
  const tenth = numberFormat(locale, "pct1", { style: "percent", maximumFractionDigits: 1 });
  if (!Number.isFinite(ratio) || ratio <= 0) return whole.format(0);
  if (ratio < 0.001) return `<${tenth.format(0.001)}`;
  return (ratio < 0.1 ? tenth : whole).format(ratio);
}

/** `part / whole`, or 0 when there is no whole. */
export function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Cache reads as a share of everything the prompts carried; null when no prompt tokens were counted. */
export function cacheHitRate(node: Pick<StatNode, "input" | "cacheRead" | "cacheWrite">): number | null {
  const prompt = node.input + node.cacheRead + node.cacheWrite;
  return prompt > 0 ? node.cacheRead / prompt : null;
}

// ---------------------------------------------------------------------------
// Change against the period before
// ---------------------------------------------------------------------------

/** Changes smaller than this (half a percent) read as "no change". */
const FLAT_BELOW = 0.005;

export type DeltaKind = "up" | "down" | "flat" | "new" | "none";

export interface Delta {
  kind: DeltaKind;
  /** (now - before) / before; 0 for `new`, `flat` and `none`. */
  ratio: number;
}

/**
 * How `current` compares with `previous`. Nothing before and something now is
 * "new" (a percentage of zero is not a number); nothing in either period says
 * nothing at all.
 */
export function deltaOf(current: number, previous: number): Delta {
  if (!(previous > 0)) return current > 0 ? { kind: "new", ratio: 0 } : { kind: "none", ratio: 0 };
  const ratio = (current - previous) / previous;
  if (Math.abs(ratio) < FLAT_BELOW) return { kind: "flat", ratio: 0 };
  return { kind: ratio > 0 ? "up" : "down", ratio };
}

/** "+18%", "−4%", "new", "no change"; null when there is nothing to compare. */
export function formatDelta(delta: Delta, locale: string, t: Translate): string | null {
  if (delta.kind === "none") return null;
  if (delta.kind === "new") return t("statistics.delta.new");
  if (delta.kind === "flat") return t("statistics.delta.flat");
  const magnitude = Math.abs(delta.ratio);
  const percent = numberFormat(locale, magnitude < 0.1 ? "pct1" : "pct0", { style: "percent", maximumFractionDigits: magnitude < 0.1 ? 1 : 0 }).format(magnitude);
  return `${delta.kind === "up" ? "+" : "\u2212"}${percent}`;
}

/** "vs yesterday", "vs last week", or "vs the 30 days before". */
export function compareLabel(period: PeriodInfo, tn: TranslatePlural, t: Translate): string {
  if (period.preset === "today") return t("statistics.vsYesterday");
  if (period.preset === "7d") return t("statistics.vsLastWeek");
  return tn("statistics.vsDays", period.days);
}

/** "today", "this week", "in the last 30 days": the span an insight sentence talks about. */
export function periodWhen(period: PeriodInfo, t: Translate): string {
  if (period.preset === "today") return t("statistics.when.today");
  if (period.preset === "7d") return t("statistics.when.week");
  if (period.preset === "30d") return t("statistics.when.days", { count: 30 });
  if (period.preset === "90d") return t("statistics.when.days", { count: 90 });
  return t("statistics.when.period");
}

// ---------------------------------------------------------------------------
// Days and times
// ---------------------------------------------------------------------------

/** A YYYY-MM-DD label as "Nov 12". Day labels are plain dates, so they are formatted as UTC to stay on the same day. */
export function formatDay(day: string, locale: string, withWeekday = false): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(withWeekday ? { weekday: "short" } : {}), timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

/** An instant as "Nov 12, 14:05" in the zone the index buckets days in, so a turn reads under the day it was counted on. */
export function formatMoment(ts: number, locale: string, zone: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(ts));
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Engine helper calls whose purpose has its own name. Anything else falls back to the raw purpose. */
const ENGINE_PURPOSES: Record<string, true> = { memory: true, "auto-thinking": true, "unexpected-stop": true, "cache-warm": true };
/** Cody background jobs whose purpose has its own name. */
const BACKGROUND_PURPOSES: Record<string, true> = { title: true, distill: true, "plan-keeper": true, planner: true, research: true };

/** What did the work: "Main chat", "Subagent · explore", "Chat titles", ... */
export function workerLabel(id: string, t: Translate): string {
  const worker = parseWorker(id);
  if (worker.kind === "main") return t("statistics.worker.main");
  if (worker.kind === "sidebar") return t("statistics.worker.sidebar");
  if (worker.kind === "advisor") return t("statistics.worker.advisor");
  if (worker.kind === "compaction") return t("statistics.worker.compaction");
  if (worker.kind === "subagent") return worker.detail ? t("statistics.worker.subagentType", { type: worker.detail }) : t("statistics.worker.subagent");
  if (worker.kind === "engine") {
    return Object.hasOwn(ENGINE_PURPOSES, worker.detail) ? t(`statistics.worker.engine.${worker.detail}`) : t("statistics.worker.engineOther", { purpose: worker.detail });
  }
  if (worker.kind === "background") {
    if (!worker.detail) return t("statistics.worker.background");
    return Object.hasOwn(BACKGROUND_PURPOSES, worker.detail) ? t(`statistics.worker.background.${worker.detail}`) : t("statistics.worker.backgroundOther", { purpose: worker.detail });
  }
  return id;
}

/**
 * What a node is called on the page. The server names what it can (a provider,
 * a model, a project folder, a titled chat) and leaves the rest empty, because
 * "no project" and "Main chat" belong to the viewer's language, not the server's.
 */
export function nodeLabel(node: Pick<StatNode, "dim" | "key" | "label" | "other">, t: Translate): string {
  if (node.other || node.key === OTHER_KEY) return t("statistics.other");
  if (node.dim === "worker") return workerLabel(node.key, t);
  if (node.dim === "project" && node.key === "") return t("statistics.noProject");
  if (node.dim === "chat" && node.key === "") return t("statistics.noChat");
  if (node.dim === "chat" && node.label === "") return t("statistics.untitledChat");
  if (node.label !== "") return node.label;
  if (node.dim === "project" && node.key.startsWith(SLUG_PREFIX)) return node.key.slice(SLUG_PREFIX.length);
  return node.key;
}

/** The translation key of a provider's billing label, and of its one-line explanation. */
export const BILLING_KEYS: Record<BillingKind, { label: string; note: string }> = {
  subscription: { label: "statistics.billing.subscription", note: "statistics.billing.subscriptionNote" },
  payg: { label: "statistics.billing.payg", note: "statistics.billing.paygNote" },
  local: { label: "statistics.billing.local", note: "statistics.billing.localNote" },
  unknown: { label: "statistics.billing.unknown", note: "statistics.billing.unknownNote" },
};

// ---------------------------------------------------------------------------
// How a cost is shown
// ---------------------------------------------------------------------------

export type CostKind =
  /** Every token was priced. */
  | "priced"
  /** Some tokens were priced and some were not: the figure is a floor. */
  | "partial"
  /** Tokens ran but no price is known: there is no figure, and it is never $0. */
  | "unknown"
  /** Tokens ran on the user's own machine: there is nothing to charge. */
  | "local"
  /** Nothing ran. */
  | "none";

export interface CostFigure {
  kind: CostKind;
  amount: number;
}

/**
 * What to print in a Cost column for a node. A model with no known price shows
 * "price unknown", never "$0.00", and a local model is not a free bargain but a
 * different kind of thing, so it is named as one.
 */
export function costFigure(node: Pick<StatNode, "cost" | "tokens" | "unpricedTokens">): CostFigure {
  if (node.cost > 0) return { kind: node.unpricedTokens > 0 ? "partial" : "priced", amount: node.cost };
  if (node.unpricedTokens > 0) return { kind: "unknown", amount: 0 };
  if (node.tokens > 0) return { kind: "local", amount: 0 };
  return { kind: "none", amount: 0 };
}

/** The cost as one string, for a sentence or an aria-label. */
export function costText(figure: CostFigure, locale: string, t: Translate): string {
  if (figure.kind === "unknown") return t("statistics.cost.unknown");
  if (figure.kind === "local") return t("statistics.cost.local");
  if (figure.kind === "none") return "\u2014";
  return `${formatUsd(figure.amount, locale)}${figure.kind === "partial" ? "+" : ""}`;
}
