import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@/lib/omp/paths";
import {
  applyChanged,
  applySeen,
  normalizeKeys,
  normalizeVersion,
  parseCounter,
  parseSnapshot,
  pruneCounters,
  syncSnapshot,
  visibleNewKeys,
  type EngineSnapshot,
  type KeyCounter,
} from "@/lib/settings-new-keys";
import { isRecord } from "@/lib/type-guards";

/**
 * The ledger behind the "New" badge on engine settings.
 *
 * An engine update adds settings and nothing says so: the Behavior hub renders
 * whatever schema the engine declares, so a setting that arrived with the
 * update looks like it was always there. This file is what makes "new" a fact:
 * it keeps, per engine, the key set Cody saw the last time it looked, and a
 * key the engine now declares that the last look did not have is new. The
 * rules themselves (what is new, when a badge fades) are the pure functions in
 * lib/settings-new-keys.ts; this module only reads and writes them to disk.
 *
 * Two layers, one file:
 *
 *   - `engines[engineId]`: the snapshot (`EngineSnapshot`), including the
 *     still-new keys and the engine version that brought each;
 *   - `users[ownerKey][engineId][key]`: one person's counter for one new key
 *     (`KeyCounter`): in how many separate Settings opens the chip was seen,
 *     and whether they changed the key. The badge fades for them at 3 counted
 *     opens or the first change, and for nobody else.
 *
 * `ownerKey` is the account id, or one fixed key for the open instance (no
 * accounts), the same idea as `trustOwnerKeyFor` in lib/devices/trust-store.ts.
 *
 * The first look at an engine only records the keys: nothing is new, so a
 * fresh install (or a lost ledger) never badges every setting. A file that is
 * missing, unreadable or malformed reads as empty for the same reason.
 *
 * Cody-level state, so it lives in the instance data dir (`getAgentDir()`)
 * and survives engine switches. Every write is read-modify-write with no
 * await in between, so two requests in this process cannot interleave.
 */

export const SETTINGS_SEEN_FILE = "cody-settings-seen.json";
const LEDGER_VERSION = 1;

/** The owner key of the open instance (no accounts). */
export const INSTANCE_SETTINGS_KEY = "__instance";

/** The owner key an actor reads and writes under: their account id, or the instance's on an open instance. */
export function settingsOwnerKeyFor(user: { id: string } | null | undefined): string {
  return user ? user.id : INSTANCE_SETTINGS_KEY;
}

type UserCounters = Record<string, Record<string, KeyCounter>>;

interface LedgerFile {
  version: number;
  engines: Record<string, EngineSnapshot>;
  /** ownerKey -> engineId -> key -> counter. */
  users: Record<string, UserCounters>;
}

export function getSettingsSeenPath(): string {
  return path.join(getAgentDir(), SETTINGS_SEEN_FILE);
}

function emptyLedger(): LedgerFile {
  return { version: LEDGER_VERSION, engines: {}, users: {} };
}

function readLedgerFile(): LedgerFile {
  const file = emptyLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getSettingsSeenPath(), "utf8"));
  } catch {
    // Missing or unreadable reads as "never looked", the same answer as a
    // corrupt file: the next look re-records the keys and badges nothing.
    return file;
  }
  if (!isRecord(parsed)) return file;
  if (isRecord(parsed.engines)) {
    for (const [engineId, raw] of Object.entries(parsed.engines)) {
      const snapshot = engineId ? parseSnapshot(raw) : null;
      if (snapshot) file.engines[engineId] = snapshot;
    }
  }
  if (isRecord(parsed.users)) {
    for (const [ownerKey, rawEngines] of Object.entries(parsed.users)) {
      if (!ownerKey || !isRecord(rawEngines)) continue;
      const engines: UserCounters = {};
      for (const [engineId, rawKeys] of Object.entries(rawEngines)) {
        if (!engineId || !isRecord(rawKeys)) continue;
        const counters: Record<string, KeyCounter> = {};
        for (const [key, rawCounter] of Object.entries(rawKeys)) {
          const counter = key ? parseCounter(rawCounter) : null;
          if (counter) counters[key] = counter;
        }
        if (Object.keys(counters).length > 0) engines[engineId] = counters;
      }
      if (Object.keys(engines).length > 0) file.users[ownerKey] = engines;
    }
  }
  return file;
}

function writeLedgerFile(file: LedgerFile): void {
  const target = getSettingsSeenPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Atomic: a crash mid-write leaves the previous ledger intact rather than a
  // truncated file that would read as "never looked" and lose which keys are
  // new and how often each was seen.
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export interface EngineKeysSync {
  /** The engine version the snapshot carries (`UNKNOWN_ENGINE_VERSION` when it could not be read). */
  engineVersion: string;
  /** The version before the last change of version, or null. */
  previousVersion: string | null;
  /** This look was the first one at the engine: the keys were only recorded. */
  firstRun: boolean;
  /** Every key still new for the engine, with the version that brought it. Terminal-only keys included. */
  introduced: Record<string, string>;
}

/**
 * One look at the engine's schema. Records the first look, and on a later look
 * that differs (a new engine version, or a different key set) turns the keys
 * the previous snapshot lacked into the new set, drops the ones that left the
 * schema, and replaces the snapshot with the current one; people's counters
 * for keys that left go with them. A look that changes nothing writes nothing.
 *
 * An empty key set changes nothing at all: a schema that could not be read is
 * not an engine that lost every setting, and must not wipe the snapshot. With
 * no snapshot to report either, nothing is new and nothing is recorded.
 */
export function syncEngineKeys(engineId: string, engineVersion: string | null | undefined, keys: Iterable<unknown>): EngineKeysSync {
  const current = normalizeKeys(keys);
  const file = readLedgerFile();
  const previous = file.engines[engineId];
  if (current.length === 0) {
    return previous
      ? { engineVersion: previous.engineVersion, previousVersion: previous.previousVersion, firstRun: false, introduced: { ...previous.introduced } }
      : { engineVersion: normalizeVersion(engineVersion), previousVersion: null, firstRun: false, introduced: {} };
  }
  const sync = syncSnapshot(previous, engineVersion, current);
  if (sync.changed) {
    file.engines[engineId] = sync.snapshot;
    for (const [ownerKey, engines] of Object.entries(file.users)) {
      const counters = engines[engineId];
      if (!counters) continue;
      const kept = pruneCounters(counters, sync.snapshot.introduced);
      if (Object.keys(kept).length > 0) engines[engineId] = kept;
      else delete engines[engineId];
      if (Object.keys(engines).length === 0) delete file.users[ownerKey];
    }
    writeLedgerFile(file);
  }
  return {
    engineVersion: sync.snapshot.engineVersion,
    previousVersion: sync.snapshot.previousVersion,
    firstRun: sync.firstRun,
    introduced: { ...sync.snapshot.introduced },
  };
}

export interface UserNewKeys {
  /** The new keys this person has not yet seen enough times or changed, sorted. */
  newKeys: string[];
  /** The engine version that brought each of `newKeys`. */
  since: Record<string, string>;
}

function userNewKeys(file: LedgerFile, ownerKey: string, engineId: string, eligible?: ReadonlySet<string>): UserNewKeys {
  const introduced = file.engines[engineId]?.introduced ?? {};
  const counters = file.users[ownerKey]?.[engineId];
  const newKeys = visibleNewKeys(introduced, counters).filter((key) => !eligible || eligible.has(key));
  const since: Record<string, string> = {};
  for (const key of newKeys) since[key] = introduced[key];
  return { newKeys, since };
}

/**
 * What is still badged for one person. `eligible`, when given, narrows the
 * answer to keys that can show a badge at all (the caller leaves out rows a
 * browser has no use for, such as terminal-only ones).
 */
export function readUserNewKeys(ownerKey: string, engineId: string, eligible?: ReadonlySet<string>): UserNewKeys {
  return userNewKeys(readLedgerFile(), ownerKey, engineId, eligible);
}

function updateCounters(
  ownerKey: string,
  engineId: string,
  keys: Iterable<unknown>,
  eligible: ReadonlySet<string> | undefined,
  update: (counter: KeyCounter | undefined) => KeyCounter,
): UserNewKeys {
  const file = readLedgerFile();
  const introduced = file.engines[engineId]?.introduced ?? {};
  const owned = file.users[ownerKey]?.[engineId] ?? {};
  const next: Record<string, KeyCounter> = { ...owned };
  let touched = false;
  for (const key of normalizeKeys(keys)) {
    // Only a key that is new for the engine has a counter: anything else is
    // not badged, and a client cannot grow the ledger with keys of its own.
    if (!(key in introduced) || (eligible && !eligible.has(key))) continue;
    const updated = update(next[key]);
    if (updated !== next[key]) {
      next[key] = updated;
      touched = true;
    }
  }
  if (touched) {
    const engines: UserCounters = { ...(file.users[ownerKey] ?? {}), [engineId]: next };
    file.users[ownerKey] = engines;
    writeLedgerFile(file);
  }
  return userNewKeys(file, ownerKey, engineId, eligible);
}

/**
 * The chips of `keys` were seen in the Settings open `openId`. Counts once per
 * (person, key, open): the counter stores the last open it counted, so a
 * retried or duplicated report cannot count twice. Returns what is still
 * badged for the person afterwards.
 */
export function recordSeen(
  ownerKey: string,
  engineId: string,
  keys: Iterable<unknown>,
  openId: string,
  eligible?: ReadonlySet<string>,
): UserNewKeys {
  return updateCounters(ownerKey, engineId, keys, eligible, (counter) => applySeen(counter, openId));
}

/** The value of `keys` was changed through Settings: the badge is gone for that person for good. */
export function recordChanged(ownerKey: string, engineId: string, keys: Iterable<unknown>, eligible?: ReadonlySet<string>): UserNewKeys {
  return updateCounters(ownerKey, engineId, keys, eligible, (counter) => applyChanged(counter));
}
