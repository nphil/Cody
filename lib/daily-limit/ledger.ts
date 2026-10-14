/**
 * The daily time limit's ledger: which wall-clock stretches a person was
 * actively using Cody, and how much of today they cover.
 *
 * Pure and browser-safe (no I/O, no Cody imports, only `Intl`): the server
 * stores and merges it (`store.ts`), the tests drive it with plain numbers.
 *
 * What is stored is a list of absolute WALL-CLOCK intervals `[start, end)` in
 * epoch milliseconds, sorted and never overlapping, NOT per-tab counters.
 * That is the whole answer to "two tabs, or a tablet and a PC, at once": each
 * of them reports the stretch it was active, the ledger takes the UNION, and
 * every second is counted at most once per person. A day is a window over the
 * ledger, chosen at read time, so a zone change or a midnight needs no rewrite.
 */

export type Interval = readonly [start: number, end: number];

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** How much history is kept. A day is all anyone is shown; the rest is slack
 * for a person who travels across the date line and for a hand-read file. */
export const LEDGER_RETENTION_DAYS = 14;

/**
 * Two reports closer than this are one stretch. A client reports consecutive
 * beats that touch exactly, but each one lands with its own network delay, so
 * the server sees them overlap or leave a few milliseconds between. Without
 * this a busy day would be thousands of slivers; with it a stretch is one
 * interval. The most a gap can add is this long per beat.
 */
export const MERGE_GAP_MS = 1_000;

/** A person who pokes the page once a minute all day still cannot grow the
 * file without bound: past this the oldest intervals go. */
export const MAX_LEDGER_INTERVALS = 5_000;

/**
 * Insert `[start, end)` and merge everything it overlaps or touches (within
 * `gapMs`). Returns a new array; the input is not changed. An empty or
 * backwards interval changes nothing.
 */
export function addInterval(ledger: readonly Interval[], start: number, end: number, gapMs: number = MERGE_GAP_MS): Interval[] {
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return ledger.slice();
  const merged: Interval[] = [];
  let from = start;
  let to = end;
  let placed = false;
  for (const interval of ledger) {
    const [a, b] = interval;
    if (b + gapMs < from) {
      merged.push(interval);
    } else if (a - gapMs > to) {
      if (!placed) {
        merged.push([from, to]);
        placed = true;
      }
      merged.push(interval);
    } else {
      // Overlaps or touches: it becomes part of the stretch being inserted.
      from = Math.min(from, a);
      to = Math.max(to, b);
    }
  }
  if (!placed) merged.push([from, to]);
  return merged;
}

/** Drop what is older than the retention window (clipping an interval that
 * straddles its edge) and, past `max`, the oldest of what is left. */
export function pruneLedger(
  ledger: readonly Interval[],
  now: number,
  retentionMs: number = LEDGER_RETENTION_DAYS * DAY_MS,
  max: number = MAX_LEDGER_INTERVALS,
): Interval[] {
  const floor = now - retentionMs;
  const kept: Interval[] = [];
  for (const [a, b] of ledger) {
    if (b <= floor) continue;
    kept.push([Math.max(a, floor), b]);
  }
  return kept.length > max ? kept.slice(kept.length - max) : kept;
}

/** The milliseconds of `[from, to)` the ledger covers. */
export function measureWithin(ledger: readonly Interval[], from: number, to: number): number {
  let total = 0;
  for (const [a, b] of ledger) {
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/**
 * Whatever a file or a client handed over, as a clean ledger: finite numbers,
 * each interval forward, sorted, merged, nothing in the future. Never throws.
 */
export function normalizeLedger(raw: unknown, now: number): Interval[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: Array<[number, number]> = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [a, b] = entry as unknown[];
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const end = Math.min(b, now);
    if (end > a) cleaned.push([Math.round(a), Math.round(end)]);
  }
  cleaned.sort((x, y) => x[0] - y[0]);
  const ledger: Interval[] = [];
  for (const [a, b] of cleaned) {
    const last = ledger[ledger.length - 1];
    if (last && a <= last[1]) ledger[ledger.length - 1] = [last[0], Math.max(last[1], b)];
    else ledger.push([a, b]);
  }
  return ledger;
}

// ----------------------------------------------------------------------------
// The local day
// ----------------------------------------------------------------------------

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

function keyFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = keyFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    keyFormatters.set(zone, formatter);
  }
  return formatter;
}

/** The calendar date a person in `zone` reads at instant `ms`: "2026-10-13". */
export function localDayKey(ms: number, zone: string): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of keyFormatter(zone).formatToParts(ms)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

export interface DayBounds {
  /** The local calendar date, "2026-10-13". */
  day: string;
  /** The first millisecond of that date in the zone. */
  start: number;
  /** The first millisecond of the next date: the day is `[start, end)`. */
  end: number;
}

/** No real local date is this long (the longest, a DST fall-back day, is 25 h). */
const SEARCH_SPAN_MS = 36 * HOUR_MS;

/**
 * The local day that contains `ms` in `zone`.
 *
 * A day is not always 24 hours (a DST change makes it 23 or 25) and "midnight"
 * is wherever the zone's calendar date flips, so the edges are FOUND, not
 * computed from an offset: the date is a non-decreasing function of time, which
 * a binary search over `localDayKey` turns into the exact first millisecond of
 * the date and of the next. That also stays right in the zones whose DST change
 * lands on midnight.
 */
export function localDayBounds(ms: number, zone: string): DayBounds {
  const day = localDayKey(ms, zone);
  let lo = ms - SEARCH_SPAN_MS;
  let hi = ms;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDayKey(mid, zone) === day) hi = mid;
    else lo = mid;
  }
  const start = hi;
  lo = ms;
  hi = ms + SEARCH_SPAN_MS;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDayKey(mid, zone) === day) lo = mid;
    else hi = mid;
  }
  return { day, start, end: hi };
}
