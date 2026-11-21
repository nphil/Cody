import {
  DEFAULT_LOCAL_MACHINE_NAME,
  WORKER_PROBLEMS,
  type MachineKind,
  type MachineMetrics,
  type MachineReason,
  type MachineState,
  type MachineStatus,
  type OwnMetrics,
  type WorkerFacts,
  type WorkerProblem,
} from "./types";
import type { MemoryEvent } from "./memory";

/**
 * What the top bar, its dropdown and the Settings card agree on when they put
 * a machine into words and colours. Pure and browser-safe, so the decisions are
 * testable without a DOM.
 */

/** i18n key for the plain sentence that explains why a machine is not online.
 * Every {@link MachineReason} has one under `machines.reason.`. */
export function machineReasonKey(reason: MachineReason): string {
  return `machines.reason.${reason}`;
}

/** i18n key for a status chip ("Online", "Offline", …). */
export function machineStatusKey(status: MachineStatus): string {
  return `machines.status.${status}`;
}

/** The name a machine wears on screen. This server's DEFAULT name is stored in
 * English, so it is shown in the reader's own language (`machines.defaultName`);
 * a name the person chose is shown exactly as typed. */
export function machineDisplayName(machine: { kind: MachineKind; name: string }, translate: (key: string) => string): string {
  return machine.kind === "local" && machine.name === DEFAULT_LOCAL_MACHINE_NAME ? translate("machines.defaultName") : machine.name;
}

/** A figure for the bar: whole percent, never past 100 or below 0. */
export function wholePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Bytes as gigabytes with one decimal ("62.6"). The kernel counts in KiB, so
 * this is the figure `free -h` would call 62Gi, written without the jargon. */
export function formatGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0.0";
  return (bytes / 1024 ** 3).toFixed(1);
}

/** The short label under which a machine fits a narrow bar: its first letter,
 * upper-cased. */
export function machineInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

/** What the top bar's little bars draw: Cody's own share of the machine when it
 * is known (a container on someone's server shows only Cody, not the neighbours
 * beside it), else the whole machine's numbers. `scope` says which. */
export function barFigures(metrics: MachineMetrics): { cpu: number | null; mem: number; scope: "cody" | "machine" } {
  return metrics.own
    ? { cpu: metrics.own.cpuPercent, mem: metrics.own.memPercent, scope: "cody" }
    : { cpu: metrics.cpuPercent, mem: metrics.memPercent, scope: "machine" };
}

/** The whole machine's memory in use, never less than Cody's own part of it. A
 * container's `/proc/meminfo` (lxcfs on Proxmox) counts caches a little
 * differently from its cgroup, and a part that is bigger than its whole would
 * read as a mistake. */
export function machineMemoryUsedBytes(metrics: MachineMetrics): number {
  return Math.max(metrics.memUsedBytes, metrics.own?.memUsedBytes ?? 0);
}

/** The busier of the two bars in {@link barFigures}. */
export function peakPercent(metrics: MachineMetrics): number {
  const { cpu, mem } = barFigures(metrics);
  return Math.max(cpu ?? 0, mem);
}

export type MachineSeverity = "normal" | "warning" | "error" | "down" | "pending";

/** How worried to be about one machine, from its numbers or its state. The
 * percentage thresholds are the shared usage ones (70 warns, 90 is an error),
 * so a memory bar and the context ring never disagree about 90%. */
export function machineSeverity(machine: MachineState): MachineSeverity {
  if (machine.status === "offline") return "down";
  if (machine.status === "connecting" || machine.status === "unavailable" || !machine.metrics) return "pending";
  const peak = peakPercent(machine.metrics);
  if (peak >= 90) return "error";
  if (peak >= 70) return "warning";
  return "normal";
}

const SEVERITY_RANK: Record<MachineSeverity, number> = { pending: 0, normal: 1, warning: 2, error: 3, down: 4 };

/** The machine that deserves the single indicator a phone has room for: one
 * that is down beats one that is struggling beats one that is fine. Ties go to
 * the busier machine, then to the earlier one in the list. */
export function worstMachine(machines: readonly MachineState[]): MachineState | null {
  let worst: MachineState | null = null;
  let worstRank = -1;
  let worstPeak = -1;
  for (const machine of machines) {
    const rank = SEVERITY_RANK[machineSeverity(machine)];
    const peak = machine.metrics ? peakPercent(machine.metrics) : 0;
    if (rank > worstRank || (rank === worstRank && peak > worstPeak)) {
      worst = machine;
      worstRank = rank;
      worstPeak = peak;
    }
  }
  return worst;
}

/**
 * How much of each machine the top bar can afford. The richest level that
 * fits wins. The widths below are the ones the CSS in `app/globals.css`
 * (`.mm-*`) really gives a chip, with a pixel of safety: one source for both
 * halves, so the picker cannot promise room the layout does not have.
 *
 * - `full`: name, labelled CPU and memory bars with their numbers.
 * - `compact`: name, icon-labelled bars with numbers.
 * - `mini`: the machine's initial and a pair of bars, no numbers (just the
 *   pair when there is only one machine: an initial would tell it nothing).
 * - `dot`: one indicator for the worst machine (a phone, or no room at all).
 * - `none`: not even that fits.
 */
export type MeterDensity = "full" | "compact" | "mini" | "dot" | "none";

export const METER_LAYOUT = {
  /** Per density: a chip's fixed width in px, the widest its name may grow,
   * the space between two chips and the button's own horizontal padding. */
  full: { fixed: 99, nameMax: 84, gap: 10, pad: 12 },
  compact: { fixed: 81, nameMax: 64, gap: 10, pad: 12 },
  mini: { fixed: 36, nameMax: 0, gap: 8, pad: 8 },
  /** One machine only: just the pair of bars, no initial. */
  miniSingle: { fixed: 29, nameMax: 0, gap: 8, pad: 8 },
  /** How wide one Latin character of the UI's monospace font is at 11px. */
  nameChar: 6.6,
  /** The one-indicator button: a 16px ring with 4px of padding either side. */
  dot: 24,
} as const;

/** How wide a name draws at 11px: the UI's monospace font is 0.6em per Latin
 * character, and a Chinese or Japanese character is a full em. */
function nameWidth(name: string): number {
  let width = 0;
  for (const char of name) width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 11 : METER_LAYOUT.nameChar;
  return width;
}

/** The richest density at which every machine fits in `available` px. A phone
 * (`forceDot`) never gets more than the single indicator. */
export function pickMeterDensity(machines: readonly MachineState[], available: number, forceDot: boolean): MeterDensity {
  if (machines.length === 0) return "none";
  if (!forceDot) {
    for (const density of ["full", "compact", "mini"] as const) {
      const layout = density === "mini" && machines.length === 1 ? METER_LAYOUT.miniSingle : METER_LAYOUT[density];
      const chips = machines.reduce((sum, machine) => sum + layout.fixed + Math.min(layout.nameMax, nameWidth(machine.name)), 0);
      if (chips + layout.gap * (machines.length - 1) + layout.pad <= available) return density;
    }
  }
  return available >= METER_LAYOUT.dot ? "dot" : "none";
}

// ── Workers ──────────────────────────────────────────────────────────────────

/** i18n key for the plain sentence behind a failed worker check. A
 * {@link WorkerProblem} has its own copy under `machines.worker.problem.`;
 * every other reason is a failed connection and keeps `machines.reason.`. */
export function workerReasonKey(reason: MachineReason | WorkerProblem): string {
  return (WORKER_PROBLEMS as readonly string[]).includes(reason)
    ? `machines.worker.problem.${reason}`
    : machineReasonKey(reason as MachineReason);
}

/** A worker's memory for a sentence: whole gigabytes from 10 up ("64"), one
 * decimal below ("7.8"). The file states it in MB; 1 GB is 1024 MB, as free(1)
 * counts. */
export function formatWorkerMemory(memMB: number): string {
  const gigabytes = Math.max(0, memMB) / 1024;
  return gigabytes >= 10 ? String(Math.round(gigabytes)) : gigabytes.toFixed(1);
}

/** The pieces of the one-line summary of a worker, in reading order: its own
 * name, architecture, cores, memory and how many jobs run at once. The caller
 * joins them with a separator. */
export function workerFactPieces(
  facts: WorkerFacts,
  t: (key: string, vars?: Record<string, string | number>) => string,
  tn: (key: string, count: number) => string,
): string[] {
  return [
    facts.name,
    facts.arch,
    tn("machines.worker.cores", facts.cpus),
    t("machines.worker.memory", { gb: formatWorkerMemory(facts.memMB) }),
    tn("machines.worker.slots", facts.slots),
  ];
}

/** The tools to draw as chips and how many are left out, so a machine with a
 * long toolchain list does not push the card off the screen. */
export function visibleWorkerTools(tools: readonly string[], max = 8): { shown: string[]; hidden: number } {
  return { shown: tools.slice(0, max), hidden: Math.max(0, tools.length - max) };
}

// ── This server's machine, shared with workers ───────────────────────────────
// A worker can run beside Cody on this server's own machine (a container next
// to Cody's; the sampler marks it `sameHostAs`). The top bar shows that machine
// once, the dropdown shows how it splits.

/** One part of a machine, on the machine's own scale. */
export interface MachinePart {
  /** 0–100 of ALL the machine's cores; null until a second reading exists. */
  cpuPercent: number | null;
  memUsedBytes: number;
  /** How much of the last ten seconds something in it waited on memory, percent; null when it did not say. */
  pressure: number | null;
}

/** This server's machine three ways: Cody, the workers beside it, and the whole machine, which holds both. */
export interface HostSplit {
  /** The machine's cores: every CPU figure here is a share of all of them. */
  cores: number;
  memTotalBytes: number;
  cody: MachinePart;
  /** The workers beside Cody that are online and show their own share, together; null when none does. */
  workers: MachinePart | null;
  machine: { cpuPercent: number | null; memUsedBytes: number };
}

function partOf(own: OwnMetrics, cores: number): MachinePart {
  return {
    cpuPercent: own.cpuPercent === null ? null : (own.cpuPercent * own.cores) / cores,
    memUsedBytes: own.memUsedBytes,
    pressure: own.pressure ?? null,
  };
}

/** The machine `host` runs on, split between Cody and `guests`; null when this server shows no share of its own (its
 * numbers are then the whole machine's, the workers' included) or has no reading. */
export function splitHost(host: MachineState, guests: readonly MachineState[]): HostSplit | null {
  const metrics = host.status === "online" ? host.metrics : null;
  if (!metrics?.own) return null;
  const cores = metrics.cores ?? metrics.own.cores;
  const cody = partOf(metrics.own, cores);
  const parts = guests.flatMap((guest) => (guest.status === "online" && guest.metrics?.own ? [partOf(guest.metrics.own, cores)] : []));
  const workers: MachinePart | null = parts.length === 0
    ? null
    : {
      cpuPercent: parts.some((part) => part.cpuPercent === null) ? null : parts.reduce((sum, part) => sum + (part.cpuPercent ?? 0), 0),
      memUsedBytes: parts.reduce((sum, part) => sum + part.memUsedBytes, 0),
      pressure: parts.reduce<number | null>((most, part) => (part.pressure === null ? most : Math.max(most ?? 0, part.pressure)), null),
    };
  const together = cody.memUsedBytes + (workers?.memUsedBytes ?? 0);
  return {
    cores,
    memTotalBytes: metrics.memTotalBytes,
    cody,
    workers,
    machine: { cpuPercent: metrics.cpuPercent, memUsedBytes: Math.max(machineMemoryUsedBytes(metrics), together) },
  };
}

/** Each machine with the workers that run on it beside Cody, in list order; such a worker is not listed on its own. */
export function hostGroups(machines: readonly MachineState[]): { machine: MachineState; guests: MachineState[] }[] {
  const ids = new Set(machines.map((machine) => machine.id));
  return machines
    .filter((machine) => !(machine.sameHostAs && ids.has(machine.sameHostAs)))
    .map((machine) => ({ machine, guests: machines.filter((other) => other.sameHostAs === machine.id) }));
}

/** A machine as the top bar draws it; `guests` are the workers folded into it. */
export type ShownMachine = MachineState & { guests?: readonly MachineState[] };

/**
 * The top bar's list: a worker beside Cody is folded into this server's entry,
 * whose own figures become Cody's and its workers' together, as shares of the
 * whole machine. Without a share of its own, this server's numbers already are
 * the whole machine's, workers included, and are left as they are.
 */
export function foldSameHost(machines: readonly MachineState[]): ShownMachine[] {
  return hostGroups(machines).map(({ machine, guests }) => {
    if (guests.length === 0) return machine;
    const split = splitHost(machine, guests);
    if (!split || !machine.metrics) return { ...machine, guests };
    const memUsedBytes = split.cody.memUsedBytes + (split.workers?.memUsedBytes ?? 0);
    const own: OwnMetrics = {
      cpuPercent: split.cody.cpuPercent === null ? null : split.cody.cpuPercent + (split.workers?.cpuPercent ?? 0),
      cores: split.cores,
      memUsedBytes,
      memTotalBytes: split.memTotalBytes,
      memPercent: split.memTotalBytes > 0 ? (memUsedBytes / split.memTotalBytes) * 100 : 0,
      memLimitBytes: null,
    };
    return { ...machine, guests, metrics: { ...machine.metrics, own } };
  });
}

/** A memory event in the reader's language, from its figures; one saved without them keeps its own (English) words. */
export function memoryEventWords(
  event: MemoryEvent,
  t: (key: string, vars?: Record<string, string | number>) => string,
  tn: (key: string, count: number, vars?: Record<string, string | number>) => string,
): string {
  const detail = event.detail;
  if (!detail) return event.text;
  switch (detail.what) {
    case "killed":
      return tn("machines.memory.killed", detail.count, { used: formatGigabytes(detail.usedBytes), limit: formatGigabytes(detail.limitBytes) });
    case "high": {
      const percent = detail.limitBytes > 0 ? Math.round((detail.usedBytes / detail.limitBytes) * 100) : 0;
      const words = t("machines.memory.high", { used: formatGigabytes(detail.usedBytes), limit: formatGigabytes(detail.limitBytes), percent });
      return detail.biggest.length > 0 ? `${words} ${t("machines.memory.biggest", { list: detail.biggest.join(", ") })}` : words;
    }
    case "cooldown":
      return t(event.kind === "oom" ? "machines.memory.cooldownOom" : "machines.memory.cooldownPressure", { minutes: detail.minutes });
    case "job":
      return detail.peakBytes === null ? t("machines.memory.job") : t("machines.memory.jobPeak", { peak: formatGigabytes(detail.peakBytes) });
  }
}
