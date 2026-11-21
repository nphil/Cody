/**
 * What Cody learns about memory on its workers and on itself, as pure functions
 * over one small ledger (memory-store.ts keeps it on disk). Nothing here calls
 * a model or a machine: the numbers come from a job's exit marker, the worker
 * check, the live meters and this server's own control group.
 *
 * Everything learned is bounded: a command's need is the biggest of its last
 * {@link ESTIMATE_RUNS} runs within {@link ESTIMATE_MAX_AGE_MS}, times
 * {@link ESTIMATE_MARGIN}; a machine that ran out of memory, or was short of
 * it, is only put behind the others for a few minutes. None of it ever stops a
 * job from running somewhere: it only changes the order of the choices.
 */

const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;

/** A run older than this says nothing about the command any more. */
export const ESTIMATE_MAX_AGE_MS = 14 * 24 * HOUR_MS;
/** The need of a command is the biggest of its last this-many runs. */
export const ESTIMATE_RUNS = 3;
/** ... times this, for the run that needs a little more. */
export const ESTIMATE_MARGIN = 1.2;
/** A machine whose kernel stopped a process for lack of memory goes behind the others for this long. */
export const OOM_COOLDOWN_MS = 5 * 60_000;
/** A machine that was short of memory goes behind the others for this long. */
export const PRESSURE_COOLDOWN_MS = 2 * 60_000;
/** Some task waited on memory for at least this share of the last ten seconds (PSI `some avg10`): the machine is short of memory. */
export const PRESSURE_SOME_PERCENT = 10;
/** This server counts as short of memory from this share of its limit. */
export const CODY_BUSY_FRACTION = 0.85;
/** The recent-events list keeps at most this many, none older than {@link EVENT_MAX_AGE_MS}. */
export const MAX_EVENTS = 50;
export const EVENT_MAX_AGE_MS = 7 * 24 * HOUR_MS;
/** At most this many commands are remembered (the ones run most recently). */
export const MAX_COMMANDS = 500;
/** The job counter covers this long. */
export const JOB_WINDOW_MS = 24 * HOUR_MS;

/** Memory this server keeps for itself and the chats before it runs a job: 2 GiB or a tenth of its limit, whichever is more. */
export function codyReserveBytes(limitBytes: number): number {
  return Math.max(2048 * MIB, Math.round(limitBytes * 0.1));
}

/** A command without the parts that change from run to run (numbers, spacing), so runs of "the same" command share what was learned. */
export function commandShape(command: string): string {
  return command.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** What a command's memory need is remembered under: the project and the command's shape. */
export function estimateKey(project: string, command: string): string {
  return `${project}\n${commandShape(command)}`;
}

export interface PeakRecord {
  at: number;
  /** The most memory the run's processes held together. For a run the kernel stopped for lack of memory: at least the limit it ran into. */
  bytes: number;
  machine: string;
  oom: boolean;
}

export type CooldownReason = "oom" | "pressure";

export interface Cooldown {
  until: number;
  why: CooldownReason;
}

export type MemoryEventKind = "oom" | "pressure" | "high";

/**
 * What an event says, as figures the Machines panel puts into the reader's
 * language; `text` keeps the same in English for the log (and for an event
 * saved without figures).
 */
export type MemoryEventDetail =
  /** The kernel stopped `count` processes in Cody's own container. */
  | { what: "killed"; count: number; usedBytes: number; limitBytes: number }
  /** Cody's own memory crossed the alert line; `biggest` names its largest processes ("node 2.1 GB"). */
  | { what: "high"; usedBytes: number; limitBytes: number; biggest: string[] }
  /** A worker goes behind the others for `minutes` (the event's kind says why). */
  | { what: "cooldown"; minutes: number }
  /** A job's command ran out of memory there: the machine's memory, and what the command held at the last reading, when known. */
  | { what: "job"; capBytes: number | null; peakBytes: number | null };

/** One line of the recent memory events the Machines panel lists. */
export interface MemoryEvent {
  at: number;
  /** A machine id, or `local` for this server. */
  machine: string;
  kind: MemoryEventKind;
  /** Plain words, ready to show. */
  text: string;
  detail?: MemoryEventDetail;
}

/** `GET /api/machines/memory`: what the Machines panel lists under each machine. */
export interface MemoryOverview {
  /** The last week's, newest first. */
  events: MemoryEvent[];
  /** Jobs started in the last 24 hours, per place (a machine id, or `local`). */
  jobs24h: Record<string, number>;
}

export interface MemoryLedger {
  version: 1;
  /** Recent runs of each command ({@link estimateKey}), newest last. */
  peaks: Record<string, PeakRecord[]>;
  /** Machines put behind the others for now. */
  cooldowns: Record<string, Cooldown>;
  /** Newest last. */
  events: MemoryEvent[];
  /** Runs started, per hour (epoch hour) and place (a machine id, or `local`). */
  jobs: Record<string, Record<string, number>>;
  /** The last out-of-memory count read from each machine, with the boot it belongs to, so only new ones count. */
  seen: Record<string, { boot: string; oom: number }>;
}

export function emptyLedger(): MemoryLedger {
  return { version: 1, peaks: {}, cooldowns: {}, events: [], jobs: {}, seen: {} };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const EVENT_KINDS: readonly string[] = ["oom", "pressure", "high"];
const bytesOrNull = (value: unknown): value is number | null => value === null || count(value);

/** An event's figures as saved, or undefined when they are not a known shape (the event then shows its `text`). */
function checkDetail(raw: unknown): MemoryEventDetail | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.what === "killed" && count(raw.count) && count(raw.usedBytes) && count(raw.limitBytes)) {
    return { what: "killed", count: raw.count, usedBytes: raw.usedBytes, limitBytes: raw.limitBytes };
  }
  if (raw.what === "high" && count(raw.usedBytes) && count(raw.limitBytes) && Array.isArray(raw.biggest) && raw.biggest.every((entry) => typeof entry === "string")) {
    return { what: "high", usedBytes: raw.usedBytes, limitBytes: raw.limitBytes, biggest: raw.biggest as string[] };
  }
  if (raw.what === "cooldown" && count(raw.minutes)) return { what: "cooldown", minutes: raw.minutes };
  if (raw.what === "job" && bytesOrNull(raw.capBytes) && bytesOrNull(raw.peakBytes)) return { what: "job", capBytes: raw.capBytes, peakBytes: raw.peakBytes };
  return undefined;
}

/**
 * The ledger as read from disk, or null when it is not one at all (it is then
 * started afresh). Entries that are malformed are dropped one by one: a bad
 * line never costs the rest.
 */
export function checkLedger(raw: unknown): MemoryLedger | null {
  if (!isObject(raw) || raw.version !== 1) return null;
  const ledger = emptyLedger();
  if (isObject(raw.peaks)) {
    for (const [key, runs] of Object.entries(raw.peaks)) {
      if (!Array.isArray(runs)) continue;
      const good = runs.filter(
        (run): run is PeakRecord => isObject(run) && count(run.at) && count(run.bytes) && typeof run.machine === "string" && typeof run.oom === "boolean",
      );
      if (good.length > 0) ledger.peaks[key] = good.map(({ at, bytes, machine, oom }) => ({ at, bytes, machine, oom }));
    }
  }
  if (isObject(raw.cooldowns)) {
    for (const [machine, cooldown] of Object.entries(raw.cooldowns)) {
      if (isObject(cooldown) && count(cooldown.until) && (cooldown.why === "oom" || cooldown.why === "pressure")) {
        ledger.cooldowns[machine] = { until: cooldown.until, why: cooldown.why };
      }
    }
  }
  if (Array.isArray(raw.events)) {
    for (const event of raw.events) {
      if (isObject(event) && count(event.at) && typeof event.machine === "string" && typeof event.kind === "string" && EVENT_KINDS.includes(event.kind) && typeof event.text === "string") {
        const detail = checkDetail(event.detail);
        ledger.events.push({ at: event.at, machine: event.machine, kind: event.kind as MemoryEventKind, text: event.text, ...(detail ? { detail } : {}) });
      }
    }
  }
  if (isObject(raw.jobs)) {
    for (const [hour, places] of Object.entries(raw.jobs)) {
      if (!/^\d+$/.test(hour) || !isObject(places)) continue;
      const kept: Record<string, number> = {};
      for (const [place, runs] of Object.entries(places)) if (count(runs)) kept[place] = runs;
      ledger.jobs[hour] = kept;
    }
  }
  if (isObject(raw.seen)) {
    for (const [machine, seen] of Object.entries(raw.seen)) {
      if (isObject(seen) && typeof seen.boot === "string" && count(seen.oom)) ledger.seen[machine] = { boot: seen.boot, oom: seen.oom };
    }
  }
  return ledger;
}

/** Forget what is too old to matter; keeps the ledger small. */
export function pruneLedger(ledger: MemoryLedger, now: number): void {
  const recent: Array<[string, PeakRecord[]]> = [];
  for (const [key, runs] of Object.entries(ledger.peaks)) {
    const kept = runs.filter((run) => now - run.at < ESTIMATE_MAX_AGE_MS).slice(-ESTIMATE_RUNS);
    if (kept.length > 0) recent.push([key, kept]);
  }
  recent.sort((a, b) => (b[1].at(-1)?.at ?? 0) - (a[1].at(-1)?.at ?? 0));
  ledger.peaks = Object.fromEntries(recent.slice(0, MAX_COMMANDS));
  for (const [machine, cooldown] of Object.entries(ledger.cooldowns)) if (cooldown.until <= now) delete ledger.cooldowns[machine];
  ledger.events = ledger.events.filter((event) => now - event.at < EVENT_MAX_AGE_MS).slice(-MAX_EVENTS);
  const firstHour = Math.floor((now - JOB_WINDOW_MS) / HOUR_MS);
  for (const hour of Object.keys(ledger.jobs)) if (Number(hour) <= firstHour) delete ledger.jobs[hour];
}

/** What a command needed lately, with the margin, in bytes; null when it has not run lately (unknown: anything will do). */
export function estimateBytes(ledger: MemoryLedger, key: string, now: number): number | null {
  const runs = (ledger.peaks[key] ?? []).filter((run) => now - run.at < ESTIMATE_MAX_AGE_MS).slice(-ESTIMATE_RUNS);
  if (runs.length === 0) return null;
  return Math.round(Math.max(...runs.map((run) => run.bytes)) * ESTIMATE_MARGIN);
}

/** Remember one run. A run stopped for lack of memory counts as needing at least `capBytes`, the limit it ran into. */
export function recordPeak(ledger: MemoryLedger, key: string, run: { at: number; bytes: number | null; machine: string; oom: boolean; capBytes?: number | null }): void {
  const bytes = Math.max(run.bytes ?? 0, run.oom ? (run.capBytes ?? 0) : 0);
  if (!(bytes > 0)) return;
  const runs = ledger.peaks[key] ?? [];
  runs.push({ at: run.at, bytes, machine: run.machine, oom: run.oom });
  ledger.peaks[key] = runs.slice(-ESTIMATE_RUNS);
}

/** Put a machine behind the others for a while. True when this starts (or worsens) a cool-down, false when one already covers it. */
export function startCooldown(ledger: MemoryLedger, machine: string, why: CooldownReason, now: number): boolean {
  const until = now + (why === "oom" ? OOM_COOLDOWN_MS : PRESSURE_COOLDOWN_MS);
  const current = ledger.cooldowns[machine];
  const active = current && current.until > now ? current : null;
  if (active && (active.why === "oom" || why === "pressure")) {
    if (until > active.until && active.why === why) active.until = until;
    return false;
  }
  ledger.cooldowns[machine] = { until, why };
  return true;
}

export function coolingDown(ledger: MemoryLedger, machine: string, now: number): Cooldown | null {
  const cooldown = ledger.cooldowns[machine];
  return cooldown && cooldown.until > now ? cooldown : null;
}

export function recordEvent(ledger: MemoryLedger, event: MemoryEvent): void {
  ledger.events.push(event);
  if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS);
}

/** A run started on `place` (a machine id, or `local`). */
export function countJob(ledger: MemoryLedger, place: string, now: number): void {
  const hour = String(Math.floor(now / HOUR_MS));
  const places = (ledger.jobs[hour] ??= {});
  places[place] = (places[place] ?? 0) + 1;
}

/** Runs started in the last 24 hours, per place. */
export function jobsLast24h(ledger: MemoryLedger, now: number): Record<string, number> {
  const firstHour = Math.floor((now - JOB_WINDOW_MS) / HOUR_MS);
  const totals: Record<string, number> = {};
  for (const [hour, places] of Object.entries(ledger.jobs)) {
    if (Number(hour) <= firstHour) continue;
    for (const [place, runs] of Object.entries(places)) totals[place] = (totals[place] ?? 0) + runs;
  }
  return totals;
}

/**
 * A machine's out-of-memory count as read now. True when it went up since the
 * last reading of the same boot; a first reading, or one after a reboot, only
 * sets the baseline.
 */
export function noteOomCount(ledger: MemoryLedger, machine: string, boot: string, oom: number): boolean {
  const seen = ledger.seen[machine];
  ledger.seen[machine] = { boot, oom };
  return Boolean(seen && seen.boot === boot && oom > seen.oom);
}

/** The `oom_kill` count of a cgroup v2 `memory.events` file; null when it has none. */
export function parseOomKills(text: string): number | null {
  const match = /^oom_kill (\d+)$/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** `some avg10` of a pressure file (`/proc/pressure/memory`, a cgroup's `memory.pressure`), in percent; null when it has none. */
export function parsePressure(text: string): number | null {
  const match = /^some avg10=(\d+(?:\.\d+)?)\b/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** The job failed and the kernel stopped a process for lack of memory while it ran. */
export function killedForMemory(code: number | null, memory: { oomKills: number | null } | null | undefined): boolean {
  return code !== 0 && (memory?.oomKills ?? 0) > 0;
}

/** A machine is short of memory: something waited on it for at least {@link PRESSURE_SOME_PERCENT} of the last ten seconds. */
export function underPressure(pressure: number | null | undefined): boolean {
  return pressure != null && pressure >= PRESSURE_SOME_PERCENT;
}

/** This server's memory, as `memory-watch.ts` reads it. */
export interface LocalMemory {
  /** In use, caches the kernel can drop already taken off. */
  usedBytes: number;
  /** The control group's limit, or the machine's memory when it has none. */
  limitBytes: number;
  /** PSI `some avg10` of the control group, percent; null when unknown. */
  pressure: number | null;
  /** Processes the kernel killed for memory in the control group so far; null when unknown. */
  oomKills: number | null;
  /** The kernel's boot id: the same for every container on this machine. */
  bootId: string | null;
}

/** Bytes as GB with one decimal, for the plain-words lines here. */
export function gigabytes(bytes: number): string {
  return (bytes / (1024 * MIB)).toFixed(1);
}

/** Memory a job may use on this server now, MB, keeping {@link codyReserveBytes} for Cody and its chats; null when unknown. */
export function localSpareMB(memory: LocalMemory | null): number | null {
  if (!memory) return null;
  return Math.max(0, Math.floor((memory.limitBytes - memory.usedBytes - codyReserveBytes(memory.limitBytes)) / MIB));
}

/** Why this server is short of memory now, in plain words; null when it is not (or nobody can tell). */
export function localStrain(memory: LocalMemory | null): string | null {
  if (!memory) return null;
  const share = memory.usedBytes / memory.limitBytes;
  const waiting = underPressure(memory.pressure);
  if (share < CODY_BUSY_FRACTION && !waiting) return null;
  return `this server is using ${gigabytes(memory.usedBytes)} of its ${gigabytes(memory.limitBytes)} GB of memory (${Math.round(share * 100)}%)${waiting ? " and is waiting on memory" : ""}`;
}
