import { metricsFrom, SampleStream } from "../machines/proc";
import { checkWorkerFacts, type MachineMetrics, type WorkerFacts, type WorkerProblem } from "../machines/types";
import { DEFAULT_WORK_ROOT, WORKER_FACTS_PATH, type WorkerLoad } from "./types";

/**
 * Reading a worker over ssh: its own description (`/etc/cody-worker.json`), a
 * check that the job directory is usable, how many jobs are alive there, and
 * one second of CPU and memory so placement has a reading even when nobody has
 * the machine meters open.
 */

/** Only these characters may end up inside the check command. The two paths are
 * Cody's constants (tests pass a temp directory); the check is never given
 * anything a person or an agent typed. */
const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

/** Warm build state (`keep/`) and per-chat scratch (`scratch/`) that nothing has touched for this long is deleted. */
export const CACHE_MAX_AGE_DAYS = 14;
/** When the work disk is fuller than this, the oldest caches go first, until it is under {@link CACHE_RELIEF_PERCENT}. */
export const CACHE_PRESSURE_PERCENT = 85;
export const CACHE_RELIEF_PERCENT = 70;
const MIB = 1024 * 1024;

/**
 * The command that reads a worker. Plain `sh -c '…'` written the way the meter
 * loop is (no quote, backslash or `!` inside) so any login shell can parse it,
 * and it prints framed sections that {@link parseWorkerProbe} reads back:
 *
 * - `@NOFILE` alone when the machine has no facts file (not a worker);
 * - `@FACTS` the file; `@ROOT` `yes`/`no`: the work root is a writable
 *   directory; `@JOBS` how many job directories have a live process (it also
 *   removes the ones a crashed Cody left behind, older than 12 hours and not
 *   running, and tidies the warm caches jobs leave under `keep/` and
 *   `scratch/`: anything untouched for two weeks, and the oldest first when
 *   the disk is over 85% full; a cache used in the last hour is never taken);
 *   `@MEM` the machine's boot id and its control group's memory (in use,
 *   limit, droppable cache, out-of-memory kills so far, and how much of the
 *   last ten seconds something waited on memory), each line empty when the
 *   machine does not have it; `@LOAD` two meter frames in the exact shape
 *   `ssh.ts` prints; `@END`. An answer without `@MEM` (an older check) is
 *   still read.
 */
export function buildWorkerCheckCommand(
  options: { factsPath?: string; workRoot?: string; cachePressure?: number; cacheRelief?: number } = {},
): string {
  const factsPath = options.factsPath ?? WORKER_FACTS_PATH;
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  const pressure = options.cachePressure ?? CACHE_PRESSURE_PERCENT;
  const relief = options.cacheRelief ?? CACHE_RELIEF_PERCENT;
  if (!SAFE_PATH.test(factsPath) || !SAFE_PATH.test(workRoot)) throw new Error("Refusing to build a worker check around an unsafe path");
  if (![pressure, relief].every((value) => Number.isInteger(value) && value >= 0 && value <= 100)) throw new Error("Refusing a cache threshold outside 0-100");
  const script = [
    `F=${factsPath}`,
    `R=${workRoot}`,
    '[ -r "$F" ] || { echo @NOFILE; exit 0; }',
    'echo @FACTS; cat "$F"; echo',
    'echo @ROOT; if [ -d "$R" ] && [ -w "$R" ]; then echo yes; else echo no; fi',
    "echo @JOBS; n=0",
    'for d in "$R"/j-*; do [ -d "$d" ] || continue; p=$(cat "$d/.pid" 2>/dev/null); '
    + 'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then n=$((n+1)); '
    + 'elif [ -n "$(find "$d" -maxdepth 0 -mmin +720 2>/dev/null)" ]; then rm -rf "$d"; fi; done',
    "echo $n",
    `for d in "$R"/keep/* "$R"/scratch/*; do [ -d "$d" ] || continue; [ -n "$(find "$d" -maxdepth 0 -mtime +${CACHE_MAX_AGE_DAYS} 2>/dev/null)" ] && rm -rf "$d"; done`,
    'u=$(df -P "$R" 2>/dev/null | tail -n 1); u=${u%%%*}; u=${u##* }',
    `if [ "\${u:-0}" -gt ${pressure} ] 2>/dev/null; then for d in $(ls -1dtr "$R"/keep/* "$R"/scratch/* 2>/dev/null); do `
    + '[ -n "$(find "$d" -maxdepth 0 -mmin +60 2>/dev/null)" ] || continue; rm -rf "$d"; '
    + 'u=$(df -P "$R" 2>/dev/null | tail -n 1); u=${u%%%*}; u=${u##* }; '
    + `[ "\${u:-100}" -le ${relief} ] && break; done; fi`,
    "echo @MEM; g=/sys/fs/cgroup",
    'echo "boot $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"',
    'echo "current $(cat $g/memory.current 2>/dev/null)"',
    'echo "max $(cat $g/memory.max 2>/dev/null)"',
    'grep -E "^inactive_file " $g/memory.stat 2>/dev/null',
    'grep -E "^oom_kill " $g/memory.events 2>/dev/null',
    '[ -r $g/memory.pressure ] && read x y z < $g/memory.pressure && echo "psi ${y#avg10=}"',
    "echo @LOAD",
    'c=$(grep -c "^cpu[0-9]" /proc/stat 2>/dev/null)',
    's() { echo "@S $c"; head -n 1 /proc/stat; grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached):" /proc/meminfo; cat /proc/loadavg; echo @E; }',
    "s; sleep 1; s",
    "echo @END",
  ].join("; ");
  return `sh -c '${script}'`;
}

/** What one check found. A problem carries a code the browser turns into plain
 * copy and `detail` for the person who can read it. */
export type WorkerProbe =
  | { ok: true; facts: WorkerFacts; load: WorkerLoad | null; liveJobs: number }
  | { ok: false; reason: WorkerProblem | "read_failed"; detail: string };

/** The facts file's text as facts, or what is wrong with it. */
export function parseWorkerFacts(text: string): { ok: true; facts: WorkerFacts } | { ok: false; detail: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, detail: `${WORKER_FACTS_PATH} is not valid JSON` };
  }
  const checked = checkWorkerFacts(raw);
  if (!checked.ok) return { ok: false, detail: `${WORKER_FACTS_PATH}: ${checked.field} is missing or not valid` };
  return checked;
}

export function loadFromMetrics(metrics: MachineMetrics): WorkerLoad {
  const own = metrics.own;
  return {
    cpuPercent: metrics.cpuPercent,
    load1: metrics.load1,
    memAvailMB: Math.round((metrics.memTotalBytes - metrics.memUsedBytes) / MIB),
    at: metrics.at,
    ...(metrics.bootId ? { bootId: metrics.bootId } : {}),
    ...(own?.memLimitBytes != null ? { capMB: Math.round(own.memLimitBytes / MIB), capUsedMB: Math.round(own.memUsedBytes / MIB) } : {}),
    ...(own?.pressure != null ? { pressure: own.pressure } : {}),
    ...(own?.oomKills != null ? { oomKills: own.oomKills } : {}),
  };
}

/**
 * The `@MEM` lines as load fields. The limit counts only when it is a number
 * smaller than the machine's memory (a container's); `max` or a bigger one is
 * no limit of its own.
 */
export function memoryFromProbe(lines: readonly string[], memTotalBytes: number | null): Partial<WorkerLoad> {
  const value = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? "";
  const whole = (text: string) => (/^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null);
  const boot = value("boot");
  const current = whole(value("current"));
  const max = whole(value("max"));
  const oom = whole(value("oom_kill"));
  const psi = value("psi");
  const memory: Partial<WorkerLoad> = {};
  if (/^[0-9a-f-]{8,64}$/.test(boot)) memory.bootId = boot;
  if (current !== null && max !== null && max > 0 && (memTotalBytes === null || max < memTotalBytes)) {
    memory.capMB = Math.round(max / MIB);
    memory.capUsedMB = Math.round(Math.max(0, current - (whole(value("inactive_file")) ?? 0)) / MIB);
  }
  if (oom !== null) memory.oomKills = oom;
  if (/^\d+(?:\.\d+)?$/.test(psi)) memory.pressure = Number(psi);
  return memory;
}

/** Read the output of {@link buildWorkerCheckCommand}. */
export function parseWorkerProbe(stdout: string, now: number): WorkerProbe {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.some((line) => line === "@NOFILE")) {
    return { ok: false, reason: "not_a_worker", detail: `There is no ${WORKER_FACTS_PATH} on that machine` };
  }
  const at = (marker: string) => lines.indexOf(marker);
  const facts = at("@FACTS");
  const root = at("@ROOT");
  const jobs = at("@JOBS");
  const load = at("@LOAD");
  const end = at("@END");
  if (facts < 0 || root < facts || jobs < root || load < jobs || end < load) {
    return { ok: false, reason: "read_failed", detail: "The check's answer was cut short" };
  }

  const parsed = parseWorkerFacts(lines.slice(facts + 1, root).join("\n"));
  if (!parsed.ok) return { ok: false, reason: "bad_facts", detail: parsed.detail };
  if (lines[root + 1] !== "yes") {
    return { ok: false, reason: "no_work_root", detail: `${DEFAULT_WORK_ROOT} is missing or not writable for the ssh user` };
  }

  const liveJobs = Number.parseInt(lines[jobs + 1] ?? "", 10);
  const stream = new SampleStream();
  const samples = stream
    .feed(`${lines.slice(load + 1, end).join("\n")}\n`)
    .flatMap((event) => (event.kind === "sample" ? [event.sample] : []));
  const last = samples.at(-1);
  const reading = last ? metricsFrom(samples.length > 1 ? samples[0] : null, last, now) : null;
  const mem = at("@MEM");
  const memory = mem > jobs && mem < load ? memoryFromProbe(lines.slice(mem + 1, load), reading?.memTotalBytes ?? null) : {};
  return {
    ok: true,
    facts: parsed.facts,
    load: reading ? { ...loadFromMetrics(reading), ...memory } : null,
    liveJobs: Number.isFinite(liveJobs) && liveJobs > 0 ? liveJobs : 0,
  };
}
