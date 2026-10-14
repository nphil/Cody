/**
 * The daily time limit's vocabulary: what is saved, what the server answers,
 * and the arithmetic that turns the ledger into "how much is left today".
 *
 * Pure and browser-safe, like `ledger.ts` beside it: the Settings card, the
 * composer ring and the routes all read the same shapes and the same rules, so
 * the number on the ring and the number in Settings cannot disagree.
 */
import { localDayBounds, measureWithin, type Interval } from "./ledger";

/** The ring turns to its warning colour for the last stretch of the day. */
export const WARNING_SECONDS = 15 * 60;
/** What "Add 15 minutes" adds. */
export const EXTEND_MINUTES = 15;

export const DEFAULT_LIMIT_MINUTES = 120;
export const MIN_LIMIT_MINUTES = 5;
/** A day. A limit of 24 h is no limit, but it is not an error either. */
export const MAX_LIMIT_MINUTES = 24 * 60;
/** The one-tap lengths in Settings; anything else is a custom value. */
export const LIMIT_PRESET_MINUTES: readonly number[] = [60, 120, 180, 240];
/** One press adds at most this much, and one day at most this much altogether. */
export const MAX_ADD_MINUTES = 240;
export const MAX_EXTRA_SECONDS = 16 * 60 * 60;

/** The Settings card's `data-search-id`, where the ring popover's link scrolls
 * to. It is `slugify("Daily time limit")`; the card's test pins that. */
export const DAILY_LIMIT_SETTINGS_ID = "daily-time-limit";

/** What a person chose. Off until they switch it on. */
export interface DailyLimitSettings {
  enabled: boolean;
  limitMinutes: number;
}

export const DEFAULT_SETTINGS: DailyLimitSettings = { enabled: false, limitMinutes: DEFAULT_LIMIT_MINUTES };

/** What one local day carries besides its usage. Keyed by `YYYY-MM-DD` in the person's zone. */
export interface DayRecord {
  /** Seconds added today with "Add 15 minutes". */
  extraSeconds: number;
  /** The limit (in seconds) the person last dismissed the "you've reached it"
   * notice at. The notice shows once per limit reached: adding time raises the
   * limit, so reaching the new one is a new occasion. */
  noticeDismissedAtSeconds: number | null;
}

/** What the routes answer and the browser keeps. */
export interface DailyLimitState {
  enabled: boolean;
  /** The saved daily length. */
  limitMinutes: number;
  /** Today's local date in `zone`. */
  day: string;
  zone: string;
  /** `[dayStartsAt, dayEndsAt)` in epoch ms: the browser refreshes once it is past the end. */
  dayStartsAt: number;
  dayEndsAt: number;
  /** The server's clock when this was computed. */
  serverNow: number;
  /** Active seconds today, all devices together. */
  usedSeconds: number;
  /** Seconds added today with "Add 15 minutes". */
  extraSeconds: number;
  /** Today's limit: the saved length plus what was added. */
  limitSeconds: number;
  /** `limitSeconds - usedSeconds`; zero or negative once the limit is reached. */
  remainingSeconds: number;
  /** The "you've reached today's limit" notice should be showing. */
  noticeDue: boolean;
}

/** A saved length: a whole number of minutes in range. Anything else is null. */
export function parseLimitMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_LIMIT_MINUTES && value <= MAX_LIMIT_MINUTES ? value : null;
}

/** One "Add time" press: a whole number of minutes in range, else null. */
export function parseAddMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ADD_MINUTES ? value : null;
}

/** Saved settings, field by field: a hand-edited file degrades to the defaults. */
export function normalizeSettings(raw: unknown): DailyLimitSettings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: record.enabled === true,
    limitMinutes: parseLimitMinutes(record.limitMinutes) ?? DEFAULT_LIMIT_MINUTES,
  };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Saved day records, dropping anything that is not a date key with sane numbers. */
export function normalizeDays(raw: unknown): Record<string, DayRecord> {
  const days: Record<string, DayRecord> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return days;
  for (const [key, value] of Object.entries(raw)) {
    if (!DAY_KEY.test(key) || typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const extra = typeof record.extraSeconds === "number" && Number.isFinite(record.extraSeconds) ? Math.round(record.extraSeconds) : 0;
    const dismissed = typeof record.noticeDismissedAtSeconds === "number" && Number.isFinite(record.noticeDismissedAtSeconds)
      ? Math.round(record.noticeDismissedAtSeconds)
      : null;
    days[key] = { extraSeconds: Math.min(MAX_EXTRA_SECONDS, Math.max(0, extra)), noticeDismissedAtSeconds: dismissed };
  }
  return days;
}

/** The newest `keep` day records; day keys sort as dates. */
export function pruneDays(days: Readonly<Record<string, DayRecord>>, keep: number): Record<string, DayRecord> {
  const newest = Object.keys(days).sort().slice(-keep);
  const kept: Record<string, DayRecord> = {};
  for (const key of newest) kept[key] = days[key];
  return kept;
}

export interface StateInput {
  settings: DailyLimitSettings;
  ledger: readonly Interval[];
  days: Readonly<Record<string, DayRecord>>;
  now: number;
  /** An IANA zone name. The day is the local date in it. */
  zone: string;
}

/** Today, for one person, as of `now`. The day is the zone's own calendar date,
 * so usage resets at ITS midnight and an interval across midnight splits there. */
export function computeDailyLimitState(input: StateInput): DailyLimitState {
  const bounds = localDayBounds(input.now, input.zone);
  const record = input.days[bounds.day];
  const extraSeconds = record?.extraSeconds ?? 0;
  const limitSeconds = input.settings.limitMinutes * 60 + extraSeconds;
  const usedSeconds = Math.round(measureWithin(input.ledger, bounds.start, Math.min(bounds.end, input.now)) / 1000);
  const remainingSeconds = limitSeconds - usedSeconds;
  const dismissedAt = record?.noticeDismissedAtSeconds ?? null;
  return {
    enabled: input.settings.enabled,
    limitMinutes: input.settings.limitMinutes,
    day: bounds.day,
    zone: input.zone,
    dayStartsAt: bounds.start,
    dayEndsAt: bounds.end,
    serverNow: input.now,
    usedSeconds,
    extraSeconds,
    limitSeconds,
    remainingSeconds,
    noticeDue: input.settings.enabled && remainingSeconds <= 0 && dismissedAt !== limitSeconds,
  };
}

/** A beat from a browser, checked and capped. */
export interface Beat {
  activeMs: number;
  endedAgoMs: number;
}

/** The most one beat may claim. A page reports every 15 s; a late timer or a
 * stretch that ran out its grace can be a little longer, never this long. */
export const MAX_BEAT_SECONDS = 90;
/** How long after a stretch ended its report may still arrive. */
export const MAX_ENDED_AGO_SECONDS = 120;

/**
 * A beat body (`{ activeSeconds, endedSecondsAgo? }`) in milliseconds, or null
 * when it is not one. Too long a stretch is CAPPED, not refused: the cap is what
 * bounds how much a single request can ever add. A beat is a claim about the
 * past, so it can never end in the future.
 */
export function parseBeat(body: unknown): Beat | null {
  if (typeof body !== "object" || body === null) return null;
  const { activeSeconds, endedSecondsAgo } = body as Record<string, unknown>;
  if (typeof activeSeconds !== "number" || !Number.isFinite(activeSeconds) || activeSeconds <= 0) return null;
  if (endedSecondsAgo !== undefined && (typeof endedSecondsAgo !== "number" || !Number.isFinite(endedSecondsAgo) || endedSecondsAgo < 0)) return null;
  return {
    activeMs: Math.round(Math.min(activeSeconds, MAX_BEAT_SECONDS) * 1000),
    endedAgoMs: Math.round(Math.min(endedSecondsAgo ?? 0, MAX_ENDED_AGO_SECONDS) * 1000),
  };
}

/** Where a beat that reached the server at `now` sits on the server's clock. */
export function beatInterval(beat: Beat, now: number): Interval | null {
  const end = now - beat.endedAgoMs;
  const start = end - beat.activeMs;
  return end > start && end > 0 ? [start, end] : null;
}
