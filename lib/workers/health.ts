import { recordWorkerCheck } from "../machines/jobs";
import { notifyMachinesChanged } from "../machines/sampler";
import { listMachineConfigs, saveWorkerFacts } from "../machines/store";
import type { WorkerCheckResult } from "../machines/types";
import { buildWorkerCheckCommand, parseWorkerProbe } from "./facts";
import { forgetWorker } from "./scheduler";
import { describeRemoteFailure, runRemote, sshShell, type RemoteShell } from "./shell";
import type { ProbeOutcome } from "./types";

/**
 * Looking at a worker: reading `/etc/cody-worker.json`, whether the work root
 * is usable and how busy the machine is, over one short ssh command. The same
 * read backs the "Check" button, the check that runs every minute while the
 * Machines list is open, and the scheduler's look at a worker before it places
 * a job. Every result is recorded the same way: the newest check for the
 * Machines list, the facts for placement.
 */

/** ssh connects within 8 s, the load reading takes 1 s more. */
export const PROBE_TIMEOUT_MS = 15_000;
export const MONITOR_INTERVAL_MS = 60_000;
/** Checks run at once (the button, the monitor): one ssh connection each. */
export const MAX_CONCURRENT_CHECKS = 2;

export interface ProbeOptions {
  shell?: RemoteShell;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  factsPath?: string;
  workRoot?: string;
}

/** Read a worker. Never rejects: whatever went wrong is the answer. */
export async function probeMachine(destination: string, options: ProbeOptions = {}): Promise<ProbeOutcome> {
  const now = options.now ?? Date.now;
  let command: string;
  try {
    command = buildWorkerCheckCommand({ factsPath: options.factsPath, workRoot: options.workRoot });
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  const result = await runRemote(options.shell ?? sshShell, destination, command, {
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    signal: options.signal,
  });
  if (result.noSsh) return { ok: false, reason: "no_ssh", detail: "" };
  if (result.aborted) return { ok: false, reason: "failed", detail: "The check was cancelled" };
  if (result.timedOut) return { ok: false, reason: "unreachable", detail: "" };
  if (result.code !== 0) {
    const failure = describeRemoteFailure(result);
    return { ok: false, reason: failure.reason, detail: failure.detail };
  }
  return parseWorkerProbe(result.stdout, now());
}

/** Write down what a check found: for the Machines list, and the facts for placement. */
export function recordProbe(
  machine: { id: string; destination: string },
  outcome: ProbeOutcome,
  startedAt: number,
  at: number,
): WorkerCheckResult {
  let result: WorkerCheckResult;
  if (outcome.ok) {
    recordWorkerCheck(machine.id, { ok: true, at });
    try {
      saveWorkerFacts(machine.id, machine.destination, outcome.facts);
    } catch {
      // Settings could not be written; the check itself still answers.
    }
    result = { ok: true, facts: outcome.facts, ms: at - startedAt, at };
  } else {
    recordWorkerCheck(machine.id, { ok: false, reason: outcome.reason, at });
    result = { ok: false, reason: outcome.reason, detail: outcome.detail, at };
  }
  // The scheduler's cached reading is older than this one.
  forgetWorker(machine.id);
  notifyMachinesChanged();
  return result;
}

/** Probe a saved machine and record it: what the scheduler does before placing a job. */
export async function probeAndRecord(machine: { id: string; destination: string }): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  const outcome = await probeMachine(machine.destination);
  recordProbe(machine, outcome, startedAt, Date.now());
  return outcome;
}

export class WorkerCheckUnknownError extends Error {
  constructor() {
    super("No such ssh machine");
    this.name = "WorkerCheckUnknownError";
  }
}

export class WorkerCheckBusyError extends Error {
  constructor() {
    super("Too many worker checks are running");
    this.name = "WorkerCheckBusyError";
  }
}

interface HealthState {
  checks: Map<string, Promise<WorkerCheckResult>>;
  monitor: { users: number; timer: NodeJS.Timeout | undefined; cycling: boolean };
}

declare global {
  var __codyWorkerHealth: HealthState | undefined;
}

function health(): HealthState {
  globalThis.__codyWorkerHealth ??= { checks: new Map(), monitor: { users: 0, timer: undefined, cycling: false } };
  return globalThis.__codyWorkerHealth;
}

/**
 * The "Check" button: read one saved ssh machine now and answer with the
 * result (a failed connection is a result, not an error). A second check of the
 * same machine while one is running shares it; more than
 * {@link MAX_CONCURRENT_CHECKS} machines at once is refused so a mashed button
 * cannot become a fan of connections.
 */
export function checkWorkerMachine(machineId: string): Promise<WorkerCheckResult> {
  const machine = listMachineConfigs().find((candidate) => candidate.id === machineId && candidate.kind === "ssh" && candidate.destination);
  if (!machine?.destination) throw new WorkerCheckUnknownError();
  const { checks } = health();
  const running = checks.get(machine.id);
  if (running) return running;
  if (checks.size >= MAX_CONCURRENT_CHECKS) throw new WorkerCheckBusyError();
  const target = { id: machine.id, destination: machine.destination };
  const startedAt = Date.now();
  const task = probeMachine(target.destination)
    .then((outcome) => recordProbe(target, outcome, startedAt, Date.now()))
    .finally(() => checks.delete(machine.id));
  checks.set(machine.id, task);
  return task;
}

async function monitorCycle(): Promise<void> {
  const { monitor } = health();
  if (monitor.cycling) return;
  monitor.cycling = true;
  try {
    for (const machine of listMachineConfigs()) {
      if (monitor.users === 0) break;
      if (machine.kind !== "ssh" || machine.worker !== true) continue;
      try {
        await checkWorkerMachine(machine.id);
      } catch {
        // busy or removed meanwhile: the next cycle looks again
      }
    }
  } finally {
    monitor.cycling = false;
  }
}

/**
 * Check every worker now and then (every {@link MONITOR_INTERVAL_MS}) while
 * someone has the Machines list open, so its health dots stay true. The first
 * viewer starts it and the last one leaving stops it, so a closed browser
 * costs nothing. Returns the function that says "this viewer left".
 */
export function startWorkerMonitor(): () => void {
  const { monitor } = health();
  monitor.users += 1;
  if (monitor.users === 1) {
    void monitorCycle();
    monitor.timer = setInterval(() => void monitorCycle(), MONITOR_INTERVAL_MS);
    monitor.timer.unref();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    monitor.users -= 1;
    if (monitor.users === 0) {
      clearInterval(monitor.timer);
      monitor.timer = undefined;
    }
  };
}
