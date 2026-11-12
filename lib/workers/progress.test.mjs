import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { Progress, PROGRESS_MIN_INTERVAL_MS, PROGRESS_REFRESH_MS, PROGRESS_OUTPUT_LINES } = await jiti.import("./progress.ts");

/**
 * Progress is what the agent sees while a job runs: the headline first, then
 * the newest output lines. It must send at most once per interval however
 * often it is poked, re-send a quiet job only when the text really changed (an
 * elapsed counter does, identical text does not), survive a listener that
 * throws, say nothing after stop() and leave no timer behind, and do nothing
 * at all when nobody listens. Small real intervals (20 to 60 ms) keep it fast.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A progress whose output is a growing list of lines the test controls. */
function harness(options = {}) {
  const lines = [];
  const sent = [];
  const progress = new Progress({
    emit: (text) => sent.push({ text, at: Date.now() }),
    tail: (count) => lines.slice(-count),
    refreshMs: 60_000,
    ...options,
  });
  return { progress, lines, sent, texts: () => sent.map((entry) => entry.text) };
}

/** Records the timers created and cleared through the globals while `body` runs. */
async function watchTimers(body) {
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
  const seen = { timeouts: [], intervals: [], clearedTimeouts: [], clearedIntervals: [] };
  globalThis.setTimeout = (...args) => {
    const handle = real.setTimeout(...args);
    seen.timeouts.push(handle);
    return handle;
  };
  globalThis.setInterval = (...args) => {
    const handle = real.setInterval(...args);
    seen.intervals.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    seen.clearedTimeouts.push(handle);
    return real.clearTimeout(handle);
  };
  globalThis.clearInterval = (handle) => {
    seen.clearedIntervals.push(handle);
    return real.clearInterval(handle);
  };
  try {
    await body(seen, real);
  } finally {
    Object.assign(globalThis, real);
  }
}

test("the defaults are twice a second, a refresh every five seconds and twenty output lines", () => {
  assert.equal(PROGRESS_MIN_INTERVAL_MS, 500);
  assert.equal(PROGRESS_REFRESH_MS, 5_000);
  assert.equal(PROGRESS_OUTPUT_LINES, 20);
});

test("the headline is the first line and the output lines follow it", async () => {
  const { progress, lines, texts } = harness({ minIntervalMs: 10 });
  lines.push("compiling a", "compiling b");
  progress.setStatus("Running on box (3 s)");
  await sleep(40);
  progress.stop();
  assert.deepEqual(texts(), ["Running on box (3 s)\ncompiling a\ncompiling b"]);
  assert.equal(progress.lastSent, "Running on box (3 s)\ncompiling a\ncompiling b");
});

test("a headline is trimmed and sent alone when the job has printed nothing", async () => {
  const { progress, texts } = harness({ minIntervalMs: 10 });
  progress.setStatus("  Waiting in the queue \n");
  await sleep(40);
  progress.stop();
  assert.deepEqual(texts(), ["Waiting in the queue"]);
});

test("at most the configured number of output lines is asked for and shown, the newest ones", async () => {
  const asked = [];
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
  const sent = [];
  const progress = new Progress({
    emit: (text) => sent.push(text),
    tail: (count) => {
      asked.push(count);
      return lines.slice(-count);
    },
    minIntervalMs: 10,
    refreshMs: 60_000,
    outputLines: 3,
  });
  progress.setStatus("S");
  await sleep(40);
  progress.stop();
  assert.deepEqual(asked, [3]);
  assert.deepEqual(sent, ["S\nline 7\nline 8\nline 9"]);
});

test("without outputLines the default of twenty is asked for", async () => {
  const asked = [];
  const progress = new Progress({ emit: () => {}, tail: (count) => (asked.push(count), []), minIntervalMs: 10, refreshMs: 60_000 });
  progress.setStatus("S");
  await sleep(40);
  progress.stop();
  assert.deepEqual(asked, [20]);
});

test("the first poke is sent at once, not after a full interval", async () => {
  const { progress, texts } = harness({ minIntervalMs: 500 });
  progress.setStatus("first");
  await sleep(40);
  progress.stop();
  assert.deepEqual(texts(), ["first"]);
});

test("however often it is poked, it sends at most once per interval and the last state is not lost", async () => {
  const interval = 60;
  const { progress, lines, sent, texts } = harness({ minIntervalMs: interval });
  progress.setStatus("S");
  const startedAt = Date.now();
  for (let index = 0; index < 40; index += 1) {
    lines.push(`out ${index}`);
    progress.poke();
    await sleep(5);
  }
  const burstMs = Date.now() - startedAt;
  await sleep(interval * 2);
  progress.stop();

  assert.ok(sent.length >= 2, "more than one update went out over the burst");
  assert.ok(sent.length <= Math.ceil(burstMs / interval) + 2, `${sent.length} updates in ${burstMs} ms is too many for a ${interval} ms interval`);
  for (let index = 1; index < sent.length; index += 1) {
    assert.ok(sent[index].at - sent[index - 1].at >= interval - 5, `updates ${index - 1} and ${index} were only ${sent[index].at - sent[index - 1].at} ms apart`);
  }
  assert.match(texts().at(-1), /out 39$/, "the newest output made it out after the burst");
});

test("a poke while one is already waiting does not queue a second send", async () => {
  const { progress, lines, texts } = harness({ minIntervalMs: 40 });
  progress.setStatus("S");
  await sleep(10);
  assert.equal(texts().length, 1);
  lines.push("a");
  progress.poke();
  progress.poke();
  progress.poke();
  await sleep(100);
  progress.stop();
  assert.deepEqual(texts(), ["S", "S\na"]);
});

test("a quiet job is re-sent after the refresh time when its headline changes over time", async () => {
  let elapsed = 0;
  const { progress, texts } = harness({ minIntervalMs: 10, refreshMs: 30 });
  progress.setStatus(() => `Running (${(elapsed += 1)} s)`);
  await sleep(200);
  progress.stop();
  assert.ok(texts().length >= 3, `only ${texts().length} updates, the refresh did not fire again and again`);
  assert.equal(new Set(texts()).size, texts().length, "every re-sent text is different from the one before");
  assert.match(texts()[0], /^Running \(1 s\)$/);
});

test("a quiet job whose text did not change is not sent again on refresh", async () => {
  const { progress, texts } = harness({ minIntervalMs: 10, refreshMs: 30 });
  progress.setStatus("Running");
  await sleep(200);
  progress.stop();
  assert.deepEqual(texts(), ["Running"]);
});

test("new output on a quiet job is picked up by the refresh even without a poke", async () => {
  const { progress, lines, texts } = harness({ minIntervalMs: 10, refreshMs: 30 });
  progress.setStatus("Running");
  await sleep(20);
  lines.push("late line");
  await sleep(100);
  progress.stop();
  assert.deepEqual(texts(), ["Running", "Running\nlate line"]);
});

test("setStatus takes a string or a function and the newest one wins", async () => {
  const { progress, texts } = harness({ minIntervalMs: 10 });
  progress.setStatus("one");
  await sleep(40);
  progress.setStatus(() => "two");
  await sleep(40);
  progress.setStatus("three");
  await sleep(40);
  progress.stop();
  assert.deepEqual(texts(), ["one", "two", "three"]);
});

test("a status function is read when the text is sent, not when it was set", async () => {
  let word = "before";
  const { progress, texts } = harness({ minIntervalMs: 30 });
  progress.setStatus("warm-up");
  await sleep(5);
  progress.setStatus(() => word);
  word = "after";
  await sleep(80);
  progress.stop();
  assert.deepEqual(texts(), ["warm-up", "after"]);
});

test("an empty or blank headline sends nothing, whatever the output is", async () => {
  const { progress, lines, texts } = harness({ minIntervalMs: 10, refreshMs: 20 });
  lines.push("output without a headline");
  progress.poke();
  progress.setStatus("");
  progress.setStatus("   \n ");
  await sleep(100);
  progress.stop();
  assert.deepEqual(texts(), []);
  assert.equal(progress.lastSent, "");
});

test("a listener that throws does not break the job and updates keep being tried", async () => {
  const calls = [];
  const lines = [];
  const progress = new Progress({
    emit: (text) => {
      calls.push(text);
      throw new Error("listener is broken");
    },
    tail: () => lines.slice(),
    minIntervalMs: 10,
    refreshMs: 60_000,
  });
  assert.doesNotThrow(() => progress.setStatus("S"));
  await sleep(40);
  lines.push("next");
  assert.doesNotThrow(() => progress.poke());
  await sleep(40);
  assert.doesNotThrow(() => progress.stop());
  assert.deepEqual(calls, ["S", "S\nnext"]);
  assert.equal(progress.lastSent, "S\nnext");
});

test("lastSent is empty before the first update and always the newest text after", async () => {
  const { progress, lines } = harness({ minIntervalMs: 10 });
  assert.equal(progress.lastSent, "");
  progress.setStatus("S");
  assert.equal(progress.lastSent, "", "nothing is sent synchronously");
  await sleep(40);
  assert.equal(progress.lastSent, "S");
  lines.push("x");
  progress.poke();
  await sleep(40);
  assert.equal(progress.lastSent, "S\nx");
  progress.stop();
  assert.equal(progress.lastSent, "S\nx", "stop keeps what was last sent");
});

test("after stop() nothing more is sent, even when a poke was waiting", async () => {
  const { progress, lines, texts } = harness({ minIntervalMs: 60 });
  progress.setStatus("S");
  await sleep(15);
  assert.deepEqual(texts(), ["S"]);
  lines.push("never shown");
  progress.poke();
  progress.stop();
  await sleep(150);
  assert.deepEqual(texts(), ["S"]);
});

test("after stop() a status change or a poke is ignored and no timer is started", async () => {
  await watchTimers(async (seen) => {
    const { progress, texts } = harness({ minIntervalMs: 10, refreshMs: 20 });
    progress.stop();
    const before = seen.timeouts.length;
    progress.setStatus("late");
    progress.poke();
    assert.equal(seen.timeouts.length, before, "no wait timer was created after stop");
    await sleep(80);
    assert.deepEqual(texts(), []);
  });
});

test("stop() clears the refresh interval and a pending wait, and is safe to call twice", async () => {
  await watchTimers(async (seen) => {
    const { progress } = harness({ minIntervalMs: 10_000, refreshMs: 10_000 });
    progress.setStatus("S");
    await sleep(15);
    progress.poke();
    assert.equal(seen.intervals.length, 1, "one refresh interval");
    const waiting = seen.timeouts.at(-1);
    progress.stop();
    progress.stop();
    assert.ok(seen.clearedIntervals.includes(seen.intervals[0]), "the refresh interval was cleared");
    assert.ok(seen.clearedTimeouts.includes(waiting), "the pending wait was cleared");
  });
});

test("a job stopped before the refresh time is never refreshed", async () => {
  let elapsed = 0;
  const { progress, texts } = harness({ minIntervalMs: 10, refreshMs: 30 });
  progress.setStatus(() => `t=${(elapsed += 1)}`);
  await sleep(15);
  progress.stop();
  const countAtStop = texts().length;
  await sleep(120);
  assert.equal(texts().length, countAtStop);
});

test("without an emit option nothing happens: no output is read and no timer is created", async () => {
  await watchTimers(async (seen) => {
    let tailCalls = 0;
    const progress = new Progress({ tail: () => (tailCalls += 1, []), minIntervalMs: 5, refreshMs: 5 });
    progress.setStatus("S");
    progress.poke();
    progress.setStatus(() => "T");
    await sleep(50);
    progress.stop();
    assert.equal(tailCalls, 0);
    assert.equal(progress.lastSent, "");
    assert.equal(seen.intervals.length, 0, "no refresh interval");
    assert.equal(seen.timeouts.filter((handle) => handle !== undefined).length, 1, "only the test's own sleep timer exists");
  });
});
