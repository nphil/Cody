/**
 * Day arithmetic for the Statistics page.
 *
 * Usage is bucketed by calendar day in ONE time zone, fixed when the index is
 * created (see `StatsStore`), so a day label is just a label: adding or
 * subtracting days is plain UTC date arithmetic and never meets a DST jump. Only
 * turning an instant into its day needs the zone.
 */

import type { PeriodInfo, RangePreset } from "./types";

const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Every real UTC offset is a multiple of 15 minutes, so a day cannot flip inside one. */
const BUCKET_MS = 15 * 60_000;
const BUCKET_CACHE_MAX = 200_000;

export const PRESET_DAYS: Record<RangePreset, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

export function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === "string" && Object.hasOwn(PRESET_DAYS, value);
}

/** `Date.UTC` of a YYYY-MM-DD label, or NaN when it is not a real calendar day. */
function dayLabelToUtc(day: string): number {
  const match = DAY_RE.exec(day);
  if (!match) return Number.NaN;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, date);
  const check = new Date(utc);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === date ? utc : Number.NaN;
}

export function isDayLabel(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(dayLabelToUtc(value));
}

function utcToDayLabel(utc: number): string {
  const date = new Date(utc);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/** The day `delta` days after (negative: before) `day`. */
export function addDays(day: string, delta: number): string {
  return utcToDayLabel(dayLabelToUtc(day) + delta * DAY_MS);
}

/** Whole days from `from` to `to`; 0 for the same day, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayLabelToUtc(to) - dayLabelToUtc(from)) / DAY_MS);
}

/** YYYY-MM-DD → 20261112, the compact form rows are stored in. */
export function dayToInt(day: string): number {
  return Number(day.slice(0, 4)) * 10_000 + Number(day.slice(5, 7)) * 100 + Number(day.slice(8, 10));
}

export function intToDay(value: number): string {
  const year = Math.floor(value / 10_000);
  const month = Math.floor((value % 10_000) / 100);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(value % 100).padStart(2, "0")}`;
}

/** Every day from `from` to `to` inclusive. Empty when `to` is before `from`. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const count = daysBetween(from, to);
  for (let i = 0; i <= count; i += 1) out.push(addDays(from, i));
  return out;
}

/**
 * A function from an instant (ms) to its yyyymmdd day in `zone`.
 *
 * `Intl.DateTimeFormat#format` costs microseconds and a first index pass asks
 * it hundreds of thousands of times, so answers are cached per quarter hour.
 */
export function makeDayOf(zone: string): (ts: number) => number {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const cache = new Map<number, number>();
  return (ts) => {
    const bucket = Math.floor(ts / BUCKET_MS);
    const hit = cache.get(bucket);
    if (hit !== undefined) return hit;
    const parts = format.formatToParts(ts);
    let year = 0;
    let month = 0;
    let day = 0;
    for (const part of parts) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
    }
    const value = year * 10_000 + month * 100 + day;
    if (cache.size >= BUCKET_CACHE_MAX) cache.clear();
    cache.set(bucket, value);
    return value;
  };
}

/** The day label of "now" in `zone`. */
export function todayIn(zone: string, now: number): string {
  return intToDay(makeDayOf(zone)(now));
}

/** A preset ends today and reaches back `days - 1` days. */
export function presetPeriod(preset: RangePreset, today: string): PeriodInfo {
  const days = PRESET_DAYS[preset];
  return { from: addDays(today, 1 - days), to: today, days, preset };
}

/** A custom period; null unless both labels are real days with `from <= to`. */
export function customPeriod(from: unknown, to: unknown): PeriodInfo | null {
  if (!isDayLabel(from) || !isDayLabel(to)) return null;
  const span = daysBetween(from, to);
  if (span < 0) return null;
  return { from, to, days: span + 1, preset: null };
}

/**
 * The period of the same length that ends the day before `period` starts: the
 * 7 days before the last 7, yesterday for today. What every "vs last ..."
 * comparison on the page measures against.
 */
export function previousPeriod(period: PeriodInfo): PeriodInfo {
  return { from: addDays(period.from, -period.days), to: addDays(period.from, -1), days: period.days, preset: null };
}
