import type { MachineWorkerState, WorkerCheckSummary } from "./types";

/**
 * What Cody knows about its workers right now: how many of its jobs run on each
 * one, and what the newest check of each found. lib/workers writes it; the
 * sampler reads it into every `MachineState`, and `GET /api/machines` reports
 * the checks.
 *
 * On globalThis, not in module state, for the reason the sampler is: the server
 * entry loads the sampler through jiti while the API routes (and the agent's
 * tool) load their copies through Next's bundler, and all of them must see the
 * same numbers. Nothing here imports anything but a type, so it can sit in
 * either graph.
 */

interface WorkerRegistry {
  jobs: Map<string, number>;
  checks: Map<string, WorkerCheckSummary>;
}

declare global {
  var __codyWorkerRegistry: WorkerRegistry | undefined;
}

function registry(): WorkerRegistry {
  globalThis.__codyWorkerRegistry ??= { jobs: new Map(), checks: new Map() };
  return globalThis.__codyWorkerRegistry;
}

/** How many of Cody's jobs are running on the machine now. */
export function setWorkerJobs(machineId: string, count: number): void {
  if (count > 0) registry().jobs.set(machineId, count);
  else registry().jobs.delete(machineId);
}

/** The newest check of the machine as a worker. */
export function recordWorkerCheck(machineId: string, summary: WorkerCheckSummary): void {
  registry().checks.set(machineId, summary);
}

export function workerCheckOf(machineId: string): WorkerCheckSummary | null {
  return registry().checks.get(machineId) ?? null;
}

/** Every recorded check, by machine id. */
export function workerChecks(): Record<string, WorkerCheckSummary> {
  return Object.fromEntries(registry().checks);
}

/** `ready` is false until a check has passed, and again after one fails. */
export function workerStateOf(machineId: string): MachineWorkerState {
  const { jobs, checks } = registry();
  return { jobs: jobs.get(machineId) ?? 0, ready: checks.get(machineId)?.ok === true };
}
