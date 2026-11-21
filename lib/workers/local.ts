import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { engineChildEnv } from "../harness/provider-keys";
import { parseOomKills } from "../machines/memory";
import type { WorkerArch } from "../machines/types";
import type { JobMemory } from "./remote";

/**
 * The same job, run on this server: what happens when no worker can take it
 * and the agent allowed that (`fallbackLocal`, the default). It runs in the
 * workspace itself, like the agent's own shell tool would, so nothing is copied
 * in or out; it is still niced and still gets the output streamed back. It is
 * also the first thing the kernel kills when this server runs out of memory
 * (`oom_score_adj` 1000), so Cody and its chats are not, and its peak memory
 * and any out-of-memory kill come back with the result, as on a worker.
 */

const KILL_GRACE_MS = 5_000;
/** How long a command that has ended gets to deliver output still in the pipe when something it left behind holds it open. */
const OUTPUT_GRACE_MS = 1_500;
/** How often the memory a job's processes hold is added up. */
const PEAK_EVERY_MS = 2_000;

/** Tool names an agent may use that are not the name of the program. */
const TOOL_PROGRAMS: Readonly<Record<string, readonly string[]>> = {
  rust: ["cargo", "rustc"],
  cargo: ["cargo"],
  python: ["python3", "python"],
  python3: ["python3"],
  node: ["node"],
  nodejs: ["node"],
  bun: ["bun"],
  go: ["go"],
  golang: ["go"],
  docker: ["docker"],
  java: ["java"],
  make: ["make"],
  gcc: ["gcc"],
  cmake: ["cmake"],
  npm: ["npm"],
  pnpm: ["pnpm"],
  yarn: ["yarn"],
};

export function currentArch(): WorkerArch | null {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return null;
}

function onPath(program: string, pathValue: string | undefined): boolean {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      fs.accessSync(path.join(directory, program), fs.constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

export type LocalFit = { ok: true } | { ok: false; why: string };

/** Could this server run a job that needs this architecture and these tools? */
export function localFits(request: { arch: WorkerArch | null; tools: readonly string[] }, environment: { arch?: WorkerArch | null; path?: string } = {}): LocalFit {
  const arch = environment.arch === undefined ? currentArch() : environment.arch;
  if (request.arch && arch !== request.arch) {
    return { ok: false, why: `this server is ${arch ?? process.arch}, the job needs ${request.arch}` };
  }
  const pathValue = environment.path ?? process.env.PATH;
  const missing = request.tools.filter((tool) => !(TOOL_PROGRAMS[tool] ?? [tool]).some((program) => onPath(program, pathValue)));
  if (missing.length) return { ok: false, why: `this server does not have ${missing.join(", ")}` };
  return { ok: true };
}

export interface LocalRunOptions {
  command: string;
  cwd: string;
  scratchDir?: string | null;
  onOutput: (text: string) => void;
  /** Stop the command after this long. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** This server's control group (tests point it at a fake one). */
  cgroupRoot?: string;
}

export interface LocalRunResult {
  /** The command's exit status; null when it was stopped by a signal or never started. */
  code: number | null;
  /** The signal that stopped it. */
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** The command could not be started. */
  startError: string | null;
  /** Its peak memory (null before the first reading, two seconds in) and the out-of-memory kills in this server's control group while it ran (null when unknown). */
  memory: JobMemory;
}

/** The memory every process of one session holds, bytes. A job is started detached, so it leads its own session and the session id is its pid. */
export function sessionBytes(sessionId: number, procRoot = "/proc"): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`${procRoot}/${entry}/stat`, "utf8");
      // `pid (name) state ppid pgrp session …`; the name may hold spaces and brackets.
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]) !== sessionId) continue;
      const kb = /^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`${procRoot}/${entry}/status`, "utf8"))?.[1];
      if (kb) total += Number(kb) * 1024;
    } catch {
      // it ended in between
    }
  }
  return total;
}

function oomKillsIn(cgroupRoot: string): number | null {
  try {
    return parseOomKills(fs.readFileSync(`${cgroupRoot}/memory.events`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Run `command` here with `sh -c`, at low priority, in its own process group so
 * a stop reaches everything it started. stderr is folded into stdout in the
 * shell so the two keep their order. The command has no stdin.
 */
export function runLocalCommand(options: LocalRunOptions): Promise<LocalRunResult> {
  const { promise, resolve } = Promise.withResolvers<LocalRunResult>();
  let timedOut = false;
  let aborted = false;
  let finished = false;

  const env = engineChildEnv(undefined, { scratchDir: options.scratchDir ?? null });
  const inner = ["-c", '{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null; exec sh -c "$0" 2>&1', options.command];
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const oomBefore = oomKillsIn(cgroupRoot);
  const niced = onPath("nice", env.PATH);
  let child: ChildProcess;
  try {
    child = niced
      ? spawn("nice", ["-n", "19", "sh", ...inner], { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      : spawn("sh", inner, { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch (error) {
    resolve({ code: null, signal: null, timedOut: false, aborted: false, startError: error instanceof Error ? error.message : String(error), memory: { peakBytes: null, oomKills: null } });
    return promise;
  }

  const stopGroup = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  let hardKill: NodeJS.Timeout | undefined;
  const stop = () => {
    if (finished || hardKill) return;
    stopGroup("SIGTERM");
    hardKill = setTimeout(() => stopGroup("SIGKILL"), KILL_GRACE_MS);
    hardKill.unref();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  timer.unref();
  const onAbort = () => {
    aborted = true;
    stop();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  let peak = 0;
  const sampler = setInterval(() => {
    if (child.pid) peak = Math.max(peak, sessionBytes(child.pid));
  }, PEAK_EVERY_MS);
  sampler.unref();

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => options.onOutput(chunk));

  const settle = (code: number | null, signal: string | null, startError: string | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(hardKill);
    clearInterval(sampler);
    options.signal?.removeEventListener("abort", onAbort);
    // Whatever the command left running in its group goes with it, which also lets go of the output pipe.
    stopGroup("SIGKILL");
    child.stdout?.destroy();
    const oomAfter = oomKillsIn(cgroupRoot);
    const oomKills = oomBefore !== null && oomAfter !== null ? Math.max(0, oomAfter - oomBefore) : null;
    resolve({ code, signal, timedOut, aborted, startError, memory: { peakBytes: peak > 0 ? peak : null, oomKills } });
  };
  child.once("error", (error) => settle(null, null, error.message));
  // The command ended; something it left behind may still hold the output pipe open, so `close` is waited for only briefly.
  child.once("exit", (code, signal) => {
    const grace = setTimeout(() => settle(code, signal, null), OUTPUT_GRACE_MS);
    grace.unref();
  });
  // `close`: the command ended and its output has been read to the end.
  child.once("close", (code, signal) => settle(code, signal, null));
  return promise;
}
