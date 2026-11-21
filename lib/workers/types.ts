import type { MachineReason, WorkerArch, WorkerFacts, WorkerProblem } from "../machines/types";

/**
 * The shapes shared by every part of `lib/workers/`. No imports but types, so
 * the pure modules (placement, file listing, the tar reader) stay testable
 * without a server.
 */

/** Where jobs live on a worker (the contract: `/srv/cody-work`, its own disk). */
export const DEFAULT_WORK_ROOT = "/srv/cody-work";

/** What the facts file is called on a worker. */
export const WORKER_FACTS_PATH = "/etc/cody-worker.json";

/** A reading of how busy a worker is, from the live meters or from a probe. */
export interface WorkerLoad {
  /** 0–100 over about a second; null when only the load average is known. */
  cpuPercent: number | null;
  /** One-minute load average. */
  load1: number | null;
  /** Memory the kernel says is available, MB; null when unknown. */
  memAvailMB: number | null;
  /** Epoch ms of the reading. */
  at: number;
  /** The machine's boot id (the same for every container on one machine), when the reading had it. */
  bootId?: string;
  /** The worker's own memory limit (its control group's), MB, when it has one. */
  capMB?: number;
  /** Memory in use under that limit, MB, caches the kernel can drop taken off. */
  capUsedMB?: number;
  /** PSI `some avg10` of its memory, percent: how much of the last ten seconds something waited on memory. */
  pressure?: number;
  /** Processes the kernel killed for memory there since it started (its control group's count). */
  oomKills?: number;
}

/** One worker as the placement sees it. */
export interface WorkerCandidate {
  /** The machine id from Settings. */
  id: string;
  /** The label the person gave it (what messages call it). */
  label: string;
  /** Null until a check has read the worker's description. */
  facts: WorkerFacts | null;
  /** False once a check or a probe found it unreachable or not a worker. */
  healthy: boolean;
  /** Cody's own jobs running on it now. */
  running: number;
  /** Jobs Cody started on it within the last few seconds: too new to show in a reading. */
  recentLaunches: number;
  load: WorkerLoad | null;
  /** The worker is behind the others for a few minutes (it ran out of memory, or was short of it, just now). */
  cooling?: "oom" | "pressure";
  /** The worker runs on the same machine as this server (same boot id): it competes with Cody for CPU and memory. */
  sameHost?: boolean;
}

export interface PlacementRequest {
  arch: WorkerArch | null;
  /** Toolchains the worker must have, lower case. */
  tools: readonly string[];
  /** Machine ids that already failed this job. */
  excluded: ReadonlySet<string>;
  /** What the command needed lately (with a margin), MB: workers with that much free go first. */
  needMB?: number | null;
  /** The job already ran out of memory on a worker with this much: only workers with more may take it. */
  minCapMB?: number | null;
}

/** Why one worker cannot take the job now; a code plus the plain words used in messages. */
export interface Refusal {
  id: string;
  label: string;
  /** `permanent`: it never could (arch, tools, not a worker, down); `busy`: it could once it frees up. */
  kind: "permanent" | "busy";
  why: string;
}

export type Placement =
  /** `caveat`: why this worker is a compromise (in plain words); `tight`: the command's known need does not fit in its free memory. Both only when so. */
  | { kind: "placed"; id: string; label: string; freeCores: number; caveat?: string; tight?: true }
  | { kind: "busy"; refusals: Refusal[] }
  | { kind: "none"; refusals: Refusal[] };

/** A machine switched on as a worker, as Settings saved it. */
export interface WorkerMachine {
  id: string;
  /** The name the person gave it. */
  label: string;
  /** The checked ssh destination. */
  destination: string;
  /** The last good reading of its description; null until one succeeded. */
  facts: WorkerFacts | null;
}

/** What one read of a worker over ssh found. */
export type ProbeOutcome =
  | { ok: true; facts: WorkerFacts; load: WorkerLoad | null; liveJobs: number }
  | { ok: false; reason: MachineReason | WorkerProblem; detail: string };
