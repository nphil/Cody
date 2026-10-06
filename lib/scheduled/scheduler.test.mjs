import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";
import { createJiti } from "jiti";

/**
 * The scheduler against a real store file and a fake clock, fake delivery and
 * fake usage: what it sends, when, how many times and what it says when it
 * cannot. Nothing here spawns an engine or waits on a real timer.
 */
const root = mkdtempSync(join(tmpdir(), "cody-scheduled-scheduler-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const scheduler = await jiti.import("./scheduler.ts");
const store = await jiti.import("./store.ts");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-05T23:00:00Z");

afterEach(() => {
  scheduler.stopScheduledSender();
  mock.timers.reset();
  writeFileSync(store.scheduledStorePath(), "", { mode: 0o600 });
});

const add = (overrides = {}) => store.insertItem({
  sessionId: "chat-1",
  accountKey: "alice",
  message: "carry on",
  mode: "at",
  dueAt: NOW - MINUTE,
  source: "user",
  ...overrides,
}, NOW).item;

const addQuota = (overrides = {}) => add({
  mode: "quota",
  dueAt: NOW - MINUTE,
  quota: { provider: "anthropic", modelId: "claude-opus-4-5", label: "Claude · Secondary", giveUpAt: NOW - MINUTE + 24 * HOUR },
  ...overrides,
});

/** A usage snapshot in which the model is spent until `resetsAt`, or usable. */
function usage({ exhaustedUntil = null, available = true } = {}) {
  return {
    available,
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    accounts: available ? [{
      provider: "anthropic",
      id: "a1",
      identity: null,
      credentialId: 1,
      label: "Anthropic",
      planType: null,
      unlimited: false,
      windows: [{
        id: "5h",
        label: "5-hour window",
        utilization: exhaustedUntil === null ? 20 : 100,
        resetsAt: exhaustedUntil === null ? new Date(NOW + 4 * HOUR).toISOString() : new Date(exhaustedUntil).toISOString(),
        state: exhaustedUntil === null ? "ok" : "exhausted",
        windowMs: 5 * HOUR,
      }],
    }] : [],
  };
}

function rig({ deliver, usage: usageFor = () => usage() } = {}) {
  const state = { clock: NOW, delivered: [], notes: [], reads: 0 };
  const deps = {
    now: () => state.clock,
    deliver: async (item) => {
      state.delivered.push({ id: item.id, sessionId: item.sessionId, message: item.message, clientMessageId: store.clientMessageIdFor(item), attempts: item.attempts, status: item.status });
      await deliver?.(item, state.delivered.length);
    },
    readUsage: async () => {
      state.reads += 1;
      return usageFor(state);
    },
    notify: async (outcome) => {
      state.notes.push(outcome);
    },
  };
  return { state, deps, advance: (ms) => { state.clock += ms; } };
}

const refusal = (message) => Object.assign(new Error(message), { retryable: false });

test("a due message is delivered exactly once, under a stable id, then removed, and the owner is told", async () => {
  const item = add();
  const { deps, state } = rig();
  await scheduler.runDue(deps);
  await scheduler.runDue(deps);
  assert.equal(state.delivered.length, 1, "a second round finds nothing left to send");
  assert.deepEqual(state.delivered[0], {
    id: item.id,
    sessionId: "chat-1",
    message: "carry on",
    clientMessageId: `sched-${item.id}`,
    attempts: 0,
    status: "sending",
  });
  assert.equal(store.findItem(item.id, NOW), null);
  assert.deepEqual(state.notes.map((note) => [note.kind, note.item.id]), [["sent", item.id]]);
});

test("nothing is sent before its time, and the scheduler knows how long to sleep", async () => {
  const item = add({ dueAt: NOW + 10 * MINUTE });
  const { deps, state } = rig();
  await scheduler.runDue(deps);
  assert.equal(state.delivered.length, 0);
  assert.equal(store.findItem(item.id, NOW).status, "pending");
  assert.equal(scheduler.nextWakeDelay(NOW), scheduler.MAX_SLEEP_MS, "a long wait is cut to a minute so a suspended clock is noticed");
  assert.equal(scheduler.nextWakeDelay(NOW + 10 * MINUTE - 30_000), 30_000);
  assert.equal(scheduler.nextWakeDelay(NOW + 10 * MINUTE - 100), scheduler.MIN_SLEEP_MS, "never a busy loop");
  assert.equal(scheduler.nextWakeDelay(NOW + 11 * MINUTE), scheduler.MIN_SLEEP_MS, "an overdue item is looked at at once, not in the past");
});

test("with nothing waiting there is nothing to wake for", () => {
  assert.equal(scheduler.nextWakeDelay(NOW), null);
  const failed = add();
  store.mutateItem(failed.id, (item) => ({ ...item, status: "failed", error: "x" }), NOW);
  assert.equal(scheduler.nextWakeDelay(NOW), null, "a failed message waits for a person, not for the clock");
});

test("a transient failure is retried on a back-off under the SAME id, then left failed and the owner told once", async () => {
  const item = add();
  const { deps, state, advance } = rig({ deliver: () => { throw new Error("The session stopped responding."); } });

  for (let attempt = 0; attempt < scheduler.RETRY_DELAYS_MS.length; attempt += 1) {
    await scheduler.runDue(deps);
    const waiting = store.findItem(item.id, state.clock);
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.attempts, attempt + 1);
    assert.equal(waiting.error, "The session stopped responding.");
    assert.equal(waiting.notBefore, state.clock + scheduler.RETRY_DELAYS_MS[attempt]);
    assert.equal(state.delivered.length, attempt + 1);
    await scheduler.runDue(deps);
    assert.equal(state.delivered.length, attempt + 1, "not before the back-off has passed");
    advance(scheduler.RETRY_DELAYS_MS[attempt]);
  }
  await scheduler.runDue(deps);
  const failed = store.findItem(item.id, state.clock);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, scheduler.MAX_ATTEMPTS);
  assert.equal(state.delivered.length, scheduler.MAX_ATTEMPTS);
  assert.deepEqual([...new Set(state.delivered.map((call) => call.clientMessageId))], [`sched-${item.id}`], "every retry is the same delivery");
  assert.deepEqual(state.delivered.map((call) => call.attempts), [0, 1, 2, 3, 4, 5], "a retry knows it is one, so it can look for its own earlier copy");
  assert.deepEqual(state.notes.map((note) => [note.kind, note.reason]), [["failed", "The session stopped responding."]]);

  advance(24 * HOUR);
  await scheduler.runDue(deps);
  assert.equal(state.delivered.length, scheduler.MAX_ATTEMPTS, "a failed message is not retried behind anyone's back");
});

test("an engine's refusal is final: no retry, failed at once, owner told", async () => {
  const item = add();
  const { deps, state } = rig({ deliver: () => { throw refusal("model_not_supported"); } });
  await scheduler.runDue(deps);
  const failed = store.findItem(item.id, NOW);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.error, "model_not_supported");
  assert.equal(failed.notBefore, undefined);
  assert.deepEqual(state.notes.map((note) => note.kind), ["failed"]);
});

test("a chat that never accepts the message is treated as not delivered after the send timeout, and queued for a retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const item = add();
  const { deps, state } = rig({ deliver: () => new Promise(() => {}) });
  const round = scheduler.runDue(deps);
  await Promise.resolve();
  mock.timers.tick(scheduler.SEND_TIMEOUT_MS + 1);
  await round;
  const waiting = store.findItem(item.id, NOW);
  assert.equal(waiting.status, "pending");
  assert.match(waiting.error, /did not accept the message in time/);
  assert.equal(state.delivered.length, 1);
  assert.equal(waiting.attempts, 1);
});

test("a cancel that lands between the decision and the claim means nothing is sent", async () => {
  const item = add();
  const { deps, state } = rig();
  store.mutateItem(item.id, () => null, NOW);
  assert.equal(await scheduler.fireItem(item.id, item.rev, deps), "skipped");
  assert.equal(state.delivered.length, 0);
});

test("an edit that lands between the decision and the claim is not sent under the old decision", async () => {
  const item = add();
  const { deps, state } = rig();
  store.mutateItem(item.id, (current) => ({ ...current, message: "edited" }), NOW);
  assert.equal(await scheduler.fireItem(item.id, item.rev, deps), "skipped", "the revision moved");
  assert.equal(state.delivered.length, 0);
  assert.equal(store.findItem(item.id, NOW).status, "pending", "and it is still waiting, to be decided about again");
  await scheduler.runDue(deps);
  assert.deepEqual(state.delivered.map((call) => call.message), ["edited"], "the next round sends what is there now");
});

test("a message already being sent cannot be claimed a second time", async () => {
  const item = add();
  const { deps, state } = rig();
  const first = scheduler.fireItem(item.id, item.rev, deps);
  const second = await scheduler.fireItem(item.id, item.rev, deps);
  assert.equal(second, "skipped");
  assert.equal(await first, "sent");
  assert.equal(state.delivered.length, 1);
});

test("a message found 'sending' at boot was interrupted: it waits again and counts as an attempt", () => {
  const item = add();
  store.mutateItem(item.id, (current) => ({ ...current, status: "sending", attempts: 1, notBefore: NOW + HOUR, firstAttemptAt: NOW - HOUR }), NOW);
  assert.equal(scheduler.recoverInterruptedItems(NOW), 1);
  const recovered = store.findItem(item.id, NOW);
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.firstAttemptAt, NOW - HOUR, "the retry searches the transcript from the very first attempt");
  assert.equal(recovered.notBefore, undefined);
  assert.equal(scheduler.recoverInterruptedItems(NOW), 0, "nothing left to recover");
});

test("a message that came due while the server was down is sent on boot, however late", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const old = add({ dueAt: NOW - 3 * 24 * HOUR, message: "missed over the weekend" });
  const stuck = add({ message: "was mid-send when the server died", dueAt: NOW - 2 * HOUR });
  store.mutateItem(stuck.id, (current) => ({ ...current, status: "sending", firstAttemptAt: NOW - 2 * HOUR }), NOW);
  const { deps, state } = rig();

  scheduler.startScheduledSender(deps);
  assert.equal(state.delivered.length, 0, "the server gets a moment to come up first");
  mock.timers.tick(scheduler.BOOT_DELAY_MS);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(state.delivered.map((call) => call.message).sort(), ["missed over the weekend", "was mid-send when the server died"]);
  assert.equal(state.delivered.find((call) => call.id === stuck.id).attempts, 1, "the interrupted one is a retry, so it checks the transcript first");
  assert.equal(store.findItem(old.id, NOW), null);
  assert.equal(store.findItem(stuck.id, NOW), null);
});

test("messages for one chat go in the order they were due, and different chats do not wait for each other", async () => {
  const log = [];
  const gates = new Map();
  const open = (key) => gates.get(key)();
  const hold = (key) => new Promise((resolve) => gates.set(key, resolve));
  const first = add({ sessionId: "A", message: "A1", dueAt: NOW - 5 * MINUTE });
  const second = add({ sessionId: "A", message: "A2", dueAt: NOW - 4 * MINUTE });
  const other = add({ sessionId: "B", message: "B1", dueAt: NOW - 3 * MINUTE });
  const { deps, state } = rig({
    deliver: async (item) => {
      log.push(`start ${item.message}`);
      await hold(item.message);
      log.push(`end ${item.message}`);
    },
  });
  const round = scheduler.runDue(deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["start A1", "start B1"], "B does not wait for A; A2 waits for A1");
  open("B1");
  await new Promise((resolve) => setImmediate(resolve));
  open("A1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.slice(-2), ["end A1", "start A2"]);
  open("A2");
  await round;
  assert.deepEqual(state.delivered.map((call) => call.message), ["A1", "B1", "A2"]);
  assert.equal(store.findItem(first.id, NOW), null);
  assert.equal(store.findItem(second.id, NOW), null);
  assert.equal(store.findItem(other.id, NOW), null);
});

test("one chat failing never stops another chat's message", async () => {
  add({ sessionId: "A", message: "doomed" });
  add({ sessionId: "B", message: "fine" });
  const { deps, state } = rig({ deliver: (item) => { if (item.message === "doomed") throw refusal("nope"); } });
  await scheduler.runDue(deps);
  assert.deepEqual(state.notes.map((note) => [note.kind, note.item.message]).sort(), [["failed", "doomed"], ["sent", "fine"]]);
});

// ---------------------------------------------------------------------------
// When quota resets
// ---------------------------------------------------------------------------

test("a quota message does not look at usage, let alone send, before its reset", async () => {
  const item = addQuota({ dueAt: NOW + 30 * MINUTE });
  const { deps, state } = rig();
  await scheduler.runDue(deps);
  assert.equal(state.reads, 0, "no read is spent before the reset");
  assert.equal(state.delivered.length, 0);
  assert.equal(store.findItem(item.id, NOW).status, "pending");
});

test("after the reset a fresh read that shows the model usable sends it", async () => {
  const item = addQuota();
  const { deps, state } = rig({ usage: () => usage() });
  await scheduler.runDue(deps);
  assert.equal(state.reads, 1);
  assert.deepEqual(state.delivered.map((call) => call.id), [item.id]);
  assert.equal(store.findItem(item.id, NOW), null);
});

test("a model still spent after its reset is re-checked in a few minutes, not sent, and not hammered", async () => {
  const item = addQuota();
  // The provider's window says it reset a moment ago, but its counters still read as spent.
  let reading = usage({ exhaustedUntil: NOW - 10_000 });
  const { deps, state, advance } = rig({ usage: () => reading });
  await scheduler.runDue(deps);
  assert.equal(state.delivered.length, 0);
  const waiting = store.findItem(item.id, NOW);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.notBefore, NOW + scheduler.QUOTA_RECHECK_MS, "a few minutes");
  await scheduler.runDue(deps);
  assert.equal(state.reads, 1, "not read again before the re-check time");

  advance(scheduler.QUOTA_RECHECK_MS);
  reading = usage();
  await scheduler.runDue(deps);
  assert.equal(state.reads, 2);
  assert.deepEqual(state.delivered.map((call) => call.id), [item.id], "and sent once the read shows it usable");
});

test("a model spent until a LATER reset sleeps until then and shows the new reset time", async () => {
  const item = addQuota();
  const laterReset = NOW + 5 * HOUR;
  const { deps, state, advance } = rig({ usage: () => usage({ exhaustedUntil: laterReset }) });
  await scheduler.runDue(deps);
  const waiting = store.findItem(item.id, NOW);
  assert.equal(waiting.dueAt, laterReset, "the row shows the reset the provider now reports");
  assert.equal(waiting.notBefore, NOW + scheduler.QUOTA_MAX_SLEEP_MS, "but it re-reads at least hourly");
  assert.equal(waiting.quota.giveUpAt, laterReset + 24 * HOUR, "giving up is counted from the reset it now waits for");
  advance(MINUTE);
  await scheduler.runDue(deps);
  assert.equal(state.reads, 1);
  assert.equal(state.delivered.length, 0);
});

test("a usage read that fails or reports nothing is not 'usable': it waits and tries again", async () => {
  const item = addQuota();
  for (const read of [() => usage({ available: false }), () => { throw new Error("spawn failed"); }]) {
    const { deps, state } = rig({ usage: read });
    await scheduler.runDue(deps);
    assert.equal(state.delivered.length, 0);
    assert.equal(store.findItem(item.id, NOW).notBefore, NOW + scheduler.QUOTA_RECHECK_MS);
    store.mutateItem(item.id, (current) => { const next = { ...current }; delete next.notBefore; return next; }, NOW);
  }
});

test("24 hours after the reset it gives up: failed, with the reason, and the owner is told", async () => {
  const item = addQuota();
  const { deps, state, advance } = rig({ usage: () => usage({ exhaustedUntil: NOW - 10_000 }) });
  await scheduler.runDue(deps);
  advance(24 * HOUR + 2 * MINUTE);
  await scheduler.runDue(deps);
  const failed = store.findItem(item.id, state.clock);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /not refilled 24 hours/);
  assert.deepEqual(state.notes.map((note) => note.kind), ["failed"]);
  assert.equal(state.delivered.length, 0);

  const unreadable = addQuota({ message: "never readable" });
  const quiet = rig({ usage: () => usage({ available: false }) });
  quiet.advance(25 * HOUR);
  await scheduler.runDue(quiet.deps);
  assert.match(store.findItem(unreadable.id, quiet.state.clock).error, /could not read the quota for 24 hours/);
});

test("a model that is usable at the very last check still gets its message", async () => {
  const item = addQuota();
  const { deps, state, advance } = rig({ usage: () => usage() });
  advance(24 * HOUR + HOUR);
  await scheduler.runDue(deps);
  assert.deepEqual(state.delivered.map((call) => call.id), [item.id], "the deadline is for giving up, not for refusing a model that is usable");
});

test("one usage read serves every quota message in a round", async () => {
  addQuota({ sessionId: "A", message: "one" });
  addQuota({ sessionId: "B", message: "two" });
  addQuota({ sessionId: "C", message: "three" });
  const { deps, state } = rig();
  await scheduler.runDue(deps);
  assert.equal(state.reads, 1);
  assert.equal(state.delivered.length, 3);
});

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

test("the timer is armed only while something waits, never keeps the process alive, and starts and stops cleanly", async () => {
  const { deps } = rig();
  scheduler.startScheduledSender(deps);
  scheduler.startScheduledSender(deps);
  const state = globalThis.__codyScheduledSender;
  assert.equal(state.started, true);
  assert.ok(state.timer, "armed for the boot round");
  assert.equal(state.timer.hasRef(), false, "unref'd: the schedule must never be what keeps the server alive");
  const first = state.timer;
  scheduler.startScheduledSender(deps);
  assert.equal(state.timer, first, "starting twice does not arm twice");

  scheduler.stopScheduledSender();
  assert.equal(state.started, false);
  assert.equal(state.timer, undefined);
  scheduler.wakeScheduledSender();
  assert.equal(state.timer, undefined, "a stopped sender ignores a wake");
});

test("a round with nothing left leaves no timer, and a change wakes the sender at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, state } = rig();
  scheduler.startScheduledSender(deps);
  mock.timers.tick(scheduler.BOOT_DELAY_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__codyScheduledSender.timer, undefined, "nothing is waiting, so nothing is armed");

  add({ message: "added later", dueAt: NOW - 1 });
  scheduler.wakeScheduledSender();
  mock.timers.tick(1);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.delivered.map((call) => call.message), ["added later"]);
});
