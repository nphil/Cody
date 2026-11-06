import { runDiskJanitor, type JanitorReport, type JanitorTrigger } from "../disk/janitor";
import type { DiskAreaId } from "../disk/status";
import { formatBytes } from "../format-bytes";
import { sweepOmpTempFiles } from "../omp/temp-files";

/**
 * Long-running cleanup the server does on its own, so an install never
 * depends on a host cron or a user script to stop leftovers piling up.
 * Runs shortly after boot (never on the startup path itself) and then every
 * hour; every timer is unref'd so it never keeps the process alive.
 *
 * Each pass is the disk janitor (lib/disk/janitor.ts: chat scratch dirs, the
 * flat sweep of the temp dir, undo snapshots, the disk budget) followed by
 * omp's own temp leftovers (browser screenshots, helper stderr dirs — see
 * lib/omp/temp-files.ts). The omp sweep runs whichever engine is active: the
 * files exist only if omp ran, and a switch away from omp must not strand the
 * ones it already left. It stays beside the janitor because it needs nothing
 * from /proc, so it still works where the janitor cannot tell what is in use.
 */
const FIRST_RUN_DELAY_MS = 60_000;
const INTERVAL_MS = 60 * 60 * 1000;

/** What one pass runs. A test passes stand-ins, so it never sweeps a real temp dir. */
export interface HousekeepingJobs {
  janitor: (trigger: JanitorTrigger) => Promise<JanitorReport>;
  ompTemp: () => Promise<{ removed: number; bytes: number }>;
}

const DEFAULT_JOBS: HousekeepingJobs = {
  janitor: (trigger) => runDiskJanitor({ trigger }),
  ompTemp: () => sweepOmpTempFiles(),
};

const AREA_LABELS: Record<DiskAreaId, string> = { tmp: "temp disk", data: "data disk" };

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** One plain line: what went, how much, and how the disks moved. */
function describeRun(report: JanitorReport): string {
  const kinds = { scratch: 0, temp: 0, snapshots: 0 };
  for (const removal of report.removed) {
    if (removal.reason === "checkpoint") kinds.snapshots += 1;
    else if (removal.reason.startsWith("scratch")) kinds.scratch += 1;
    else kinds.temp += 1;
  }
  const parts = [
    kinds.scratch > 0 ? count(kinds.scratch, "chat scratch folder", "chat scratch folders") : "",
    kinds.temp > 0 ? count(kinds.temp, "old temp file or folder", "old temp files and folders") : "",
    kinds.snapshots > 0 ? count(kinds.snapshots, "old undo-snapshot store", "old undo-snapshot stores") : "",
  ].filter(Boolean);
  const moved: string[] = [];
  for (const after of report.areasAfter) {
    const before = report.areasBefore.find((area) => area.id === after.id);
    if (!before) continue;
    const from = Math.round((before.usedBytes / before.totalBytes) * 100);
    const to = Math.round((after.usedBytes / after.totalBytes) * 100);
    if (from !== to) moved.push(`${AREA_LABELS[after.id]} ${from}% → ${to}% used`);
  }
  const problems = report.errors.length > 0 ? `; ${count(report.errors.length, "problem", "problems")} (see Settings › System)` : "";
  return `${report.trigger} pass removed ${count(report.removed.length, "item", "items")}, ${formatBytes(report.freedBytes)} (${parts.join(", ")})${moved.length > 0 ? `; ${moved.join(", ")}` : ""}${problems}`;
}

/** One pass. Never rejects: it runs from a timer, where a rejection would take the server down. */
async function runOnce(trigger: JanitorTrigger, jobs: HousekeepingJobs): Promise<void> {
  try {
    const report = await jobs.janitor(trigger);
    if (report.removed.length > 0) console.log(`[Cody] disk janitor: ${describeRun(report)}`);
  } catch (error) {
    console.warn(`[Cody] disk janitor failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { removed, bytes } = await jobs.ompTemp();
    if (removed > 0) {
      console.log(`[Cody] housekeeping: removed ${removed} old engine temp file(s), ${(bytes / 1_048_576).toFixed(1)} MB`);
    }
  } catch (error) {
    console.warn(`[Cody] housekeeping failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let started: { first: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null = null;

export function startEngineHousekeeping(jobs: HousekeepingJobs = DEFAULT_JOBS): void {
  if (started) return;
  const first = setTimeout(() => void runOnce("boot", jobs), FIRST_RUN_DELAY_MS);
  const every = setInterval(() => void runOnce("hourly", jobs), INTERVAL_MS);
  first.unref?.();
  every.unref?.();
  started = { first, every };
}

export function stopEngineHousekeeping(): void {
  if (!started) return;
  clearTimeout(started.first);
  clearInterval(started.every);
  started = null;
}
