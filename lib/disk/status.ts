import { statSync } from "node:fs";
import * as os from "node:os";
import { getDiskSpace } from "../disk-space";
import { getAgentDir } from "../omp/paths";

/**
 * How full the two filesystems Cody's sessions write to are.
 *
 * - `tmp`: the system temp dir, which also holds every session's scratch.
 * - `data`: the instance data dir (sessions, checkpoints, tools, home).
 *
 * On a ZFS dataset with a quota, statfs reports the quota as the size, so
 * "used against its quota" is simply total minus available. An area whose
 * statfs cannot be read is left out: unknown space never blocks anything.
 *
 * The thresholds are fractions of FREE space. Below `low` sessions are told
 * to clean up; below `critical` new turns are refused. They are repeated in
 * lib/omp/extensions/cody-disk-budget.ts (omp loads that file with no Cody
 * imports), and lib/disk/status.test.mjs keeps the two equal.
 */

export const DISK_LOW_FREE_FRACTION = 0.15;
export const DISK_CRITICAL_FREE_FRACTION = 0.05;

export type DiskAreaId = "tmp" | "data";
export type DiskLevel = "ok" | "low" | "critical";

export interface DiskArea {
  id: DiskAreaId;
  /** The directory probed (not necessarily the mount point). */
  path: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  /** availableBytes / totalBytes, 0..1. */
  freeFraction: number;
  level: DiskLevel;
  /** Set on the second area when both live on the same filesystem, so a
   *  caller does not count (or show) one disk twice. */
  sameFilesystemAs?: DiskAreaId;
}

export function diskAreaPaths(): Array<{ id: DiskAreaId; path: string }> {
  return [
    { id: "tmp", path: os.tmpdir() },
    { id: "data", path: getAgentDir() },
  ];
}

export function levelForFreeFraction(freeFraction: number): DiskLevel {
  if (freeFraction < DISK_CRITICAL_FREE_FRACTION) return "critical";
  if (freeFraction < DISK_LOW_FREE_FRACTION) return "low";
  return "ok";
}

function deviceOf(dir: string): number | null {
  try {
    return statSync(dir).dev;
  } catch {
    return null;
  }
}

/** Read every area now. `probe` is injectable so tests (and the throwaway
 *  low-disk proof) can fake statfs numbers without filling a real disk. */
export function readDiskAreas(
  probe: (dir: string) => { availableBytes: number; totalBytes: number } | null = getDiskSpace,
  paths: Array<{ id: DiskAreaId; path: string }> = diskAreaPaths(),
): DiskArea[] {
  const areas: DiskArea[] = [];
  const seenDevices = new Map<number, DiskAreaId>();
  for (const { id, path } of paths) {
    const space = probe(path);
    if (!space || !(space.totalBytes > 0)) continue;
    const availableBytes = Math.max(0, Math.min(space.availableBytes, space.totalBytes));
    const freeFraction = availableBytes / space.totalBytes;
    const area: DiskArea = {
      id,
      path,
      totalBytes: space.totalBytes,
      availableBytes,
      usedBytes: space.totalBytes - availableBytes,
      freeFraction,
      level: levelForFreeFraction(freeFraction),
    };
    const device = deviceOf(path);
    if (device !== null) {
      const first = seenDevices.get(device);
      if (first) area.sameFilesystemAs = first;
      else seenDevices.set(device, id);
    }
    areas.push(area);
  }
  return areas;
}

/** The most urgent area, or null when every area is ok (or unreadable). */
export function worstDiskArea(areas: DiskArea[]): DiskArea | null {
  let worst: DiskArea | null = null;
  for (const area of areas) {
    if (area.level === "ok") continue;
    if (!worst || area.freeFraction < worst.freeFraction) worst = area;
  }
  return worst;
}
