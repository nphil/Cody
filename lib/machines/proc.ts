import type { MachineMetrics, OwnMetrics } from "./types";

/**
 * Reading CPU and memory the way Linux reports them: `/proc/stat`,
 * `/proc/meminfo` and `/proc/loadavg`. Pure parsing and arithmetic, so the same
 * code serves this server (it reads the files) and an ssh machine (a fixed loop
 * on the far side prints them), and both are testable without a machine.
 */

/** Cumulative CPU time in kernel ticks since boot. */
export interface CpuTimes {
  total: number;
  idle: number;
}

/** One reading. CPU use needs two of them: it is the share of ticks that were
 * not idle between the two. */
export interface RawSample {
  cpu: CpuTimes;
  cores: number | null;
  memTotalKb: number;
  memAvailableKb: number;
  load1: number | null;
  /** Cody's own container (its cgroup); null when the machine does not show one. */
  own: OwnRaw | null;
  /** The kernel's boot id (a `boot <id>` line), when the collector printed one. */
  bootId?: string;
}

/** One reading of the control group Cody runs in. On a Docker host or a
 * Proxmox container `/proc/stat` is the WHOLE machine's CPU, so Cody's own
 * share comes from here instead. */
export interface OwnRaw {
  /** CPU time the group has used since it began, in microseconds. */
  cpuUsec: number;
  /** A monotonic clock in ms (the machine's uptime), the other half of a rate. */
  clockMs: number;
  /** Cores the group may use: its quota when it has one, else the cores it can see. */
  cores: number;
  /** Memory in use, caches the kernel can drop already taken off. */
  memUsedBytes: number;
  /** The group's memory limit; null when there is none. */
  memLimitBytes: number | null;
  /** cgroup v2 `oom_kill`: processes killed for memory in the group so far. */
  oomKills?: number;
  /** cgroup v2 memory PSI `some avg10`, percent. */
  pressure?: number;
}

/** `cpu  user nice system idle iowait irq softirq steal guest guest_nice`.
 * `guest` and `guest_nice` are already counted inside `user` and `nice`, so
 * only the first eight columns make up the total; old kernels print fewer. */
export function parseCpuTimes(line: string): CpuTimes | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "cpu" || parts.length < 5) return null;
  const ticks = parts.slice(1, 9).map(Number);
  if (ticks.some((tick) => !Number.isFinite(tick) || tick < 0)) return null;
  return { total: ticks.reduce((sum, tick) => sum + tick, 0), idle: ticks[3] + (ticks[4] ?? 0) };
}

const MEMINFO_FIELD = /^(MemTotal|MemFree|MemAvailable|Buffers|Cached):\s+(\d+)/;

/** Total and available memory in KiB. `MemAvailable` (kernel 3.14+) is what is
 * left without swapping once reclaimable caches are counted as free; on a
 * kernel without it, free + buffers + page cache is the same idea. */
export function parseMeminfo(lines: Iterable<string>): { totalKb: number; availableKb: number } | null {
  const fields = new Map<string, number>();
  for (const line of lines) {
    const match = MEMINFO_FIELD.exec(line);
    if (match) fields.set(match[1], Number(match[2]));
  }
  const totalKb = fields.get("MemTotal");
  if (totalKb === undefined || !(totalKb > 0)) return null;
  let availableKb = fields.get("MemAvailable");
  if (availableKb === undefined) {
    const freeKb = fields.get("MemFree");
    if (freeKb === undefined) return null;
    availableKb = freeKb + (fields.get("Buffers") ?? 0) + (fields.get("Cached") ?? 0);
  }
  return { totalKb, availableKb: Math.min(Math.max(availableKb, 0), totalKb) };
}

/** `0.52 0.58 0.59 2/467 12345` → the one-minute figure. */
export function parseLoad1(line: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+\/\d+/.exec(line.trim());
  return match ? Number(match[1]) : null;
}

/** `/proc/stat` lists the machine as a whole (`cpu `) and then each logical CPU
 * (`cpu0 `, `cpu1 `, …): counting the second kind is the core count. */
export function countCores(statText: string): number | null {
  const count = statText.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length;
  return count > 0 ? count : null;
}

/** A cgroup v1 limit file says "no limit" with a number near 2^63. */
const V1_UNLIMITED_BYTES = 2 ** 62;

function ownNumber(values: Map<string, string>, key: string): number | null {
  const raw = values.get(key);
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Cody's own CPU and memory from the lines both collectors print. Each line is
 * `cg2 <name> <value…>` (cgroup v2) or `cg1 <name> <value>` (v1), plus
 * `up <seconds>`, the machine's uptime, as the clock. v2 names are the kernel's
 * (`usage_usec`, `memory.current`, `memory.max`, `cpu.max`, `inactive_file`);
 * v1's are `cpuacct.usage` (ns), `memory.usage_in_bytes`,
 * `memory.limit_in_bytes`, `cpu.cfs_quota_us`, `cpu.cfs_period_us` and
 * `total_inactive_file`. `nproc` is how many cores the group can see. Null when
 * the machine shows no usable group: the bar then says "whole machine".
 */
export function parseOwn(lines: Iterable<string>, fallbackCores: number | null): OwnRaw | null {
  const values = new Map<string, string>();
  let version: 1 | 2 | null = null;
  let uptime: number | null = null;
  for (const line of lines) {
    const match = /^cg([12]) (\S+) ?(.*)$/.exec(line.trim());
    if (match) {
      const lineVersion = match[1] === "2" ? 2 : 1;
      if (version === null) version = lineVersion;
      if (lineVersion === version) values.set(match[2], match[3].trim());
      continue;
    }
    const up = /^up (\d+(?:\.\d+)?)$/.exec(line.trim());
    if (up) uptime = Number(up[1]);
  }
  if (version === null || uptime === null) return null;

  let cpuUsec: number | null;
  let memCurrent: number | null;
  let inactive: number | null;
  let limit: number | null;
  let quotaCores: number | null = null;
  if (version === 2) {
    cpuUsec = ownNumber(values, "usage_usec");
    memCurrent = ownNumber(values, "memory.current");
    inactive = ownNumber(values, "inactive_file");
    limit = ownNumber(values, "memory.max"); // "max" is not a number: no limit
    const [quota, period] = (values.get("cpu.max") ?? "").split(/\s+/);
    if (/^\d+$/.test(quota ?? "") && /^\d+$/.test(period ?? "") && Number(period) > 0 && Number(quota) > 0) {
      quotaCores = Number(quota) / Number(period);
    }
  } else {
    const ns = ownNumber(values, "cpuacct.usage");
    cpuUsec = ns === null ? null : ns / 1000;
    memCurrent = ownNumber(values, "memory.usage_in_bytes");
    inactive = ownNumber(values, "total_inactive_file");
    limit = ownNumber(values, "memory.limit_in_bytes");
    if (limit !== null && limit >= V1_UNLIMITED_BYTES) limit = null;
    // v1 spells "no quota" as -1, which is not a number either
    const quota = ownNumber(values, "cpu.cfs_quota_us");
    const period = ownNumber(values, "cpu.cfs_period_us");
    if (quota !== null && period !== null && period > 0 && quota > 0) quotaCores = quota / period;
  }
  if (cpuUsec === null || memCurrent === null) return null;

  const visible = ownNumber(values, "nproc") ?? fallbackCores;
  const cores = quotaCores !== null ? (visible !== null ? Math.min(quotaCores, visible) : quotaCores) : visible;
  if (cores === null || !(cores > 0)) return null;
  const oomKills = version === 2 ? ownNumber(values, "oom_kill") : null;
  const pressure = version === 2 ? values.get("psi_some") ?? "" : "";
  return {
    cpuUsec,
    clockMs: uptime * 1000,
    cores,
    memUsedBytes: Math.max(0, memCurrent - (inactive ?? 0)),
    memLimitBytes: limit !== null && limit > 0 ? limit : null,
    ...(oomKills !== null ? { oomKills } : {}),
    ...(/^\d+(?:\.\d+)?$/.test(pressure) ? { pressure: Number(pressure) } : {}),
  };
}

/** Assemble a reading from the pieces both collectors produce. Null when the
 * CPU line or memory is missing: a half-read reading is worse than none. */
export function buildRawSample(input: {
  cpuLine: string | null;
  memLines: Iterable<string>;
  loadLine: string | null;
  cores: number | null;
  /** The `cg1`/`cg2`/`up` lines (see {@link parseOwn}) and a `boot <id>` line; none when the machine has no cgroup. */
  ownLines?: Iterable<string>;
}): RawSample | null {
  const cpu = input.cpuLine === null ? null : parseCpuTimes(input.cpuLine);
  const mem = parseMeminfo(input.memLines);
  if (!cpu || !mem) return null;
  const ownLines = input.ownLines ? [...input.ownLines] : null;
  let bootId: string | undefined;
  for (const line of ownLines ?? []) {
    const match = /^boot ([0-9a-f-]{8,64})$/.exec(line.trim());
    if (match) bootId = match[1];
  }
  return {
    cpu,
    cores: input.cores,
    memTotalKb: mem.totalKb,
    memAvailableKb: mem.availableKb,
    load1: input.loadLine === null ? null : parseLoad1(input.loadLine),
    own: ownLines ? parseOwn(ownLines, input.cores) : null,
    ...(bootId ? { bootId } : {}),
  };
}

/** Busy share, 0–100, between two readings. Null when no ticks passed or the
 * counters went backwards (a reboot between them): there is nothing true to say. */
export function cpuPercent(previous: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - previous.total;
  const idle = next.idle - previous.idle;
  if (!(total > 0) || idle < 0) return null;
  const busy = (1 - idle / total) * 100;
  return Math.round(Math.min(100, Math.max(0, busy)) * 10) / 10;
}

/** Cody's own CPU share, 0–100 of the cores it may use, between two readings.
 * Null when no time passed or a counter went backwards (a restart). */
export function ownCpuPercent(previous: OwnRaw, next: OwnRaw): number | null {
  const wallUsec = (next.clockMs - previous.clockMs) * 1000;
  const usedUsec = next.cpuUsec - previous.cpuUsec;
  if (!(wallUsec > 0) || usedUsec < 0) return null;
  const busy = (usedUsec / (wallUsec * next.cores)) * 100;
  return Math.round(Math.min(100, Math.max(0, busy)) * 10) / 10;
}

/** Cody's own figures. Memory is measured against the MACHINE's memory (the
 * same scale as the whole-machine bar, so the two can be compared and Cody's
 * part always sits inside the machine's); a container limit smaller than that
 * is reported on the side as `memLimitBytes`. */
function ownMetricsFrom(previous: RawSample | null, next: RawSample): OwnMetrics | null {
  const own = next.own;
  if (!own) return null;
  const memTotalBytes = next.memTotalKb * 1024;
  const memUsedBytes = Math.min(own.memUsedBytes, memTotalBytes);
  return {
    cpuPercent: previous?.own ? ownCpuPercent(previous.own, own) : null,
    cores: Math.round(own.cores * 10) / 10,
    memUsedBytes,
    memTotalBytes,
    memPercent: Math.round((memUsedBytes / memTotalBytes) * 1000) / 10,
    memLimitBytes: own.memLimitBytes !== null && own.memLimitBytes < memTotalBytes ? own.memLimitBytes : null,
    ...(own.oomKills !== undefined ? { oomKills: own.oomKills } : {}),
    ...(own.pressure !== undefined ? { pressure: own.pressure } : {}),
  };
}

/** The numbers the top bar shows, from this reading and the one before it. */
export function metricsFrom(previous: RawSample | null, next: RawSample, at: number): MachineMetrics {
  const usedKb = next.memTotalKb - next.memAvailableKb;
  return {
    own: ownMetricsFrom(previous, next),
    cpuPercent: previous ? cpuPercent(previous.cpu, next.cpu) : null,
    cores: next.cores,
    load1: next.load1,
    memTotalBytes: next.memTotalKb * 1024,
    memUsedBytes: usedKb * 1024,
    memPercent: Math.round((usedKb / next.memTotalKb) * 1000) / 10,
    at,
    ...(next.bootId ? { bootId: next.bootId } : {}),
  };
}

/** What one ssh sample looks like on the wire, and what the parser makes of the
 * stream it arrives in. The remote loop (lib/machines/ssh.ts) frames each
 * reading as `@S <cores>` … `@E`; a machine with no `/proc` says `@NOPROC`. */
export type StreamEvent = { kind: "sample"; sample: RawSample } | { kind: "no_proc" };

/** A block longer than this is not ours: drop it rather than grow. */
const MAX_BLOCK_LINES = 64;
/** A line longer than this without a newline is garbage, not a sample. */
const MAX_PENDING_CHARS = 64 * 1024;

export class SampleStream {
  private pending = "";
  private block: string[] | null = null;
  private cores: number | null = null;

  /** Feed stdout text as it arrives; returns every event that completed. Partial
   * lines wait for the rest, and anything malformed is skipped, never thrown. */
  feed(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      this.line(line, events);
      newline = this.pending.indexOf("\n");
    }
    if (this.pending.length > MAX_PENDING_CHARS) this.pending = "";
    return events;
  }

  private line(line: string, events: StreamEvent[]): void {
    if (line === "@NOPROC") {
      events.push({ kind: "no_proc" });
      return;
    }
    if (line.startsWith("@S")) {
      const cores = Number(line.slice(2).trim());
      this.cores = Number.isInteger(cores) && cores > 0 ? cores : null;
      this.block = [];
      return;
    }
    if (line === "@E") {
      const block = this.block;
      this.block = null;
      if (block) {
        const sample = buildRawSample({
          cpuLine: block.find((entry) => entry.startsWith("cpu ")) ?? null,
          memLines: block,
          loadLine: block.find((entry) => /^\d+(?:\.\d+)?\s/.test(entry)) ?? null,
          cores: this.cores,
          ownLines: block,
        });
        if (sample) events.push({ kind: "sample", sample });
      }
      return;
    }
    if (this.block && this.block.length < MAX_BLOCK_LINES) this.block.push(line);
  }
}
