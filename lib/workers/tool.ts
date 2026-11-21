import { localSpareMB } from "../machines/memory";
import { countJobStart, jobNeedMB, recordJobRun } from "../machines/memory-store";
import { readLocalMemory } from "../machines/memory-watch";
import { normalizeWorkerArch, WORKER_TOOL_PATTERN } from "../machines/types";
import type { WorkerArch } from "../machines/types";
import { isRecord } from "../type-guards";
import { workerScheduler } from "./live";
import { localFits, runLocalCommand } from "./local";
import { MAX_COMMAND_BYTES } from "./remote";
import { DEFAULT_JOB_TIMING, runWorkerJob, type JobDeps, type JobRequest } from "./run";
import { sshShell } from "./shell";
import { DEFAULT_WORK_ROOT } from "./types";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from "./definition";

/**
 * `run_on_worker`: the agent's way to send a heavy command to another machine.
 * Everything else about it lives in the sibling modules; this file is the
 * parser for the arguments the agent may pass and the one function every
 * harness calls. The words the agent reads are in definition.ts.
 */

/** What the harness knows about the call. */
export interface RunOnWorkerContext {
  /** The chat's workspace. */
  cwd: string;
  sessionId: string;
  /** The chat's scratch directory; found from the session id when omitted. */
  scratchDir?: string | null;
  /** Aborted when the agent cancels the call or the chat ends: everything is stopped and cleaned up. */
  signal?: AbortSignal;
  /** Called with the job's progress as it runs. The FIRST non-empty line is a one-line status; the rest is the latest output. */
  onProgress?: (text: string) => void;
}

export interface RunOnWorkerResult {
  text: string;
  /** True when the command failed or the job could not be completed. */
  isError: boolean;
}

/** At most this many toolchains may be asked for. */
const MAX_TOOLS = 16;
/** One glob or path in `include` / `results`. */
const MAX_ENTRY_CHARS = 4096;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function fail<T>(message: string): Parsed<T> {
  return { ok: false, message };
}

/** A list of strings; a single string counts as a list of one. */
function readList(raw: unknown, name: string): Parsed<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  const items = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(items)) return fail(`${name} must be a list of strings.`);
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return fail(`${name} must be a list of strings.`);
    if (item.includes("\0")) return fail(`${name} has an entry with a NUL character.`);
    if (item.length > MAX_ENTRY_CHARS) return fail(`${name} has an entry longer than ${MAX_ENTRY_CHARS} characters.`);
    out.push(item);
  }
  return { ok: true, value: out };
}

function readTools(raw: unknown): Parsed<string[]> {
  const list = readList(raw, "tools");
  if (!list.ok) return list;
  const tools = new Set<string>();
  for (const entry of list.value) {
    const tool = entry.trim().toLowerCase();
    if (!tool) continue;
    if (!WORKER_TOOL_PATTERN.test(tool)) return fail(`tools has "${entry}", which is not a toolchain name (letters, digits and . _ + - only, at most 32 characters).`);
    tools.add(tool);
  }
  if (tools.size > MAX_TOOLS) return fail(`tools has more than ${MAX_TOOLS} entries.`);
  return { ok: true, value: [...tools] };
}

function readTimeout(raw: unknown): Parsed<number> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: DEFAULT_TIMEOUT_SECONDS };
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return fail("timeoutSeconds must be a number of seconds.");
  return { ok: true, value: Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(seconds))) };
}

function readFlag(raw: unknown, name: string, fallback: boolean): Parsed<boolean> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  if (typeof raw === "boolean") return { ok: true, value: raw };
  if (raw === "true") return { ok: true, value: true };
  if (raw === "false") return { ok: true, value: false };
  return fail(`${name} must be true or false.`);
}

/** What the agent asked for, checked and tidied; or the sentence that tells it what to fix. */
export function parseRunOnWorkerArgs(raw: unknown): Parsed<JobRequest> {
  if (!isRecord(raw)) return fail("run_on_worker needs an object with at least `command`.");

  const { command } = raw;
  if (typeof command !== "string" || command.trim() === "") return fail("command is required: the shell command to run on the worker.");
  if (command.includes("\0")) return fail("command has a NUL character, which a shell cannot take.");
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return fail(`command is longer than ${MAX_COMMAND_BYTES / 1024} KB. Put the commands in a script file in the project and run that.`);

  let cwd: string | undefined;
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (typeof raw.cwd !== "string") return fail("cwd must be a path (a string).");
    if (raw.cwd.includes("\0")) return fail("cwd has a NUL character.");
    cwd = raw.cwd;
  }

  const include = readList(raw.include, "include");
  if (!include.ok) return include;
  const results = readList(raw.results, "results");
  if (!results.ok) return results;
  const tools = readTools(raw.tools);
  if (!tools.ok) return tools;

  let arch: WorkerArch | null = null;
  if (raw.arch !== undefined && raw.arch !== null && raw.arch !== "") {
    arch = normalizeWorkerArch(raw.arch);
    if (!arch) return fail(`arch must be "x86_64" or "aarch64" (got ${JSON.stringify(raw.arch)}).`);
  }

  const timeout = readTimeout(raw.timeoutSeconds);
  if (!timeout.ok) return timeout;
  const fallbackLocal = readFlag(raw.fallbackLocal, "fallbackLocal", true);
  if (!fallbackLocal.ok) return fallbackLocal;

  return {
    ok: true,
    value: {
      command,
      cwd,
      include: include.value.length > 0 ? include.value : undefined,
      results: results.value,
      arch,
      tools: tools.value,
      timeoutMs: timeout.value * 1000,
      fallbackLocal: fallbackLocal.value,
    },
  };
}

/** The real things a job touches: the machines in Settings, ssh, this server's shell. */
function liveDeps(): JobDeps {
  return {
    scheduler: workerScheduler(),
    shell: sshShell,
    workRoot: DEFAULT_WORK_ROOT,
    localFit: localFits,
    runLocal: runLocalCommand,
    timing: DEFAULT_JOB_TIMING,
    now: Date.now,
    memory: {
      needMB: jobNeedMB,
      recordRun: recordJobRun,
      countJob: countJobStart,
      localSpareMB: () => localSpareMB(readLocalMemory()),
    },
  };
}

/**
 * Run one `run_on_worker` call for any harness. Never rejects: whatever went
 * wrong is the text the agent reads.
 */
export async function runOnWorker(rawArgs: unknown, ctx: RunOnWorkerContext): Promise<RunOnWorkerResult> {
  try {
    const parsed = parseRunOnWorkerArgs(rawArgs);
    if (!parsed.ok) return { text: parsed.message, isError: true };
    return await runWorkerJob(parsed.value, ctx, liveDeps());
  } catch (error) {
    return { text: `run_on_worker failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
