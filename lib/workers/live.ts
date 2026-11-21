import { setWorkerJobs } from "../machines/jobs";
import { machineCooldown, noteMachineMemory } from "../machines/memory-store";
import { readLocalMemory } from "../machines/memory-watch";
import { getMachineStates, notifyMachinesChanged } from "../machines/sampler";
import { listMachineConfigs } from "../machines/store";
import { loadFromMetrics } from "./facts";
import { probeAndRecord } from "./health";
import { REAL_CLOCK, WorkerScheduler } from "./scheduler";
import type { WorkerLoad, WorkerMachine } from "./types";

/**
 * The scheduler this server runs, wired to the real things: the machines saved
 * in Settings, the live meters, ssh, and the Machines list that shows how many
 * jobs run where.
 */

/** Machines switched on as workers, in the order Settings lists them. */
export function listWorkerMachines(): WorkerMachine[] {
  const workers: WorkerMachine[] = [];
  for (const config of listMachineConfigs()) {
    if (config.kind !== "ssh" || config.worker !== true || !config.destination) continue;
    workers.push({ id: config.id, label: config.name, destination: config.destination, facts: config.workerFacts ?? null });
  }
  return workers;
}

/** The newest meter reading of a machine; there is none while nobody has the Machines list open. */
function meterOf(machineId: string): WorkerLoad | null {
  const state = getMachineStates().find((candidate) => candidate.id === machineId);
  if (!state || state.status !== "online" || !state.metrics) return null;
  return loadFromMetrics(state.metrics);
}

/**
 * One scheduler for the whole server, on globalThis: the agent's tool runs in
 * Next's bundle and the Machines routes in their own, and every job must queue
 * in the same line.
 */
export function workerScheduler(): WorkerScheduler {
  globalThis.__codyWorkerScheduler ??= new WorkerScheduler({
    listWorkers: listWorkerMachines,
    meterOf,
    probe: (machine) => probeAndRecord(machine),
    publishJobs(machineId, count) {
      setWorkerJobs(machineId, count);
      notifyMachinesChanged();
    },
    clock: REAL_CLOCK,
    memory: {
      noteLoad(machine, load, now) {
        noteMachineMemory(machine.id, machine.label, { bootId: load.bootId, oomKills: load.oomKills, pressure: load.pressure }, now);
      },
      cooling: (machineId, now) => machineCooldown(machineId, now)?.why ?? null,
      local: () => readLocalMemory(),
    },
  });
  return globalThis.__codyWorkerScheduler;
}
