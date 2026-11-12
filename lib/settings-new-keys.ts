/**
 * The rules behind the "New" badge on engine settings: which setting keys an
 * engine update added, and when the badge fades for one person.
 *
 * Pure and browser-safe on purpose (no Node imports): the server's ledger
 * (lib/settings-seen.ts) decides with these functions, and the Settings dialog
 * can reason about the same shapes without a second copy of the rules.
 *
 * Two layers:
 *
 *   - PER ENGINE, a snapshot of the keys Cody saw the last time it looked
 *     (`EngineSnapshot`). A key in the engine's current schema that the
 *     snapshot does not have is "new since the last engine update"; the
 *     snapshot then moves on to the current key set. The very first look at an
 *     engine only records: nothing is new, otherwise a fresh install would
 *     badge every one of ~550 settings.
 *   - PER PERSON, a counter per new key (`KeyCounter`). The badge fades for
 *     that person after the chip has been seen in `FADE_AFTER_SEEN` separate
 *     Settings opens, or once they have changed the key.
 */
import { asNumber, isRecord } from "./type-guards";

/** A badge fades for a person once its chip has been seen in this many
 * separate Settings opens (or the key was changed, whichever comes first). */
export const FADE_AFTER_SEEN = 3;

/** Stored in place of an engine version Cody could not read, so a snapshot
 * still exists and still diffs by key set. */
export const UNKNOWN_ENGINE_VERSION = "unknown";

export interface EngineSnapshot {
  /** The engine version when this snapshot was taken (`UNKNOWN_ENGINE_VERSION` when it could not be read). */
  engineVersion: string;
  /** The version the snapshot before it carried; null until the version changes. */
  previousVersion: string | null;
  /** Every key the engine's schema declared, sorted. Terminal-only rows included. */
  keys: string[];
  /** Keys that arrived after the first look and are still in the schema, each
   * with the engine version that brought it. Successive upgrades accumulate
   * here; a key that leaves the schema drops out. */
  introduced: Record<string, string>;
}

export interface KeyCounter {
  /** In how many separate Settings opens the chip has been seen; stops at `FADE_AFTER_SEEN`. */
  seen: number;
  /** The Settings open that last counted, so a retried or duplicated report of the same open cannot count twice. */
  openId: string | null;
  /** The key's value was changed through Settings. */
  changed: boolean;
}

/** Deduplicated, sorted, non-empty strings only: the canonical stored form of a key set. */
export function normalizeKeys(keys: Iterable<unknown>): string[] {
  const set = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort();
}

/** The engine version as stored: the text, or the placeholder when there is none. */
export function normalizeVersion(version: unknown): string {
  const text = typeof version === "string" ? version.trim() : "";
  return text || UNKNOWN_ENGINE_VERSION;
}

/**
 * Which of `currentKeys` the previous snapshot did not have. `null` previous
 * keys is the first look: recorded, nothing new.
 */
export function diffEngineKeys(
  previousKeys: readonly string[] | null | undefined,
  currentKeys: Iterable<unknown>,
): { firstRun: boolean; added: string[] } {
  if (!previousKeys) return { firstRun: true, added: [] };
  const known = new Set(previousKeys);
  return { firstRun: false, added: normalizeKeys(currentKeys).filter((key) => !known.has(key)) };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function sameIntroduced(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => right[key] === left[key]);
}

export interface SnapshotSync {
  /** What the ledger should now hold for the engine. */
  snapshot: EngineSnapshot;
  /** There was no snapshot: this look only recorded the keys. */
  firstRun: boolean;
  /** The keys this look found that the previous snapshot did not have. */
  added: string[];
  /** The snapshot differs from the previous one, so it has to be written. */
  changed: boolean;
}

/**
 * Fold one look at the engine's schema into its snapshot.
 *
 *   - first look: record the keys, nothing is new;
 *   - later looks: the keys not in the previous snapshot join `introduced`
 *     under the current engine version, `introduced` keeps what it already
 *     held (so new keys accumulate across upgrades while unfaded) except keys
 *     that left the schema, and the snapshot is replaced by the current one.
 *
 * Only the key set decides what is new. The version is a label: it names the
 * update a key arrived in, and an engine whose version could not be read still
 * diffs.
 *
 * A downgrade adds nothing (the keys are a subset) and drops what vanished; the
 * keys it dropped are new again if the engine comes back to them, the same
 * rule as a model that leaves and returns to the catalog.
 */
export function syncSnapshot(
  previous: EngineSnapshot | null | undefined,
  engineVersion: unknown,
  currentKeys: Iterable<unknown>,
): SnapshotSync {
  const version = normalizeVersion(engineVersion);
  const keys = normalizeKeys(currentKeys);
  if (!previous) {
    return { snapshot: { engineVersion: version, previousVersion: null, keys, introduced: {} }, firstRun: true, added: [], changed: true };
  }
  const { added } = diffEngineKeys(previous.keys, keys);
  const present = new Set(keys);
  const introduced: Record<string, string> = {};
  for (const [key, since] of Object.entries(previous.introduced)) {
    if (present.has(key)) introduced[key] = since;
  }
  for (const key of added) introduced[key] = version;
  const snapshot: EngineSnapshot = {
    engineVersion: version,
    previousVersion: previous.engineVersion !== version ? previous.engineVersion : previous.previousVersion,
    keys,
    introduced,
  };
  const changed = snapshot.engineVersion !== previous.engineVersion
    || snapshot.previousVersion !== previous.previousVersion
    || !sameKeys(snapshot.keys, previous.keys)
    || !sameIntroduced(snapshot.introduced, previous.introduced);
  return { snapshot, firstRun: false, added, changed };
}

/** A snapshot as read from disk: anything that is not one is null, and an
 * `introduced` entry for a key the snapshot does not list is dropped. */
export function parseSnapshot(raw: unknown): EngineSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw.keys)) return null;
  const keys = normalizeKeys(raw.keys);
  const listed = new Set(keys);
  const introduced: Record<string, string> = {};
  if (isRecord(raw.introduced)) {
    for (const [key, since] of Object.entries(raw.introduced)) {
      if (listed.has(key) && typeof since === "string" && since.trim()) introduced[key] = since.trim();
    }
  }
  const previousVersion = typeof raw.previousVersion === "string" && raw.previousVersion.trim() ? raw.previousVersion.trim() : null;
  return { engineVersion: normalizeVersion(raw.engineVersion), previousVersion, keys, introduced };
}

/** A counter as read from disk; null for anything that is not one. */
export function parseCounter(raw: unknown): KeyCounter | null {
  if (!isRecord(raw)) return null;
  const stored = asNumber(raw.seen) ?? 0;
  const seen = Math.min(FADE_AFTER_SEEN, Math.max(0, Math.floor(stored)));
  return { seen, openId: typeof raw.openId === "string" && raw.openId ? raw.openId : null, changed: raw.changed === true };
}

/** The badge is gone for this person: the chip was seen enough times, or the key was changed. */
export function isFaded(counter: KeyCounter | null | undefined): boolean {
  return counter != null && (counter.changed || counter.seen >= FADE_AFTER_SEEN);
}

/**
 * The chip of a key was seen in the Settings open `openId`. Counts once per
 * open: the same `openId` again returns the counter untouched (the very same
 * object), so a retried or duplicated report, or the chip scrolling in and out,
 * cannot count twice. A faded counter stays as it is.
 */
export function applySeen(counter: KeyCounter | null | undefined, openId: string): KeyCounter {
  const current = counter ?? { seen: 0, openId: null, changed: false };
  if (isFaded(current) || current.openId === openId) return current;
  return { ...current, seen: current.seen + 1, openId };
}

/** The key's value was changed through Settings: the badge is gone for good. */
export function applyChanged(counter: KeyCounter | null | undefined): KeyCounter {
  if (counter?.changed) return counter;
  return { seen: counter?.seen ?? 0, openId: counter?.openId ?? null, changed: true };
}

/** The introduced keys one person has neither seen enough times nor changed, sorted. */
export function visibleNewKeys(
  introduced: Readonly<Record<string, string>>,
  counters: Readonly<Record<string, KeyCounter>> | null | undefined,
): string[] {
  return Object.keys(introduced).filter((key) => !isFaded(counters?.[key])).sort();
}

/** The counters of keys that are still introduced: a key that left the schema
 * takes its counter with it, and starts from zero if it ever returns. */
export function pruneCounters(
  counters: Readonly<Record<string, KeyCounter>>,
  introduced: Readonly<Record<string, string>>,
): Record<string, KeyCounter> {
  const kept: Record<string, KeyCounter> = {};
  for (const [key, counter] of Object.entries(counters)) {
    if (key in introduced) kept[key] = counter;
  }
  return kept;
}

/** Bounds of one report, so a client cannot make the server hold or scan an unbounded body. */
export const MAX_REPORT_KEYS = 1000;
export const MAX_REPORT_KEY_CHARS = 200;
export const MAX_OPEN_ID_CHARS = 128;

/** What the Settings dialog tells the server: which new keys it showed in this
 * open (`seen`) and which it changed (`changed`). */
export interface SeenReport {
  /** One random id per Settings open: what makes a repeated report count once. */
  openId: string;
  seen: string[];
  changed: string[];
}

/** The body of a report, normalized, or why it is refused. */
export function parseSeenReport(body: unknown): { report: SeenReport } | { error: string } {
  if (!isRecord(body)) return { error: "The body must be a JSON object" };
  const { openId } = body;
  if (typeof openId !== "string" || !openId.trim() || openId.length > MAX_OPEN_ID_CHARS) {
    return { error: `openId must be a non-empty string of at most ${MAX_OPEN_ID_CHARS} characters` };
  }
  const lists: Record<"seen" | "changed", string[]> = { seen: [], changed: [] };
  for (const field of ["seen", "changed"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (
      !Array.isArray(value)
      || value.length > MAX_REPORT_KEYS
      || !value.every((key) => typeof key === "string" && key.length <= MAX_REPORT_KEY_CHARS)
    ) {
      return { error: `${field} must be an array of at most ${MAX_REPORT_KEYS} setting keys of at most ${MAX_REPORT_KEY_CHARS} characters` };
    }
    lists[field] = normalizeKeys(value);
  }
  return { report: { openId, seen: lists.seen, changed: lists.changed } };
}
