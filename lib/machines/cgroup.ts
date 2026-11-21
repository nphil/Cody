import { readFile } from "node:fs/promises";
import { availableParallelism, uptime } from "node:os";

/**
 * Cody's own container, read from this server's control-group files. It prints
 * the same `cg1`/`cg2`/`up` lines the ssh loop in `ssh.ts` prints, so one
 * parser (`parseOwn` in proc.ts) serves both. Inside a Docker container
 * `/proc/stat` and `/proc/meminfo` describe the whole host; these files
 * describe the container.
 */

const ROOT = "/sys/fs/cgroup";

async function text(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/** `name value` lines of a stat file, for the names asked for. */
function statLines(version: 1 | 2, body: string | null, names: readonly string[]): string[] {
  if (body === null) return [];
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const [name, value] = line.split(" ");
    if (names.includes(name)) lines.push(`cg${version} ${name} ${value}`);
  }
  return lines;
}

export interface OwnReadOptions {
  root?: string;
  /** Seconds, the clock the CPU rate is measured against. */
  uptimeSeconds?: number;
  cpus?: number;
}

/** The lines for this container, or an empty list when the machine shows no
 * control group (macOS, Windows, a bare kernel without cgroups). */
export async function readOwnLines(options: OwnReadOptions = {}): Promise<string[]> {
  const root = options.root ?? ROOT;
  const clock = `up ${options.uptimeSeconds ?? uptime()}`;
  const nproc = options.cpus ?? availableParallelism();

  const [usageUsec, current] = await Promise.all([text(`${root}/cpu.stat`), text(`${root}/memory.current`)]);
  if (usageUsec !== null && current !== null) {
    const [max, cpuMax, memStat] = await Promise.all([
      text(`${root}/memory.max`),
      text(`${root}/cpu.max`),
      text(`${root}/memory.stat`),
    ]);
    return [
      clock,
      `cg2 nproc ${nproc}`,
      ...statLines(2, usageUsec, ["usage_usec"]),
      `cg2 memory.current ${current}`,
      `cg2 memory.max ${max ?? ""}`,
      `cg2 cpu.max ${cpuMax ?? ""}`,
      ...statLines(2, memStat, ["inactive_file"]),
    ];
  }

  for (const cpuDir of [`${root}/cpuacct`, `${root}/cpu,cpuacct`]) {
    const [usage, used] = await Promise.all([text(`${cpuDir}/cpuacct.usage`), text(`${root}/memory/memory.usage_in_bytes`)]);
    if (usage === null || used === null) continue;
    const [limit, quota, period, memStat] = await Promise.all([
      text(`${root}/memory/memory.limit_in_bytes`),
      text(`${cpuDir}/cpu.cfs_quota_us`),
      text(`${cpuDir}/cpu.cfs_period_us`),
      text(`${root}/memory/memory.stat`),
    ]);
    return [
      clock,
      `cg1 nproc ${nproc}`,
      `cg1 cpuacct.usage ${usage}`,
      `cg1 memory.usage_in_bytes ${used}`,
      `cg1 memory.limit_in_bytes ${limit ?? ""}`,
      `cg1 cpu.cfs_quota_us ${quota ?? ""}`,
      `cg1 cpu.cfs_period_us ${period ?? ""}`,
      ...statLines(1, memStat, ["total_inactive_file"]),
    ];
  }
  return [];
}
