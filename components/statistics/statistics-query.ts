/**
 * What the Statistics page keeps in its address (period, ring order, metric) and
 * how those choices turn into an API request.
 *
 * A plain module, not a client component: the server page parses the address
 * with it before the first paint, and the client page writes it back as the
 * person changes things. A value imported from a "use client" file cannot be
 * called on the server, which is why this lives apart from StatisticsPage.
 */

import { customPeriod, isRangePreset } from "@/lib/statistics/days";
import { isGroupBy, type GroupBy, type RangePreset } from "@/lib/statistics/types";
import type { Metric } from "@/lib/statistics/sunburst";

/** Either one of the quick ranges or two day labels the person chose. */
export type PeriodSpec = { kind: "preset"; preset: RangePreset } | { kind: "custom"; from: string; to: string };

export interface StatisticsInitial {
  period: PeriodSpec;
  groupBy: GroupBy;
  metric: Metric;
}

export const DEFAULT_PRESET: RangePreset = "7d";
export const DEFAULT_GROUP_BY: GroupBy = "provider";
export const DEFAULT_METRIC: Metric = "cost";

/** The query parameters this page owns; anything else in the address is left alone. */
const OWN_PARAMS = ["range", "from", "to", "by", "metric"] as const;

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The page state an address asks for. Anything unreadable falls back to the
 * defaults rather than failing: a mistyped address should still open the page.
 */
export function parseStatisticsInitial(params: SearchParams): StatisticsInitial {
  const range = single(params.range);
  const by = single(params.by);

  let period: PeriodSpec = { kind: "preset", preset: DEFAULT_PRESET };
  if (range === "custom") {
    const custom = customPeriod(single(params.from), single(params.to));
    if (custom) period = { kind: "custom", from: custom.from, to: custom.to };
  } else if (isRangePreset(range)) {
    period = { kind: "preset", preset: range };
  }

  return {
    period,
    groupBy: isGroupBy(by) ? by : DEFAULT_GROUP_BY,
    metric: single(params.metric) === "tokens" ? "tokens" : DEFAULT_METRIC,
  };
}

export function samePeriod(a: PeriodSpec, b: PeriodSpec): boolean {
  if (a.kind === "preset") return b.kind === "preset" && a.preset === b.preset;
  return b.kind === "custom" && a.from === b.from && a.to === b.to;
}

/**
 * The address query string for a page state, with a leading `?` (or nothing at
 * all when every choice is the default, so the plain address stays plain).
 * `current` is the address as it is now, so parameters this page does not own
 * survive.
 */
export function statisticsSearch(current: string, state: StatisticsInitial): string {
  const params = new URLSearchParams(current);
  for (const key of OWN_PARAMS) params.delete(key);

  if (state.period.kind === "custom") {
    params.set("range", "custom");
    params.set("from", state.period.from);
    params.set("to", state.period.to);
  } else if (state.period.preset !== DEFAULT_PRESET) {
    params.set("range", state.period.preset);
  }
  if (state.groupBy !== DEFAULT_GROUP_BY) params.set("by", state.groupBy);
  if (state.metric !== DEFAULT_METRIC) params.set("metric", state.metric);

  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** The query string the API takes for a period and ring order (`refresh` is added by the caller). */
export function statisticsApiQuery(period: PeriodSpec, groupBy: GroupBy): string {
  const params = new URLSearchParams();
  if (period.kind === "custom") {
    params.set("from", period.from);
    params.set("to", period.to);
  } else {
    params.set("preset", period.preset);
  }
  params.set("groupBy", groupBy);
  return params.toString();
}
