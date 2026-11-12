import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  SEEN_BATCH_MS,
  SEEN_DWELL_MS,
  SEEN_MIN_RATIO,
  createSeenReporter,
  newOpenId,
  observeSeen,
  parseNewKeysAnswer,
} = await jiti.import("./settings-new-reporter.ts");
const { MAX_OPEN_ID_CHARS, MAX_REPORT_KEYS } = await jiti.import("./settings-new-keys.ts");

/** A virtual clock: timers run when `advance` moves time past them, in order. */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(run, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

/** A reporter env whose POSTs are recorded and answer `outcomes` in order (true when exhausted). */
function reporterEnv(outcomes = []) {
  const time = clock();
  const sent = [];
  return {
    time,
    sent,
    env: {
      send: async (report, options) => {
        sent.push({ report: structuredClone(report), keepalive: options.keepalive });
        return outcomes.length > 0 ? outcomes.shift() : true;
      },
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("parseNewKeysAnswer reads the route's answer and refuses anything else", () => {
  assert.deepEqual(
    parseNewKeysAnswer({ engine: { id: "omp", version: "18.19.0" }, previousVersion: "18.8.3", firstRun: false, newKeys: ["a.b", "c"], since: { "a.b": "18.19.0", c: null, d: 4 }, fadeAfter: 3 }),
    { engineId: "omp", version: "18.19.0", keys: ["a.b", "c"], since: { "a.b": "18.19.0", c: null } },
  );
  assert.deepEqual(parseNewKeysAnswer({ engine: { id: "omp", version: null }, newKeys: [] }), { engineId: "omp", version: null, keys: [], since: {} });
  assert.deepEqual(parseNewKeysAnswer({ engine: { id: "omp" }, newKeys: ["ok", 7, "", null] })?.keys, ["ok"], "non-string and empty entries are dropped");
  for (const garbage of [null, undefined, "text", 3, [], {}, { error: "nope" }, { engine: {}, newKeys: [] }, { engine: { id: "" }, newKeys: [] }, { engine: { id: "omp" } }, { engine: { id: "omp" }, newKeys: "a" }]) {
    assert.equal(parseNewKeysAnswer(garbage), null, JSON.stringify(garbage));
  }
});

test("an open id is unique and fits what the server accepts", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newOpenId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id.length > 0 && id.length <= MAX_OPEN_ID_CHARS);
});

test("a seen key is sent once per open, however often the chip reports it", async () => {
  const { env, sent, time } = reporterEnv();
  const reporter = createSeenReporter("open-1", env);
  reporter.seen("a");
  reporter.seen("a");
  reporter.seen("b");
  assert.equal(sent.length, 0, "nothing goes out before the batch window ends");
  time.advance(SEEN_BATCH_MS - 1);
  assert.equal(sent.length, 0);
  time.advance(1);
  assert.deepEqual(sent, [{ report: { openId: "open-1", seen: ["a", "b"] }, keepalive: false }], "one POST carries every chip that arrived in the window");
  await settle();
  reporter.seen("a");
  reporter.seen("b");
  time.advance(SEEN_BATCH_MS * 5);
  assert.equal(sent.length, 1, "a chip that scrolls in again later is not a second view");
  reporter.seen("c");
  time.advance(SEEN_BATCH_MS);
  assert.deepEqual(sent[1].report, { openId: "open-1", seen: ["c"] }, "a new key starts a new batch under the same open id");
});

test("a change goes out at once, with the pending views minus the changed key", () => {
  const { env, sent, time } = reporterEnv();
  const reporter = createSeenReporter("open-2", env);
  reporter.seen("a");
  reporter.seen("b");
  reporter.changed("b");
  assert.deepEqual(sent, [{ report: { openId: "open-2", seen: ["a"], changed: ["b"] }, keepalive: false }]);
  assert.equal(time.pending(), 0, "the batch timer was spent by the flush");
  reporter.changed("b");
  reporter.seen("b");
  time.advance(SEEN_BATCH_MS * 3);
  assert.equal(sent.length, 1, "a changed key is neither changed nor seen a second time");
  reporter.changed("c");
  assert.deepEqual(sent[1].report, { openId: "open-2", changed: ["c"] });
});

test("a failed POST puts its keys back and they ride with the next one, with no retry loop", async () => {
  const { env, sent, time } = reporterEnv([false]);
  const reporter = createSeenReporter("open-3", env);
  reporter.seen("a");
  time.advance(SEEN_BATCH_MS);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(time.pending(), 0, "a failure arms no timer of its own");
  time.advance(SEEN_BATCH_MS * 10);
  assert.equal(sent.length, 1, "no retry loop");
  reporter.seen("b");
  time.advance(SEEN_BATCH_MS);
  assert.deepEqual(sent[1].report, { openId: "open-3", seen: ["a", "b"] }, "the failed key is sent again with the next batch");
  await settle();
  reporter.seen("a");
  time.advance(SEEN_BATCH_MS);
  assert.equal(sent.length, 2, "once accepted it is not sent again");
});

test("a failed change is sent again with the next flush", async () => {
  const { env, sent } = reporterEnv([false]);
  const reporter = createSeenReporter("open-4", env);
  reporter.changed("a");
  await settle();
  reporter.flush();
  assert.deepEqual(sent.map((entry) => entry.report), [
    { openId: "open-4", changed: ["a"] },
    { openId: "open-4", changed: ["a"] },
  ]);
});

test("closing the dialog flushes what waits with keepalive and then ignores everything", () => {
  const { env, sent, time } = reporterEnv();
  const reporter = createSeenReporter("open-5", env);
  reporter.seen("a");
  reporter.dispose();
  assert.deepEqual(sent, [{ report: { openId: "open-5", seen: ["a"] }, keepalive: true }]);
  assert.equal(time.pending(), 0);
  reporter.seen("b");
  reporter.changed("c");
  reporter.dispose();
  time.advance(SEEN_BATCH_MS * 2);
  assert.equal(sent.length, 1, "a disposed reporter sends nothing more");
});

test("a report never exceeds the server's bound: a longer list is split", () => {
  const { env, sent } = reporterEnv();
  const reporter = createSeenReporter("open-6", env);
  const keys = Array.from({ length: MAX_REPORT_KEYS * 2 + 5 }, (_, index) => `k${index}`);
  for (const key of keys) reporter.seen(key);
  reporter.flush();
  assert.equal(sent.length, 3);
  assert.ok(sent.every((entry) => entry.report.seen.length <= MAX_REPORT_KEYS));
  assert.deepEqual(sent.flatMap((entry) => entry.report.seen), keys);
});

/** An IntersectionObserver stand-in the test drives by hand. */
function observerEnv({ supported = true, visible = true } = {}) {
  const time = clock();
  const state = { visible, observed: [], disconnects: 0, callback: null, visibilityListeners: new Set() };
  const env = {
    createObserver: (callback, options) => {
      if (!supported) return null;
      state.callback = callback;
      state.options = options;
      return { observe: (target) => state.observed.push(target), disconnect: () => { state.disconnects += 1; } };
    },
    pageVisible: () => state.visible,
    onVisibilityChange: (listener) => {
      state.visibilityListeners.add(listener);
      return () => state.visibilityListeners.delete(listener);
    },
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  };
  return {
    env,
    time,
    state,
    see: (ratio) => state.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    setVisible: (visible) => { state.visible = visible; state.visibilityListeners.forEach((listener) => listener()); },
  };
}

test("a chip counts as seen once it has been mostly on screen for a moment", () => {
  const harness = observerEnv();
  let seen = 0;
  const stop = observeSeen("chip", () => { seen += 1; }, harness.env);
  assert.deepEqual(harness.state.observed, ["chip"]);
  assert.ok(harness.state.options.threshold.includes(SEEN_MIN_RATIO));
  harness.see(0.9);
  harness.time.advance(SEEN_DWELL_MS - 1);
  assert.equal(seen, 0, "not before the dwell ends");
  harness.time.advance(1);
  assert.equal(seen, 1);
  assert.equal(harness.state.disconnects, 1, "it stops watching once counted");
  assert.equal(harness.state.visibilityListeners.size, 0);
  harness.time.advance(10_000);
  assert.equal(seen, 1, "and never fires twice");
  stop();
});

test("scrolling past a chip does not count; coming back and staying does", () => {
  const harness = observerEnv();
  let seen = 0;
  observeSeen("chip", () => { seen += 1; }, harness.env);
  harness.see(1);
  harness.time.advance(SEEN_DWELL_MS - 100);
  harness.see(0);
  harness.time.advance(SEEN_DWELL_MS * 3);
  assert.equal(seen, 0, "it left before the dwell ended");
  harness.see(0.3);
  harness.time.advance(SEEN_DWELL_MS * 3);
  assert.equal(seen, 0, "less than half of it on screen is not seen");
  harness.see(0.5);
  harness.time.advance(SEEN_DWELL_MS);
  assert.equal(seen, 1, "half of it for the dwell is");
});

test("a hidden page never counts, and counting resumes when it is shown again", () => {
  const harness = observerEnv({ visible: false });
  let seen = 0;
  observeSeen("chip", () => { seen += 1; }, harness.env);
  harness.see(1);
  assert.equal(harness.time.pending(), 0, "no dwell starts in a hidden page");
  harness.time.advance(SEEN_DWELL_MS * 3);
  assert.equal(seen, 0);
  harness.setVisible(true);
  harness.time.advance(SEEN_DWELL_MS - 1);
  assert.equal(seen, 0);
  harness.setVisible(false);
  harness.time.advance(SEEN_DWELL_MS * 3);
  assert.equal(seen, 0, "hiding the page mid-dwell restarts the wait");
  harness.setVisible(true);
  harness.time.advance(SEEN_DWELL_MS);
  assert.equal(seen, 1);
});

test("an element that never intersects (a hub under display:none) never counts", () => {
  const harness = observerEnv();
  let seen = 0;
  observeSeen("chip", () => { seen += 1; }, harness.env);
  harness.see(0);
  harness.time.advance(SEEN_DWELL_MS * 100);
  assert.equal(seen, 0);
});

test("stopping early means the chip is never reported", () => {
  const harness = observerEnv();
  let seen = 0;
  const stop = observeSeen("chip", () => { seen += 1; }, harness.env);
  harness.see(1);
  harness.time.advance(SEEN_DWELL_MS - 1);
  stop();
  harness.time.advance(SEEN_DWELL_MS * 5);
  assert.equal(seen, 0);
  assert.equal(harness.state.disconnects, 1);
  assert.equal(harness.time.pending(), 0);
});

test("a browser that cannot observe visibility counts nothing", () => {
  const harness = observerEnv({ supported: false });
  let seen = 0;
  const stop = observeSeen("chip", () => { seen += 1; }, harness.env);
  harness.time.advance(SEEN_DWELL_MS * 5);
  assert.equal(seen, 0);
  assert.doesNotThrow(stop);
});
