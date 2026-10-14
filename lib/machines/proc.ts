import type { MachineMetrics } from "./types";

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

/** Assemble a reading from the pieces both collectors produce. Null when the
 * CPU line or memory is missing: a half-read reading is worse than none. */
export function buildRawSample(input: {
  cpuLine: string | null;
  memLines: Iterable<string>;
  loadLine: string | null;
  cores: number | null;
}): RawSample | null {
  const cpu = input.cpuLine === null ? null : parseCpuTimes(input.cpuLine);
  const mem = parseMeminfo(input.memLines);
  if (!cpu || !mem) return null;
  return {
    cpu,
    cores: input.cores,
    memTotalKb: mem.totalKb,
    memAvailableKb: mem.availableKb,
    load1: input.loadLine === null ? null : parseLoad1(input.loadLine),
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

/** The numbers the top bar shows, from this reading and the one before it. */
export function metricsFrom(previous: RawSample | null, next: RawSample, at: number): MachineMetrics {
  const usedKb = next.memTotalKb - next.memAvailableKb;
  return {
    cpuPercent: previous ? cpuPercent(previous.cpu, next.cpu) : null,
    cores: next.cores,
    load1: next.load1,
    memTotalBytes: next.memTotalKb * 1024,
    memUsedBytes: usedKb * 1024,
    memPercent: Math.round((usedKb / next.memTotalKb) * 1000) / 10,
    at,
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
        });
        if (sample) events.push({ kind: "sample", sample });
      }
      return;
    }
    if (this.block && this.block.length < MAX_BLOCK_LINES) this.block.push(line);
  }
}
