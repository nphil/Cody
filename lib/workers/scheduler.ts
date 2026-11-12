import type { WorkerArch } from "../machines/types";
import { describeRefusals, place } from "./placement";
import type { ProbeOutcome, Refusal, WorkerCandidate, WorkerLoad, WorkerMachine } from "./types";

/**
 * Who gets which worker, and when. A job asks for a worker ({@link
 * WorkerScheduler.acquire}) and is answered with one of four things: a worker
 * (a lease it gives back when done), "run it here" (nothing could take it and
 * the caller allowed that), "refused" (nothing ever could, or the wait ran
 * out), or "aborted".
 *
 * One dispatcher decides for everybody, in the order jobs asked (first in,
 * first out): a freed slot goes to the oldest job that can use it. It looks at
 * the workers again whenever something changes (a lease ends, a job arrives)
 * and every few seconds while a job waits, because a worker that is only used
 * while idle can open up with nothing of Cody's finishing.
 *
 * What it knows about a worker comes from three places, newest wins: the live
 * meters (when someone has the Machines list open), a probe over ssh
 * (cached for a few seconds, and dropped when one of Cody's jobs ends there),
 * and Cody's own count of jobs it has running. All of it is injected, so the
 * rules can be tested without a network or a clock.
 */

/** At most this many jobs wait at once; the next one is told to try later. */
export const MAX_QUEUE = 16;
/** A job gives up waiting after this long. */
export const MAX_WAIT_MS = 30 * 60_000;
/** While anything waits, the workers are looked at again this often. */
export const TICK_MS = 5_000;
/** A probe answers for this long. */
export const PROBE_TTL_MS = 15_000;
/** A probe that failed answers for this long (so a dead machine is not asked for every job). */
export const FAILED_PROBE_TTL_MS = 30_000;
/** A live meter reading is trusted for this long. */
export const METER_FRESH_MS = 6_000;
/** A job Cody started this recently is not in any reading yet. */
export const RECENT_LAUNCH_MS = 6_000;

export interface SchedulerClock {
  now(): number;
  /** Run `run` once after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const REAL_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface SchedulerDeps {
  /** Machines switched on as workers, in Settings order. */
  listWorkers(): WorkerMachine[];
  /** The newest live meter reading of a machine; null when nobody is watching or it is offline. */
  meterOf(machineId: string): WorkerLoad | null;
  /** Read a worker over ssh. Never rejects. */
  probe(machine: WorkerMachine): Promise<ProbeOutcome>;
  /** The number of Cody's jobs on a machine changed. */
  publishJobs(machineId: string, count: number): void;
  clock: SchedulerClock;
}

export interface AcquireRequest {
  arch: WorkerArch | null;
  tools: readonly string[];
  /** Machines that already failed this job. */
  excluded: ReadonlySet<string>;
  /** This server may run the job instead of waiting (the caller allowed it and arch and tools fit). */
  local: boolean;
}

export interface WaitingInfo {
  /** 1-based place among the jobs that are waiting. */
  position: number;
  waiting: number;
  waitedMs: number;
  /** Why the workers cannot take it yet, in plain words. */
  why: string;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called while the job waits, at least every {@link TICK_MS}. */
  onWaiting?: (info: WaitingInfo) => void;
}

export interface WorkerLease {
  machine: WorkerMachine;
  /** Give the slot back. Safe to call twice. */
  release(): void;
}

export type Acquired =
  | { kind: "worker"; lease: WorkerLease; waitedMs: number; freeCores: number }
  | { kind: "local"; why: string; waitedMs: number }
  | { kind: "refused"; why: string; waitedMs: number }
  | { kind: "aborted" };

interface Waiter {
  request: AcquireRequest;
  options: AcquireOptions;
  enqueuedAt: number;
  /** True once a pass found no worker for it right now and it stays queued. */
  waiting: boolean;
  settle(result: Acquired): void;
}

interface LeaseRecord {
  machine: WorkerMachine;
  at: number;
  released: boolean;
}

interface CachedProbe {
  at: number;
  outcome: ProbeOutcome;
}

export class WorkerScheduler {
  private readonly leases = new Map<string, Set<LeaseRecord>>();
  private readonly probes = new Map<string, CachedProbe>();
  private readonly inflight = new Map<string, Promise<void>>();
  private queue: Waiter[] = [];
  private dispatching = false;
  private again = false;
  private cancelTick: (() => void) | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Ask for a worker. Resolves when one is free, or with why none will be. Never rejects. */
  acquire(request: AcquireRequest, options: AcquireOptions = {}): Promise<Acquired> {
    const { promise, resolve } = Promise.withResolvers<Acquired>();
    const { signal } = options;
    if (signal?.aborted) {
      resolve({ kind: "aborted" });
      return promise;
    }
    let settled = false;
    const onAbort = () => waiter.settle({ kind: "aborted" });
    const waiter: Waiter = {
      request,
      options,
      enqueuedAt: this.deps.clock.now(),
      waiting: false,
      settle: (result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.queue = this.queue.filter((other) => other !== waiter);
        resolve(result);
        this.arrangeTick();
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.queue.push(waiter);
    void this.dispatch();
    return promise;
  }

  /** What is going on, for tests and the status line. */
  snapshot(): { waiting: number; running: Record<string, number> } {
    const running: Record<string, number> = {};
    for (const [id, set] of this.leases) running[id] = set.size;
    return { waiting: this.queue.filter((waiter) => waiter.waiting).length, running };
  }

  /** Forget what was read about a machine (its settings changed, or a check just ran). */
  forget(machineId: string): void {
    this.probes.delete(machineId);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  private async dispatch(): Promise<void> {
    if (this.dispatching) {
      this.again = true;
      return;
    }
    this.dispatching = true;
    try {
      do {
        this.again = false;
        if (this.queue.length === 0) break;
        await this.refresh();
        this.pass();
      } while (this.again);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = this.deps.clock.now();
      for (const waiter of [...this.queue]) {
        waiter.settle({ kind: "refused", why: `Could not choose a worker: ${message}`, waitedMs: now - waiter.enqueuedAt });
      }
    } finally {
      this.dispatching = false;
      this.arrangeTick();
    }
  }

  private arrangeTick(): void {
    if (!this.queue.some((waiter) => waiter.waiting)) {
      this.cancelTick?.();
      this.cancelTick = null;
      return;
    }
    if (this.cancelTick) return;
    this.cancelTick = this.deps.clock.after(TICK_MS, () => {
      this.cancelTick = null;
      void this.dispatch();
    });
  }

  /** Read the workers whose last reading is too old to trust. */
  private async refresh(): Promise<void> {
    const now = this.deps.clock.now();
    const due = this.deps.listWorkers().filter((machine) => this.needsProbe(machine, now));
    await Promise.all(due.map((machine) => this.probeOnce(machine)));
  }

  private needsProbe(machine: WorkerMachine, now: number): boolean {
    if (this.freshProbe(machine.id, now)) return false;
    const meter = this.deps.meterOf(machine.id);
    // A live meter says the machine is up and how busy it is; its description is already known.
    return !(meter && now - meter.at <= METER_FRESH_MS && machine.facts);
  }

  private freshProbe(machineId: string, now: number): ProbeOutcome | null {
    const cached = this.probes.get(machineId);
    if (!cached) return null;
    return now - cached.at < (cached.outcome.ok ? PROBE_TTL_MS : FAILED_PROBE_TTL_MS) ? cached.outcome : null;
  }

  private probeOnce(machine: WorkerMachine): Promise<void> {
    const running = this.inflight.get(machine.id);
    if (running) return running;
    const task = (async () => {
      let outcome: ProbeOutcome;
      try {
        outcome = await this.deps.probe(machine);
      } catch (error) {
        outcome = { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
      }
      this.probes.set(machine.id, { at: this.deps.clock.now(), outcome });
    })().finally(() => this.inflight.delete(machine.id));
    this.inflight.set(machine.id, task);
    return task;
  }

  /** Decide for every queued job, oldest first, with what is known right now. */
  private pass(): void {
    const now = this.deps.clock.now();
    const machines = this.deps.listWorkers();
    for (const waiter of [...this.queue]) {
      if (!this.queue.includes(waiter)) continue;
      const { request } = waiter;
      const waitedMs = now - waiter.enqueuedAt;
      const placement = place(this.candidates(machines, now), { arch: request.arch, tools: request.tools, excluded: request.excluded });

      if (placement.kind === "placed") {
        const machine = machines.find((candidate) => candidate.id === placement.id);
        if (machine) {
          waiter.settle({ kind: "worker", lease: this.grant(machine, now), waitedMs, freeCores: placement.freeCores });
          continue;
        }
      }
      if (placement.kind === "none") {
        const why = describeRefusals(placement.refusals);
        waiter.settle(request.local ? { kind: "local", why, waitedMs } : { kind: "refused", why, waitedMs });
        continue;
      }
      const why = placement.kind === "busy" ? busyReasons(placement.refusals) : "the machine that was chosen has just been removed from the list";
      if (request.local) {
        waiter.settle({ kind: "local", why, waitedMs });
        continue;
      }
      if (!waiter.waiting) {
        const waitingNow = this.queue.filter((other) => other.waiting).length;
        if (waitingNow >= MAX_QUEUE) {
          waiter.settle({ kind: "refused", why: `${waitingNow} jobs are already waiting for a worker (the queue holds ${MAX_QUEUE}); ${why}`, waitedMs });
          continue;
        }
        waiter.waiting = true;
      }
      if (waitedMs >= MAX_WAIT_MS) {
        waiter.settle({ kind: "refused", why: `waited ${Math.round(MAX_WAIT_MS / 60_000)} minutes for a worker and none became free (${why})`, waitedMs });
        continue;
      }
      this.notify(waiter, why, waitedMs);
    }
  }

  private notify(waiter: Waiter, why: string, waitedMs: number): void {
    const handler = waiter.options.onWaiting;
    if (!handler) return;
    const waiting = this.queue.filter((other) => other.waiting);
    try {
      handler({ position: waiting.indexOf(waiter) + 1, waiting: waiting.length, waitedMs, why });
    } catch {
      // a status line that throws must not stop the queue
    }
  }

  private candidates(machines: readonly WorkerMachine[], now: number): WorkerCandidate[] {
    return machines.map((machine): WorkerCandidate => {
      const probe = this.freshProbe(machine.id, now);
      const meter = this.deps.meterOf(machine.id);
      let load: WorkerLoad | null = meter && now - meter.at <= METER_FRESH_MS ? meter : null;
      let facts = machine.facts;
      let healthy = true;
      let live = 0;
      if (probe?.ok) {
        facts = probe.facts;
        live = probe.liveJobs;
        if (probe.load && (!load || probe.load.at > load.at)) load = probe.load;
      } else if (probe) {
        healthy = false;
      }
      const ours = [...(this.leases.get(machine.id) ?? [])];
      return {
        id: machine.id,
        label: machine.label,
        facts,
        healthy,
        // Jobs of other Cody instances show up only in the probe.
        running: Math.max(ours.length, live),
        recentLaunches: ours.filter((record) => now - record.at < RECENT_LAUNCH_MS).length,
        load,
      };
    });
  }

  // ── Leases ─────────────────────────────────────────────────────────────────

  private grant(machine: WorkerMachine, now: number): WorkerLease {
    const record: LeaseRecord = { machine, at: now, released: false };
    let set = this.leases.get(machine.id);
    if (!set) {
      set = new Set();
      this.leases.set(machine.id, set);
    }
    set.add(record);
    this.deps.publishJobs(machine.id, set.size);
    return { machine, release: () => this.release(record) };
  }

  private release(record: LeaseRecord): void {
    if (record.released) return;
    record.released = true;
    const set = this.leases.get(record.machine.id);
    set?.delete(record);
    if (set?.size === 0) this.leases.delete(record.machine.id);
    // The load changed: the next job reads the machine again.
    this.probes.delete(record.machine.id);
    this.deps.publishJobs(record.machine.id, set?.size ?? 0);
    void this.dispatch();
  }
}

/** The busy reasons of a refusal list, for one line of status. */
export function busyReasons(refusals: readonly Refusal[]): string {
  const busy = refusals.filter((refusal) => refusal.kind === "busy");
  return describeRefusals(busy.length > 0 ? busy : refusals);
}

declare global {
  var __codyWorkerScheduler: WorkerScheduler | undefined;
}

/**
 * Drop what the server's scheduler remembers about a machine (a check just
 * ran). The scheduler lives on globalThis, like the machine sampler, because
 * the server entry and the API routes each load their own copy of this file.
 */
export function forgetWorker(machineId: string): void {
  globalThis.__codyWorkerScheduler?.forget(machineId);
}
