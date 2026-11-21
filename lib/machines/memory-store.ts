import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import {
  checkLedger,
  coolingDown,
  countJob,
  emptyLedger,
  estimateBytes,
  EVENT_MAX_AGE_MS,
  jobsLast24h,
  noteOomCount,
  pruneLedger,
  recordEvent,
  recordPeak,
  startCooldown,
  underPressure,
  type Cooldown,
  type CooldownReason,
  type MemoryEvent,
  type MemoryEventDetail,
  type MemoryOverview,
  type MemoryLedger,
} from "./memory";

/**
 * The memory ledger on disk (`cody-worker-memory.json` in the agent
 * directory), cached on globalThis so the server entry and the routes share
 * one copy. A file that cannot be read or is not a ledger is started afresh
 * with one warning in the log: it only ever holds hints, so losing it costs
 * nothing but what was learned. Writes go to a temporary file first, so a
 * crash mid-write leaves the old ledger.
 */

const FILE = "cody-worker-memory.json";

declare global {
  var __codyWorkerMemory: { ledger: MemoryLedger; file: string } | undefined;
}

function load(): MemoryLedger {
  const file = path.join(getAgentDir(), FILE);
  const cached = globalThis.__codyWorkerMemory;
  if (cached && cached.file === file) return cached.ledger;
  let ledger = emptyLedger();
  try {
    const checked = checkLedger(JSON.parse(fs.readFileSync(file, "utf8")));
    if (checked) ledger = checked;
    else console.warn(`[workers] ${file} is not a memory ledger; starting a new one`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[workers] ${file} could not be read (${error instanceof Error ? error.message : String(error)}); starting a new one`);
    }
  }
  globalThis.__codyWorkerMemory = { ledger, file };
  return ledger;
}

function save(ledger: MemoryLedger): void {
  const file = path.join(getAgentDir(), FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn(`[workers] the memory ledger could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // nothing more to do
    }
  }
}

/** Change the ledger and save it. */
function mutate<T>(change: (ledger: MemoryLedger, now: number) => T, now: number): T {
  const ledger = load();
  pruneLedger(ledger, now);
  const result = change(ledger, now);
  save(ledger);
  return result;
}

/** Read the ledger without changing the file. */
function peek<T>(read: (ledger: MemoryLedger, now: number) => T, now: number): T {
  return read(load(), now);
}

/** Start a cool-down; when it is new, log it. A job's own event (`job`) is listed whatever happens, else a new cool-down lists its own. */
function coolDown(ledger: MemoryLedger, machine: string, label: string, why: CooldownReason, now: number, job?: { text: string; detail: MemoryEventDetail }): void {
  const started = startCooldown(ledger, machine, why, now);
  if (job) recordEvent(ledger, { at: now, machine, kind: why, ...job });
  if (!started) return;
  const minutes = Math.round((ledger.cooldowns[machine].until - now) / 60_000);
  const words = `${label}: ${why === "oom" ? "its kernel stopped a process for lack of memory" : "it was short of memory"}, so it goes behind the other workers for ${minutes} min.`;
  console.log(`[workers] ${words}`);
  if (!job) recordEvent(ledger, { at: now, machine, kind: why, text: words, detail: { what: "cooldown", minutes } });
}

/** What a command needed lately (with the margin), MB; null when it has not run lately. */
export function jobNeedMB(key: string, now = Date.now()): number | null {
  const bytes = peek((ledger) => estimateBytes(ledger, key, now), now);
  return bytes === null ? null : Math.ceil(bytes / (1024 * 1024));
}

/** A run ended. `oom`: the kernel stopped part of it for lack of memory, so the machine cools down and the command counts as needing at least `capBytes`. */
export function recordJobRun(run: { key: string; machine: string; label: string; peakBytes: number | null; oom: boolean; capBytes: number | null; text?: string }, now = Date.now()): void {
  if (run.peakBytes === null && !run.oom) return;
  mutate((ledger) => {
    recordPeak(ledger, run.key, { at: now, bytes: run.peakBytes, machine: run.machine, oom: run.oom, capBytes: run.capBytes });
    if (!run.oom) return;
    const job = run.text ? { text: run.text, detail: { what: "job" as const, capBytes: run.capBytes, peakBytes: run.peakBytes } } : undefined;
    if (run.machine !== "local") coolDown(ledger, run.machine, run.label, "oom", now, job);
    else if (job) recordEvent(ledger, { at: now, machine: run.machine, kind: "oom", ...job });
  }, now);
}

/**
 * What a fresh reading of a worker says about its memory: short of it (a
 * cool-down of two minutes), or a new out-of-memory kill since the last
 * reading of the same boot (five minutes). Only writes when something is new.
 */
export function noteMachineMemory(machine: string, label: string, reading: { bootId?: string | null; oomKills?: number | null; pressure?: number | null }, now = Date.now()): void {
  const pressed = underPressure(reading.pressure);
  const boot = reading.bootId ?? null;
  const oom = reading.oomKills ?? null;
  const changed = peek((ledger) => {
    const seen = ledger.seen[machine];
    const newOom = boot !== null && oom !== null && (!seen || seen.boot !== boot || seen.oom !== oom);
    const cooling = coolingDown(ledger, machine, now);
    return newOom || (pressed && !cooling);
  }, now);
  if (!changed) return;
  mutate((ledger) => {
    if (boot !== null && oom !== null && noteOomCount(ledger, machine, boot, oom)) coolDown(ledger, machine, label, "oom", now);
    if (pressed) coolDown(ledger, machine, label, "pressure", now);
  }, now);
}

/** The cool-down a machine is in, if any. */
export function machineCooldown(machine: string, now = Date.now()): Cooldown | null {
  return peek((ledger) => coolingDown(ledger, machine, now), now);
}

/** A run started on `place` (a machine id, or `local`). */
export function countJobStart(place: string, now = Date.now()): void {
  mutate((ledger) => countJob(ledger, place, now), now);
}

/** Add one line to the recent memory events. */
export function noteMemoryEvent(event: MemoryEvent): void {
  mutate((ledger) => recordEvent(ledger, event), event.at);
}

/** What the Machines panel shows: recent memory events (newest first) and runs per place in the last 24 hours. */
export function memoryOverview(now = Date.now()): MemoryOverview {
  return peek((ledger) => ({ events: ledger.events.filter((event) => now - event.at < EVENT_MAX_AGE_MS).slice().reverse(), jobs24h: jobsLast24h(ledger, now) }), now);
}

/** Forget the cached copy (tests point the agent directory somewhere else). */
export function resetMemoryLedgerCache(): void {
  globalThis.__codyWorkerMemory = undefined;
}
