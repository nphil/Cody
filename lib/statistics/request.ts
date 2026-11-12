/**
 * Reads the Statistics API's query string into what the query layer takes.
 * Pure — the day "today" is handed in, so a test can pin it and the route can
 * give the zone the index buckets days in.
 */

import { addDays, customPeriod, isRangePreset, presetPeriod } from "./days";
import { RETAIN_DAYS } from "./store";
import { isGroupBy, type GroupBy, type PeriodInfo } from "./types";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string };

/** The preset a request without a period gets. */
export const DEFAULT_PRESET = "7d";
export const DEFAULT_GROUP_BY: GroupBy = "provider";
/** The longest chat id a deep dive accepts; real ids are UUIDs. */
const MAX_SESSION_ID_CHARS = 200;

type Params = Pick<URLSearchParams, "get" | "has">;

/**
 * The period a request asks for: `from` and `to` together (a custom range) or
 * a `preset`; with neither, the last 7 days. A custom range is pulled in to the
 * days the index keeps and never reaches past today, so a typo cannot ask for
 * a thousand empty days. A range that lies wholly outside them is refused.
 */
export function parsePeriod(params: Params, today: string): ParseResult<PeriodInfo> {
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null || to !== null) {
    if (from === null || to === null) return { ok: false, error: "from and to must be given together", code: "invalid_range" };
    const asked = customPeriod(from, to);
    if (!asked) return { ok: false, error: "from and to must be real days (YYYY-MM-DD) with from not after to", code: "invalid_range" };
    const earliest = addDays(today, 1 - RETAIN_DAYS);
    const kept = customPeriod(asked.from < earliest ? earliest : asked.from, asked.to > today ? today : asked.to);
    if (!kept) return { ok: false, error: `the period lies outside the last ${RETAIN_DAYS} days`, code: "invalid_range" };
    return { ok: true, value: kept };
  }
  const preset = params.get("preset") ?? DEFAULT_PRESET;
  if (!isRangePreset(preset)) return { ok: false, error: "preset must be today, 7d, 30d or 90d", code: "invalid_preset" };
  return { ok: true, value: presetPeriod(preset, today) };
}

/** A deep dive's period: the same query, but a request that names none means "the whole life of the chat", so null. */
export function parseOptionalPeriod(params: Params, today: string): ParseResult<PeriodInfo | null> {
  if (!params.has("from") && !params.has("to") && !params.has("preset")) return { ok: true, value: null };
  return parsePeriod(params, today);
}

export function parseGroupBy(params: Params): ParseResult<GroupBy> {
  const value = params.get("groupBy") ?? DEFAULT_GROUP_BY;
  return isGroupBy(value) ? { ok: true, value } : { ok: false, error: "groupBy must be provider, project, model or worker", code: "invalid_group_by" };
}

/** The chat id of a deep dive request, or null when the request is not one. An id that cannot be a chat id is refused. */
export function parseSession(params: Params): ParseResult<string | null> {
  const value = params.get("session");
  if (value === null) return { ok: true, value: null };
  if (value === "" || value.length > MAX_SESSION_ID_CHARS) return { ok: false, error: "session must be a chat id", code: "invalid_session" };
  return { ok: true, value };
}
