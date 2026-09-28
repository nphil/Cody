import fs from "fs";
import os from "os";
import path from "path";

/**
 * omp leaves files in the system temp dir that nothing ever removes:
 *
 * - `omp-sshots-<id>.<ext>` — every browser screenshot any session takes
 *   (src/tools/browser/tab-worker.ts). The image already lives in the
 *   transcript by then; the file is a leftover. ~75 in one day on the
 *   owner's instance.
 * - `omp-worker-stderr-<rand>/` — one per helper process omp spawns (the
 *   memory embedder and friends), each holding a stderr log.
 *
 * On a long-lived container these only accumulate. Cody runs every engine
 * child with its own environment, so this process's `os.tmpdir()` is the
 * same directory those children write to. Anything past the age limit is
 * long finished with: a screenshot is used the moment it is taken, and a
 * helper process that is still alive keeps its open log even when the
 * directory entry goes away.
 */
const SWEEPABLE = /^(omp-sshots-[\w-]+\.(png|webp|jpe?g)|omp-worker-stderr-[\w-]+)$/;

export const OMP_TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OmpTempSweepResult {
  removed: number;
  bytes: number;
}

/** Delete omp's own temp leftovers older than `maxAgeMs`. Never throws: a
 *  file that vanished or cannot be removed is skipped. */
export async function sweepOmpTempFiles(
  dir: string = os.tmpdir(),
  maxAgeMs: number = OMP_TEMP_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<OmpTempSweepResult> {
  const result: OmpTempSweepResult = { removed: 0, bytes: 0 };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!SWEEPABLE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.promises.lstat(full);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.promises.rm(full, { recursive: true, force: true });
      result.removed += 1;
      result.bytes += stat.isFile() ? stat.size : 0;
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
  return result;
}
