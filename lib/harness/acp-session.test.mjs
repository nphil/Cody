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

test("a tool call is named by the engine's own metadata, never by its title", () => {
  const state = fresh();
  // ACP's `title` is a human SENTENCE. One adapter renders a Bash call as the
  // whole command line, so a chip built from `title` reads "npm run typecheck"
  // where every other engine says "Bash". The real name rides in `_meta`,
  // under the agent's own namespace — which is why the PATH is spec data and
  // this module still names no engine.
  const path = ["someEngine", "toolName"];
  assert.deepEqual(
    translateSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "npm run typecheck",
        kind: "execute",
        _meta: { someEngine: { toolName: "Bash" } },
      },
      state,
      { toolNameMetaPath: path },
    ),
    [{ type: "tool_execution_start", toolCallId: "t1", toolName: "Bash" }],
  );

  // The declared path missing from THIS frame falls back rather than blanking
  // the chip; so does a non-string sitting where the name should be.
  assert.equal(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Read file" }, state, { toolNameMetaPath: path })[0].toolName,
    "Read file",
  );
  assert.equal(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Read file", _meta: { someEngine: { toolName: 7 } } }, state, { toolNameMetaPath: path })[0].toolName,
    "Read file",
  );
  // An engine with no declared path gets the standard field when it has one.
  assert.equal(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t4", name: "Edit", title: "Rewrite the config" }, state)[0].toolName,
    "Edit",
  );
});

test("a turn's usage is read as a delta, and never invented", async () => {
  const { readPromptUsage } = await jiti.import("./acp-session.ts");
  // PromptResponse.usage describes the turn that just ended, which is exactly
  // Cody's contract: every usage frame is a delta to ADD. The four fields sum
  // to the agent's own total, so no subtraction is needed and none is done.
  assert.deepEqual(
    readPromptUsage({ inputTokens: 2, outputTokens: 13, cachedReadTokens: 24432, cachedWriteTokens: 8635, totalTokens: 33082 }),
    { input: 2, output: 13, cacheRead: 24432, cacheWrite: 8635 },
  );
  // Cost is deliberately absent: ACP does not state its cost figure is
  // per-turn, and a cumulative number added as a delta compounds into
  // something wrong that looks authoritative.
  assert.equal("cost" in readPromptUsage({ inputTokens: 1, cost: { amount: 0.04 } }), false);
  // Nothing to report is null, not an empty frame the browser would still add.
  for (const empty of [undefined, null, "", 42, {}, { inputTokens: 0, outputTokens: 0 }, { inputTokens: "many" }, { inputTokens: -5 }]) {
    assert.equal(readPromptUsage(empty), null, `no frame for ${JSON.stringify(empty)}`);
  }
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

/** Wait until a predicate holds over the collected events. */
function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = predicate();
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("an approval reaches the user and the answer reaches the agent", async () => {
  await withSession({ ACP_STUB_ASK_PERMISSION: "1" }, async (session, events) => {
    await session.send({ type: "prompt", message: "edit a file" });

    const ask = await waitFor(() => events.find((e) => e.type === "permission_request"), "permission_request");
    assert.equal(ask.toolCall.title, "Write src/index.ts");
    // The AGENT's options, not buttons Cody invented: only it knows whether
    // "always" is on offer.
    assert.deepEqual(ask.options.map((o) => o.optionId), ["yes", "always", "no"]);
    assert.deepEqual(ask.options.map((o) => o.kind), ["allow_once", "allow_always", "reject_once"]);

    // A blocked turn is still a running turn.
    const blocked = await session.send({ type: "get_state" });
    assert.equal(blocked.isPromptRunning, true);
    // ...and the request survives a reload, which only sees state.
    assert.deepEqual(blocked.pendingPermissions.map((p) => p.requestId), [ask.requestId]);

    const answer = await session.send({ type: "respond_permission", requestId: ask.requestId, optionId: "always" });
    assert.deepEqual(answer, { answered: true });

    await waitForEvent(events, "agent_end");
    const reply = events.find((e) => e.type === "message_end");
    assert.match(reply.content[0].text, /"outcome":"selected"/);
    assert.match(reply.content[0].text, /"optionId":"always"/);

    // Nothing is left dangling once the turn is over.
    const after = await session.send({ type: "get_state" });
    assert.deepEqual(after.pendingPermissions, []);
  });
});

test("an unknown option is a denial, never an approval", async () => {
  // A stale card in a second tab, or a client sending an id the agent never
  // offered. Resolving that into "selected" would grant something nobody
  // agreed to.
  await withSession({ ACP_STUB_ASK_PERMISSION: "1" }, async (session, events) => {
    await session.send({ type: "prompt", message: "edit a file" });
    const ask = await waitFor(() => events.find((e) => e.type === "permission_request"), "permission_request");

    await session.send({ type: "respond_permission", requestId: ask.requestId, optionId: "not-an-option" });
    await waitForEvent(events, "agent_end");
    const reply = events.find((e) => e.type === "message_end");
    assert.match(reply.content[0].text, /"outcome":"cancelled"/);

    // Answering twice is a stale click, reported rather than thrown.
    const again = await session.send({ type: "respond_permission", requestId: ask.requestId, optionId: "yes" });
    assert.deepEqual(again, { answered: false });
  });
});

test("aborting settles the approval the agent is blocked on", async () => {
  // The protocol requires it: a client that cancels MUST answer every pending
  // request with `cancelled`. Skip it and the agent waits forever on a turn
  // the user already gave up on.
  await withSession({ ACP_STUB_ASK_PERMISSION: "1" }, async (session, events) => {
    await session.send({ type: "prompt", message: "edit a file" });
    const ask = await waitFor(() => events.find((e) => e.type === "permission_request"), "permission_request");

    await session.send({ type: "abort" });
    const resolved = await waitFor(() => events.find((e) => e.type === "permission_resolved"), "permission_resolved");
    assert.equal(resolved.requestId, ask.requestId);
    assert.equal(resolved.outcome, "cancelled");
    assert.deepEqual((await session.send({ type: "get_state" })).pendingPermissions, []);
  });
});

test("an agent offering no usable option is declined, not approved", async () => {
  await withSession({ ACP_STUB_ASK_PERMISSION: "empty" }, async (session, events) => {
    await session.send({ type: "prompt", message: "edit a file" });
    await waitForEvent(events, "agent_end");

    assert.ok(!events.some((e) => e.type === "permission_request"), "nothing to show means nothing to ask");
    const notice = events.find((e) => e.type === "notice");
    assert.match(notice.message, /offered no options/i);
    const reply = events.find((e) => e.type === "message_end");
    assert.match(reply.content[0].text, /"outcome":"cancelled"/);
  });
});

// ---------------------------------------------------------------------------
// Model selection over ACP
//
// Two wire shapes are live in the ecosystem at once, and both payloads below
// are transcribed from a real agent rather than invented: the config-option
// one from the installed Claude Code and Codex adapters (which build it in
// `buildConfigOptions` / `createModelConfigOption` with `category: "model"`),
// the session-model one from a live `session/new` against Hermes 0.19, which
// answers `models: {availableModels, currentModelId}` and no `configOptions`
// at all.
//
// The reason this is pinned: an ACP engine reporting NO models is what made
// /api/models the composer's only source, and /api/models used to answer with
// omp's catalog. An engine that publishes its own models must surface them.

const { readModelSurface, readConfigOptionModels, readSessionModelState } =
  await jiti.import("./acp-session.ts");

/** As `@agentclientprotocol/claude-agent-acp` builds it. */
const CONFIG_OPTION_RESPONSE = {
  sessionId: "sess-1",
  configOptions: [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "acceptEdits", name: "Accept Edits" }],
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [
        { value: "default", name: "Default", description: "Claude Sonnet 4.6" },
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
    {
      id: "fast",
      name: "Fast mode",
      category: "model_config",
      type: "select",
      currentValue: "off",
      options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }],
    },
  ],
};

/** As a live Hermes `session/new` answered, trimmed to three models. */
const SESSION_MODEL_RESPONSE = {
  sessionId: "d1c23dd0-62e7-4e9c-bf44-b1248e200624",
  models: {
    currentModelId: "bedrock:us.anthropic.claude-sonnet-5",
    availableModels: [
      { modelId: "bedrock:us.anthropic.claude-sonnet-5", name: "us.anthropic.claude-sonnet-5", description: "Provider: AWS Bedrock" },
      { modelId: "bedrock:us.anthropic.claude-sonnet-4-6", name: "us.anthropic.claude-sonnet-4-6", description: "Provider: AWS Bedrock" },
      { modelId: "bedrock:us.anthropic.claude-opus-4-6-v1", name: "us.anthropic.claude-opus-4-6-v1", description: "Provider: AWS Bedrock" },
    ],
  },
  modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
};

test("the model selector is picked out of configOptions by category, not by position", () => {
  const surface = readModelSurface(CONFIG_OPTION_RESPONSE);
  assert.equal(surface.configId, "model");
  assert.equal(surface.current, "sonnet");
  assert.deepEqual(surface.options.map((o) => o.value), ["default", "sonnet", "opus"]);
  // The mode and fast-mode selectors are `type: "select"` too. Mistaking one
  // for the model would let the model picker change the permission mode.
  assert.ok(!surface.options.some((o) => o.value === "acceptEdits"));
  assert.ok(!surface.options.some((o) => o.value === "on"));
});

test("the older session models field is read when an agent publishes no configOptions", () => {
  const surface = readModelSurface(SESSION_MODEL_RESPONSE);
  // configId null is what routes the switch to session/set_model rather than
  // session/set_config_option — the two calls are not interchangeable.
  assert.equal(surface.configId, null);
  assert.equal(surface.current, "bedrock:us.anthropic.claude-sonnet-5");
  assert.equal(surface.options.length, 3);
  assert.equal(surface.options[0].name, "us.anthropic.claude-sonnet-5");
  assert.equal(surface.options[0].description, "Provider: AWS Bedrock");
});

test("an agent that publishes no model selector yields nothing to render", () => {
  // No fabricated single-entry list: an empty picker is a picker the user can
  // click and change nothing with.
  assert.equal(readModelSurface({ sessionId: "s" }), null);
  assert.equal(readModelSurface({ sessionId: "s", configOptions: [] }), null);
  assert.equal(readModelSurface(null), null);
  // A mode selector alone is not a model selector.
  assert.equal(readConfigOptionModels(CONFIG_OPTION_RESPONSE.configOptions.slice(0, 1)), null);
  assert.equal(readSessionModelState({ availableModels: [] }), null);
});

test("config options win when an agent is mid-migration and ships both shapes", () => {
  const both = { ...CONFIG_OPTION_RESPONSE, models: SESSION_MODEL_RESPONSE.models };
  assert.equal(readModelSurface(both).configId, "model", "the current spec's shape is authoritative");
});

test("grouped select options are flattened rather than dropped", () => {
  // ACP's SessionConfigSelectOptions is EITHER a flat list OR a list of
  // {group, name, options}. Reading only the flat form would silently hand
  // back an empty picker for an agent that groups by provider.
  const surface = readConfigOptionModels([{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "b",
    options: [
      { group: "anthropic", name: "Anthropic", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] },
      { group: "openai", name: "OpenAI", options: [{ value: "c", name: "C" }] },
    ],
  }]);
  assert.deepEqual(surface.options.map((o) => o.value), ["a", "b", "c"]);
});

test("a model with no display name falls back to its id, never to nothing", () => {
  const surface = readSessionModelState({
    currentModelId: "x",
    availableModels: [{ modelId: "x" }, { modelId: "" }, { name: "no id" }],
  });
  assert.deepEqual(surface.options, [{ value: "x", name: "x" }]);
});

test("an agent's own models reach get_state, and a pick reaches the agent", async () => {
  // Over a real pipe, both directions: the selector the agent published at
  // session/new has to arrive in the state the composer reads, and the pick
  // has to leave as session/set_config_option and come back as the agent's
  // own confirmation.
  await withSession({ ACP_STUB_MODELS: "config" }, async (session, events) => {
    const before = await session.send({ type: "get_state" });
    assert.equal(before.modelSelectable, true);
    assert.deepEqual(before.model, { provider: "stubengine", id: "alpha", name: "Alpha" });
    assert.deepEqual(before.availableModels.map((m) => m.id), ["alpha", "beta"]);
    // The MODE selector arrives in the same array and is the same
    // `type: "select"`; it must never be offered as a model.
    assert.ok(!before.availableModels.some((m) => m.id === "yolo"));

    const switched = await session.send({ type: "set_model", provider: "stubengine", modelId: "beta" });
    assert.deepEqual(switched, { provider: "stubengine", id: "beta", name: "Beta" });

    const after = await session.send({ type: "get_state" });
    assert.deepEqual(after.model, { provider: "stubengine", id: "beta", name: "Beta" });
    // config_update is the event Cody's session hook already treats as
    // authoritative for the running model — no new client vocabulary.
    const announced = events.filter((event) => event.type === "config_update");
    assert.equal(announced.at(-1).model.id, "beta");
  });
});

test("the older set_model shape is driven end to end too", async () => {
  await withSession({ ACP_STUB_MODELS: "session" }, async (session, events) => {
    const before = await session.send({ type: "get_state" });
    assert.deepEqual(before.model, { provider: "stubengine", id: "beta", name: "Beta" });
    assert.equal(before.availableModels.find((m) => m.id === "beta").description, "the other one");

    // This agent answers set_model with `{}` and announces the change as a
    // current_model_update notification instead — a client that only read the
    // response would never learn the new value.
    assert.deepEqual(
      await session.send({ type: "set_model", modelId: "alpha" }),
      { provider: "stubengine", id: "alpha", name: "Alpha" },
    );
    assert.equal((await session.send({ type: "get_state" })).model.id, "alpha");
    assert.ok(events.some((event) => event.type === "config_update" && event.model.id === "alpha"));
  });
});

test("an agent with no model selector says unsupported instead of inventing one", async () => {
  await withSession({}, async (session) => {
    const state = await session.send({ type: "get_state" });
    assert.equal(state.modelSelectable, false);
    assert.deepEqual(state.availableModels, []);
    assert.equal(state.model, null);
    // "unsupported" is the code the UI hides on, and it is decided PER
    // SESSION: whether models can be switched depends on the agent and the
    // account behind it, which no static capability flag could tell the truth
    // about.
    await assert.rejects(
      session.send({ type: "set_model", modelId: "alpha" }),
      (error) => error.code === "unsupported",
    );
  });
});

test("a model the agent never offered is refused, not forwarded", async () => {
  await withSession({ ACP_STUB_MODELS: "config" }, async (session) => {
    // omp model ids reach this command from a composer that has not yet
    // learned the engine changed. Passing one through would either error
    // deep in the agent or, worse, be accepted as an opaque id.
    await assert.rejects(
      session.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-5" }),
      (error) => error.code === "invalid_model",
    );
    assert.equal((await session.send({ type: "get_state" })).model.id, "alpha", "the selection is unchanged");
  });
});
