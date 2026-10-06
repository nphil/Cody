import { randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getDeviceTrustPath } from "../auth/paths";
import { listUsers, type UserRecord } from "../auth/users";
import { isRecord } from "../type-guards";
import { MAX_TRUSTED_DEVICES, parseTrustedDevice, type TrustedDevice } from "./trust";

/**
 * Where each account's remembered devices live: `<accounts dir>/device-trust.json`,
 * written atomically with 0600 permissions. One record per account id, plus one
 * for an OPEN instance (no accounts: whoever is looking is the administrator,
 * exactly as the notification settings work - lib/notifications/store.ts).
 *
 * A device is in this file only because a person pressed Allow with "Remember
 * this device" in the chat (lib/devices/trust-client.ts is the one writer, and
 * app/api/devices/trust/route.ts refuses a write that does not come from a
 * page). Nothing in this module grants anything on its own.
 *
 * Reads are defensive: the file is Cody's own but a person can hand-edit it, so
 * every stored device is re-checked with the same rules a write uses and an
 * invalid one is dropped. Writes are strict: an invalid device is an error,
 * never something silently stored.
 */

/** The owner key of the open-instance record. */
export const INSTANCE_TRUST_KEY = "__instance";

interface TrustRecord {
  devices: TrustedDevice[];
}

interface TrustFile {
  version: 1;
  accounts: Record<string, TrustRecord>;
  instance?: TrustRecord;
}

/** A write the store refused. `code` is what the route puts on the 400. */
export class InvalidTrustedDeviceError extends Error {
  readonly code = "invalid_trusted_device";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTrustedDeviceError";
  }
}

/** The owner key an actor reads and writes under: their account id, or the instance's on an open instance. */
export function trustOwnerKeyFor(user: UserRecord | null): string {
  return user ? user.id : INSTANCE_TRUST_KEY;
}

/** Newest `grantedAt` first; devices with the same time keep their order. */
function newestFirst(devices: TrustedDevice[]): TrustedDevice[] {
  return devices.sort((left, right) => right.grantedAt - left.grantedAt);
}

/** The lenient half: whatever was on disk, as a clean list. Invalid and repeated entries are dropped. */
function parseRecord(raw: unknown): TrustRecord {
  const devices = new Map<string, TrustedDevice>();
  const stored = isRecord(raw) && Array.isArray(raw.devices) ? raw.devices : [];
  for (const entry of stored) {
    const grantedAt = isRecord(entry) ? entry.grantedAt : undefined;
    if (typeof grantedAt !== "number" || !Number.isFinite(grantedAt) || grantedAt < 0) continue;
    const device = parseTrustedDevice(entry, grantedAt);
    if (!device) continue;
    const existing = devices.get(device.key);
    if (!existing || existing.grantedAt < device.grantedAt) devices.set(device.key, device);
  }
  return { devices: newestFirst([...devices.values()]).slice(0, MAX_TRUSTED_DEVICES) };
}

function readFile(): TrustFile {
  const empty: TrustFile = { version: 1, accounts: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getDeviceTrustPath(), "utf8"));
    if (!isRecord(parsed)) return empty;
    const accounts: Record<string, TrustRecord> = {};
    if (isRecord(parsed.accounts)) {
      for (const [userId, record] of Object.entries(parsed.accounts)) accounts[userId] = parseRecord(record);
    }
    return { version: 1, accounts, ...(isRecord(parsed.instance) ? { instance: parseRecord(parsed.instance) } : {}) };
  } catch {
    return empty;
  }
}

function writeFile(file: TrustFile): void {
  const target = getDeviceTrustPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function recordOf(file: TrustFile, ownerKey: string): TrustRecord | undefined {
  return ownerKey === INSTANCE_TRUST_KEY ? file.instance : file.accounts[ownerKey];
}

function setRecord(file: TrustFile, ownerKey: string, devices: TrustedDevice[]): void {
  if (ownerKey === INSTANCE_TRUST_KEY) {
    if (devices.length > 0) file.instance = { devices };
    else delete file.instance;
  } else if (devices.length > 0) {
    file.accounts[ownerKey] = { devices };
  } else {
    delete file.accounts[ownerKey];
  }
}

/**
 * Saves `file`. A deleted account's record goes with it the next time anyone
 * writes: what it let the agent control must not outlive the person it belonged
 * to. Nothing is pruned while the account store reads as empty, so a lost
 * accounts file cannot wipe the remembered devices.
 */
function save(file: TrustFile): void {
  const live = new Set(listUsers().map((user) => user.id));
  if (live.size > 0) {
    for (const userId of Object.keys(file.accounts)) {
      if (!live.has(userId)) delete file.accounts[userId];
    }
  }
  writeFile(file);
}

/** An owner's remembered devices, newest `grantedAt` first. */
export function listTrustedDevices(ownerKey: string): TrustedDevice[] {
  return [...(recordOf(readFile(), ownerKey)?.devices ?? [])];
}

/**
 * Validate `body` (`parseTrustedDevice`: the key is derived here, never taken
 * from the caller) and remember it for the owner: a device already remembered
 * is refreshed (new `grantedAt`, label and product id as sent), and past
 * `MAX_TRUSTED_DEVICES` the oldest `grantedAt` is dropped. Throws
 * InvalidTrustedDeviceError before anything is written. Answers the owner's list.
 *
 * `now` exists so a test can order grants without waiting.
 */
export function rememberTrustedDevice(ownerKey: string, body: unknown, now: number = Date.now()): TrustedDevice[] {
  const device = parseTrustedDevice(body, now);
  if (!device) throw new InvalidTrustedDeviceError("The device needs a label, a USB vendor id and a serial number");
  const file = readFile();
  const others = (recordOf(file, ownerKey)?.devices ?? []).filter((stored) => stored.key !== device.key);
  const devices = newestFirst([device, ...others]).slice(0, MAX_TRUSTED_DEVICES);
  setRecord(file, ownerKey, devices);
  save(file);
  return [...devices];
}

/** Remove a remembered device. Idempotent: a key the owner does not hold is not an error and writes nothing. Answers the owner's list. */
export function forgetTrustedDevice(ownerKey: string, key: string): TrustedDevice[] {
  const file = readFile();
  const current = recordOf(file, ownerKey)?.devices ?? [];
  const devices = current.filter((stored) => stored.key !== key);
  if (devices.length === current.length) return [...current];
  setRecord(file, ownerKey, devices);
  save(file);
  return [...devices];
}
