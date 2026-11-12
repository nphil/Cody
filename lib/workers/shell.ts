import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { findSshBinary, classifySshFailure, firstStderrLine, sshCommandArgs } from "../machines/ssh";
import type { MachineReason } from "../machines/types";

/**
 * One command on one worker, over ssh. Everything the workers feature does on
 * a remote machine (read its description, unpack the project, run the job, pack
 * the results, clean up) is one of these, so this is the single seam: tests put
 * a stand-in `ssh` first on PATH, and nothing else in `lib/workers/` knows
 * ssh exists.
 *
 * The rules of `lib/machines/ssh.ts` apply unchanged: the destination is the
 * checked machine address (one argument after `--`, via `sshCommandArgs`), the
 * remote command is built by Cody from constants and quoted values, and ssh's
 * stdin is a pipe Cody owns. It is never `-n`: a job's stdin is the far side's
 * dead-man's switch (see `remote.ts`), so when Cody dies, however it dies, the
 * kernel closes the pipe and the job on the worker is stopped.
 */

/** What is left of a command once it ended. */
export interface RemoteExit {
  /** The command's exit status; null when ssh was killed or could not start. */
  code: number | null;
  /** The tail of what ssh and the command wrote to stderr. */
  stderr: string;
  /** This server has no `ssh` program. */
  noSsh: boolean;
}

export interface RemoteProcess {
  stdin: Writable;
  stdout: Readable;
  exited: Promise<RemoteExit>;
  /** End the command now: stdin closes first (the far side's dead-man's switch), then the local ssh is terminated. */
  kill(): void;
}

export interface RemoteShell {
  /** Start `remoteCommand` on `destination`. Never throws: a machine that cannot be reached is an exit. */
  start(destination: string, remoteCommand: string): RemoteProcess;
}

/** POSIX single-quoting: the only way to hand an arbitrary string to `sh -c`. */
export function shQuote(value: string): string {
  if (value.includes("\0")) throw new Error("A NUL byte cannot be passed to a shell");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Keep stderr bounded: the last couple of KB hold the reason. */
const STDERR_KEEP = 4096;
const KILL_GRACE_MS = 2_000;

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** A server that stops should not leave ssh clients running; the far side's
 * dead-man's switch then ends the commands. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of live) child.kill("SIGTERM");
  });
}

function finishedProcess(exit: RemoteExit): RemoteProcess {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  stdout.end();
  stdin.resume();
  return { stdin, stdout, exited: Promise.resolve(exit), kill() {} };
}

export const sshShell: RemoteShell = {
  start(destination, remoteCommand) {
    const binary = findSshBinary();
    if (!binary) return finishedProcess({ code: null, stderr: "", noSsh: true });
    installExitHook();

    let args: string[];
    try {
      args = sshCommandArgs(destination, remoteCommand);
    } catch (error) {
      return finishedProcess({ code: null, stderr: error instanceof Error ? error.message : String(error), noSsh: false });
    }
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    live.add(child);
    child.stdin?.on("error", () => {
      // ssh went away first: nothing was ever going to be read from here
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });

    const { promise: exited, resolve } = Promise.withResolvers<RemoteExit>();
    let settled = false;
    const settle = (exit: RemoteExit) => {
      if (settled) return;
      settled = true;
      live.delete(child);
      resolve(exit);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle({ code: null, stderr: error.message, noSsh: error.code === "ENOENT" });
    });
    // `close`, not `exit`: stdout has been read to its end by then.
    child.once("close", (code) => settle({ code, stderr, noSsh: false }));

    return {
      stdin: child.stdin as Writable,
      stdout: child.stdout as Readable,
      exited,
      kill() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.stdin?.end();
        child.kill("SIGTERM");
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        hard.unref();
      },
    };
  },
};

/** A plain reason for a remote command that did not finish normally. */
export function describeRemoteFailure(exit: RemoteExit): { reason: MachineReason; detail: string } {
  if (exit.noSsh) return { reason: "no_ssh", detail: "" };
  return { reason: classifySshFailure(exit.stderr, exit.code), detail: firstStderrLine(exit.stderr) };
}

export interface RemoteResult extends RemoteExit {
  stdout: string;
  /** Cody ended it: the time limit ran out. */
  timedOut: boolean;
  /** Cody ended it: the caller's signal aborted. */
  aborted: boolean;
}

/**
 * Run a short remote command to its end and collect its output. For the
 * commands whose answer is text (a check, a cleanup); streaming ones use the
 * process directly.
 */
export async function runRemote(
  shell: RemoteShell,
  destination: string,
  remoteCommand: string,
  options: { timeoutMs: number; signal?: AbortSignal; maxStdoutBytes?: number },
): Promise<RemoteResult> {
  const proc = shell.start(destination, remoteCommand);
  const maxBytes = options.maxStdoutBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  let aborted = false;
  proc.stdout.on("data", (chunk: Buffer) => {
    if (size >= maxBytes) return;
    chunks.push(chunk);
    size += chunk.length;
  });
  // Nothing is ever written: ssh's stdin stays a pipe we own until the end.
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    proc.kill();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const exit = await proc.exited;
    return { ...exit, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, aborted };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    proc.stdin.end();
  }
}
