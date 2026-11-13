import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LIVE_STREAM_RETRY_MS, LIVE_STREAM_WATCHDOG_MS, openLiveStream } = await jiti.import("./live-stream.ts");

const CLOSED = 2;
const CONNECTING = 0;
const OPEN = 1;

/** A stream on a clock the test moves by hand, over sources it can poke. */
function harness(options = {}) {
  let t = 5_000_000;
  let nextId = 1;
  const timers = new Map();
  const sources = [];
  const messages = [];
  const environment = {
    open: (url) => {
      const source = { url, readyState: CONNECTING, closed: false, onmessage: null, onerror: null, close() { this.closed = true; this.readyState = CLOSED; } };
      sources.push(source);
      return source;
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const stream = openLiveStream({ url: "/events", onMessage: (event) => messages.push(event.data), environment, ...options });
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
  const current = () => sources[sources.length - 1];
  const deliver = (source, data = "x") => source.onmessage({ data });
  const refuse = (source) => {
    source.readyState = CLOSED;
    source.onerror({});
  };
  return { stream, sources, messages, advance, current, deliver, refuse, timers };
}

test("opens the stream at once and hands every frame to the listener", () => {
  const h = harness();
  assert.equal(h.sources.length, 1);
  assert.equal(h.current().url, "/events");
  h.deliver(h.current(), "a");
  h.deliver(h.current(), "b");
  assert.deepEqual(h.messages, ["a", "b"]);
});

test("a dropped connection the browser is retrying itself is left alone", () => {
  const h = harness();
  h.current().readyState = CONNECTING;
  h.current().onerror({});
  h.advance(60_000);
  assert.equal(h.sources.length, 1);
  assert.equal(h.current().closed, false);
});

test("a refusal closes the stream for good, so it is opened again after a pause that grows", () => {
  const h = harness();
  h.refuse(h.current());
  assert.equal(h.sources.length, 1, "not at once: the server just said no");
  h.advance(LIVE_STREAM_RETRY_MS[0] - 1);
  assert.equal(h.sources.length, 1);
  h.advance(1);
  assert.equal(h.sources.length, 2);

  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[1] - 1);
  assert.equal(h.sources.length, 2);
  h.advance(1);
  assert.equal(h.sources.length, 3);

  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[2]);
  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[3]);
  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[3] - 1);
  assert.equal(h.sources.length, 5);
  h.advance(1);
  assert.equal(h.sources.length, 6, "the pause stops growing at the last step");
});

test("a frame that arrives ends the run of refusals: the next pause starts short again", () => {
  const h = harness();
  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[0]);
  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[1]);
  assert.equal(h.sources.length, 3);

  h.deliver(h.current());
  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[0]);
  assert.equal(h.sources.length, 4);
});

test("reopen closes the old connection, opens a new one now and forgets the backoff", () => {
  const h = harness();
  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[0]);
  h.refuse(h.current());
  assert.equal(h.timers.size, 1, "a retry is waiting");

  const before = h.sources.length;
  h.stream.reopen();
  assert.equal(h.sources.length, before + 1);
  assert.equal(h.timers.size, 0, "the waiting retry is cancelled, not doubled up");

  h.refuse(h.current());
  h.advance(LIVE_STREAM_RETRY_MS[0]);
  assert.equal(h.sources.length, before + 2, "the pause is back to the first step");
});

test("reopen replaces a connection that still reads as open", () => {
  const h = harness();
  const first = h.current();
  first.readyState = OPEN;
  h.stream.reopen();
  assert.equal(first.closed, true);
  assert.equal(h.sources.length, 2);
  // Whatever the replaced connection still emits is not the stream's business.
  h.deliver(first, "late");
  h.deliver(h.current(), "fresh");
  assert.deepEqual(h.messages, ["fresh"]);
});

test("a stream with a silence limit is replaced once it has said nothing for longer than the limit", () => {
  const h = harness({ silenceLimitMs: 75_000 });
  const first = h.current();
  first.readyState = OPEN;
  h.deliver(first);
  // A frame every 30 s keeps it alive however long that goes on.
  for (let i = 0; i < 10; i++) {
    h.advance(30_000);
    h.deliver(first);
  }
  assert.equal(h.sources.length, 1);

  h.advance(75_000);
  assert.equal(h.sources.length, 1, "the check that lands exactly on the limit lets it live");
  h.advance(LIVE_STREAM_WATCHDOG_MS);
  assert.equal(h.sources.length, 2, "the next check, past the limit, replaces it");
  assert.equal(first.closed, true);
  h.advance(60_000);
  assert.ok(h.sources.length >= 2);
});

test("silence is measured from the moment the stream was opened, so a quiet start is not instant death", () => {
  const h = harness({ silenceLimitMs: 75_000 });
  h.advance(60_000);
  assert.equal(h.sources.length, 1);
});

test("a stream without a silence limit is never replaced for being quiet", () => {
  const h = harness();
  h.current().readyState = OPEN;
  h.advance(60 * 60_000);
  assert.equal(h.sources.length, 1);
  assert.equal(h.timers.size, 0, "no watchdog timer at all");
});

test("the silence check leaves a connection waiting out a refusal on its own schedule", () => {
  const h = harness({ silenceLimitMs: 20_000, watchdogMs: 5_000 });
  h.refuse(h.current());
  // The retry is due after 2 s, the watchdog after 5 s: the retry wins, and
  // the watchdog never races it into a second connection.
  h.advance(5_000);
  assert.equal(h.sources.length, 2);
});

test("close ends it for good: no connection, no retry, no watchdog, and reopen does nothing", () => {
  const h = harness({ silenceLimitMs: 75_000 });
  const first = h.current();
  h.refuse(first);
  h.stream.close();
  assert.equal(h.timers.size, 0);
  h.advance(10 * 60_000);
  assert.equal(h.sources.length, 1);

  h.stream.reopen();
  assert.equal(h.sources.length, 1);

  const live = harness({ silenceLimitMs: 75_000 });
  const source = live.current();
  live.stream.close();
  assert.equal(source.closed, true);
  assert.equal(live.timers.size, 0);
});
