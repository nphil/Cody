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
}

export interface PlacementRequest {
  arch: WorkerArch | null;
  /** Toolchains the worker must have, lower case. */
  tools: readonly string[];
  /** Machine ids that already failed this job. */
  excluded: ReadonlySet<string>;
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
  | { kind: "placed"; id: string; label: string; freeCores: number }
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
