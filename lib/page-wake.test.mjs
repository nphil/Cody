import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  WAKE_CLOCK_JUMP_MS,
  WAKE_DEBOUNCE_MS,
  WAKE_MIN_AWAY_MS,
  WAKE_TICK_MS,
  attachWakeSources,
  createWakeDetector,
  subscribePageWake,
} = await jiti.import("./page-wake.ts");

/** A detector on a clock the test moves by hand; timers fire in order as it advances. */
function harness(options = {}) {
  let t = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const detector = createWakeDetector({
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  const events = [];
  detector.subscribe((event) => events.push(event));
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    t = end;
  };
  return { detector, events, advance, timers, now: () => t };
}

test("coming back from a long hide is one wake, a moment after the tab turns visible", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(10 * 60_000);
  assert.equal(h.events.length, 0, "nothing fires while hidden");

  h.detector.signal({ type: "visible" });
  assert.equal(h.events.length, 0, "the wake is coalesced, not immediate");
  h.advance(WAKE_DEBOUNCE_MS - 1);
  assert.equal(h.events.length, 0);
  h.advance(1);

  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "visible");
  assert.equal(h.events[0].awayMs, 10 * 60_000 + WAKE_DEBOUNCE_MS);
  assert.equal(h.events[0].at, h.now());
});

test("visible, focus, pageshow and online landing together are one event naming the strongest reason", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(60_000);
  h.detector.signal({ type: "pageshow", persisted: true });
  h.detector.signal({ type: "visible" });
  h.detector.signal({ type: "focus" });
  h.advance(100);
  h.detector.signal({ type: "online" });
  h.advance(WAKE_DEBOUNCE_MS);

  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "pageshow");
  assert.ok(h.events[0].awayMs >= 60_000);
  assert.equal(h.timers.size, 0, "no timer is left behind");
});

test("a tab flicker shorter than the minimum absence is not a wake", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(WAKE_MIN_AWAY_MS - 1);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS * 5);
  assert.equal(h.events.length, 0);

  // The flicker was forgotten: a later focus has no absence behind it.
  h.detector.signal({ type: "focus" });
  h.advance(WAKE_DEBOUNCE_MS * 5);
  assert.equal(h.events.length, 0);
});

test("the minimum absence itself counts", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(WAKE_MIN_AWAY_MS);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
});

test("focus with no absence on record (focus moving into an iframe of the page) is ignored", () => {
  const h = harness();
  h.advance(10 * 60_000);
  h.detector.signal({ type: "focus" });
  h.advance(WAKE_DEBOUNCE_MS * 5);
  assert.equal(h.events.length, 0);
});

test("focus alone completes a wake when the visibility event never came", () => {
  const h = harness();
  // A webview that reports the offline spell but never visibilitychange.
  h.detector.signal({ type: "offline" });
  h.advance(30_000);
  h.detector.signal({ type: "focus" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "focus");
});

test("pageshow is a wake only when the page came out of the back/forward cache", () => {
  const h = harness();
  h.detector.signal({ type: "pageshow", persisted: false });
  h.advance(WAKE_DEBOUNCE_MS * 5);
  assert.equal(h.events.length, 0, "the first load is not a wake");

  h.detector.signal({ type: "hidden" });
  h.advance(1_000);
  h.detector.signal({ type: "pageshow", persisted: true });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "pageshow");
});

test("the network returning is a wake however short the outage", () => {
  const h = harness();
  h.detector.signal({ type: "offline" });
  h.advance(1_500);
  h.detector.signal({ type: "online" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "online");
  assert.equal(h.events[0].awayMs, 1_500 + WAKE_DEBOUNCE_MS);
});

test("a Page Lifecycle resume is a wake", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(30_000);
  h.detector.signal({ type: "resume" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "resume");
});

test("a clock that jumped while the page stayed visible is a wake; ordinary ticks are not", () => {
  const h = harness();
  for (let i = 0; i < 50; i++) {
    h.advance(WAKE_TICK_MS);
    h.detector.signal({ type: "tick" });
  }
  h.advance(WAKE_DEBOUNCE_MS * 2);
  assert.equal(h.events.length, 0, "on-time ticks say nothing");

  // The lid closes: no timers run, the wall clock moves on.
  h.advance(20 * 60_000);
  h.detector.signal({ type: "tick" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "clock");
  assert.ok(h.events[0].awayMs >= 20 * 60_000);
});

test("drift below the jump threshold is not a sleep", () => {
  const h = harness();
  h.advance(WAKE_TICK_MS + WAKE_CLOCK_JUMP_MS - 1);
  h.detector.signal({ type: "tick" });
  h.advance(WAKE_DEBOUNCE_MS * 2);
  assert.equal(h.events.length, 0);

  h.advance(WAKE_TICK_MS + WAKE_CLOCK_JUMP_MS);
  h.detector.signal({ type: "tick" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
});

test("throttled timers of a hidden page are not mistaken for sleep, and neither is the first tick after it returns", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  // A background tab's timers run about once a minute.
  for (let i = 0; i < 10; i++) {
    h.advance(60_000);
    h.detector.signal({ type: "tick" });
  }
  assert.equal(h.events.length, 0);

  h.advance(50_000);
  h.detector.signal({ type: "visible" });
  h.advance(1_000);
  h.detector.signal({ type: "tick" });
  h.advance(WAKE_DEBOUNCE_MS * 3);

  assert.equal(h.events.length, 1, "one wake for the return, no second one for the drift");
  assert.equal(h.events[0].reason, "visible");
});

test("hiding again before the window closes drops the pending wake and keeps the absence on the books", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS / 2);
  h.detector.signal({ type: "hidden" });
  h.advance(WAKE_DEBOUNCE_MS * 4);
  assert.equal(h.events.length, 0, "nothing is emitted to a hidden page");
  assert.equal(h.timers.size, 0);

  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.ok(h.events[0].awayMs >= 2 * 60_000, "the absence runs from the first time it went away");
});

test("a network return while the page is hidden waits for the page to be seen", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(30_000);
  h.detector.signal({ type: "online" });
  h.advance(WAKE_DEBOUNCE_MS * 3);
  assert.equal(h.events.length, 0);

  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
});

test("two bursts further apart than the window are two wakes", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  h.advance(30_000);
  h.detector.signal({ type: "hidden" });
  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 2);
  assert.ok(h.events[1].awayMs >= 60_000 && h.events[1].awayMs < 120_000, "the second absence is measured from its own start");
});

test("a page that starts hidden owes a wake when it is first shown", () => {
  const h = harness({ hidden: true });
  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
});

test("unsubscribe stops delivery, and a listener that throws does not starve the others", () => {
  const h = harness();
  const seen = [];
  const off = h.detector.subscribe((event) => seen.push(event.reason));
  const originalError = console.error;
  console.error = () => {};
  try {
    h.detector.subscribe(() => { throw new Error("one surface broke"); });
    h.detector.subscribe((event) => seen.push(`after:${event.reason}`));
    h.detector.signal({ type: "hidden" });
    h.advance(60_000);
    h.detector.signal({ type: "visible" });
    h.advance(WAKE_DEBOUNCE_MS);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(seen, ["visible", "after:visible"]);

  off();
  h.detector.signal({ type: "hidden" });
  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.deepEqual(seen, ["visible", "after:visible", "after:visible"]);
  assert.equal(h.detector.listenerCount(), 3);
});

test("dispose cancels a pending wake", () => {
  const h = harness();
  h.detector.signal({ type: "hidden" });
  h.advance(60_000);
  h.detector.signal({ type: "visible" });
  h.detector.dispose();
  h.advance(WAKE_DEBOUNCE_MS * 2);
  assert.equal(h.events.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.detector.listenerCount(), 0);
});

/** Event targets that record listeners, for the DOM wiring. */
function fakeBrowser(visibilityState = "visible") {
  const windowHandlers = new Map();
  const documentHandlers = new Map();
  const intervals = new Map();
  let nextInterval = 1;
  const add = (map) => (type, handler) => map.set(type, [...(map.get(type) ?? []), handler]);
  const remove = (map) => (type, handler) => map.set(type, (map.get(type) ?? []).filter((candidate) => candidate !== handler));
  const doc = {
    visibilityState,
    addEventListener: add(documentHandlers),
    removeEventListener: remove(documentHandlers),
  };
  const win = {
    addEventListener: add(windowHandlers),
    removeEventListener: remove(windowHandlers),
    setInterval: (fn, ms) => {
      const id = nextInterval++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  };
  return {
    browser: { window: win, document: doc },
    doc,
    intervals,
    fire: (target, type, event = {}) => (target === "window" ? windowHandlers : documentHandlers).get(type)?.forEach((handler) => handler(event)),
    listenerCount: () => [...windowHandlers.values(), ...documentHandlers.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

test("browser events map onto detector signals, and teardown removes every listener and the tick timer", () => {
  const h = harness();
  const fake = fakeBrowser();
  const detach = attachWakeSources(h.detector, fake.browser);
  assert.equal(fake.intervals.size, 1);
  assert.equal([...fake.intervals.values()][0].ms, WAKE_TICK_MS);

  fake.doc.visibilityState = "hidden";
  fake.fire("document", "visibilitychange");
  h.advance(60_000);
  fake.doc.visibilityState = "visible";
  fake.fire("document", "visibilitychange");
  fake.fire("window", "focus");
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].reason, "visible");

  fake.fire("window", "pagehide");
  h.advance(60_000);
  fake.fire("window", "pageshow", { persisted: true });
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1].reason, "pageshow");

  fake.fire("window", "offline");
  h.advance(2_000);
  fake.fire("window", "online");
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 3);
  assert.equal(h.events[2].reason, "online");

  fake.fire("document", "freeze");
  h.advance(60_000);
  fake.fire("document", "resume");
  h.advance(WAKE_DEBOUNCE_MS);
  assert.equal(h.events.length, 4);
  assert.equal(h.events[3].reason, "resume");

  [...fake.intervals.values()][0].fn();
  detach();
  assert.equal(fake.listenerCount(), 0);
  assert.equal(fake.intervals.size, 0);
});

test("the shared subscription installs the browser listeners with the first subscriber and removes them with the last", async () => {
  const fake = fakeBrowser();
  const timeouts = new Map();
  let nextTimeout = 1;
  const clock = { now: 5_000_000 };
  const realDateNow = Date.now;
  Date.now = () => clock.now;
  globalThis.window = {
    ...fake.browser.window,
    setTimeout: (fn, ms) => {
      const id = nextTimeout++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
  };
  globalThis.document = fake.doc;
  try {
    assert.equal(fake.listenerCount(), 0);
    const calls = [];
    const offA = subscribePageWake((event) => calls.push(["a", event.reason]));
    const installed = fake.listenerCount();
    assert.ok(installed > 0);
    const offB = subscribePageWake((event) => calls.push(["b", event.reason]));
    assert.equal(fake.listenerCount(), installed, "a second subscriber shares the listeners");
    assert.equal(fake.intervals.size, 1);

    fake.doc.visibilityState = "hidden";
    fake.fire("document", "visibilitychange");
    clock.now += 60_000;
    fake.doc.visibilityState = "visible";
    fake.fire("document", "visibilitychange");
    assert.equal(timeouts.size, 1, "one coalescing timer for both subscribers");
    [...timeouts.values()][0].fn();
    assert.deepEqual(calls, [["a", "visible"], ["b", "visible"]]);

    offA();
    assert.equal(fake.listenerCount(), installed, "still held for the remaining subscriber");
    offB();
    assert.equal(fake.listenerCount(), 0);
    assert.equal(fake.intervals.size, 0);
  } finally {
    Date.now = realDateNow;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("subscribing on the server is a harmless no-op", () => {
  assert.equal(typeof globalThis.window, "undefined");
  const off = subscribePageWake(() => assert.fail("never"));
  off();
});
