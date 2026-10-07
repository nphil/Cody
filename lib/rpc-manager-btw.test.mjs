import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * /btw side questions (omp 18.7) through the session wrapper: what the
 * browser may send, what omp's answers look like to the caller, and the one
 * promise the frames make — an answer streaming back is not a turn, so it
 * never changes the running state, but it does count as the child being busy.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, WebRpcError, subscribeRunningSessions } = await jiti.import("./rpc-manager.ts");
const { RpcCommandError, RpcCommandTimeoutError } = await jiti.import("./omp/rpc-process.ts");
const { piHarness } = await jiti.import("./harness/pi.ts");

function createHarness(commandHandler = async () => ({}), engine = {}) {
  let onFrame = () => {};
  const sent = [];
  const events = [];
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendFrame() {},
    sendCommand: async (command, timeoutMs) => {
      sent.push({ command, timeoutMs });
      return commandHandler(command, timeoutMs);
    },
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}), ...engine });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, sent, events, emitFrame: (frame) => onFrame(frame) };
}

test("a side question reaches omp with only the fields omp defines, and omp's record comes back", async () => {
  const record = { id: "159c283649af351e", status: "running", answer: "" };
  const { wrapper, sent } = createHarness(async () => ({ record }));
  try {
    const answer = await wrapper.send({
      type: "btw", question: "why is the sky blue?", recordId: "159c283649af351e",
      clientMessageId: "m1", streamingBehavior: "steer", images: [{ data: "AAAA" }], timeZone: "UTC", extra: 1,
    });
    assert.deepEqual(answer, { record });
    assert.deepEqual(sent.map((entry) => entry.command), [{ type: "btw", question: "why is the sky blue?", recordId: "159c283649af351e" }]);
  } finally { wrapper.destroy(); }
});

test("a question that is not text, and a missing or empty recordId, are sent so omp's own answer decides", async () => {
  const { wrapper, sent } = createHarness();
  try {
    await wrapper.send({ type: "btw", question: 42 });
    await wrapper.send({ type: "btw" });
    await wrapper.send({ type: "btw", question: "hi", recordId: "" });
    await wrapper.send({ type: "btw", question: "hi", recordId: 7 });
    assert.deepEqual(sent.map((entry) => entry.command), [
      { type: "btw", question: "" },
      { type: "btw", question: "" },
      { type: "btw", question: "hi" },
      { type: "btw", question: "hi" },
    ]);
  } finally { wrapper.destroy(); }
});

test("omp's refusals reach the caller word for word, and an omp without side questions fails like any unknown command", async () => {
  const refusal = (message) => async () => { throw new RpcCommandError("btw", message); };
  for (const message of [
    "A /btw question is still running; cancel it first",
    "btw requires a non-empty question",
    "Unknown /btw topic: abc",
    "No active model available for /btw.",
    "Unknown command: btw",
  ]) {
    const { wrapper } = createHarness(refusal(message));
    try {
      await assert.rejects(
        wrapper.send({ type: "btw", question: "q" }),
        (error) => error instanceof RpcCommandError && !(error instanceof WebRpcError) && error.message === message,
      );
    } finally { wrapper.destroy(); }
  }
});

test("a side question is given a bounded wait, and one that never starts is reported without touching the child", async () => {
  let attempt = 0;
  const { wrapper, sent } = createHarness(async (command, timeoutMs) => {
    attempt += 1;
    if (attempt === 1) throw new RpcCommandTimeoutError(command.type, timeoutMs);
    return { record: { id: "r2" } };
  });
  try {
    wrapper.promptRunning = true; // a long turn is under way: the child is healthy
    await assert.rejects(
      wrapper.send({ type: "btw", question: "q" }),
      (error) => error instanceof WebRpcError
        && error.code === "btw_ack_timeout"
        && /busy with another command/.test(error.message),
    );
    assert.equal(sent[0].timeoutMs, 30_000);
    assert.equal(wrapper.isAlive(), true, "the child is not recycled");
    assert.equal(wrapper.isRunning(), true, "the running turn is untouched");
    // The next ask just works.
    assert.deepEqual(await wrapper.send({ type: "btw", question: "q" }), { record: { id: "r2" } });
  } finally { wrapper.destroy(); }
});

test("a side question never changes whether the chat is running", async () => {
  const { wrapper, events } = createHarness(async () => ({ record: { id: "r1" } }));
  try {
    await wrapper.send({ type: "btw", question: "q" });
    assert.equal(wrapper.isRunning(), false);
    assert.equal(events.some((event) => event.type === "agent_start"), false);
  } finally { wrapper.destroy(); }
});

test("cancel and history are forwarded as they are and their answers come back", async () => {
  const records = [{ id: "b", status: "complete" }, { id: "a", status: "cancelled" }];
  const { wrapper, sent } = createHarness(async (command) => {
    if (command.type === "btw_cancel") return { cancelled: true };
    if (command.type === "get_btw_history") return { records };
    return {};
  });
  try {
    assert.deepEqual(await wrapper.send({ type: "btw_cancel", recordId: "b" }), { cancelled: true });
    assert.deepEqual(await wrapper.send({ type: "btw_cancel" }), { cancelled: true });
    assert.deepEqual(await wrapper.send({ type: "get_btw_history" }), { records });
    assert.deepEqual(sent.map((entry) => entry.command), [
      { type: "btw_cancel", recordId: "b" },
      { type: "btw_cancel" },
      { type: "get_btw_history" },
    ]);
  } finally { wrapper.destroy(); }
});

test("history asked for again while the first ask waits behind a long command shares one engine command", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { wrapper, sent } = createHarness(async (command) => {
    if (command.type === "get_btw_history") { await gate; return { records: [] }; }
    return {};
  });
  try {
    const first = wrapper.send({ type: "get_btw_history" });
    const second = wrapper.send({ type: "get_btw_history" });
    const third = wrapper.send({ type: "get_btw_history" });
    release();
    assert.deepEqual(await Promise.all([first, second, third]), [{ records: [] }, { records: [] }, { records: [] }]);
    assert.equal(sent.length, 1);
    // Once answered, a later ask is a fresh one.
    await wrapper.send({ type: "get_btw_history" });
    assert.equal(sent.length, 2);
  } finally { wrapper.destroy(); }
});

test("answer frames reach listeners, and neither start a turn nor announce a running change", async () => {
  const { wrapper, events, emitFrame } = createHarness();
  // Registered like a live session, so a real running change would be broadcast.
  const registry = (globalThis.__ompSessions ??= new Map());
  registry.set(wrapper.sessionId, wrapper);
  const broadcasts = [];
  const unsubscribe = subscribeRunningSessions((update) => broadcasts.push(update));
  try {
    const record = { id: "r1", status: "running", answer: "" };
    emitFrame({ type: "btw_record", record });
    emitFrame({ type: "btw_delta", recordId: "r1", delta: "Because " });
    emitFrame({ type: "btw_record", record: { ...record, status: "complete", answer: "Because of Rayleigh scattering." } });
    assert.deepEqual(events.map((event) => event.type), ["btw_record", "btw_delta", "btw_record"]);
    assert.deepEqual(events[1], { type: "btw_delta", recordId: "r1", delta: "Because " });
    assert.equal(events[2].record.answer, "Because of Rayleigh scattering.");
    assert.equal(wrapper.isRunning(), false);
    assert.deepEqual(broadcasts, []);

    // Control: a real turn does announce itself through the same listener.
    emitFrame({ type: "agent_start" });
    assert.equal(broadcasts.length > 0, true);
  } finally {
    unsubscribe();
    registry.delete(wrapper.sessionId);
    wrapper.destroy();
  }
});

test("answer frames do not disturb a turn that is running, and a history-save notice passes through as an ordinary notice", async () => {
  const { wrapper, events, emitFrame } = createHarness();
  try {
    emitFrame({ type: "agent_start" });
    assert.equal(wrapper.isRunning(), true);
    emitFrame({ type: "btw_delta", recordId: "r1", delta: "x" });
    emitFrame({ type: "btw_record", record: { id: "r1", status: "complete", answer: "x" } });
    assert.equal(wrapper.isRunning(), true, "a finished side answer does not end the turn");
    emitFrame({ type: "notice", level: "error", source: "btw-history", message: "Could not save /btw history: disk full" });
    assert.equal(events.at(-1).type, "notice");
    assert.equal(events.at(-1).source, "btw-history");
    assert.equal(wrapper.isRunning(), true);
  } finally { wrapper.destroy(); }
});

test("a child answering a side question is not idled out, but one that only sits there is", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const build = () => {
    let onFrame = () => {};
    const wrapper = new AgentSessionWrapper(
      { isAlive: true, dispose: async () => {}, onFrame(listener) { onFrame = listener; return () => {}; }, sendFrame() {}, sendCommand: async () => ({}) },
      process.cwd(),
      { rpcUi: {}, label: "omp", relaunch: () => ({}) },
    );
    wrapper.start();
    return { wrapper, emitFrame: (frame) => onFrame(frame) };
  };
  const answering = build();
  const idle = build();

  t.mock.timers.tick(9 * 60_000);
  answering.emitFrame({ type: "btw_delta", recordId: "r1", delta: "x" });

  // The idle window opened at startup closes for the one that did nothing;
  // the streaming answer pushed it back.
  t.mock.timers.tick(2 * 60_000);
  assert.equal(idle.wrapper.isAlive(), false);
  assert.equal(answering.wrapper.isAlive(), true);
  answering.wrapper.destroy();
});

test("pi, whose RPC vocabulary has no side questions, refuses all three commands before sending anything", async () => {
  const { wrapper, sent } = createHarness(async () => ({}), { rpcUi: piHarness.rpcUi });
  try {
    for (const type of ["btw", "btw_cancel", "get_btw_history"]) {
      await assert.rejects(
        wrapper.send({ type, question: "q" }),
        (error) => error instanceof RpcCommandError && error.code === "unsupported",
        type,
      );
    }
    assert.deepEqual(sent, []);
  } finally { wrapper.destroy(); }
});
