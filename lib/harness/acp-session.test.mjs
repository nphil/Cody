import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AcpEngineSession, translateSessionUpdate } = await jiti.import("./acp-session.ts");

/** Fresh streaming state, as one session holds across a turn. */
const fresh = () => ({ open: false, text: "" });

test("a run of message chunks opens once and accumulates", () => {
  const state = fresh();
  // ACP sends assistant text as chunks with no explicit start or end, so the
  // FIRST chunk has to synthesize message_start.
  const first = translateSessionUpdate(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    state,
  );
  assert.deepEqual(first.map((e) => e.type), ["message_start", "message_update"]);
  assert.equal(first[1].delta, "Hel");
  assert.deepEqual(first[1].content, [{ type: "text", text: "Hel" }]);

  const second = translateSessionUpdate(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
    state,
  );
  assert.deepEqual(second.map((e) => e.type), ["message_update"], "no second message_start");
  assert.equal(second[0].delta, "lo");
  assert.deepEqual(second[0].content, [{ type: "text", text: "Hello" }], "content is cumulative");
  assert.deepEqual(state, { open: true, text: "Hello" });
});

test("thinking chunks are distinct from message chunks", () => {
  const state = fresh();
  const events = translateSessionUpdate(
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    state,
  );
  assert.deepEqual(events, [{ type: "thinking", delta: "hmm" }]);
  // Reasoning must not open an assistant message, or the transcript would
  // show the model's private thinking as its answer.
  assert.deepEqual(state, { open: false, text: "" });
});

test("tool calls map to start and only terminal updates end them", () => {
  const state = fresh();
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file" }, state),
    [{ type: "tool_execution_start", toolCallId: "t1", toolName: "Read file" }],
  );
  // No title: fall back to the kind rather than rendering "undefined".
  assert.equal(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", kind: "edit" }, state)[0].toolName,
    "edit",
  );
  // In-progress updates are not endings.
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }, state),
    [],
  );
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }, state),
    [{ type: "tool_execution_end", toolCallId: "t1", isError: false }],
  );
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" }, state),
    [{ type: "tool_execution_end", toolCallId: "t2", isError: true }],
  );
});

test("unknown and malformed updates are ignored, never thrown on", () => {
  const state = fresh();
  // ACP keeps gaining sessionUpdate variants; meeting a new one must not break
  // a live chat, and must not disturb an open message.
  state.open = true;
  state.text = "partial";
  for (const input of [
    { sessionUpdate: "plan", entries: [] },
    { sessionUpdate: "some_future_variant", whatever: true },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "..." } },
    { sessionUpdate: "agent_message_chunk" },
    {},
    null,
    undefined,
    "not an object",
    42,
  ]) {
    assert.deepEqual(translateSessionUpdate(input, state), [], `ignored: ${JSON.stringify(input)}`);
  }
  assert.deepEqual(state, { open: true, text: "partial" }, "open message left intact");
});

test("an empty turn explains itself instead of leaving a void", async () => {
  const { emptyTurnMessage } = await jiti.import("./acp-session.ts");

  // The case that actually happens on a fresh install: a clean end_turn with
  // no content, because no model or credentials are configured. Silence here
  // reads as "Cody is broken", so it must name the likely cause.
  const fresh = emptyTurnMessage("Hermes", "end_turn", "Run `hermes setup` in a Cody terminal.");
  assert.match(fresh, /Hermes ended the turn without a reply/);
  assert.match(fresh, /hermes setup/, "carries the engine's own remedy");

  // Engine-neutral fallback when a spec supplies no hint.
  assert.match(emptyTurnMessage("SomeAgent", "end_turn"), /may have no model configured/);
  assert.doesNotMatch(emptyTurnMessage("SomeAgent", "end_turn"), /hermes/i, "no engine leaks into the generic path");

  // Distinct stop reasons get their own sentence rather than the setup guess.
  assert.match(emptyTurnMessage("Hermes", "refusal"), /declined/);
  assert.match(emptyTurnMessage("Hermes", "max_tokens"), /output limit/);
  assert.match(emptyTurnMessage("Hermes", "cancelled"), /stopped before replying/);
  assert.doesNotMatch(emptyTurnMessage("Hermes", "refusal"), /setup/, "a refusal is not a config problem");
});

// --------------------------------------------------------------------------
// Transport tests: a real ACP agent on the other end of a real pipe.
//
// Everything above this line tests a pure function, and every one of them
// passed while the transport delivered NOTHING — the SDK hands notification
// handlers a context object, and reading the payload off the wrong one
// discarded every frame the agent sent. These drive the real class.
// --------------------------------------------------------------------------

const STUB = fileURLToPath(new URL("./acp-agent-stub.mjs", import.meta.url));

function stubSpec(env = {}) {
  return {
    id: "stubengine",
    name: "StubEngine",
    binaryPath: process.execPath,
    args: [STUB],
    env,
    setupHint: "Configure it first.",
  };
}

/** Drive one session and collect everything it emits. */
async function withSession(env, body) {
  const dir = mkdtempSync(join(tmpdir(), "cody-acp-test-"));
  // Session bookkeeping lands in the agent dir; keep it out of the real one.
  const previousHome = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = dir;
  const session = new AcpEngineSession(stubSpec(env), { cwd: dir, sessionId: `acp-test-${randomUUID()}` });
  const events = [];
  session.onEvent((event) => events.push(event));
  try {
    await session.waitUntilReady();
    return await body(session, events);
  } finally {
    await session.destroyAndWait();
    if (previousHome === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve once the session has emitted an event of this type. */
function waitForEvent(events, type, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.find((event) => event.type === type);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${type}: saw ${events.map((e) => e.type).join(",")}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("a real agent's streamed reply reaches the session", async () => {
  await withSession({}, async (session, events) => {
    await session.send({ type: "prompt", message: "hi" });
    await waitForEvent(events, "agent_end");

    const types = events.map((event) => event.type);
    // The regression this file exists for: every one of these was missing.
    assert.ok(types.includes("thinking"), `no thinking event: ${types.join(",")}`);
    assert.ok(types.includes("message_start"), `no message_start: ${types.join(",")}`);
    assert.ok(types.includes("message_update"), `no message_update: ${types.join(",")}`);

    const end = events.find((event) => event.type === "message_end");
    assert.deepEqual(end.content, [{ type: "text", text: "Hello world" }]);

    // A turn that DID answer must not also be explained as empty.
    assert.ok(!events.some((e) => e.type === "notice"), "a streamed turn needs no notice");

    // ...and the reply is banked, so a reload shows it.
    const state = await session.send({ type: "get_messages" });
    assert.deepEqual(state.messages.at(-1), { role: "assistant", content: [{ type: "text", text: "Hello world" }] });
  });
});

test("a prompt is acknowledged immediately, not held for the whole turn", async () => {
  // The browser aborts the prompt POST after 30s and rolls the user's message
  // back out of the transcript, so a slow turn must not be awaited here.
  await withSession({ ACP_STUB_DELAY_MS: "1500" }, async (session, events) => {
    const start = Date.now();
    const ack = await session.send({ type: "prompt", message: "slow one" });
    const elapsed = Date.now() - start;

    assert.equal(ack, null, "prompt returns an acknowledgement, not the turn result");
    assert.ok(elapsed < 700, `prompt blocked for ${elapsed}ms; it must return as soon as the turn starts`);

    // Mid-turn the reconciler must be told the turn is still live, or it ends
    // the run at its 15s check and unlocks the composer under a busy agent.
    const mid = await session.send({ type: "get_state" });
    assert.equal(mid.isStreaming, true);
    assert.equal(mid.isPromptRunning, true);
    assert.equal(session.isRunning(), true);

    await waitForEvent(events, "agent_end");
    const after = await session.send({ type: "get_state" });
    assert.equal(after.isStreaming, false);
    assert.equal(after.isPromptRunning, false);
    // An idle session must not keep the sidebar's running indicator lit.
    assert.equal(session.isRunning(), false);
  });
});

test("a genuinely empty turn is still explained", async () => {
  await withSession({ ACP_STUB_SILENT: "1" }, async (session, events) => {
    await session.send({ type: "prompt", message: "hi" });
    await waitForEvent(events, "agent_end");
    const notice = events.find((event) => event.type === "notice");
    assert.ok(notice, "silence with no explanation is the void this guards against");
    assert.match(notice.message, /StubEngine/);
    assert.match(notice.message, /Configure it first\./);
  });
});
