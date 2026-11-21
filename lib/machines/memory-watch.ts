import * as fs from "node:fs";
import { EVENT_TAGS } from "../notifications/compose";
import { reportNtfyFailure } from "../notifications/dispatch";
import { publishNtfy } from "../notifications/ntfy";
import { recipientsForAccountEvent } from "../notifications/recipients";
import { isConfigured } from "../notifications/store";
import { gigabytes as gb, parseOomKills, parsePressure, type LocalMemory } from "./memory";
import { noteMemoryEvent } from "./memory-store";
import { parseMeminfo } from "./proc";

/**
 * This server's own memory: read on demand when a job is placed, and watched
 * for the two moments worth telling someone about. The watch costs nothing
 * while all is well: the kernel wakes it when the control group's
 * `memory.events` changes (it hit its limit, or killed something), and a
 * quarter-minute timer catches a slow climb, which that file does not show.
 *
 * - The kernel stopped a process here for lack of memory: one line in the
 *   recent memory events.
 * - Cody passed {@link HIGH_FRACTION} of its limit: one line and a `memoryHigh`
 *   notification naming the biggest processes, once until it is back under
 *   {@link CLEAR_FRACTION}.
 */

const ROOT = "/sys/fs/cgroup";
/** Cody is high on memory from this share of its limit, ... */
export const HIGH_FRACTION = 0.9;
/** ... and back to normal under this one. */
export const CLEAR_FRACTION = 0.8;
const POLL_MS = 15_000;
/** Changes of `memory.events` come in bursts while the limit is hit: at most one reading per this long. */
const MIN_GAP_MS = 1_000;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Read this server's memory now (a handful of small kernel files). Null when it cannot tell at all. */
export function readLocalMemory(root = ROOT, procRoot = "/proc"): LocalMemory | null {
  const meminfo = parseMeminfo((readText(`${procRoot}/meminfo`) ?? "").split("\n"));
  const machineBytes = meminfo ? meminfo.totalKb * 1024 : null;
  const current = Number.parseInt(readText(`${root}/memory.current`) ?? "", 10);
  const max = Number.parseInt(readText(`${root}/memory.max`) ?? "", 10);
  let usedBytes: number;
  let limitBytes: number;
  if (Number.isSafeInteger(current)) {
    const inactive = /^inactive_file (\d+)$/m.exec(readText(`${root}/memory.stat`) ?? "");
    usedBytes = Math.max(0, current - Number(inactive?.[1] ?? 0));
    const limits = [Number.isSafeInteger(max) && max > 0 ? max : null, machineBytes].filter((value): value is number => value !== null);
    if (limits.length === 0) return null;
    limitBytes = Math.min(...limits);
  } else if (meminfo && machineBytes !== null) {
    usedBytes = machineBytes - meminfo.availableKb * 1024;
    limitBytes = machineBytes;
  } else {
    return null;
  }
  const events = readText(`${root}/memory.events`);
  const pressure = readText(`${root}/memory.pressure`);
  return {
    usedBytes,
    limitBytes,
    pressure: pressure === null ? null : parsePressure(pressure),
    oomKills: events === null ? null : parseOomKills(events),
    bootId: readText(`${procRoot}/sys/kernel/random/boot_id`)?.trim() || null,
  };
}

/** The processes holding the most memory here, biggest first: `name size` each. */
export function biggestProcesses(procRoot = "/proc", count = 3): string[] {
  const found: Array<{ name: string; kb: number }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
  for (const pid of entries) {
    const status = readText(`${procRoot}/${pid}/status`);
    if (!status) continue;
    const name = /^Name:\s+(.+)$/m.exec(status)?.[1];
    const kb = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0);
    if (name && kb > 0) found.push({ name, kb });
  }
  return found
    .sort((a, b) => b.kb - a.kb)
    .slice(0, count)
    .map(({ name, kb }) => `${name} ${gb(kb * 1024)} GB`);
}

interface WatchState {
  watcher: fs.FSWatcher | null;
  timer: NodeJS.Timeout | null;
  pending: NodeJS.Timeout | null;
  lastAt: number;
  high: boolean;
  oomKills: number | null;
}

declare global {
  var __codyMemoryWatch: WatchState | undefined;
}

async function notifyHigh(title: string, message: string): Promise<void> {
  for (const recipient of recipientsForAccountEvent()) {
    const { prefs } = recipient;
    if (!isConfigured(prefs) || !prefs.events.memoryHigh.enabled) continue;
    const target = { server: prefs.server, topic: prefs.topic, token: prefs.token };
    const result = await publishNtfy(target, {
      title,
      message,
      priority: prefs.events.memoryHigh.priority,
      tags: [EVENT_TAGS.memoryHigh],
      ...(prefs.codyUrl ? { click: `${prefs.codyUrl}/?machines=1` } : {}),
    });
    if (!result.ok) reportNtfyFailure(recipient.key, target.server, "publish", result);
  }
}

/** Look at this server's memory once, and say what is new. */
export function checkLocalMemory(state: WatchState, memory: LocalMemory | null, now: number, tell: { event: typeof noteMemoryEvent; notify: typeof notifyHigh; biggest: () => string[] }): void {
  if (!memory) return;
  if (memory.oomKills !== null) {
    if (state.oomKills !== null && memory.oomKills > state.oomKills) {
      const killed = memory.oomKills - state.oomKills;
      tell.event({
        at: now,
        machine: "local",
        kind: "oom",
        text: `Cody's server: the kernel stopped ${killed === 1 ? "a process" : `${killed} processes`} for lack of memory (${gb(memory.usedBytes)} of ${gb(memory.limitBytes)} GB in use).`,
        detail: { what: "killed", count: killed, usedBytes: memory.usedBytes, limitBytes: memory.limitBytes },
      });
    }
    state.oomKills = memory.oomKills;
  }
  const share = memory.usedBytes / memory.limitBytes;
  if (share < CLEAR_FRACTION) state.high = false;
  if (share < HIGH_FRACTION || state.high) return;
  state.high = true;
  const biggest = tell.biggest();
  const text = `Cody's server is using ${gb(memory.usedBytes)} of its ${gb(memory.limitBytes)} GB of memory (${Math.round(share * 100)}%).${biggest.length > 0 ? ` Biggest: ${biggest.join(", ")}.` : ""}`;
  tell.event({ at: now, machine: "local", kind: "high", text, detail: { what: "high", usedBytes: memory.usedBytes, limitBytes: memory.limitBytes, biggest } });
  void tell.notify("Cody is low on memory", `${text} New jobs go to workers while it lasts.`).catch((error: unknown) => {
    console.warn(`[workers] the memory notification failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function check(): void {
  const state = globalThis.__codyMemoryWatch;
  if (!state) return;
  const now = Date.now();
  if (now - state.lastAt < MIN_GAP_MS) {
    state.pending ??= setTimeout(() => {
      state.pending = null;
      check();
    }, MIN_GAP_MS);
    state.pending.unref();
    return;
  }
  state.lastAt = now;
  try {
    checkLocalMemory(state, readLocalMemory(), now, { event: noteMemoryEvent, notify: notifyHigh, biggest: () => biggestProcesses() });
  } catch (error) {
    console.warn(`[workers] reading this server's memory failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Start watching (the server calls this once at startup; a second call does nothing). */
export function startMemoryWatch(): void {
  if (globalThis.__codyMemoryWatch) return;
  const state: WatchState = { watcher: null, timer: null, pending: null, lastAt: 0, high: false, oomKills: null };
  globalThis.__codyMemoryWatch = state;
  try {
    state.watcher = fs.watch(`${ROOT}/memory.events`, { persistent: false }, check);
    state.watcher.on("error", () => {
      state.watcher?.close();
      state.watcher = null;
    });
  } catch {
    // no cgroup v2 here: the timer alone does it
  }
  state.timer = setInterval(check, POLL_MS);
  state.timer.unref();
  check();
}

export function stopMemoryWatch(): void {
  const state = globalThis.__codyMemoryWatch;
  if (!state) return;
  state.watcher?.close();
  clearInterval(state.timer ?? undefined);
  clearTimeout(state.pending ?? undefined);
  globalThis.__codyMemoryWatch = undefined;
}
