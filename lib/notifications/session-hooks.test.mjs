import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * The seams the notifications ride on, in the two session classes: an observer
 * channel that is NOT a listener (a listener keeps a child alive and receives
 * host-tool calls meant for a page), a probe for whether a dialog is still
 * waiting, the signals that exist only for observers, and the two structured
 * notices.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-hooks-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { AcpEngineSession } = await jiti.import("../harness/acp-session.ts");

function harness(options = {}) {
  let onFrame = () => {};
  const sentFrames = [];
  let commandHandler = options.sendCommand ?? (async () => ({}));
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendFrame(frame) { sentFrames.push(frame); },
    sendCommand: (command, ...rest) => commandHandler(command, ...rest),
    sendCommandWithId: () => ({ id: "rpc-1", result: Promise.resolve({ agentInvoked: true }) }),
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  return { wrapper, sentFrames, emitFrame: (frame) => onFrame(frame), setCommandHandler: (next) => { commandHandler = next; } };
}

const dialog = (fields) => ({ type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"], ...fields });
const types = (list) => list.map((event) => event.type);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// omp wrapper
// ---------------------------------------------------------------------------

test("an observer is told everything a listener is told, and stops being told when it unsubscribes", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const listened = [];
    const observed = [];
    wrapper.onEvent((event) => listened.push(event));
    const stop = wrapper.observeEvents((event) => observed.push(event));
    emitFrame({ type: "agent_start" });
    emitFrame(dialog());
    emitFrame({ type: "notice", level: "info", message: "hello" });
    emitFrame({ type: "agent_end", messages: [] });
    assert.deepEqual(observed, listened);
    assert.deepEqual(types(observed), ["agent_start", "extension_ui_request", "notice", "agent_end"]);
    stop();
    emitFrame({ type: "agent_start" });
    assert.equal(observed.length, 4);
    assert.equal(listened.length, 5);
  } finally { await wrapper.destroyAndWait(); }
});

test("an observer is not a listener: it neither keeps the child alive nor counts as a page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { wrapper, emitFrame } = harness();
  const unobserved = wrapper.observeEvents(() => {});
  assert.equal(wrapper.listeners.length, 0, "the listener list is untouched");
  emitFrame({ type: "agent_start" });
  emitFrame({ type: "agent_end", messages: [] });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(wrapper.isAlive(), false, "an unattended child still idles out with an observer on it");
  unobserved();
  await wrapper.destroyAndWait();

  const attended = harness();
  attended.wrapper.onEvent(() => {});
  attended.emitFrame({ type: "agent_start" });
  attended.emitFrame({ type: "agent_end", messages: [] });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(attended.wrapper.isAlive(), true, "whereas a real page does");
  await attended.wrapper.destroyAndWait();
});

test("host tools are not routed to an observer: with no page attached the call is refused at once", async () => {
  const { wrapper, emitFrame, sentFrames } = harness();
  try {
    await wrapper.send({ type: "set_host_tools", tools: [{ name: "my_tool" }] });
    wrapper.observeEvents(() => {});
    emitFrame({ type: "host_tool_call", id: "h1", toolName: "my_tool", arguments: {} });
    const refusal = sentFrames.find((frame) => frame.type === "host_tool_result" && frame.id === "h1");
    assert.ok(refusal, "answered immediately, so the agent never waits on a tool nobody can run");
    assert.equal(refusal.isError, true);
  } finally { await wrapper.destroyAndWait(); }
});

test("an observer that throws reaches neither the session, nor the other observers, nor the listeners", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const listened = [];
    const second = [];
    wrapper.onEvent((event) => listened.push(event));
    wrapper.observeEvents(() => { throw new Error("observer bug"); });
    wrapper.observeEvents((event) => second.push(event));
    assert.doesNotThrow(() => emitFrame({ type: "notice", level: "info", message: "still works" }));
    assert.equal(listened.length, 1);
    assert.equal(second.length, 1);
    assert.equal(wrapper.isAlive(), true);
  } finally { await wrapper.destroyAndWait(); }
});

test("a dialog is probed as still waiting until it is answered, and not after", async () => {
  const { wrapper, emitFrame, sentFrames } = harness();
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    emitFrame(dialog());
    const pending = wrapper.getPendingUiRequest("d1");
    assert.equal(pending.method, "select");
    assert.deepEqual(pending.options, ["a", "b"]);
    assert.equal(wrapper.getPendingUiRequest("nope"), null);

    await wrapper.send({ type: "extension_ui_response", id: "d1", value: "a" });
    assert.equal(wrapper.getPendingUiRequest("d1"), null);
    assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "d1", value: "a" }]);
    assert.deepEqual(observed.filter((event) => event.type === "cody_ui_request_resolved"), [{ type: "cody_ui_request_resolved", id: "d1" }]);
  } finally { await wrapper.destroyAndWait(); }
});

test("an answer for an id that was never waiting signals nothing", async () => {
  const { wrapper } = harness();
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    await wrapper.send({ type: "extension_ui_response", id: "ghost", value: "x" });
    assert.deepEqual(observed, []);
  } finally { await wrapper.destroyAndWait(); }
});

test("omp cancelling a dialog, and a dialog timing out, both end its wait — for observers too", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    emitFrame(dialog({ id: "c1" }));
    emitFrame({ type: "extension_ui_request", id: "x", method: "cancel", targetId: "c1" });
    assert.equal(wrapper.getPendingUiRequest("c1"), null);
    assert.deepEqual(observed.filter((e) => e.type === "cody_ui_request_resolved").map((e) => e.id), ["c1"]);
    assert.ok(observed.some((e) => e.type === "extension_ui_request" && e.method === "cancel"), "the cancel frame itself still reaches observers");

    emitFrame(dialog({ id: "t1", timeout: 25 }));
    assert.ok(wrapper.getPendingUiRequest("t1"), "live while its time lasts");
    assert.equal(typeof wrapper.getPendingUiRequest("t1").expiresAt, "number");
    await wait(80);
    assert.equal(wrapper.getPendingUiRequest("t1"), null);
    assert.deepEqual(observed.filter((e) => e.type === "cody_ui_request_resolved").map((e) => e.id), ["c1", "t1"], "omp emits nothing when a timeout lapses; observers still hear it");
  } finally { await wrapper.destroyAndWait(); }
});

test("a dialog past its deadline is gone even before its timer has run", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    emitFrame(dialog({ id: "late", timeout: 60_000 }));
    wrapper.getPendingUiRequest("late").expiresAt = Date.now() - 1;
    assert.equal(wrapper.getPendingUiRequest("late"), null);
    assert.deepEqual(observed.filter((e) => e.type === "cody_ui_request_resolved").map((e) => e.id), ["late"]);
  } finally { await wrapper.destroyAndWait(); }
});

test("a dialog re-sent under the same id retires the old one and announces the new one", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    emitFrame(dialog({ options: ["a", "b"] }));
    emitFrame(dialog({ options: ["x", "y"] }));
    assert.deepEqual(wrapper.getPendingUiRequest("d1").options, ["x", "y"]);
    assert.deepEqual(types(observed), ["extension_ui_request", "cody_ui_request_resolved", "extension_ui_request"], "the old one is retired, then the new one announced");
  } finally { await wrapper.destroyAndWait(); }
});

test("closing or restarting the session says every dialog is gone — once, and only if any was waiting", async () => {
  const idle = harness();
  const idleSeen = [];
  idle.wrapper.observeEvents((event) => idleSeen.push(event));
  await idle.wrapper.destroyAndWait();
  assert.equal(idleSeen.some((e) => e.type === "cody_ui_requests_cleared"), false);

  const busy = harness();
  const busySeen = [];
  busy.wrapper.observeEvents((event) => busySeen.push(event));
  busy.emitFrame(dialog({ id: "d1" }));
  busy.emitFrame(dialog({ id: "d2" }));
  await busy.wrapper.destroyAndWait();
  assert.equal(busySeen.filter((e) => e.type === "cody_ui_requests_cleared").length, 1);
  assert.equal(busy.wrapper.getPendingUiRequest("d1"), null);
});

test("pressing Stop is announced to observers the moment it is pressed, not when the engine answers", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { wrapper } = harness({ sendCommand: async (command) => { if (command.type === "abort") await gate; return {}; } });
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    const stopping = wrapper.send({ type: "abort" });
    await wait(10);
    assert.deepEqual(types(observed), ["cody_run_stopped"], "before the engine's reply (its own agent_end can arrive first)");
    release();
    await stopping;
  } finally { await wrapper.destroyAndWait(); }
});

test("the todo pause's notice and the crash notice carry a machine-readable reason, with their text unchanged", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const listened = [];
    const observed = [];
    wrapper.onEvent((event) => listened.push(event));
    wrapper.observeEvents((event) => observed.push(event));

    emitFrame({ type: "agent_start" });
    emitFrame({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Step one is done.\nShould I continue with step two?" }], stopReason: "stop" } });
    emitFrame({ type: "todo_reminder", count: 1 });
    const pause = observed.find((event) => event.type === "notice");
    assert.deepEqual(pause, {
      type: "notice",
      level: "info",
      reason: "awaiting_reply",
      message: "Waiting for your reply — the agent's task list is on hold.",
    });
    assert.deepEqual(listened.find((event) => event.type === "notice"), pause, "the page sees the same notice, extra field and all");

    observed.length = 0;
    wrapper.handleProcessExit("warming up\nfatal: out of memory\n");
    const crash = observed.find((event) => event.type === "notice");
    assert.equal(crash.level, "error");
    assert.equal(crash.reason, "engine_exit");
    assert.equal(crash.message, "The omp process for this session exited unexpectedly: fatal: out of memory");
    assert.deepEqual(types(observed).filter((type) => type === "notice" || type === "agent_end"), ["notice", "agent_end"], "the crash is announced before the terminal end it causes");
  } finally { await wrapper.destroyAndWait(); }
});

test("a reply that asks nothing does not pause the todo list, so it announces no waiting notice", async () => {
  const { wrapper, emitFrame } = harness();
  try {
    const observed = [];
    wrapper.observeEvents((event) => observed.push(event));
    emitFrame({ type: "agent_start" });
    emitFrame({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Step one is done." }], stopReason: "stop" } });
    emitFrame({ type: "todo_reminder", count: 1 });
    assert.equal(observed.some((event) => event.type === "notice"), false);
  } finally { await wrapper.destroyAndWait(); }
});

// ---------------------------------------------------------------------------
// ACP session, against the real stub agent
// ---------------------------------------------------------------------------

const STUB = fileURLToPath(new URL("../harness/acp-agent-stub.mjs", import.meta.url));

async function withAcpSession(env, body) {
  const dir = mkdtempSync(join(tmpdir(), "cody-notify-acp-"));
  const previous = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = dir;
  const session = new AcpEngineSession(
    { id: "stubengine", name: "StubEngine", binaryPath: process.execPath, args: [STUB], env, setupHint: "Configure it first." },
    { cwd: dir, sessionId: `acp-hook-${randomUUID()}` },
  );
  try {
    await session.waitUntilReady();
    return await body(session);
  } finally {
    await session.destroyAndWait();
    if (previous === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await wait(10);
  }
}

test("an ACP observer sees an approval open and settle, the approval can be probed while it waits, and the observer is not a listener", async () => {
  await withAcpSession({ ACP_STUB_ASK_PERMISSION: "1" }, async (session) => {
    const observed = [];
    session.observeEvents((event) => observed.push(event));
    assert.equal(session.listeners.length, 0);

    await session.send({ type: "prompt", message: "edit a file" });
    await until(() => observed.some((event) => event.type === "permission_request"), "permission_request");
    const ask = observed.find((event) => event.type === "permission_request");
    const probed = session.getPendingPermission(ask.requestId);
    assert.equal(probed.requestId, ask.requestId);
    assert.equal(probed.toolCall.title, "Write src/index.ts");
    assert.deepEqual(probed.options.map((option) => option.optionId), ["yes", "always", "no"]);
    assert.equal(session.getPendingPermission("perm-999"), null);

    await session.send({ type: "respond_permission", requestId: ask.requestId, optionId: "yes" });
    await until(() => observed.some((event) => event.type === "agent_end"), "agent_end");
    assert.equal(session.getPendingPermission(ask.requestId), null, "answered: no longer waiting");
    assert.deepEqual(
      types(observed).filter((type) => ["agent_start", "permission_request", "permission_resolved", "message_end", "agent_end"].includes(type)),
      ["agent_start", "permission_request", "permission_resolved", "message_end", "agent_end"],
    );
    assert.equal(session.listeners.length, 0, "still not a listener");
  });
});

test("an ACP approval settled by Stop is probed as gone, and unsubscribing stops the flow", async () => {
  await withAcpSession({ ACP_STUB_ASK_PERMISSION: "1" }, async (session) => {
    const observed = [];
    const stop = session.observeEvents((event) => observed.push(event));
    await session.send({ type: "prompt", message: "edit a file" });
    await until(() => observed.some((event) => event.type === "permission_request"), "permission_request");
    const ask = observed.find((event) => event.type === "permission_request");
    await session.send({ type: "abort" });
    await until(() => observed.some((event) => event.type === "permission_resolved"), "permission_resolved");
    assert.equal(observed.find((event) => event.type === "permission_resolved").outcome, "cancelled");
    assert.equal(session.getPendingPermission(ask.requestId), null);
    stop();
    const before = observed.length;
    await until(() => !session.isRunning(), "the cancelled turn to end");
    await wait(30);
    assert.equal(observed.length, before);
  });
});
