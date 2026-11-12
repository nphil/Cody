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

/**
 * The command that reads a worker. Plain `sh -c '…'` written the way the meter
 * loop is (no quote, backslash or `!` inside) so any login shell can parse it,
 * and it prints framed sections that {@link parseWorkerProbe} reads back:
 *
 * - `@NOFILE` alone when the machine has no facts file (not a worker);
 * - `@FACTS` the file; `@ROOT` `yes`/`no`: the work root is a writable
 *   directory; `@JOBS` how many job directories have a live process (it also
 *   removes the ones a crashed Cody left behind, older than 12 hours and not
 *   running); `@LOAD` two meter frames in the exact shape `ssh.ts` prints; `@END`.
 */
export function buildWorkerCheckCommand(options: { factsPath?: string; workRoot?: string } = {}): string {
  const factsPath = options.factsPath ?? WORKER_FACTS_PATH;
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  if (!SAFE_PATH.test(factsPath) || !SAFE_PATH.test(workRoot)) throw new Error("Refusing to build a worker check around an unsafe path");
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
  return {
    cpuPercent: metrics.cpuPercent,
    load1: metrics.load1,
    memAvailMB: Math.round((metrics.memTotalBytes - metrics.memUsedBytes) / (1024 * 1024)),
    at: metrics.at,
  };
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
  return {
    ok: true,
    facts: parsed.facts,
    load: reading ? loadFromMetrics(reading) : null,
    liveJobs: Number.isFinite(liveJobs) && liveJobs > 0 ? liveJobs : 0,
  };
}
