import { StringDecoder } from "node:string_decoder";
import { firstStderrLine } from "../machines/ssh";
import type { MachineReason } from "../machines/types";
import { ExecStreamParser, type ExecEvent } from "./remote";
import { describeRemoteFailure, type RemoteShell } from "./shell";

/**
 * Running the job on the worker and watching it: one ssh command (built by
 * `buildExecCommand`) whose stdout carries the job's output between a start
 * marker and an exit marker. What counts as what:
 *
 * - the exit marker is the ONLY proof the command ended and with which status;
 * - no start marker: it never ran (ssh failed, the directory was missing, the
 *   machine did not answer in time), so another worker can take the job;
 * - a start marker but no exit marker, and nobody asked to stop: the worker or
 *   the connection went away mid-run ("dropped");
 * - the time limit counts from the start marker; at the limit (or when the
 *   caller cancels) ssh's stdin is closed, which is the far side's dead-man's
 *   switch: it stops the job's process group (TERM, KILL five seconds later).
 *   Cody never writes to that stdin and never uses `-n`.
 */

export interface ExecuteTiming {
  /** The job must have said it started within this long. */
  startTimeoutMs: number;
  /** After a stop request the far side has this long to end the job before ssh itself is cut. */
  stopGraceMs: number;
  /** Once the exit marker is in, ssh has this long to end by itself. */
  exitWaitMs: number;
}

export const DEFAULT_EXECUTE_TIMING: ExecuteTiming = { startTimeoutMs: 60_000, stopGraceMs: 15_000, exitWaitMs: 2_000 };

export interface ExecuteOptions {
  shell: RemoteShell;
  destination: string;
  /** The command from `buildExecCommand`. */
  command: string;
  /** The token that command was built with. */
  token: string;
  /** Stop the job after it has run this long. */
  timeoutMs: number;
  signal?: AbortSignal;
  timing?: Partial<ExecuteTiming>;
  /** The job's first instruction is running now. */
  onStarted?: () => void;
  /** Output of the job, in order. */
  onOutput: (text: string) => void;
}

export type ExecuteOutcome =
  /** The command ended by itself; `code` is its exit status. */
  | { kind: "exited"; code: number }
  /** The time limit ran out and the job was stopped; `code` is what it ended with, if it said. */
  | { kind: "timeout"; code: number | null }
  | { kind: "cancelled" }
  /** It never started: another worker may do. */
  | { kind: "no_start"; reason: MachineReason; detail: string }
  /** It started, then the connection or the worker went away without an exit status. */
  | { kind: "dropped"; reason: MachineReason; detail: string };

export async function executeOnWorker(options: ExecuteOptions): Promise<ExecuteOutcome> {
  const timing: ExecuteTiming = { ...DEFAULT_EXECUTE_TIMING, ...options.timing };
  const { signal } = options;
  const proc = options.shell.start(options.destination, options.command);
  const parser = new ExecStreamParser(options.token);
  const decoder = new StringDecoder("utf8");

  let started = false;
  let startFailed = false;
  let noDirectory = false;
  let exitCode: number | null = null;
  let timedOut = false;
  let cancelled = false;
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void): NodeJS.Timeout => {
    const timer = setTimeout(run, ms);
    timers.add(timer);
    return timer;
  };

  /** Close ssh's stdin so the far side stops the job itself; cut ssh if that takes too long. */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    proc.stdin.end();
    later(timing.stopGraceMs, () => proc.kill());
  };

  const handle = (events: ExecEvent[]) => {
    for (const event of events) {
      if (event.kind === "started") {
        started = true;
        later(options.timeoutMs, () => {
          timedOut = true;
          stop();
        });
        options.onStarted?.();
      } else if (event.kind === "nodir") {
        noDirectory = true;
      } else if (event.kind === "output") {
        options.onOutput(event.text);
      } else {
        exitCode = event.code;
        later(timing.exitWaitMs, () => proc.kill());
      }
    }
  };

  proc.stdout.on("data", (chunk: Buffer | string) => {
    handle(parser.feed(typeof chunk === "string" ? chunk : decoder.write(chunk)));
  });

  later(timing.startTimeoutMs, () => {
    if (started || exitCode !== null) return;
    startFailed = true;
    proc.kill();
  });

  const onAbort = () => {
    cancelled = true;
    if (started) stop();
    else proc.kill();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const exit = await proc.exited;
    const rest = decoder.end();
    if (rest) handle(parser.feed(rest));
    handle(parser.end());

    if (cancelled) return { kind: "cancelled" };
    if (timedOut) return { kind: "timeout", code: exitCode };
    if (exitCode !== null) return { kind: "exited", code: exitCode };
    const failure = describeRemoteFailure(exit);
    if (noDirectory) return { kind: "no_start", reason: "failed", detail: "the job's directory is missing on the worker" };
    if (!started) {
      if (startFailed) return { kind: "no_start", reason: "unreachable", detail: `the job did not start within ${Math.round(timing.startTimeoutMs / 1000)} s` };
      return { kind: "no_start", reason: failure.reason, detail: failure.detail || firstStderrLine(parser.preamble) };
    }
    return { kind: "dropped", reason: failure.reason, detail: failure.detail || "the connection ended without the command's exit status" };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    proc.stdin.end();
  }
}
