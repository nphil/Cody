/** Shared display formatters for UI surfaces (previously inlined per
 * component — AppShell had two byte-identical copies, ChatInput and
 * ModelCatalogPicker each had a near-identical variant). */

import type { UsageWindowState } from "./usage/types";

/** "1.2M / 34k / 1234" compact rendering. `toLocaleString` applies only when
 * `locale` is provided (the <1000 branch in ChatInput's token counter). */
export function formatCompactNumber(n: number, locale?: string): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return locale ? n.toLocaleString(locale) : String(n);
}

/** Context-usage percentage with a stable one-decimal format. */
export function formatPercent(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/**
 * API-equivalent spend at a chosen precision (2 decimals for the compact chip,
 * 4 for the tooltip and the session panel).
 *
 * The "less than" guard is derived from the precision itself, so it can never
 * drift away from the formatter: at four decimals $0.0042 prints as "$0.0042",
 * not as "<$0.0001" — a guard pinned to a coarser threshold than its own
 * formatter understates the figure by up to two orders of magnitude.
 *
 * Callers decide whether a cost of zero is even a figure worth printing: a
 * session whose models carry no published price has an unknown cost, not a
 * zero one.
 */
export function formatApiCost(cost: number, digits: 2 | 4): string {
  const smallest = digits === 2 ? 0.01 : 0.0001;
  if (!Number.isFinite(cost) || cost <= 0) return `$${(0).toFixed(digits)}`;
  return cost >= smallest ? `$${cost.toFixed(digits)}` : `<$${smallest.toFixed(digits)}`;
}

/**
 * Short relative age ("3m ago", "2h ago", "4d ago") for a timestamp string.
 *
 * `now` is passed in rather than read from the clock so a component that ticks
 * to keep its label true re-renders deterministically — and so this is testable
 * without freezing time. An unparseable timestamp returns null: the three
 * surfaces that show ages (session list, command palette, usage popover) all
 * render nothing rather than risk `Intl.RelativeTimeFormat` throwing on NaN.
 */
export function formatRelativeTime(value: string, locale: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  if (minutes < 1) return formatter.format(0, "minute");
  if (minutes < 60) return formatter.format(-minutes, "minute");

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.floor(hours / 24), "day");
}

/**
 * Shipped fullness thresholds, shared by the composer ring, the quota bars, the
 * context ring and the top-bar context chip: under 70 is the accent, 70–89
 * warns, 90 and up is an error. One threshold pair, so two surfaces reading the
 * same percentage can never disagree about whether it is worth worrying about
 * (they did: one compared `>= 90`, the other `> 90`, so exactly 90.0% was an
 * error in the composer and merely a warning in the top bar).
 *
 * The percentage alone is not the whole story: a provider can reject requests
 * against a window that reads 12% full (a hard cap Cody cannot see, a suspended
 * account, a per-model block). Painting that accent-coloured would tell the
 * composer "plenty left" about a window nothing can be spent on, so an
 * engine-reported state overrides the number upward — never downward.
 */
export function usageToneColor(percent: number, state?: UsageWindowState): string {
  if (state === "exhausted") return "var(--status-error)";
  if (percent >= 90) return "var(--status-error)";
  if (state === "warning" || percent >= 70) return "var(--status-warning)";
  return "var(--accent)";
}
