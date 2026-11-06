import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

/**
 * How hard Cody's own janitor works to keep the disk from filling.
 *
 * Nothing on the host cleans up after Cody (no cron, no host script, by
 * design): this file and the janitor that reads it are the only cleanup. One
 * small file in the instance data dir beside the other Cody-level state, 0600
 * and written atomically. A missing or damaged file reads as the defaults,
 * value by value, so a hand-edit can never switch the janitor off by accident.
 */

const FILE_NAME = "cody-disk.json";

export interface DiskSettings {
  /** A session's scratch dir is removed once the session has been idle (no
   *  live engine, no activity) this many days. */
  scratchIdleDays: number;
  /** A top-level entry of the system temp dir is swept once nothing inside it
   *  changed for this many hours (and nothing uses or mentions it). */
  tmpIdleHours: number;
  /** The same for top-level DIRECTORIES of `$HOME/tmp` (files there are kept:
   *  helper scripts and tokens live there). */
  homeTmpIdleHours: number;
  /** Above this percentage used on the temp or data filesystem, the janitor
   *  also removes the scratch of the longest-idle sessions first. */
  budgetPercent: number;
  /** Workspace undo snapshots: total size cap in GB … */
  checkpointMaxGb: number;
  /** … and age cap in days for a shadow repo nobody has used. */
  checkpointMaxAgeDays: number;
}

export const DISK_SETTINGS_DEFAULTS: Readonly<DiskSettings> = Object.freeze({
  scratchIdleDays: 3,
  tmpIdleHours: 24,
  homeTmpIdleHours: 72,
  budgetPercent: 70,
  checkpointMaxGb: 5,
  checkpointMaxAgeDays: 14,
});

/** Inclusive bounds per field. A value outside them is refused on write and
 *  replaced by the default on read. */
export const DISK_SETTINGS_BOUNDS: Readonly<Record<keyof DiskSettings, readonly [number, number]>> = Object.freeze({
  scratchIdleDays: [1, 90],
  tmpIdleHours: [6, 720],
  homeTmpIdleHours: [24, 2160],
  budgetPercent: [40, 95],
  checkpointMaxGb: [1, 500],
  checkpointMaxAgeDays: [1, 365],
});

const KEYS = Object.keys(DISK_SETTINGS_DEFAULTS) as Array<keyof DiskSettings>;

export function getDiskSettingsPath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

function inBounds(key: keyof DiskSettings, value: unknown): value is number {
  const [min, max] = DISK_SETTINGS_BOUNDS[key];
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function readDiskSettings(): DiskSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getDiskSettingsPath(), "utf8"));
  } catch {
    parsed = null;
  }
  const settings: DiskSettings = { ...DISK_SETTINGS_DEFAULTS };
  if (!isRecord(parsed)) return settings;
  for (const key of KEYS) {
    if (inBounds(key, parsed[key])) settings[key] = parsed[key];
  }
  return settings;
}

export class DiskSettingsError extends Error {
  constructor(readonly field: keyof DiskSettings | null) {
    super(field ? `${field} is outside its allowed range` : "Disk settings must be an object");
    this.name = "DiskSettingsError";
  }
}

/** Apply a partial update and persist the result. Unknown keys are ignored; a
 *  known key with an out-of-range value throws `DiskSettingsError`. */
export function writeDiskSettings(patch: unknown): DiskSettings {
  if (!isRecord(patch)) throw new DiskSettingsError(null);
  const next = readDiskSettings();
  for (const key of KEYS) {
    if (!(key in patch)) continue;
    if (!inBounds(key, patch[key])) throw new DiskSettingsError(key);
    next[key] = patch[key];
  }
  const file = getDiskSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return next;
}
