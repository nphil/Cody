import { sweepOmpTempFiles } from "../omp/temp-files";

/**
 * Long-running cleanup the server does on its own, so an install never
 * depends on a host cron or a user script to stop engine leftovers piling
 * up. Runs shortly after boot (never on the startup path itself) and then
 * once a day; every timer is unref'd so it never keeps the process alive.
 *
 * Today that is omp's temp-dir leftovers (browser screenshots, helper
 * stderr dirs — see lib/omp/temp-files.ts), swept whichever engine is
 * active: the files exist only if omp ran, and a switch away from omp must
 * not strand the ones it already left.
 */
const FIRST_RUN_DELAY_MS = 60_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

let started: { first: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null = null;

async function runOnce(): Promise<void> {
  const { removed, bytes } = await sweepOmpTempFiles();
  if (removed > 0) {
    console.log(`[Cody] housekeeping: removed ${removed} old engine temp file(s), ${(bytes / 1_048_576).toFixed(1)} MB`);
  }
}

export function startEngineHousekeeping(): void {
  if (started) return;
  const first = setTimeout(() => void runOnce(), FIRST_RUN_DELAY_MS);
  const every = setInterval(() => void runOnce(), INTERVAL_MS);
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
