/** Shared display formatters for UI surfaces (previously inlined per
 * component — AppShell had two byte-identical copies, ChatInput and
 * ModelCatalogPicker each had a near-identical variant). */

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
