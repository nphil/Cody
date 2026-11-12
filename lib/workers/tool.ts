import { normalizeWorkerArch, WORKER_TOOL_PATTERN } from "../machines/types";
import type { WorkerArch } from "../machines/types";
import { isRecord } from "../type-guards";
import { workerScheduler } from "./live";
import { localFits, runLocalCommand } from "./local";
import { MAX_COMMAND_BYTES } from "./remote";
import { DEFAULT_JOB_TIMING, runWorkerJob, type JobDeps, type JobRequest } from "./run";
import { sshShell } from "./shell";
import { DEFAULT_WORK_ROOT } from "./types";
import type { HostToolDefinition } from "../pi-types";

/**
 * `run_on_worker`: the agent's way to send a heavy command to another machine.
 * Everything else about it lives in the sibling modules; this file is the
 * agent-facing surface (the description it reads, the arguments it may pass)
 * and the one function every harness calls.
 */

export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MAX_TIMEOUT_SECONDS = 7200;

export const RUN_ON_WORKER_TOOL: HostToolDefinition = {
  name: "run_on_worker",
  description:
    "Run a heavy command on another machine (a \"worker\") instead of on the server this chat runs on, and get its output and result files back. "
    + "Use it for long CPU- or memory-hungry work: full builds and compiles (cargo, go, next build, bun build), whole test suites, bundling, image builds. "
    + "Do NOT use it for quick commands, edits, git, or anything that needs this machine's running services, dev server, ports or secrets: those stay local with your normal shell tool. "
    + "Cody copies the project to the worker (default: the git repository's tracked and untracked-but-not-ignored files, so node_modules and other ignored files are NOT copied: install dependencies inside `command`, for example `bun install && bun run build`), "
    + "runs `command` there at low priority from the copy of `cwd`, streams the output, copies the paths in `results` back into the workspace, and deletes the copy. "
    + "Edits you make to files while it runs are not copied. "
    + "The worker is chosen for you (it must match `arch` and have every tool in `tools`; the one with the most free CPU and memory wins). "
    + "If no worker can take the job right now it runs on this server instead and the result says so; pass fallbackLocal=false to wait in the queue for a worker instead. "
    + "If the worker drops out mid-run, Cody runs the job once more elsewhere and tells you exactly what happened. "
    + "The result starts with the exit code and where it ran, then the last 200 lines of output; the whole output is saved to a file whose path is given. "
    + "Results copied back overwrite files in the workspace but never delete any.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command, run with sh -c from the copy of `cwd` on the worker. Failures are reported through the exit code.",
      },
      cwd: {
        type: "string",
        description: "Directory the command runs in. Default: this chat's workspace. Relative paths resolve against the workspace; it must be inside the workspace's git repository.",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "Globs, relative to `cwd`, of the files to copy to the worker (for example [\"src/**\", \"package.json\"]). Default: every tracked and untracked-but-not-ignored file of the git repository (the whole repository, not only `cwd`).",
      },
      results: {
        type: "array",
        items: { type: "string" },
        description: "Files or directories, relative to `cwd`, to copy back into the workspace when the command finishes, also when it fails (for example [\"dist\", \"target/release/app\"]). Default: none.",
      },
      arch: {
        type: "string",
        enum: ["x86_64", "aarch64"],
        description: "Require a worker of this CPU architecture. Set it when the results are programs that must run on this server.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Toolchains the worker must have, for example [\"node\", \"rust\", \"docker\"] (see what workers offer by asking the person, or leave empty).",
      },
      timeoutSeconds: {
        type: "number",
        description: `Stop the command after this many seconds of running (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}).`,
      },
      fallbackLocal: {
        type: "boolean",
        description: "Default true: when no worker can take the job now, run it on this server and say so. false: wait in the queue for a worker (up to 30 minutes) and never run it here.",
      },
    },
    required: ["command"],
  },
};

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
