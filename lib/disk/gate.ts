import { formatBytes } from "../format-bytes";
import { readDiskAreas, worstDiskArea, type DiskArea } from "./status";

/**
 * The low-disk gate: while a filesystem Cody's sessions write to is almost
 * full (under `DISK_CRITICAL_FREE_FRACTION` free, lib/disk/status.ts), a NEW
 * turn is refused with a reason a person can act on, instead of being started
 * into a disk that cannot hold what it will write. Below the softer `low`
 * line nothing is refused: the running agents are told to clean up instead
 * (lib/omp/extensions/cody-disk-budget.ts).
 *
 * Callers: the two routes that start a turn (`POST /api/agent/new` and
 * `POST /api/agent/[id]`) answer HTTP 507 `disk_full`; a scheduled message
 * counts the refusal as a delivery that can be tried again; and the run
 * supervisor puts a recovery off until there is room. Every import here is
 * relative: the custom server loads this file through a bare jiti.
 */

/**
 * `customType` of the hidden line the agent is given when a disk runs low
 * ("Disk space is low: …", written by lib/omp/extensions/cody-disk-budget.ts).
 * It is for the model, never for the person reading the chat. The extension
 * runs under omp (Bun) with no Cody imports and lib/message-display.ts is
 * loaded by client components, so both repeat this literal;
 * lib/omp/cody-disk-budget.test.mjs pins the three together.
 */
export const DISK_LOW_CUSTOM_TYPE = "cody-disk-low";

export interface DiskGateRefusal {
  code: "disk_full";
  /** The fullest area that is critical. */
  area: DiskArea;
  /** Plain English: what is full and how to clean it. Safe to show as it is. */
  message: string;
}

/** How long one reading is reused: requests arrive in bursts (a retry, several
 *  tabs, a scheduler round) and each reading is a statfs per area. */
const GATE_CACHE_MS = 5_000;

type DiskProbe = NonNullable<Parameters<typeof readDiskAreas>[0]>;

let probe: DiskProbe | undefined;
let clock: () => number = Date.now;
let cached: { at: number; refusal: DiskGateRefusal | null } | null = null;

/** Test hook: read fake statfs numbers on a fake clock instead of the real
 *  disks. `null` puts the real ones back. Either way the cached reading is
 *  dropped, so one test never sees another's answer. */
export function configureDiskGateForTests(inputs: { probe?: DiskProbe; now?: () => number } | null): void {
  probe = inputs?.probe;
  clock = inputs?.now ?? Date.now;
  cached = null;
}

const AREA_WORDS: Record<DiskArea["id"], string> = {
  tmp: "temporary disk space",
  data: "data disk space",
};

function diskFullMessage(area: DiskArea): string {
  // Floored, so a disk that is 4.6% free never reads as "5%" next to a 5% line
  // (the epsilon keeps an exact 3% from floating-point-flooring to 2).
  const percent = Math.floor(area.freeFraction * 100 + 1e-9);
  const free = percent < 1 ? "under 1% free" : `${percent}% free`;
  return `The server's ${AREA_WORDS[area.id]} is almost full (${free}: ${formatBytes(area.availableBytes)} of ${formatBytes(area.totalBytes)}), so Cody is not starting new work right now. `
    + "Press Clean idle scratch now in Settings → System → Disk space, or tell a running agent to delete its scratch files, then send again.";
}

/**
 * Whether a disk is critically low right now. Reads at most every 5 seconds.
 * A disk that cannot be read (no statfs, a vanished path) never blocks anyone:
 * unknown space is not empty space.
 */
export function checkDiskForNewTurn(): DiskGateRefusal | null {
  const now = clock();
  if (cached && now >= cached.at && now - cached.at < GATE_CACHE_MS) return cached.refusal;
  let refusal: DiskGateRefusal | null = null;
  try {
    const worst = worstDiskArea(readDiskAreas(probe));
    if (worst?.level === "critical") refusal = { code: "disk_full", area: worst, message: diskFullMessage(worst) };
  } catch {
    // The gate is a courtesy, never a lock: a failed reading lets the turn through.
    refusal = null;
  }
  cached = { at: now, refusal };
  return refusal;
}

/**
 * Whether a message command would START agent work, as opposed to reaching an
 * agent that is already working. Only a command that starts work is refused
 * when the disk is critical (`checkDiskForNewTurn`):
 *
 * - `prompt` on an idle chat, and `follow_up` (or a `prompt` that asks to be
 *   held as one) even on a running chat, because it begins a new turn as soon
 *   as the running one ends;
 * - `steer` and `abort_and_prompt` on a chat that is already running are let
 *   through. They add no new turn: they redirect the one that is running, and
 *   that is exactly how a person tells a runaway build to stop and clean up.
 *   On an idle chat both are a plain prompt and count as starting work;
 * - `abort`, `bash`, `set_model` and every other command are not messages and
 *   never reach this check.
 */
export function commandStartsNewWork(command: { type?: unknown; streamingBehavior?: unknown }, chatRunning: boolean): boolean {
  switch (command.type) {
    case "follow_up":
      return true;
    case "steer":
    case "abort_and_prompt":
      return !chatRunning;
    case "prompt":
      return !(chatRunning && command.streamingBehavior === "steer");
    default:
      return false;
  }
}
