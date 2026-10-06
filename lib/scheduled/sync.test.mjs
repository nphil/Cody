import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createScheduledSync } = await jiti.import("./sync.ts");
const { SCHEDULED_LIMITS } = await jiti.import("./types.ts");

const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const MIN = 60_000;
const GRACE = 1_500;
const DAY = 24 * 60 * MIN;

const item = (id, offsetMs, overrides = {}) => ({
  id,
  sessionId: "chat-a",
  message: `message ${id}`,
  mode: "at",
  at: new Date(NOW + offsetMs).toISOString(),
  source: "user",
  status: "pending",
  createdAt: new Date(NOW - DAY).toISOString(),
  ...overrides,
});

/** Lets every already-settled promise run its continuation. `setImmediate` is not part of the mocked timers. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Every controller a test made. A controller arms a real timer for the next
 * due row, and a timer left running keeps the test process (and so the whole
 * file) alive for minutes; disposing them after each test ends that.
 */
const made = [];
afterEach(() => {
  for (const sync of made.splice(0)) sync.dispose();
});

/**
 * A controller wired to a `list` the test answers by hand, so every read is
 * visible as a call that stays open until it is resolved or rejected.
 */
function harness({ visible = true } = {}) {
  const reads = [];
  const states = [];
  const env = { visible, now: NOW };
  const sync = createScheduledSync({
    onChange: (state) => states.push(state),
    list: (sessionId, { signal }) => new Promise((resolve, reject) => reads.push({ sessionId, signal, resolve, reject })),
    isVisible: () => env.visible,
    now: () => env.now,
  });
  made.push(sync);
  const answer = async (read, items) => {
    read.resolve({ items, limits: SCHEDULED_LIMITS });
    await flush();
  };
  const fail = async (read) => {
    read.reject(new Error("offline"));
    await flush();
  };
  /** Opens the chat and answers its first read. */
  const open = async (sessionId, items) => {
    sync.setSession(sessionId);
    await answer(reads.at(-1), items);
  };
  return { sync, reads, states, env, answer, fail, open };
}

function withTimers(body) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const finish = () => mock.timers.reset();
  return Promise.resolve(body(mock.timers)).finally(finish);
}

test("a chat with no id reads nothing and publishes nothing", async () => {
  const { sync, reads, states } = harness();
  sync.setSession(null);
  sync.refresh();
  sync.visibilityChanged();
  await flush();
  assert.equal(reads.length, 0);
  assert.equal(states.length, 0);
  assert.equal(sync.getState().sessionId, null);
  assert.deepEqual(sync.getState().items, []);
  assert.equal(sync.getState().loaded, false);
});

test("opening a chat reads it and shows its rows soonest first", async () => {
  const { sync, reads, answer } = harness();
  sync.setSession("chat-a");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].sessionId, "chat-a");
  assert.equal(sync.getState().loaded, false);
  await answer(reads[0], [item("late", 2 * MIN), item("soon", MIN), item("mid", 90_000)]);
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["soon", "mid", "late"]);
  assert.equal(sync.getState().loaded, true);
  assert.equal(sync.getState().failed, false);
  assert.deepEqual(sync.getState().limits, SCHEDULED_LIMITS);
});

test("rows due at the same moment keep the order they were made in", async () => {
  const { sync, open } = harness();
  await open("chat-a", [
    item("second", MIN, { createdAt: new Date(NOW - 1_000).toISOString() }),
    item("first", MIN, { createdAt: new Date(NOW - 5_000).toISOString() }),
  ]);
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["first", "second"]);
});

test("switching chats drops the previous chat's rows at once and reads the new chat", async () => {
  await withTimers(async () => {
    const { sync, reads, states, open, answer } = harness();
    await open("chat-a", [item("a1", MIN)]);
    assert.equal(sync.getState().items.length, 1);

    sync.setSession("chat-b");
    // Before the new chat has answered, nothing of chat A is on screen.
    assert.equal(sync.getState().sessionId, "chat-b");
    assert.deepEqual(sync.getState().items, []);
    assert.equal(sync.getState().loaded, false);
    assert.equal(states.at(-1).sessionId, "chat-b");
    assert.equal(reads.length, 2);
    assert.equal(reads[1].sessionId, "chat-b");

    await answer(reads[1], [item("b1", MIN, { sessionId: "chat-b" })]);
    assert.deepEqual(sync.getState().items.map((row) => row.id), ["b1"]);
  });
});

test("setting the chat it already follows does nothing", async () => {
  const { sync, reads, states, open } = harness();
  await open("chat-a", [item("a1", MIN)]);
  const published = states.length;
  sync.setSession("chat-a");
  await flush();
  assert.equal(reads.length, 1);
  assert.equal(states.length, published);
});

test("an answer that arrives late for the previous chat is ignored, a failure too", async () => {
  const { sync, reads, answer, fail } = harness();
  sync.setSession("chat-a");
  const stale = reads[0];
  sync.setSession("chat-b");
  assert.equal(stale.signal.aborted, true);

  await answer(stale, [item("a1", MIN)]);
  assert.deepEqual(sync.getState().items, []);
  assert.equal(sync.getState().sessionId, "chat-b");
  assert.equal(sync.getState().loaded, false);

  sync.setSession("chat-c");
  await fail(reads[1]);
  assert.equal(sync.getState().failed, false);
  assert.equal(sync.getState().sessionId, "chat-c");

  await answer(reads[2], [item("c1", MIN, { sessionId: "chat-c" })]);
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["c1"]);
});

test("closing the chat (no id) drops the rows and cancels the read in flight", async () => {
  const { sync, reads, answer } = harness();
  sync.setSession("chat-a");
  const open = reads[0];
  sync.setSession(null);
  assert.equal(open.signal.aborted, true);
  await answer(open, [item("a1", MIN)]);
  assert.equal(sync.getState().sessionId, null);
  assert.deepEqual(sync.getState().items, []);
  assert.equal(reads.length, 1);
});

test("reads asked for while one is in flight collapse into exactly one more", async () => {
  const { sync, reads, answer } = harness();
  sync.setSession("chat-a");
  for (let i = 0; i < 6; i += 1) sync.refresh();
  sync.visibilityChanged();
  await flush();
  assert.equal(reads.length, 1);

  await answer(reads[0], [item("a1", 60 * MIN)]);
  assert.equal(reads.length, 2, "one follow-on read, not seven");

  // Asking during that second read folds into one third read, and no more.
  sync.refresh();
  sync.refresh();
  await answer(reads[1], [item("a1", 60 * MIN)]);
  assert.equal(reads.length, 3);
  await answer(reads[2], [item("a1", 60 * MIN)]);
  assert.equal(reads.length, 3);
});

test("dispose aborts the read in flight and nothing changes after it", async () => {
  const { sync, reads, states, answer } = harness();
  sync.setSession("chat-a");
  const open = reads[0];
  const published = states.length;
  sync.dispose();
  assert.equal(open.signal.aborted, true);

  await answer(open, [item("a1", MIN)]);
  assert.equal(states.length, published);
  assert.deepEqual(sync.getState().items, []);
  assert.equal(reads.length, 1);
});

test("dispose leaves no timer behind and the controller refuses further work", async () => {
  await withTimers(async (timers) => {
    const { sync, reads, states, open } = harness();
    await open("chat-a", [item("a1", 30 * MIN)]);
    const published = states.length;

    sync.dispose();
    timers.tick(2 * DAY);
    await flush();
    assert.equal(reads.length, 1, "the armed timer was cleared");

    sync.setSession("chat-b");
    sync.refresh();
    sync.visibilityChanged();
    sync.upsert(item("a2", MIN));
    sync.remove("a1");
    await flush();
    assert.equal(reads.length, 1);
    assert.equal(states.length, published);
    assert.deepEqual(sync.getState().items.map((row) => row.id), ["a1"]);
  });
});

test("one timer is armed for the soonest pending due time plus the grace, and it reads then", async () => {
  await withTimers(async (timers) => {
    const { reads, env, open, answer } = harness();
    await open("chat-a", [item("later", 20 * MIN), item("soonest", 5 * MIN), item("middle", 10 * MIN)]);
    assert.equal(reads.length, 1);

    timers.tick(5 * MIN + GRACE - 1);
    await flush();
    assert.equal(reads.length, 1, "not before the grace has passed");
    timers.tick(1);
    await flush();
    assert.equal(reads.length, 2);

    // The clock moved on and the first row is gone: the next timer is for the next due time, not for the first again.
    env.now = NOW + 5 * MIN + GRACE;
    await answer(reads[1], [item("later", 20 * MIN), item("middle", 10 * MIN)]);
    timers.tick(5 * MIN - 1);
    await flush();
    assert.equal(reads.length, 2);
    timers.tick(1);
    await flush();
    assert.equal(reads.length, 3);
  });
});

test("nothing waiting means no timer at all", async () => {
  await withTimers(async (timers) => {
    const { reads, open } = harness();
    await open("chat-a", []);
    timers.tick(40 * DAY);
    await flush();
    assert.equal(reads.length, 1);

    const second = harness();
    await second.open("chat-a", [item("failed", -MIN, { status: "failed", error: "gave up" }), item("far-failed", MIN, { status: "failed" })]);
    timers.tick(40 * DAY);
    await flush();
    assert.equal(second.reads.length, 1);
  });
});

test("a hidden tab arms nothing; coming back reads at once", async () => {
  await withTimers(async (timers) => {
    const { sync, reads, env, open, answer } = harness({ visible: false });
    await open("chat-a", [item("a1", 5 * MIN)]);
    timers.tick(DAY);
    await flush();
    assert.equal(reads.length, 1);

    env.visible = true;
    sync.visibilityChanged();
    assert.equal(reads.length, 2);
    await answer(reads[1], [item("a1", 5 * MIN)]);
    timers.tick(5 * MIN + GRACE);
    await flush();
    assert.equal(reads.length, 3, "visible again, so the timer is armed");
  });
});

test("hiding the tab stops a timer that was already waiting", async () => {
  await withTimers(async (timers) => {
    const { sync, reads, env, open } = harness();
    await open("chat-a", [item("a1", 5 * MIN)]);
    env.visible = false;
    sync.visibilityChanged();
    timers.tick(DAY);
    await flush();
    assert.equal(reads.length, 1);
  });
});

test("while a message is on its way the list is read again after 5, 10 then 15 seconds", async () => {
  await withTimers(async (timers) => {
    const { reads, open, answer } = harness();
    const sending = [item("a1", -MIN, { status: "sending" })];
    await open("chat-a", sending);

    timers.tick(4_999);
    await flush();
    assert.equal(reads.length, 1);
    timers.tick(1);
    await flush();
    assert.equal(reads.length, 2);
    await answer(reads[1], sending);

    timers.tick(9_999);
    await flush();
    assert.equal(reads.length, 2);
    timers.tick(1);
    await flush();
    assert.equal(reads.length, 3);
    await answer(reads[2], sending);

    timers.tick(14_999);
    await flush();
    assert.equal(reads.length, 3);
    timers.tick(1);
    await flush();
    assert.equal(reads.length, 4);
    await answer(reads[3], sending);

    timers.tick(14_999);
    await flush();
    assert.equal(reads.length, 4, "the back-off stays at 15 s");
    timers.tick(1);
    await flush();
    assert.equal(reads.length, 5);
  });
});

test("follow-up reads give up after twenty, and a refresh or the tab coming back starts them over", async () => {
  await withTimers(async (timers) => {
    const { sync, reads, open, answer } = harness();
    const stuck = [item("a1", -MIN, { status: "sending" })];
    await open("chat-a", stuck);

    for (let i = 0; i < 20; i += 1) {
      timers.tick(15_000);
      await flush();
      assert.equal(reads.length, i + 2, `follow-up ${i + 1}`);
      await answer(reads.at(-1), stuck);
    }
    timers.tick(DAY);
    await flush();
    assert.equal(reads.length, 21, "no twenty-first follow-up");

    sync.refresh();
    assert.equal(reads.length, 22);
    await answer(reads.at(-1), stuck);
    timers.tick(5_000);
    await flush();
    assert.equal(reads.length, 23, "the back-off began again at 5 s");
    await answer(reads.at(-1), stuck);

    // Run them out again, then let the tab coming back be the one that restarts them.
    for (let i = 0; i < 19; i += 1) {
      timers.tick(15_000);
      await flush();
      await answer(reads.at(-1), stuck);
    }
    const spent = reads.length;
    timers.tick(DAY);
    await flush();
    assert.equal(reads.length, spent);
    sync.visibilityChanged();
    assert.equal(reads.length, spent + 1);
  });
});

test("when the message has gone, the follow-ups stop", async () => {
  await withTimers(async (timers) => {
    const { reads, open, answer } = harness();
    await open("chat-a", [item("a1", -MIN, { status: "sending" })]);
    timers.tick(5_000);
    await flush();
    await answer(reads[1], []);
    timers.tick(DAY);
    await flush();
    assert.equal(reads.length, 2);
  });
});

test("a failed read keeps the rows on screen and flags it; the next success clears the flag", async () => {
  const { sync, reads, states, open, answer, fail } = harness();
  await open("chat-a", [item("a1", 60 * MIN)]);

  sync.refresh();
  await fail(reads[1]);
  assert.equal(sync.getState().failed, true);
  assert.equal(sync.getState().loaded, true);
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["a1"]);

  // A second failure changes nothing a reader could see, so it publishes nothing.
  const published = states.length;
  sync.refresh();
  await fail(reads[2]);
  assert.equal(states.length, published);
  assert.equal(sync.getState().failed, true);

  // The same rows again: recovery still has to reach the screen.
  sync.refresh();
  await answer(reads[3], [item("a1", 60 * MIN)]);
  assert.equal(sync.getState().failed, false);
  assert.equal(states.at(-1).failed, false);
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["a1"]);
});

test("a read that fails before the first answer shows no rows and is not 'loaded'", async () => {
  const { sync, reads, fail, answer } = harness();
  sync.setSession("chat-a");
  await fail(reads[0]);
  assert.equal(sync.getState().failed, true);
  assert.equal(sync.getState().loaded, false);
  assert.deepEqual(sync.getState().items, []);
  sync.refresh();
  await answer(reads[1], []);
  assert.equal(sync.getState().failed, false);
  assert.equal(sync.getState().loaded, true);
});

test("an answer that would draw the same rows hands the page the very same state, so it does not re-render", async () => {
  const { sync, reads, states, open, answer } = harness();
  const rows = () => [item("b", 2 * MIN), item("a", MIN)];
  await open("chat-a", rows());
  const before = sync.getState();
  const distinct = () => new Set(states).size;
  const seen = distinct();

  sync.refresh();
  // Fresh objects, the server's own order: still the same rows.
  await answer(reads[1], rows().reverse());
  assert.equal(sync.getState(), before);
  assert.equal(distinct(), seen);

  // A changed status, text or time is a new state.
  sync.refresh();
  await answer(reads[2], [item("b", 2 * MIN), item("a", MIN, { status: "sending" })]);
  assert.equal(distinct(), seen + 1);
  assert.equal(sync.getState().items[0].status, "sending");

  sync.refresh();
  await answer(reads[3], [item("b", 2 * MIN, { message: "edited" }), item("a", MIN, { status: "sending" })]);
  assert.equal(distinct(), seen + 2);
  sync.refresh();
  await answer(reads[4], [item("b", 3 * MIN, { message: "edited" }), item("a", MIN, { status: "sending" })]);
  assert.equal(distinct(), seen + 3);
});

test("upsert shows a row without reading, sorted in, and replaces a row it already has", async () => {
  const { sync, reads, states, open } = harness();
  await open("chat-a", [item("a", 10 * MIN), item("c", 30 * MIN)]);

  sync.upsert(item("b", 20 * MIN));
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["a", "b", "c"]);
  assert.equal(states.at(-1), sync.getState());

  sync.upsert(item("a", 40 * MIN, { message: "moved" }));
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["b", "c", "a"]);
  assert.equal(sync.getState().items.at(-1).message, "moved");
  assert.equal(reads.length, 1, "no read for the person's own changes");
});

test("upsert and remove ignore another chat's item and an id they do not hold", async () => {
  const { sync, states, open } = harness();
  await open("chat-a", [item("a", 10 * MIN)]);
  const before = sync.getState();
  const published = states.length;

  sync.upsert(item("x", MIN, { sessionId: "chat-b" }));
  sync.remove("not-there");
  assert.equal(sync.getState(), before);
  assert.equal(states.length, published, "no event at all");
});

test("remove drops a row without reading", async () => {
  const { sync, reads, open } = harness();
  await open("chat-a", [item("a", 10 * MIN), item("b", 20 * MIN)]);
  sync.remove("a");
  assert.deepEqual(sync.getState().items.map((row) => row.id), ["b"]);
  assert.equal(reads.length, 1);
});

test("upsert and remove keep the timer true: a new soonest row is waited for, an emptied list is not", async () => {
  await withTimers(async (timers) => {
    const { sync, reads, open } = harness();
    await open("chat-a", [item("far", 60 * MIN)]);

    sync.upsert(item("near", 2 * MIN));
    timers.tick(2 * MIN + GRACE);
    await flush();
    assert.equal(reads.length, 2, "read at the new soonest time, not an hour out");

    const quiet = harness();
    await quiet.open("chat-a", [item("only", 5 * MIN)]);
    quiet.sync.remove("only");
    timers.tick(DAY);
    await flush();
    assert.equal(quiet.reads.length, 1);
  });
});
