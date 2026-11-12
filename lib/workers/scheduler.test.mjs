import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  WorkerScheduler,
  MAX_QUEUE,
  MAX_WAIT_MS,
  TICK_MS,
  PROBE_TTL_MS,
  FAILED_PROBE_TTL_MS,
  METER_FRESH_MS,
  RECENT_LAUNCH_MS,
} = await jiti.import("./scheduler.ts");

/**
 * The scheduler decides who gets which worker and when. What matters here:
 * jobs are served first in, first out (but a free slot goes to the oldest job
 * that can actually use it); the queue is bounded and a wait runs out; an
 * abort always cleans up (no timer is left ticking); a worker is read over
 * ssh only when no fresh live meter covers it, the answer is cached, and a
 * dead machine is not asked for every job; Cody's own just-started jobs count
 * even though no reading shows them yet; and nothing ever hangs, even when the
 * list of workers cannot be read.
 *
 * Everything is injected: a manual clock (time only moves when a test calls
 * `advance`), a list of workers, meters, and a probe that counts its calls.
 */

const START = 1_000_000;

function fakeClock() {
  let time = START;
  let seq = 0;
  let timers = [];
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => time,
    after(ms, run) {
      const timer = { at: time + ms, seq: seq++, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
    get pending() {
      return timers.length;
    },
    /** Move time forward, running due callbacks in order and letting promises settle between steps. */
    async advance(ms) {
      const target = time + ms;
      await settle();
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        time = due.at;
        due.run();
        await settle();
      }
      time = target;
      await settle();
    },
    settle,
  };
}

function facts(over = {}) {
  return { name: "a", arch: "x86_64", cpus: 8, memMB: 16384, slots: 1, tools: ["node", "rust"], onlyWhenIdle: false, ...over };
}

function machine(id, over = {}) {
  return { id, label: id, destination: `${id}.lan`, facts: facts({ name: id }), ...over };
}

const okProbe = (machineFacts, extra = {}) => ({ ok: true, facts: machineFacts, load: null, liveJobs: 0, ...extra });
const deadProbe = { ok: false, reason: "failed", detail: "no route" };

/** A scheduler wired to fakes. `workers`, `meters` and `outcomes` stay editable by the test. */
function rig(workers = [machine("a")]) {
  const clock = fakeClock();
  const state = {
    workers,
    meters: new Map(),
    outcomes: new Map(),
    probeCalls: [],
    published: [],
    gate: null,
    listThrows: null,
    listCalls: 0,
    probeThrows: false,
  };
  const deps = {
    clock,
    listWorkers() {
      state.listCalls++;
      if (state.listThrows) throw new Error(state.listThrows);
      return state.workers;
    },
    meterOf: (id) => state.meters.get(id) ?? null,
    async probe(m) {
      state.probeCalls.push(m.id);
      if (state.gate) await state.gate.promise;
      if (state.probeThrows) throw new Error("ssh exploded");
      const set = state.outcomes.get(m.id);
      const outcome = typeof set === "function" ? set() : set;
      return outcome ?? okProbe(m.facts ?? facts({ name: m.id }));
    },
    publishJobs: (id, count) => state.published.push([id, count]),
  };
  const sched = new WorkerScheduler(deps);
  /** Start an acquire and track whether it has answered yet. */
  const go = (request = {}, options = {}) => {
    const job = { done: false, result: null };
    job.promise = sched
      .acquire({ arch: null, tools: [], excluded: new Set(), local: false, ...request }, options)
      .then((result) => {
        job.done = true;
        job.result = result;
        return result;
      });
    return job;
  };
  return { sched, clock, state, go };
}

test("a free worker is granted at once and the job count is published", async () => {
  const { sched, clock, state, go } = rig();
  const job = go();
  const got = await job.promise;
  assert.equal(got.kind, "worker");
  assert.equal(got.lease.machine.id, "a");
  assert.equal(got.waitedMs, 0);
  assert.equal(got.freeCores, 8);
  assert.deepEqual(state.published, [["a", 1]]);
  assert.deepEqual(sched.snapshot(), { waiting: 0, running: { a: 1 } });
  assert.equal(clock.pending, 0);
});

test("release publishes zero, is safe to call twice, and wakes the next waiter", async () => {
  const { sched, clock, state, go } = rig();
  const first = await go().promise;
  const second = go();
  await clock.settle();
  assert.equal(second.done, false);
  assert.equal(sched.snapshot().waiting, 1);

  first.lease.release();
  first.lease.release();
  assert.equal((await second.promise).kind, "worker");
  // granted, released once (0), granted again (1): the second release call published nothing
  assert.deepEqual(state.published, [["a", 1], ["a", 0], ["a", 1]]);
});

test("with one slot, jobs get it in the order they asked", async () => {
  const { sched, clock, go } = rig();
  const order = [];
  const a = go();
  const b = go();
  const c = go();
  for (const [name, job] of [["A", a], ["B", b], ["C", c]]) job.promise.then(() => order.push(name));
  await clock.settle();
  assert.deepEqual(order, ["A"]);
  assert.equal(sched.snapshot().waiting, 2);

  a.result.lease.release();
  await clock.settle();
  assert.deepEqual(order, ["A", "B"]);
  assert.equal(sched.snapshot().waiting, 1);
  assert.equal(c.done, false);

  b.result.lease.release();
  await clock.settle();
  assert.deepEqual(order, ["A", "B", "C"]);
  assert.equal(sched.snapshot().waiting, 0);
  assert.equal(c.result.kind, "worker");
});

test("a freed slot goes to the oldest job that can use it, so a younger job on another architecture runs at once", async () => {
  const { clock, go } = rig([machine("x", { facts: facts({ name: "x", arch: "x86_64" }) }), machine("y", { facts: facts({ name: "y", arch: "aarch64" }) })]);
  const holder = go({ arch: "x86_64" });
  await holder.promise;
  const older = go({ arch: "x86_64" });
  await clock.settle();
  assert.equal(older.done, false);

  const younger = go({ arch: "aarch64" });
  const got = await younger.promise;
  assert.equal(got.kind, "worker");
  assert.equal(got.lease.machine.id, "y");
  assert.equal(older.done, false);

  holder.result.lease.release();
  const olderGot = await older.promise;
  assert.equal(olderGot.lease.machine.id, "x");
});

test("only MAX_QUEUE jobs wait; the next is refused at once naming the limit, and an abort frees a place", async () => {
  const { sched, clock, go } = rig();
  const holder = await go().promise;
  const controllers = [];
  const waiters = [];
  for (let i = 0; i < MAX_QUEUE; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    waiters.push(go({}, { signal: controller.signal }));
  }
  await clock.settle();
  assert.equal(sched.snapshot().waiting, MAX_QUEUE);
  assert.ok(waiters.every((job) => !job.done));

  const overflow = go();
  const refused = await overflow.promise;
  assert.equal(refused.kind, "refused");
  assert.match(refused.why, new RegExp(`${MAX_QUEUE} jobs are already waiting`));
  assert.match(refused.why, new RegExp(`queue holds ${MAX_QUEUE}`));
  assert.equal(sched.snapshot().waiting, MAX_QUEUE);

  controllers[0].abort();
  await clock.settle();
  assert.equal(waiters[0].result.kind, "aborted");
  assert.equal(sched.snapshot().waiting, MAX_QUEUE - 1);

  const admitted = go();
  await clock.settle();
  assert.equal(admitted.done, false);
  assert.equal(sched.snapshot().waiting, MAX_QUEUE);

  for (const controller of controllers) controller.abort();
  holder.lease.release();
  const last = await admitted.promise;
  assert.equal(last.kind, "worker");
});

test("a job that waits MAX_WAIT_MS is refused with a message about the wait, and nothing keeps ticking", async () => {
  const { sched, clock, go } = rig();
  await go().promise;
  const waiter = go();
  await clock.settle();
  assert.equal(clock.pending, 1);

  await clock.advance(MAX_WAIT_MS - TICK_MS);
  assert.equal(waiter.done, false);
  assert.equal(sched.snapshot().waiting, 1);

  for (let waited = MAX_WAIT_MS - TICK_MS; waited < MAX_WAIT_MS; waited += TICK_MS) await clock.advance(TICK_MS);
  assert.equal(waiter.done, true);
  assert.equal(waiter.result.kind, "refused");
  assert.match(waiter.result.why, /waited 30 minutes for a worker/);
  assert.equal(waiter.result.waitedMs, MAX_WAIT_MS);
  assert.equal(sched.snapshot().waiting, 0);
  assert.equal(clock.pending, 0);
});

test("an already aborted request is answered aborted without touching any dependency", async () => {
  const { clock, state, go } = rig();
  const controller = new AbortController();
  controller.abort();
  const got = await go({}, { signal: controller.signal }).promise;
  assert.deepEqual(got, { kind: "aborted" });
  assert.equal(state.listCalls, 0);
  assert.deepEqual(state.probeCalls, []);
  assert.deepEqual(state.published, []);
  assert.equal(clock.pending, 0);
});

test("a job aborted while waiting is answered aborted, leaves the queue, and stops the tick", async () => {
  const { sched, clock, state, go } = rig();
  await go().promise;
  const controller = new AbortController();
  const waiter = go({}, { signal: controller.signal });
  await clock.settle();
  assert.equal(sched.snapshot().waiting, 1);
  assert.equal(clock.pending, 1);

  controller.abort();
  assert.deepEqual(await waiter.promise, { kind: "aborted" });
  assert.equal(sched.snapshot().waiting, 0);
  assert.equal(clock.pending, 0);
  assert.deepEqual(state.published, [["a", 1]]);
});

test("a job that may run here does so at once when the only worker is full, and says its slots are in use", async () => {
  const { clock, go } = rig();
  await go().promise;
  const got = await go({ local: true }).promise;
  assert.equal(got.kind, "local");
  assert.match(got.why, /all 1 of its job slots are in use/);
  assert.equal(got.waitedMs, 0);
  assert.equal(clock.pending, 0);
});

test("a worker with the wrong architecture is never chosen: local when allowed, refused with the reason otherwise", async () => {
  const { go } = rig();
  const local = await go({ arch: "aarch64", local: true }).promise;
  assert.equal(local.kind, "local");
  assert.match(local.why, /it is x86_64, the job needs aarch64/);

  const refused = await go({ arch: "aarch64", local: false }).promise;
  assert.equal(refused.kind, "refused");
  assert.match(refused.why, /a: it is x86_64, the job needs aarch64/);
});

test("a worker without the required tool is refused naming the tool", async () => {
  const { go } = rig();
  const refused = await go({ tools: ["go"] }).promise;
  assert.equal(refused.kind, "refused");
  assert.match(refused.why, /it has no go/);
});

test("with no worker switched on, the job is refused or runs locally with the plain sentence", async () => {
  const { clock, go } = rig([]);
  const refused = await go().promise;
  assert.deepEqual(refused, { kind: "refused", why: "no machine is switched on as a worker", waitedMs: 0 });
  const local = await go({ local: true }).promise;
  assert.deepEqual(local, { kind: "local", why: "no machine is switched on as a worker", waitedMs: 0 });
  assert.equal(clock.pending, 0);
});

test("excluded machines are skipped: the other worker is used, and when none is left the job is refused", async () => {
  const { go } = rig([machine("a"), machine("b")]);
  const got = await go({ excluded: new Set(["a"]) }).promise;
  assert.equal(got.kind, "worker");
  assert.equal(got.lease.machine.id, "b");

  const none = await go({ excluded: new Set(["a", "b"]) }).promise;
  assert.equal(none.kind, "refused");
  assert.match(none.why, /it already failed this job/);
});

test("a probe answer is cached for PROBE_TTL_MS, then the worker is read again", async () => {
  const { clock, state, go } = rig([machine("a", { facts: facts({ name: "a", slots: 5 }) })]);
  await go().promise;
  assert.deepEqual(state.probeCalls, ["a"]);
  await go().promise;
  assert.equal(state.probeCalls.length, 1);

  await clock.advance(PROBE_TTL_MS - 1);
  await go().promise;
  assert.equal(state.probeCalls.length, 1);

  await clock.advance(1);
  await go().promise;
  assert.equal(state.probeCalls.length, 2);
});

test("a failed probe refuses that worker as not answering, and is remembered for FAILED_PROBE_TTL_MS", async () => {
  const { clock, state, go } = rig();
  state.outcomes.set("a", deadProbe);
  const refused = await go().promise;
  assert.equal(refused.kind, "refused");
  assert.match(refused.why, /a: it did not answer its last check/);
  assert.equal(state.probeCalls.length, 1);

  // past the good-answer lifetime but inside the failed one: not asked again
  await clock.advance(PROBE_TTL_MS + 1_000);
  assert.equal((await go().promise).kind, "refused");
  assert.equal(state.probeCalls.length, 1);

  // the machine came back; once the failed answer is old it is asked again
  state.outcomes.delete("a");
  await clock.advance(FAILED_PROBE_TTL_MS - PROBE_TTL_MS - 1_000);
  const back = await go().promise;
  assert.equal(state.probeCalls.length, 2);
  assert.equal(back.kind, "worker");
});

test("a probe that throws counts as a failed probe", async () => {
  const { state, go } = rig();
  state.probeThrows = true;
  const refused = await go().promise;
  assert.equal(refused.kind, "refused");
  assert.match(refused.why, /did not answer its last check/);
});

test("releasing a lease drops the cached probe so the next job reads the machine again", async () => {
  const { state, go } = rig([machine("a", { facts: facts({ name: "a", slots: 2 }) })]);
  const first = await go().promise;
  await go().promise;
  assert.equal(state.probeCalls.length, 1);
  first.lease.release();
  await go().promise;
  assert.equal(state.probeCalls.length, 2);
});

test("forget(id) drops the cached probe", async () => {
  const { sched, state, go } = rig([machine("a", { facts: facts({ name: "a", slots: 3 }) })]);
  await go().promise;
  sched.forget("a");
  await go().promise;
  assert.equal(state.probeCalls.length, 2);
});

test("acquires that arrive during one probe share it", async () => {
  const { clock, state, go } = rig([machine("a", { facts: facts({ name: "a", slots: 2 }) })]);
  state.gate = Promise.withResolvers();
  const one = go();
  const two = go();
  await clock.settle();
  assert.equal(state.probeCalls.length, 1);
  assert.equal(one.done || two.done, false);
  state.gate.resolve();
  const [x, y] = await Promise.all([one.promise, two.promise]);
  assert.equal(x.kind, "worker");
  assert.equal(y.kind, "worker");
  assert.equal(state.probeCalls.length, 1);
});

test("a fresh live meter with known facts means no probe; a stale one, or unknown facts, does probe", async () => {
  const { clock, state, go } = rig([machine("a", { facts: facts({ name: "a", slots: 9 }) })]);
  const reading = (at) => ({ cpuPercent: 5, load1: 0.1, memAvailMB: 8000, at });

  state.meters.set("a", reading(clock.now()));
  assert.equal((await go().promise).kind, "worker");
  assert.equal(state.probeCalls.length, 0);

  // exactly METER_FRESH_MS old is still fresh
  await clock.advance(METER_FRESH_MS);
  state.meters.set("a", reading(clock.now() - METER_FRESH_MS));
  await go().promise;
  assert.equal(state.probeCalls.length, 0);

  state.meters.set("a", reading(clock.now() - METER_FRESH_MS - 1));
  await go().promise;
  assert.equal(state.probeCalls.length, 1);

  // a fresh meter does not stand in for a description that was never read
  const unknown = rig([machine("u", { facts: null })]);
  unknown.state.meters.set("u", reading(unknown.clock.now()));
  assert.equal((await unknown.go().promise).kind, "worker");
  assert.equal(unknown.state.probeCalls.length, 1);
});

test("a fresh meter reading is what placement judges the load by", async () => {
  const { clock, state, go } = rig([machine("a", { facts: facts({ name: "a", onlyWhenIdle: true }) })]);
  state.meters.set("a", { cpuPercent: 90, load1: 4, memAvailMB: 8000, at: clock.now() });
  const got = await go({ local: true }).promise;
  assert.equal(got.kind, "local");
  assert.match(got.why, /only takes jobs while idle and its CPU is at 90%/);
  assert.equal(state.probeCalls.length, 0);
});

test("facts from the probe override what Settings saved", async () => {
  const r = rig([machine("a", { facts: facts({ name: "a", arch: "x86_64", slots: 1 }) })]);
  r.state.outcomes.set("a", okProbe(facts({ name: "a", arch: "aarch64", slots: 2 })));
  const first = await r.go({ arch: "aarch64" }).promise;
  assert.equal(first.kind, "worker");
  const second = await r.go({ arch: "aarch64" }).promise;
  assert.equal(second.kind, "worker", "the probe says 2 slots");
  assert.equal((await r.go({ arch: "x86_64", local: true }).promise).kind, "local");

  const unread = rig([machine("n", { facts: null })]);
  assert.equal((await unread.go().promise).kind, "worker");
});

test("jobs of other Cody instances seen by the probe count against the slots", async () => {
  const { go, state } = rig([machine("a", { facts: facts({ name: "a", slots: 2 }) })]);
  state.outcomes.set("a", okProbe(facts({ name: "a", slots: 2 }), { liveJobs: 1 }));
  const first = await go({ local: true }).promise;
  assert.equal(first.kind, "worker", "one of two slots is still free");

  const full = rig([machine("a", { facts: facts({ name: "a", slots: 1 }) })]);
  full.state.outcomes.set("a", okProbe(facts({ name: "a", slots: 1 }), { liveJobs: 1 }));
  const second = await full.go({ local: true }).promise;
  assert.equal(second.kind, "local");
  assert.match(second.why, /all 1 of its job slots are in use/);
});

test("onWaiting reports a 1-based position, the queue length, the wait so far and why, and survives a throwing handler", async () => {
  const { sched, clock, go } = rig();
  const holder = await go().promise;
  const seenA = [];
  const seenB = [];
  const a = go({}, {
    onWaiting: (info) => {
      seenA.push(info);
      throw new Error("status line broke");
    },
  });
  const b = go({}, { onWaiting: (info) => seenB.push(info) });
  await clock.settle();

  // within the first pass A is told before B has been counted as waiting; the next tick shows both
  assert.equal(seenA[0].position, 1);
  assert.equal(seenA[0].waitedMs, 0);
  assert.match(seenA[0].why, /all 1 of its job slots are in use/);
  assert.equal(seenB.at(-1).position, 2);
  assert.equal(seenB.at(-1).waiting, 2);

  const before = seenB.length;
  await clock.advance(TICK_MS);
  assert.ok(seenB.length > before);
  assert.equal(seenB.at(-1).waitedMs, TICK_MS);
  assert.equal(seenB.at(-1).position, 2);
  assert.equal(seenA.at(-1).position, 1);
  assert.equal(seenA.at(-1).waiting, 2);

  holder.lease.release();
  const got = await a.promise;
  assert.equal(got.kind, "worker", "the throwing handler did not break the queue");
  assert.equal(sched.snapshot().waiting, 1);
  got.lease.release();
  assert.equal((await b.promise).kind, "worker");
});

test("a job Cody just started counts against its worker even though no reading shows it, until RECENT_LAUNCH_MS passes", async () => {
  // Both workers are idle. `a` has more cores and wins a tie; once it has a fresh launch it is
  // treated as half used (2 slots), so the next job goes to `b`.
  const idle = { cpuPercent: 0, load1: 0, memAvailMB: 16000, at: 0 };
  const a = machine("a", { facts: facts({ name: "a", cpus: 8, slots: 2, onlyWhenIdle: true }) });
  const b = machine("b", { facts: facts({ name: "b", cpus: 6, slots: 1 }) });
  const { clock, state, go } = rig([a, b]);
  state.outcomes.set("a", () => okProbe(a.facts, { load: idle }));
  state.outcomes.set("b", () => okProbe(b.facts, { load: idle }));

  const first = await go().promise;
  assert.equal(first.lease.machine.id, "a");
  assert.equal(first.freeCores, 8);

  const second = await go().promise;
  assert.equal(second.lease.machine.id, "b");
  assert.equal(second.freeCores, 6);
  second.lease.release();

  // still within the window: `a` is still discounted
  await clock.advance(RECENT_LAUNCH_MS - 1);
  const third = await go().promise;
  assert.equal(third.lease.machine.id, "b");
  third.lease.release();

  // the launch is old enough to be in the readings: `a` is back to all 8 cores
  await clock.advance(1);
  const fourth = await go().promise;
  assert.equal(fourth.lease.machine.id, "a");
  assert.equal(fourth.freeCores, 8);
});

test("if the workers cannot be listed, a new job is refused instead of hanging", async () => {
  const { clock, state, go } = rig();
  state.listThrows = "settings unreadable";
  const got = await go().promise;
  assert.equal(got.kind, "refused");
  assert.equal(got.why, "Could not choose a worker: settings unreadable");
  assert.equal(clock.pending, 0);
});

test("if the workers become unlistable while jobs wait, every waiting job is refused on the next look", async () => {
  const { sched, clock, state, go } = rig();
  await go().promise;
  const one = go();
  const two = go();
  await clock.settle();
  assert.equal(sched.snapshot().waiting, 2);

  state.listThrows = "boom";
  await clock.advance(TICK_MS);
  for (const job of [one, two]) {
    assert.equal(job.result.kind, "refused");
    assert.match(job.result.why, /Could not choose a worker: boom/);
    assert.equal(job.result.waitedMs, TICK_MS);
  }
  assert.equal(sched.snapshot().waiting, 0);
  assert.equal(clock.pending, 0);
});
