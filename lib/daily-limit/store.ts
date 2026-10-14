import { randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getDailyLimitPath } from "../auth/paths";
import { listUsers, type UserRecord } from "../auth/users";
import { isRecord } from "../type-guards";
import { addInterval, LEDGER_RETENTION_DAYS, localDayKey, normalizeLedger, pruneLedger, type Interval } from "./ledger";
import {
  beatInterval,
  computeDailyLimitState,
  DEFAULT_SETTINGS,
  MAX_EXTRA_SECONDS,
  normalizeDays,
  normalizeSettings,
  parseAddMinutes,
  parseLimitMinutes,
  pruneDays,
  type Beat,
  type DailyLimitSettings,
  type DailyLimitState,
  type DayRecord,
} from "./state";

/**
 * Where each person's daily time limit lives: `<accounts dir>/daily-limit.json`,
 * written atomically with 0600 permissions (what someone does and when is theirs
 * alone). One record per account id, plus one for an OPEN instance (no accounts:
 * whoever is looking is the one person), exactly as the other per-person
 * preferences keep theirs (lib/notifications/store.ts, lib/time-zone-prefs.ts).
 *
 * A record is the person's settings, the notes of the days they have touched,
 * and the LEDGER of wall-clock stretches they were actively using Cody
 * (`ledger.ts`). The ledger is what makes the total shared across devices: every
 * tab and device reports into the same union. It is pruned to the last 14 days
 * and capped in size on every write, so nothing here grows without bound.
 *
 * The file is Cody's own but a person can hand-edit it, so a read re-checks
 * everything and degrades field by field; a write is strict and refuses a value
 * out of range. Every function reads, changes and writes within one synchronous
 * turn, so two requests can never interleave a half-written record.
 */

/** The record key of the open-instance person. */
export const INSTANCE_KEY = "__instance";

/** A write the store refused. `code` is what the route puts on the 400. */
export class InvalidDailyLimitError extends Error {
  readonly code = "invalid_daily_limit";

  constructor(message: string) {
    super(message);
    this.name = "InvalidDailyLimitError";
  }
}

interface PersonRecord {
  settings: DailyLimitSettings;
  days: Record<string, DayRecord>;
  intervals: Interval[];
}

interface DailyLimitFile {
  version: 1;
  accounts: Record<string, PersonRecord>;
}

/** The key a person's record is stored under. */
export function limitKeyFor(user: UserRecord | null): string {
  return user ? user.id : INSTANCE_KEY;
}

function emptyRecord(): PersonRecord {
  return { settings: { ...DEFAULT_SETTINGS }, days: {}, intervals: [] };
}

function parseRecord(raw: unknown, now: number): PersonRecord {
  const record = isRecord(raw) ? raw : {};
  return {
    settings: normalizeSettings(record.settings),
    days: normalizeDays(record.days),
    intervals: normalizeLedger(record.intervals, now),
  };
}

function readFile(now: number): DailyLimitFile {
  const empty: DailyLimitFile = { version: 1, accounts: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getDailyLimitPath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.accounts)) return empty;
    const accounts: Record<string, PersonRecord> = {};
    for (const [key, value] of Object.entries(parsed.accounts)) accounts[key] = parseRecord(value, now);
    return { version: 1, accounts };
  } catch {
    return empty;
  }
}

function writeFile(file: DailyLimitFile): void {
  const target = getDailyLimitPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function sameLedger(a: readonly Interval[], b: readonly Interval[]): boolean {
  return a.length === b.length && a.every((interval, index) => interval[0] === b[index][0] && interval[1] === b[index][1]);
}

/**
 * Save `file` with `key`'s record replaced. A deleted account's record goes with
 * it the next time anyone saves, but nothing is pruned while the account store
 * reads as empty, so a lost accounts file cannot wipe everyone's day.
 */
function saveRecord(file: DailyLimitFile, key: string, record: PersonRecord, now: number): void {
  file.accounts[key] = {
    settings: record.settings,
    days: pruneDays(record.days, LEDGER_RETENTION_DAYS),
    intervals: pruneLedger(record.intervals, now),
  };
  const live = new Set(listUsers().map((user) => user.id));
  if (live.size > 0) {
    for (const accountKey of Object.keys(file.accounts)) {
      if (accountKey !== INSTANCE_KEY && !live.has(accountKey)) delete file.accounts[accountKey];
    }
  }
  writeFile(file);
}

function stateOf(record: PersonRecord, zone: string, now: number): DailyLimitState {
  return computeDailyLimitState({ settings: record.settings, ledger: record.intervals, days: record.days, now, zone });
}

/** Today, for one person, in `zone`. */
export function readDailyLimitState(user: UserRecord | null, zone: string, now: number = Date.now()): DailyLimitState {
  const record = readFile(now).accounts[limitKeyFor(user)] ?? emptyRecord();
  return stateOf(record, zone, now);
}

/** What a PUT may change, once checked. */
export interface DailyLimitPatch {
  enabled?: boolean;
  limitMinutes?: number;
  /** Minutes to add to TODAY's limit ("Add 15 minutes"). */
  addMinutes?: number;
  /** Dismiss today's "you've reached the limit" notice at the current limit. */
  dismissNotice?: true;
}

const PATCH_KEYS = ["enabled", "limitMinutes", "addMinutes", "dismissNotice"] as const;

/** A PUT body that is acceptable, or an InvalidDailyLimitError saying what is not. */
export function validateDailyLimitPatch(input: unknown): DailyLimitPatch {
  if (!isRecord(input)) throw new InvalidDailyLimitError("The request body must be an object");
  const patch: DailyLimitPatch = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new InvalidDailyLimitError("enabled must be true or false");
    patch.enabled = input.enabled;
  }
  if (input.limitMinutes !== undefined) {
    const minutes = parseLimitMinutes(input.limitMinutes);
    if (minutes === null) throw new InvalidDailyLimitError("limitMinutes must be a whole number of minutes from 5 to 1440");
    patch.limitMinutes = minutes;
  }
  if (input.addMinutes !== undefined) {
    const minutes = parseAddMinutes(input.addMinutes);
    if (minutes === null) throw new InvalidDailyLimitError("addMinutes must be a whole number of minutes from 1 to 240");
    patch.addMinutes = minutes;
  }
  if (input.dismissNotice !== undefined) {
    if (input.dismissNotice !== true) throw new InvalidDailyLimitError("dismissNotice must be true");
    patch.dismissNotice = true;
  }
  if (!PATCH_KEYS.some((key) => patch[key] !== undefined)) throw new InvalidDailyLimitError("Nothing to update");
  return patch;
}

/**
 * Apply a settings change, an "Add time" or a notice dismissal. Throws
 * InvalidDailyLimitError before anything is written. Usage is never touched
 * here: turning the limit off keeps today's total, so turning it on again
 * does not forget the morning.
 */
export function updateDailyLimit(user: UserRecord | null, input: unknown, zone: string, now: number = Date.now()): DailyLimitState {
  const patch = validateDailyLimitPatch(input);
  const file = readFile(now);
  const key = limitKeyFor(user);
  const record = file.accounts[key] ?? emptyRecord();
  if (patch.enabled !== undefined) record.settings.enabled = patch.enabled;
  if (patch.limitMinutes !== undefined) record.settings.limitMinutes = patch.limitMinutes;

  const day = localDayKey(now, zone);
  const today: DayRecord = record.days[day] ?? { extraSeconds: 0, noticeDismissedAtSeconds: null };
  if (patch.addMinutes !== undefined) today.extraSeconds = Math.min(MAX_EXTRA_SECONDS, today.extraSeconds + patch.addMinutes * 60);
  if (patch.dismissNotice) today.noticeDismissedAtSeconds = record.settings.limitMinutes * 60 + today.extraSeconds;
  if (patch.addMinutes !== undefined || patch.dismissNotice) record.days[day] = today;

  saveRecord(file, key, record, now);
  return stateOf(record, zone, now);
}

/**
 * Add one beat from a browser to the person's ledger: the stretch it claims,
 * placed on this server's clock and merged into the union, so a second tab or
 * device reporting the same seconds adds nothing. Nothing is recorded while the
 * limit is off — a person who switched it off is not being counted — and the
 * file is only rewritten when the union actually grew.
 */
export function recordBeat(user: UserRecord | null, beat: Beat, zone: string, now: number = Date.now()): DailyLimitState {
  const file = readFile(now);
  const key = limitKeyFor(user);
  const record = file.accounts[key] ?? emptyRecord();
  if (!record.settings.enabled) return stateOf(record, zone, now);
  const interval = beatInterval(beat, now);
  if (interval) {
    const next = addInterval(record.intervals, interval[0], interval[1]);
    if (!sameLedger(next, record.intervals)) {
      record.intervals = next;
      saveRecord(file, key, record, now);
    }
  }
  return stateOf(record, zone, now);
}
