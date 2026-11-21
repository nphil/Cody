import { underPressure } from "../machines/memory";
import { formatBytes } from "./format";
import type { Placement, PlacementRequest, Refusal, WorkerCandidate } from "./types";

/**
 * Which worker takes a job. Pure: the scheduler gathers what is known about
 * every worker (its facts, its health, a fresh reading of its load, how many of
 * Cody's jobs already run there) and this function only decides.
 *
 * A worker is eligible when it is a known, healthy worker of the right
 * architecture with the required tools and a free slot, (when it says
 * `onlyWhenIdle`) is quiet right now, and (after the job ran out of memory
 * somewhere) has more memory than that machine. Among those, in this order:
 * one with the memory the command needed lately free, one that is not short
 * of memory and did not just run out of it, the most free cores (a worker on
 * this server's own machine counts two fewer: it competes with Cody), the
 * fewest running jobs, the most free memory, then the name, so the same
 * inputs always give the same answer. Memory only orders the choices: when no
 * worker has what the command needed, or every one is short, the best of them
 * still takes the job, and the answer says why it is a compromise.
 *
 * "Busy" and "none" are different answers: busy means a worker that matches
 * would take the job once something finishes (worth queueing for), none means
 * nobody ever could (wrong architecture, missing tools, down).
 */

/** A worker marked `onlyWhenIdle` takes a job only while its CPU is at or under this. */
export const IDLE_CPU_PERCENT = 25;
/** Free cores a worker on this server's own machine gives up in the ranking. */
export const SAME_HOST_CORES = 2;
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

/** Memory a job could use on the worker now, MB: what the machine has available, and what is left under the worker's own limit when it has one. Null when unknown. */
export function freeMemoryMB(candidate: WorkerCandidate): number | null {
  const load = candidate.load;
  const available = load?.memAvailMB ?? null;
  const underCap = load?.capMB != null && load.capUsedMB != null ? load.capMB - load.capUsedMB : null;
  if (available === null) return underCap;
  return underCap === null ? available : Math.min(available, underCap);
}

/** The most memory a job could ever have on the worker, MB: its own limit when one was read, else its description's. */
export function memoryCapMB(candidate: WorkerCandidate): number | null {
  return candidate.load?.capMB ?? candidate.facts?.memMB ?? null;
}

function megabytes(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}

/** The command's known need fits in the worker's free memory (an unknown need or unknown free memory fits). */
function fits(candidate: WorkerCandidate, needMB: number | null | undefined): boolean {
  if (!needMB) return true;
  const free = freeMemoryMB(candidate);
  return free === null || needMB <= free;
}

/** Short of memory now, or it ran out of it (or was short) a few minutes ago. */
function strained(candidate: WorkerCandidate): boolean {
  return candidate.cooling !== undefined || underPressure(candidate.load?.pressure);
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
  if (request.minCapMB != null) {
    const cap = memoryCapMB(candidate);
    if (cap !== null && cap <= request.minCapMB) return permanent(`it has ${megabytes(cap)} of memory, and the job already ran out of memory on a worker with ${megabytes(request.minCapMB)}`);
  }
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
function compare(a: WorkerCandidate, b: WorkerCandidate, needMB: number | null | undefined): number {
  const fit = Number(fits(b, needMB)) - Number(fits(a, needMB));
  if (fit !== 0) return fit;
  const strain = Number(strained(a)) - Number(strained(b));
  if (strain !== 0) return strain;
  const coresA = freeCores(a) - (a.sameHost ? SAME_HOST_CORES : 0);
  const coresB = freeCores(b) - (b.sameHost ? SAME_HOST_CORES : 0);
  const cores = Math.round(coresB * 10) - Math.round(coresA * 10);
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
  const [best] = open.sort((a, b) => compare(a, b, request.needMB));
  if (best) {
    const tight = !fits(best, request.needMB);
    const caveats: string[] = [];
    if (tight && request.needMB) {
      caveats.push(`the last runs of this command needed about ${megabytes(request.needMB)} of memory and no worker had that much free (${best.label} had ${megabytes(freeMemoryMB(best) ?? 0)})`);
    }
    if (strained(best)) {
      caveats.push(`${best.label} ${best.cooling === "oom" ? "ran out of memory a few minutes ago" : "is short of memory"}, and was still the best choice`);
    }
    return {
      kind: "placed",
      id: best.id,
      label: best.label,
      freeCores: freeCores(best),
      ...(caveats.length > 0 ? { caveat: caveats.join("; ") } : {}),
      ...(tight ? { tight: true as const } : {}),
    };
  }
  return { kind: refusals.some((refusal) => refusal.kind === "busy") ? "busy" : "none", refusals };
}

/** One line per refusal, for a message to the agent or the person. */
export function describeRefusals(refusals: readonly Refusal[]): string {
  if (refusals.length === 0) return "no machine is switched on as a worker";
  return refusals.map((refusal) => `${refusal.label}: ${refusal.why}`).join("; ");
}
