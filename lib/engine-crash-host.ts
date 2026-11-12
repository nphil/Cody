import * as fs from "node:fs";
import { parseCgroupEvents, type CgroupCounters, type EngineCrashDisk } from "./engine-crash";
import { readDiskAreas } from "./disk/status";

/**
 * What the machine itself says about an engine that died: the container's
 * cgroup counters (the kernel's record of a process it killed for memory, and
 * of forks it refused), and how full Cody's disks are. Server-side only; the
 * pure classifier is lib/engine-crash.ts.
 *
 * Every read here is one small file, and none of them throws: a host with no
 * cgroup (macOS, a bare Windows box) simply has no counters, and the
 * classifier reads that as "the kernel did not say".
 */

function readCounter(files: string[], key: string): number | null {
  for (const file of files) {
    try {
      const value = parseCgroupEvents(fs.readFileSync(file, "utf8"))[key];
      if (typeof value === "number") return value;
    } catch {
      // Not there on this host: try the next layout.
    }
  }
  return null;
}

/** cgroup v2 first, then the v1 files a few older hosts still use. */
const MEMORY_EVENTS = ["/sys/fs/cgroup/memory.events", "/sys/fs/cgroup/memory/memory.oom_control"];
const PIDS_EVENTS = ["/sys/fs/cgroup/pids.events"];

export function readCgroupCounters(): CgroupCounters {
  return {
    oomKill: readCounter(MEMORY_EVENTS, "oom_kill"),
    pidsMax: readCounter(PIDS_EVENTS, "max"),
  };
}

/** Cody's two disks and how full each is, for naming the one a write failed on. Empty when they cannot be read. */
export function readEngineCrashDisks(): Array<{ id: EngineCrashDisk; path: string; freeFraction: number }> {
  try {
    return readDiskAreas().map((area) => ({ id: area.id, path: area.path, freeFraction: area.freeFraction }));
  } catch {
    return [];
  }
}
