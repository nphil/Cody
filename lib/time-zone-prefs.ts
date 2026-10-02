import { randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getInstanceTimeZonePath } from "./auth/paths";
import { getSessionOwner } from "./auth/session-owners";
import { findUserById, updateUser, type UserPreferences, type UserRecord } from "./auth/users";
import { normalizeTimeZone, resolveTimeZone, serverTimeZone, type ResolvedTimeZone } from "./time-zone";
import { isRecord } from "./type-guards";

/**
 * Where a person's time zone lives, and the one function that turns it (plus
 * the zone of the message being sent) into the zone an agent runs in.
 *
 * Two values per owner:
 *  - `explicit`   — chosen in Settings → Preferences; absent means "Automatic".
 *  - `deviceZone` — the last browser zone seen for them, saved without asking.
 *    It is only the FALLBACK for a message that carries no device zone of its
 *    own; a message that does carry one is resolved against it live
 *    (lib/time-zone.ts has the precedence).
 *
 * The owner is the signed-in account, or — on an open instance with no
 * accounts — a single instance-level record in the accounts directory, kept
 * the way the other open-instance preferences are (whoever is looking is the
 * administrator). A session with no recorded owner on an instance that does
 * have accounts falls back to that instance record too.
 */

export interface TimeZonePrefs {
  explicit: string | null;
  deviceZone: string | null;
}

/** The caller asked to save a zone this runtime does not know. */
export class InvalidTimeZoneError extends Error {
  readonly code = "invalid_time_zone";

  constructor() {
    super("That is not a time zone this server knows");
    this.name = "InvalidTimeZoneError";
  }
}

function readInstancePrefs(): TimeZonePrefs {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getInstanceTimeZonePath(), "utf8"));
    if (!isRecord(parsed)) return { explicit: null, deviceZone: null };
    return { explicit: normalizeTimeZone(parsed.explicit), deviceZone: normalizeTimeZone(parsed.deviceZone) };
  } catch {
    return { explicit: null, deviceZone: null };
  }
}

function writeInstancePrefs(prefs: TimeZonePrefs): void {
  const target = getInstanceTimeZonePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, ...prefs }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** `user === null` reads the instance-level record. A record handed in may have
 * been read before a write (a request resolves its account once, then saves),
 * so an account's values always come from the store itself. */
export function readTimeZonePrefs(user: UserRecord | null): TimeZonePrefs {
  if (user === null) return readInstancePrefs();
  const stored = findUserById(user.id) ?? user;
  return {
    explicit: stored.preferences?.timeZone ?? null,
    deviceZone: stored.preferences?.deviceTimeZone ?? null,
  };
}

/**
 * Save the zone the person picked, or clear it (`null`) to go back to
 * Automatic. A value that is not a zone is an error, never silently stored:
 * what is saved here becomes an engine's `TZ`.
 */
export function setExplicitTimeZone(user: UserRecord | null, zone: string | null): TimeZonePrefs {
  const normalized = zone === null ? null : normalizeTimeZone(zone);
  if (zone !== null && normalized === null) throw new InvalidTimeZoneError();
  if (user === null) {
    const next = { ...readInstancePrefs(), explicit: normalized };
    writeInstancePrefs(next);
    return next;
  }
  const updated = updateUser(user.id, (record) => {
    const next: UserPreferences = { ...record.preferences };
    if (normalized) next.timeZone = normalized;
    else delete next.timeZone;
    if (Object.keys(next).length > 0) record.preferences = next;
    else delete record.preferences;
  });
  return readTimeZonePrefs(updated);
}

/**
 * Remember the zone of the browser that just spoke. Written only when it
 * differs from what is stored (a send per message must not rewrite the account
 * file per message), and a value that is not a zone is ignored rather than
 * failing the request that carried it — a bad hint must never cost a message.
 */
export function noteDeviceTimeZone(user: UserRecord | null, zone: unknown): TimeZonePrefs {
  const normalized = normalizeTimeZone(zone);
  const current = readTimeZonePrefs(user);
  if (normalized === null || normalized === current.deviceZone) return current;
  if (user === null) {
    const next = { ...readInstancePrefs(), deviceZone: normalized };
    writeInstancePrefs(next);
    return next;
  }
  const updated = updateUser(user.id, (record) => {
    record.preferences = { ...record.preferences, deviceTimeZone: normalized };
  });
  return readTimeZonePrefs(updated);
}

/**
 * The zone for a message from `user`, whose browser reports `deviceZone`
 * (absent for a caller with no browser). Chosen > this device > last seen >
 * the server > UTC.
 */
export function effectiveTimeZone(user: UserRecord | null, deviceZone?: unknown): ResolvedTimeZone {
  const prefs = readTimeZonePrefs(user);
  return resolveTimeZone({ explicit: prefs.explicit, device: deviceZone, lastSeen: prefs.deviceZone, server: serverTimeZone() });
}

/**
 * The zone a message runs under, and a note of the device it came from for next
 * time. The one call the message routes make: it never fails a request over a
 * bad browser value (that is just ignored), and it writes only when the
 * browser's zone is new.
 */
export function zoneForMessage(user: UserRecord | null, deviceZone: unknown): string {
  noteDeviceTimeZone(user, deviceZone);
  return effectiveTimeZone(user, deviceZone).zone;
}

/**
 * The zone for work nobody is typing for: a child started when a session is
 * merely viewed, a background job on a session. The session's owner decides;
 * a session with none uses the instance-level record.
 */
export function ownerTimeZone(sessionId: string | null | undefined): string {
  const ownerId = sessionId ? getSessionOwner(sessionId) : null;
  return effectiveTimeZone(ownerId ? findUserById(ownerId) : null).zone;
}
