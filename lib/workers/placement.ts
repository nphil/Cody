import type { Placement, PlacementRequest, Refusal, WorkerCandidate } from "./types";

/**
 * Which worker takes a job. Pure: the scheduler gathers what is known about
 * every worker (its facts, its health, a fresh reading of its load, how many of
 * Cody's jobs already run there) and this function only decides.
 *
 * A worker is eligible when it is a known, healthy worker of the right
 * architecture with the required tools and a free slot, and (when it says
 * `onlyWhenIdle`) is quiet right now. Among those the one with the most free
 * cores wins, then the fewest running jobs, then the most free memory, then
 * the name, so the same inputs always give the same answer.
 *
 * "Busy" and "none" are different answers: busy means a worker that matches
 * would take the job once something finishes (worth queueing for), none means
 * nobody ever could (wrong architecture, missing tools, down).
 */

/** A worker marked `onlyWhenIdle` takes a job only while its CPU is at or under this. */
export const IDLE_CPU_PERCENT = 25;
/** A worker with less memory than this available takes no new job. */
export const MIN_FREE_MEM_MB = 512;

/** How busy the CPU is, 0–100: the reading when there is one, else the load average against the core count. */
function busyPercent(candidate: WorkerCandidate): number | null {
  const { facts, load } = candidate;
  if (load?.cpuPercent != null) return load.cpuPercent;
  if (load?.load1 != null && facts) return Math.min(100, (load.load1 / facts.cpus) * 100);
  return null;
}

/**
 * Cores that are idle on the worker, counting jobs Cody started a moment ago
 * (they are not in the reading yet) at one slot's share of the cores each.
 */
export function freeCores(candidate: WorkerCandidate): number {
  const { facts } = candidate;
  if (!facts) return 0;
  const busy = busyPercent(candidate);
  const used = (busy === null ? 0 : (facts.cpus * busy) / 100) + candidate.recentLaunches * (facts.cpus / facts.slots);
  return Math.max(0, facts.cpus - used);
}

function refusalFor(candidate: WorkerCandidate, request: PlacementRequest): Refusal | null {
  const { id, label, facts } = candidate;
  const permanent = (why: string): Refusal => ({ id, label, kind: "permanent", why });
  const busy = (why: string): Refusal => ({ id, label, kind: "busy", why });

  if (request.excluded.has(id)) return permanent("it already failed this job");
  if (!candidate.healthy) return permanent("it did not answer its last check");
  if (!facts) return permanent("its description (/etc/cody-worker.json) has not been read yet");
  if (request.arch && facts.arch !== request.arch) return permanent(`it is ${facts.arch}, the job needs ${request.arch}`);
  const missing = request.tools.filter((tool) => !facts.tools.includes(tool));
  if (missing.length > 0) return permanent(`it has no ${missing.join(", ")}`);
  if (candidate.running >= facts.slots) return busy(`all ${facts.slots} of its job slots are in use`);
  if (facts.onlyWhenIdle) {
    const percent = busyPercent(candidate);
    if (percent === null) return busy("it only takes jobs while idle and its load could not be read");
    if (percent > IDLE_CPU_PERCENT) return busy(`it only takes jobs while idle and its CPU is at ${Math.round(percent)}%`);
  }
  const free = candidate.load?.memAvailMB;
  if (free != null && free < MIN_FREE_MEM_MB) return busy(`only ${Math.round(free)} MB of its memory is free`);
  return null;
}

/** Best first. */
function compare(a: WorkerCandidate, b: WorkerCandidate): number {
  const cores = Math.round(freeCores(b) * 10) - Math.round(freeCores(a) * 10);
  if (cores !== 0) return cores;
  if (a.running !== b.running) return a.running - b.running;
  const memA = a.load?.memAvailMB ?? a.facts?.memMB ?? 0;
  const memB = b.load?.memAvailMB ?? b.facts?.memMB ?? 0;
  if (memA !== memB) return memB - memA;
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

export function place(candidates: readonly WorkerCandidate[], request: PlacementRequest): Placement {
  const open: WorkerCandidate[] = [];
  const refusals: Refusal[] = [];
  for (const candidate of candidates) {
    const refusal = refusalFor(candidate, request);
    if (refusal) refusals.push(refusal);
    else open.push(candidate);
  }
  const [best] = open.sort(compare);
  if (best) return { kind: "placed", id: best.id, label: best.label, freeCores: freeCores(best) };
  return { kind: refusals.some((refusal) => refusal.kind === "busy") ? "busy" : "none", refusals };
}

/** One line per refusal, for a message to the agent or the person. */
export function describeRefusals(refusals: readonly Refusal[]): string {
  if (refusals.length === 0) return "no machine is switched on as a worker";
  return refusals.map((refusal) => `${refusal.label}: ${refusal.why}`).join("; ");
}
