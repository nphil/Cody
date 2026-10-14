import { readFile } from "node:fs/promises";
import { buildRawSample, countCores, metricsFrom, type RawSample } from "./proc";
import { runSsh, type SshRun } from "./ssh";
import { listMachineConfigs } from "./store";
import {
  SAMPLE_INTERVAL_MS,
  type MachineConfig,
  type MachineMetrics,
  type MachineReason,
  type MachineState,
  type MachineStatus,
  type MachineTestResult,
} from "./types";

/**
 * Keeps one live reading per machine, but only while somebody is looking.
 *
 * A browser that shows the top bar holds `GET /api/machines/stream` open, and
 * that subscription is what makes the sampler run: the first subscriber starts
 * a collector per machine (a timer reading `/proc` for this server, one
 * long-lived `ssh` for each other machine), the last one leaving starts a
 * minute's countdown (a page reload must not tear every ssh down), and when it
 * runs out every collector stops and every ssh process is killed. Nobody
 * watching means nothing runs and nothing is open on anyone's machine.
 *
 * Memory is bounded by construction: one record per machine (at most
 * `MAX_MACHINES`), holding the latest reading and the one before it. There is
 * no history.
 */

export interface CollectorEvents {
  /** A fresh reading arrived. */
  sample(raw: RawSample): void;
  /** The machine cannot be read right now. */
  state(status: Exclude<MachineStatus, "online">, reason: MachineReason): void;
}

export interface Collector {
  stop(): void;
}

export type CollectorFactory = (config: MachineConfig, events: CollectorEvents) => Collector;

/** The clock and timers, injectable so the lifecycle is testable without
 * waiting a minute. Real timers never keep the process alive. */
export interface Timers {
  now(): number;
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

// ── Collectors ───────────────────────────────────────────────────────────────

async function readProcFiles(): Promise<RawSample | null> {
  const [stat, meminfo, loadavg] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/loadavg", "utf8").catch(() => ""),
  ]);
  return buildRawSample({
    cpuLine: stat.split("\n", 1)[0] ?? null,
    memLines: meminfo.split("\n"),
    loadLine: loadavg.split("\n", 1)[0] ?? null,
    cores: countCores(stat),
  });
}

/** After the first reading the next comes quickly, so the first CPU figure
 * (it needs two readings) appears almost at once instead of two seconds in. */
const LOCAL_WARMUP_MS = 500;

/** This server: `/proc`, read on a timer. Linux only: anything else reports
 * itself unavailable rather than guessing from numbers that mean something
 * different (macOS and Windows have no `MemAvailable`). */
export function startLocalCollector(
  events: CollectorEvents,
  timers: Timers = REAL_TIMERS,
  read: () => Promise<RawSample | null> = readProcFiles,
  platform: string = process.platform,
): Collector {
  if (platform !== "linux") {
    events.state("unavailable", "not_linux");
    return { stop() {} };
  }
  let stopped = false;
  let cancel: (() => void) | null = null;
  let readings = 0;

  const tick = async () => {
    cancel = null;
    if (stopped) return;
    let sample: RawSample | null = null;
    let missing = false;
    try {
      sample = await read();
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (stopped) return;
    if (sample) {
      readings += 1;
      events.sample(sample);
    } else {
      events.state("unavailable", missing ? "not_linux" : "read_failed");
      // No /proc at all will not come back by waiting; a hiccup might.
      if (missing) return;
    }
    cancel = timers.after(readings === 1 ? LOCAL_WARMUP_MS : SAMPLE_INTERVAL_MS, () => void tick());
  };
  void tick();

  return {
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}

/** Retry gaps after a connection fails, growing to a ceiling. */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
/** Failures that only the person can fix (a key, a name, a host key): trying
 * again every few seconds would just fill the far side's auth log, and on a
 * machine running fail2ban get Cody's address banned. A change in Settings
 * restarts the machine at once; otherwise it is retried this rarely. */
export const RETRY_SLOW_MS = 5 * 60_000;
const SLOW_REASONS: ReadonlySet<MachineReason> = new Set(["auth", "host_key", "unknown_host", "no_ssh"]);
/** An ssh that is alive but silent this long is stuck. */
export const STALL_MS = 15_000;
const STALL_CHECK_MS = 5_000;

/** A machine over ssh: one long-lived connection that is restarted, with
 * backoff, whenever it dies, and killed the moment the collector stops. */
export function startSshCollector(
  destination: string,
  events: CollectorEvents,
  timers: Timers = REAL_TIMERS,
  connectSsh: typeof runSsh = runSsh,
): Collector {
  let stopped = false;
  let generation = 0;
  let failures = 0;
  let run: SshRun | null = null;
  let cancelRetry: (() => void) | null = null;
  let cancelStallCheck: (() => void) | null = null;
  let lastProgress = 0;
  let samplesThisRun = 0;

  const fail = (reason: MachineReason) => {
    failures += 1;
    // A machine that was working and merely dropped gets one quiet, immediate
    // retry shown as "connecting" instead of flashing "offline".
    const quick = samplesThisRun > 0 && failures === 1;
    events.state(quick ? "connecting" : "offline", quick ? "dropped" : reason);
    const wait = SLOW_REASONS.has(reason) ? RETRY_SLOW_MS : RETRY_BACKOFF_MS[Math.min(failures - 1, RETRY_BACKOFF_MS.length - 1)];
    cancelRetry = timers.after(wait, connect);
  };

  const watch = (mine: number) => {
    cancelStallCheck = timers.after(STALL_CHECK_MS, () => {
      cancelStallCheck = null;
      if (stopped || mine !== generation || !run) return;
      if (timers.now() - lastProgress > STALL_MS) {
        run.stop();
        run = null;
        generation += 1;
        fail("unreachable");
        return;
      }
      watch(mine);
    });
  };

  function connect() {
    cancelRetry = null;
    if (stopped) return;
    const mine = ++generation;
    lastProgress = timers.now();
    samplesThisRun = 0;
    try {
      run = connectSsh(destination, {
        onSample(sample) {
          if (stopped || mine !== generation) return;
          failures = 0;
          samplesThisRun += 1;
          lastProgress = timers.now();
          events.sample(sample);
        },
        onNoProc() {
          if (stopped || mine !== generation) return;
          run?.stop();
          run = null;
          generation += 1;
          cancelStallCheck?.();
          cancelStallCheck = null;
          // Reachable but not Linux: that does not change by retrying.
          events.state("unavailable", "not_linux");
        },
        onClose(close) {
          if (stopped || mine !== generation) return;
          run = null;
          cancelStallCheck?.();
          cancelStallCheck = null;
          fail(close.reason);
        },
      });
    } catch {
      run = null;
      fail("failed");
      return;
    }
    watch(mine);
  }
  connect();

  return {
    stop() {
      stopped = true;
      generation += 1;
      cancelRetry?.();
      cancelStallCheck?.();
      cancelRetry = null;
      cancelStallCheck = null;
      run?.stop();
      run = null;
    },
  };
}

// ── The sampler ──────────────────────────────────────────────────────────────

export type MachineListener = (machines: MachineState[]) => void;

export interface SamplerDeps {
  readConfig(): MachineConfig[];
  collect: CollectorFactory;
  timers: Timers;
}

/** After the last viewer leaves, how long the sampler keeps running. */
export const IDLE_STOP_MS = 60_000;
/** Readings that land together are sent together. */
const EMIT_DELAY_MS = 250;
/** One per open page; far more than a person has tabs. */
const MAX_SUBSCRIBERS = 64;

interface Runtime {
  config: MachineConfig;
  status: MachineStatus;
  reason: MachineReason | null;
  raw: RawSample | null;
  metrics: MachineMetrics | null;
  collector: Collector | null;
}

function stateOf(runtime: Runtime): MachineState {
  const { config } = runtime;
  return { id: config.id, name: config.name, kind: config.kind, status: runtime.status, reason: runtime.reason, metrics: runtime.metrics };
}

export class MachineSampler {
  private readonly runtimes = new Map<string, Runtime>();
  private order: string[] = [];
  private readonly listeners = new Set<MachineListener>();
  private running = false;
  private cancelIdleStop: (() => void) | null = null;
  private cancelEmit: (() => void) | null = null;

  constructor(private readonly deps: SamplerDeps) {}

  /** Start watching. Null when there are already too many viewers. The
   * returned function stops watching; the last one out starts the countdown. */
  subscribe(listener: MachineListener): (() => void) | null {
    if (this.listeners.size >= MAX_SUBSCRIBERS) return null;
    this.listeners.add(listener);
    this.cancelIdleStop?.();
    this.cancelIdleStop = null;
    if (!this.running) this.start();
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      this.cancelIdleStop = this.deps.timers.after(IDLE_STOP_MS, () => {
        this.cancelIdleStop = null;
        if (this.listeners.size === 0) this.stop();
      });
    };
  }

  /** Every machine, in the order Settings lists them. */
  states(): MachineState[] {
    if (!this.running) {
      return this.deps.readConfig().map((config) => ({
        id: config.id, name: config.name, kind: config.kind, status: "connecting", reason: "starting", metrics: null,
      }));
    }
    const states: MachineState[] = [];
    for (const id of this.order) {
      const runtime = this.runtimes.get(id);
      if (runtime) states.push(stateOf(runtime));
    }
    return states;
  }

  /** The saved list changed: start what was added, stop what was removed,
   * restart what now points somewhere else, rename the rest in place. */
  reconcile(): void {
    if (!this.running) return;
    const configs = this.deps.readConfig();
    const wanted = new Set(configs.map((config) => config.id));
    for (const [id, runtime] of this.runtimes) {
      if (wanted.has(id)) continue;
      runtime.collector?.stop();
      this.runtimes.delete(id);
    }
    this.order = configs.map((config) => config.id);
    for (const config of configs) {
      const existing = this.runtimes.get(config.id);
      if (!existing) {
        this.createRuntime(config);
      } else if (existing.config.kind !== config.kind || existing.config.destination !== config.destination) {
        existing.collector?.stop();
        this.runtimes.delete(config.id);
        this.createRuntime(config);
      } else {
        existing.config = config;
      }
    }
    this.scheduleEmit();
  }

  /** Stop every collector now (server shutdown, or the idle countdown ran out).
   * Viewers stay subscribed: a new one starts it again. */
  stop(): void {
    this.cancelIdleStop?.();
    this.cancelEmit?.();
    this.cancelIdleStop = null;
    this.cancelEmit = null;
    for (const runtime of this.runtimes.values()) runtime.collector?.stop();
    this.runtimes.clear();
    this.order = [];
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private start(): void {
    this.running = true;
    const configs = this.deps.readConfig();
    this.order = configs.map((config) => config.id);
    for (const config of configs) this.createRuntime(config);
  }

  private createRuntime(config: MachineConfig): void {
    const runtime: Runtime = { config, status: "connecting", reason: "starting", raw: null, metrics: null, collector: null };
    this.runtimes.set(config.id, runtime);
    // A runtime that was replaced or removed must not be written to by the
    // collector it used to own.
    const live = () => this.runtimes.get(config.id) === runtime;
    try {
      runtime.collector = this.deps.collect(config, {
        sample: (raw) => {
          if (!live()) return;
          runtime.metrics = metricsFrom(runtime.raw, raw, this.deps.timers.now());
          runtime.raw = raw;
          runtime.status = "online";
          runtime.reason = null;
          this.scheduleEmit();
        },
        state: (status, reason) => {
          if (!live()) return;
          runtime.status = status;
          runtime.reason = reason;
          // Numbers from before the outage would be a lie, and the first
          // reading afterwards has nothing true to subtract from.
          runtime.raw = null;
          runtime.metrics = null;
          this.scheduleEmit();
        },
      });
    } catch {
      runtime.status = "offline";
      runtime.reason = "failed";
    }
  }

  private scheduleEmit(): void {
    if (this.cancelEmit) return;
    this.cancelEmit = this.deps.timers.after(EMIT_DELAY_MS, () => {
      this.cancelEmit = null;
      const states = this.states();
      for (const listener of [...this.listeners]) {
        try {
          listener(states);
        } catch {
          // a viewer that went away mid-frame
        }
      }
    });
  }
}

// ── The one sampler this server runs ─────────────────────────────────────────

declare global {
  var __codyMachineSampler: MachineSampler | undefined;
}

function liveDeps(): SamplerDeps {
  return {
    readConfig: listMachineConfigs,
    collect: (config, events) =>
      config.kind === "local" ? startLocalCollector(events) : startSshCollector(config.destination ?? "", events),
    timers: REAL_TIMERS,
  };
}

/** On globalThis, not in module state: the server entry loads this file through
 * jiti (to stop it at shutdown) while the API routes load it through Next's
 * bundler, and both must be talking to the same sampler. */
function machineSampler(): MachineSampler {
  if (!globalThis.__codyMachineSampler) {
    globalThis.__codyMachineSampler = new MachineSampler(liveDeps());
    process.once("exit", () => globalThis.__codyMachineSampler?.stop());
  }
  return globalThis.__codyMachineSampler;
}

export function subscribeMachines(listener: MachineListener): (() => void) | null {
  return machineSampler().subscribe(listener);
}

export function getMachineStates(): MachineState[] {
  return machineSampler().states();
}

/** Call after the saved list changed. */
export function reconcileMachines(): void {
  globalThis.__codyMachineSampler?.reconcile();
}

/** Server shutdown: kill every ssh this sampler started. */
export function stopMachineSampler(): void {
  globalThis.__codyMachineSampler?.stop();
}

// ── Test button ──────────────────────────────────────────────────────────────

export class MachineTestBusyError extends Error {
  constructor() {
    super("Too many machine tests are running");
    this.name = "MachineTestBusyError";
  }
}

/** A test is one ssh process the person asked for; bounding them keeps a
 * mashed button from becoming a fan of connections. */
const MAX_CONCURRENT_TESTS = 2;
export const TEST_TIMEOUT_MS = 12_000;
let testsRunning = 0;

/**
 * Take one real reading over ssh, exactly as the sampler would: the first
 * connection answers with a reading at once and a second a second later, which
 * is what a CPU figure needs. Resolves with the numbers or with the reason it
 * failed, never rejects (except for the concurrency bound).
 */
export function testSshMachine(
  destination: string,
  connectSsh: typeof runSsh = runSsh,
  timeoutMs: number = TEST_TIMEOUT_MS,
): Promise<MachineTestResult> {
  if (testsRunning >= MAX_CONCURRENT_TESTS) return Promise.reject(new MachineTestBusyError());
  testsRunning += 1;
  return new Promise<MachineTestResult>((resolve) => {
    const started = Date.now();
    let previous: RawSample | null = null;
    let settled = false;
    let run: SshRun | null = null;
    const timer = setTimeout(() => settle({ ok: false, reason: "unreachable", detail: "" }), timeoutMs);
    timer.unref?.();

    function settle(result: MachineTestResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run?.stop();
      testsRunning -= 1;
      resolve(result);
    }

    try {
      run = connectSsh(destination, {
        onSample(sample) {
          if (!previous) {
            previous = sample;
            return;
          }
          const metrics = metricsFrom(previous, sample, Date.now());
          settle({
            ok: true,
            ms: Date.now() - started,
            cpuPercent: metrics.cpuPercent,
            cores: metrics.cores,
            load1: metrics.load1,
            memPercent: metrics.memPercent,
            memTotalBytes: metrics.memTotalBytes,
            memUsedBytes: metrics.memUsedBytes,
          });
        },
        onNoProc: () => settle({ ok: false, reason: "not_linux", detail: "" }),
        onClose: (close) => settle({ ok: false, reason: close.samples > 0 ? "dropped" : close.reason, detail: close.detail }),
      });
    } catch {
      settle({ ok: false, reason: "failed", detail: "" });
    }
    // A connection that answered before `run` was assigned has settled
    // already; make sure it is not left running.
    if (settled) run?.stop();
  });
}
