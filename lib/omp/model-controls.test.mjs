import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";
import { ompVersionOf, startLab } from "./fixtures/model-controls/rpc-lab.mjs";

/**
 * omp 19.1's remote model controls, proven on recorded frames (always) and on a REAL engine against a fake
 * Anthropic server (when an omp binary is available: CODY_OMP_BIN). The recordings are
 * lib/fixtures/omp-19.1.0-{model,queue}-controls.json with omp-19.0.0-model-controls.json for contrast.
 * What the proofs decided is written down in docs/agents/engines.md (omp 19.1 model controls).
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveThinkingSelector } = await jiti.import("../../hooks/session-control-scope.ts");
const { resolveAvailableThinkingLevels, selectableThinkingLevels, thinkingLevelsForMeta } = await jiti.import("../thinking-levels.ts");
const { versionAtLeast } = await jiti.import("./omp-cli.ts");

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const m191 = fixture("omp-19.1.0-model-controls.json");
const m190 = fixture("omp-19.0.0-model-controls.json");
const q191 = fixture("omp-19.1.0-queue-controls.json");
const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const stepsOf = (fx, scenario) => fx.scenarios[scenario].steps;
const stepOf = (fx, scenario, type, match = {}) => stepsOf(fx, scenario).find((s) => s.command.type === type && Object.entries(match).every(([key, value]) => s.command[key] === value));
const statesOf = (fx, scenario) => stepsOf(fx, scenario).filter((s) => s.command.type === "get_state").map((s) => s.response.data);
/** The first get_state recorded after step `index`. */
const stateAfter = (steps, index) => steps.slice(index).find((s) => s.command.type === "get_state").response.data;
const frames = (step) => [...(step.eventsBefore ?? []), ...(step.eventsAfter ?? [])];
const deepFind = (value, key) => {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return value[key];
  for (const child of Object.values(value)) {
    const found = deepFind(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

// ---- recorded frames ---------------------------------------------------------------------------------------

test("omp 19.1's get_state names the chosen selector and the model's ladder; 19.0's names neither", () => {
  const states = statesOf(m191, "static").filter((d) => d.thinkingLevel != null);
  assert.ok(states.length >= 8);
  for (const d of states) {
    assert.equal(typeof d.configuredThinkingLevel, "string");
    assert.ok(d.thinkingLevels.includes("auto") && d.thinkingLevels.includes("off"));
  }
  for (const d of statesOf(m190, "static")) {
    assert.equal(d.configuredThinkingLevel, undefined);
    assert.equal(d.thinkingLevels, undefined);
    assert.ok(!d.keys.includes("configuredThinkingLevel") && !d.keys.includes("thinkingLevels"));
  }
});

test("an Auto chat reads Auto from a 19.1 snapshot alone; an older engine's snapshot cannot say", () => {
  const auto = statesOf(m191, "static").find((d) => d.configuredThinkingLevel === "auto");
  assert.ok(auto);
  assert.notEqual(auto.thinkingLevel, "auto", "the engine reports the level auto resolved to");
  assert.deepEqual(resolveThinkingSelector(auto.thinkingLevel, auto.configuredThinkingLevel, false), { display: "auto", rememberedAuto: true });

  const steps = stepsOf(m190, "static");
  const settled = stateAfter(steps, steps.findIndex((s) => s.command.type === "set_thinking_level" && s.command.level === "auto"));
  assert.equal(settled.configuredThinkingLevel, undefined);
  assert.equal(resolveThinkingSelector(settled.thinkingLevel, undefined, false).display, settled.thinkingLevel, "without a memory the snapshot reads as an explicit level");
  assert.equal(resolveThinkingSelector(settled.thinkingLevel, undefined, true).display, "auto", "the remembered pick is all that keeps Auto on 19.0");
});

test("an explicit pick reads back as itself on 19.1 even when Auto was remembered", () => {
  const steps = stepsOf(m191, "static");
  const at = steps.findIndex((s) => s.command.type === "set_thinking_level" && s.command.level === "low");
  const state = stateAfter(steps, at);
  assert.equal(state.configuredThinkingLevel, "low");
  assert.deepEqual(resolveThinkingSelector(state.thinkingLevel, state.configuredThinkingLevel, true), { display: "low", rememberedAuto: false });
  const echo = frames(steps[at]).find((f) => f.type === "thinking_level_changed");
  assert.equal(echo.configured, undefined, "the echo of an explicit pick carries no configured: the snapshot settles it");
});

test("the ladder omp names for a model is Cody's catalog ladder plus Auto", () => {
  const models = stepOf(m191, "static", "get_available_models").response.data.models;
  const seen = new Set();
  for (const d of statesOf(m191, "static").filter((s) => s.thinkingLevel != null)) {
    const model = models.find((m) => `${m.provider}/${m.id}` === d.model);
    assert.ok(model, d.model);
    seen.add(d.model);
    const cody = thinkingLevelsForMeta({ provider: model.provider, modelId: model.id, reasoning: model.reasoning, thinking: model.thinking });
    assert.deepEqual(d.thinkingLevels.filter((level) => level !== "auto"), cody, d.model);
  }
  assert.equal(seen.size, 3);
});

test("the engine's list answers for the model it runs, the catalog for a pick still waiting to apply", () => {
  const opus = { provider: "mock", modelId: "claude-opus-5-5" };
  const haiku = { provider: "mock", modelId: "claude-haiku-5-5" };
  const engineLevels = statesOf(m191, "static")[0].thinkingLevels;
  const live = { ...opus, reasoning: true, thinking: { efforts: ["minimal", "low", "medium", "high", "xhigh"] }, engineLevels };
  assert.deepEqual(resolveAvailableThinkingLevels(["off", "low"], opus, live), engineLevels);
  assert.deepEqual(resolveAvailableThinkingLevels(["off", "minimal", "low", "medium"], haiku, live), ["off", "minimal", "low", "medium"]);
  assert.deepEqual(resolveAvailableThinkingLevels(undefined, haiku, live), null);
  assert.deepEqual(resolveAvailableThinkingLevels(undefined, opus, { ...live, engineLevels: [] }), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(resolveAvailableThinkingLevels(["off", "low"], opus, { ...live, engineLevels: undefined }), ["off", "low"]);
  assert.deepEqual(selectableThinkingLevels(engineLevels), ["auto", "off", "minimal", "low", "medium", "high", "xhigh"]);
});

test("the 19.1 selector fields reach the browser only when the engine reported them, at every snapshot", () => {
  const manager = read("../rpc-manager.ts");
  const from = manager.indexOf('thinkingLevel: state.thinkingLevel ?? "off"');
  assert.ok(from > 0);
  const slice = manager.slice(from, from + 800);
  assert.match(slice, /state\.configuredThinkingLevel !== undefined \? \{ configuredThinkingLevel: state\.configuredThinkingLevel \} : \{\}/);
  assert.match(slice, /state\.thinkingLevels !== undefined \? \{ thinkingLevels: state\.thinkingLevels \} : \{\}/);
  const hook = read("../../hooks/useAgentSession.ts");
  for (const snapshot of ["agentState.state", "liveState", "d.state"]) {
    assert.ok(hook.includes(`adoptThinkingLevel(${snapshot}.thinkingLevel, ${snapshot}.configuredThinkingLevel)`), `${snapshot} hands the engine's selector over`);
  }
  assert.equal((hook.match(/toThinkingModelMeta\([^)]*\.thinkingLevels\)/g) ?? []).length, 4, "every state snapshot that sets the live model also hands over its ladder (a config_update event carries no state)");
});

test("19.1 added the picker, abort-and-deliver and resume; 19.0 refuses all three", () => {
  assert.equal(stepOf(m191, "static", "get_model_picker").response.success, true);
  assert.equal(stepOf(m191, "static", "abort_and_deliver_queue").response.success, true);
  for (const type of ["get_model_picker", "abort_and_deliver_queue"]) {
    assert.equal(stepOf(m190, "static", type).response.error, `Unknown command: ${type}`);
  }
  assert.equal(stepOf(m190, "resumeIdle", "resume").response.error, "Unknown command: resume");
  assert.equal(stepOf(m190, "static", "abort_and_restore_queue").response.success, true, "the restore command is the same on both");
});

test("set_model's role and thinkingLevel are applied on 19.1 and silently ignored (still success) on 19.0", () => {
  for (const [fx, applied] of [[m191, true], [m190, false]]) {
    const steps = stepsOf(fx, "static");
    const at = steps.findIndex((s) => s.command.type === "set_model" && s.command.role === "smol");
    assert.equal(steps[at].response.success, true);
    const level = stateAfter(steps, at).thinkingLevel;
    if (applied) assert.equal(level, "off");
    else assert.notEqual(level, "off");
  }
  const picks = stepsOf(m191, "static").filter((s) => s.command.type === "get_model_picker" && s.command.query === "@");
  const rows = picks.at(-1).response.data.rows;
  assert.equal(rows.find((r) => r.id === "claude-haiku-5-5").current, true, "the picker marks the row of the role that was picked");
  assert.notEqual(rows.find((r) => r.id === "claude-opus-5-5").current, true);
  assert.match(stepOf(m191, "static", "get_model_picker", { limit: 0 }).response.error, /positive integer/);
});

test("a level the model does not offer is not safe to send: an unknown selector is accepted and corrupts the state", () => {
  const steps = stepsOf(m191, "static");
  const at = steps.findIndex((s) => s.command.type === "set_model" && s.command.thinkingLevel === "turbo");
  assert.equal(steps[at].response.success, true);
  const state = stateAfter(steps, at);
  assert.equal(state.thinkingLevel, undefined);
  assert.equal(state.configuredThinkingLevel, undefined);
  const clamped = stepsOf(m191, "static").find((s) => s.command.thinkingLevel === "xhigh" && s.command.modelId === "claude-haiku-5-5");
  assert.equal(frames(clamped).find((f) => f.type === "thinking_level_changed").thinkingLevel, "medium", "a real level above the model's top is clamped");
  const source = read("../model-switch/switch.ts");
  assert.match(source, /set_thinking_level/, "Cody keeps validating levels itself before it sends them");
});

test("no engine has a helper model command: a stray subagentId switches the chat and the helper keeps its model", () => {
  for (const fx of [m191, m190]) {
    for (const type of ["set_subagent_model", "set_subagent_thinking_level"]) assert.match(stepOf(fx, "static", type).response.error, /^Unknown command/);
  }
  const steps = stepsOf(m191, "helper");
  const helpers = steps.filter((s) => s.command.type === "get_subagents").map((s) => s.response.data.subagents[0]);
  assert.equal(helpers.length >= 3, true);
  const models = new Set(helpers.map((h) => deepFind(h, "resolvedModelIdentity")));
  assert.deepEqual([...models], ["mock/claude-opus-5-5"]);
  const switches = steps.filter((s) => s.command.type === "set_model");
  assert.equal(switches.length, 2);
  assert.ok(switches.every((s) => s.response.success));
  assert.equal(stateAfter(steps, steps.indexOf(switches[1])).model, "mock/claude-haiku-5-5", "the stray subagentId switched the root chat");
});

test("set_model while a reply is streaming is acknowledged at once and the in-flight reply is untouched", () => {
  const steps = stepsOf(m191, "midstream");
  assert.ok(m191.scenarios.midstream.result.ackMs < 2000);
  const at = steps.findIndex((s) => s.command.type === "set_model");
  assert.equal(steps[at].response.success, true);
  assert.ok(frames(steps[at]).some((f) => f.type === "model_changed"));
  const requests = m191.scenarios.midstream.providerRequests;
  assert.deepEqual(requests.filter((r) => r.kind === "main").map((r) => r.model), ["claude-opus-5-5", "claude-opus-5-6"]);
});

test("recorded queue controls: restore empties the queue, plain abort keeps it, deliver moves everything", () => {
  const restore = stepOf(q191, "restore", "abort_and_restore_queue").response.data;
  assert.deepEqual(restore.steering.map((m) => m.text), ["LC-FOLLOW steer-one"]);
  assert.deepEqual(restore.followUp.map((m) => m.text), ["LC-FOLLOW follow-one"]);
  assert.equal(q191.scenarios.restore.result.finalQueued, 0);
  assert.equal(stepOf(q191, "abort", "abort").response.success, true);
  assert.deepEqual(stepOf(q191, "deliver", "abort_and_deliver_queue").response.data, { aborted: true });
  assert.deepEqual(stepOf(q191, "deliverEmpty", "abort_and_deliver_queue").response.data, { aborted: false });
  const queued = frames(stepOf(q191, "deliver", "abort_and_deliver_queue")).filter((f) => f.type === "queue_update");
  assert.ok(queued.some((f) => (f.steering ?? []).length === 2), "the follow-up joins the steering queue");
});

test("recorded resume: nothing to resume on a fresh chat; idle, streaming and queued chats continue", () => {
  const idle = stepsOf(q191, "resumeIdle").filter((s) => s.command.type === "resume");
  assert.deepEqual(idle.map((s) => s.response.success), [false, true]);
  assert.equal(idle[0].response.error, "Nothing to resume");
  assert.equal(stepOf(q191, "resumeQueued", "resume").response.success, true);
  assert.equal(stepOf(q191, "resumeStreaming", "resume").response.success, true);
  assert.ok(frames(stepOf(q191, "resumeStreaming", "resume")).some((f) => f.type === "prompt_result"), "a streaming reply is aborted and re-run");
});

// ---- a real engine -------------------------------------------------------------------------------------------

const bin = ompTestPackageBin();
const version = ompTestPackageSkip() ? null : ompVersionOf(bin);
const realSkip = ompTestPackageSkip() || (version && !versionAtLeast(version, [19, 0, 0]) ? "these proofs cover omp 19.0 and later" : false);
const has191 = Boolean(version) && versionAtLeast(version, [19, 1, 0]);
const unknown = (type) => ({ success: false, error: `Unknown command: ${type}` });

test("a real engine: selectors, picker, set_model fields, role marks and the missing helper commands", { skip: realSkip, timeout: 120_000 }, async () => {
  const lab = await startLab(bin);
  try {
    const fresh = await lab.send({ type: "resume" });
    if (has191) assert.deepEqual([fresh.success, fresh.error], [false, "Nothing to resume"]);
    else assert.equal(fresh.error, unknown("resume").error);
    const deliver = await lab.send({ type: "abort_and_deliver_queue" });
    if (has191) assert.deepEqual(deliver.data, { aborted: false });
    else assert.equal(deliver.error, unknown("abort_and_deliver_queue").error);

    const state = await lab.state();
    assert.equal(state.model.id, "claude-opus-5-5");
    if (has191) {
      assert.equal(typeof state.configuredThinkingLevel, "string");
      assert.deepEqual(state.thinkingLevels.slice(0, 2), ["off", "auto"]);
    } else {
      assert.equal(state.configuredThinkingLevel, undefined);
      assert.equal(state.thinkingLevels, undefined);
    }

    const picker = await lab.send({ type: "get_model_picker" });
    if (has191) {
      assert.equal(picker.data.total, 3);
      assert.deepEqual(picker.data.rows.map((r) => r.id).sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5-6"]);
      assert.equal((await lab.send({ type: "get_model_picker", limit: 0 })).success, false);
    } else {
      assert.equal(picker.error, unknown("get_model_picker").error);
    }

    const roleSwitch = await lab.send({ type: "set_model", provider: "mock", modelId: "claude-haiku-5-5", role: "smol", thinkingLevel: "off" });
    assert.equal(roleSwitch.success, true, "a 19.0 engine accepts the extra fields without using them");
    const afterRole = await lab.state();
    assert.equal(afterRole.model.id, "claude-haiku-5-5");
    if (has191) {
      assert.equal(afterRole.thinkingLevel, "off");
      const quick = await lab.send({ type: "get_model_picker", query: "@" });
      assert.equal(quick.data.rows.find((r) => r.role === "smol").current, true);
    } else {
      assert.notEqual(afterRole.thinkingLevel, "off");
    }

    const mark = lab.frames.length;
    assert.equal((await lab.send({ type: "set_thinking_level", level: "auto" })).success, true);
    const echo = await lab.until((f) => f.type === "thinking_level_changed", { from: mark });
    assert.equal(echo.configured, "auto");
    const auto = await lab.state();
    assert.notEqual(auto.thinkingLevel, "auto");
    if (has191) assert.equal(auto.configuredThinkingLevel, "auto");

    for (const type of ["set_subagent_model", "set_subagent_thinking_level"]) {
      const refused = await lab.send({ type, subagentId: "0-Nobody", provider: "mock", modelId: "claude-opus-5-5", level: "high" });
      assert.equal(refused.error, unknown(type).error);
    }
    assert.equal((await lab.send({ type: "set_model", provider: "mock", modelId: "no-such-model" })).error, "Model not found: mock/no-such-model");
  } finally {
    await lab.stop();
  }
});

test("a real engine: set_model mid-reply is acknowledged at once and the next turn uses the new model", { skip: realSkip, timeout: 120_000 }, async () => {
  const lab = await startLab(bin, { delayMs: 4000 });
  try {
    await lab.promptInFlight("first turn");
    const startedAt = Date.now();
    const switched = await lab.send({ type: "set_model", provider: "mock", modelId: "claude-opus-5-6" });
    assert.equal(switched.success, true);
    assert.ok(Date.now() - startedAt < 2500, "not held until the reply ends");
    lab.mock.setDelay(0);
    await lab.settled();
    assert.equal(lab.frames.some((f) => f.type === "message_end" && f.message?.role === "assistant" && f.message.stopReason === "error"), false);
    const from = lab.frames.length;
    await lab.send({ type: "prompt", message: "second turn" });
    await lab.settled({ from });
    assert.deepEqual(lab.mock.requests.map((r) => r.model), ["claude-opus-5-5", "claude-opus-5-6"]);
  } finally {
    await lab.stop();
  }
});

test("a real engine: abort-and-restore returns the queue; on 19.1 abort-and-deliver runs it and resume continues", { skip: realSkip, timeout: 180_000 }, async () => {
  const lab = await startLab(bin, { delayMs: 4000 });
  const queueTwo = async () => {
    await lab.promptInFlight("main turn");
    await lab.send({ type: "prompt", message: "steer-one", streamingBehavior: "steer" });
    await lab.send({ type: "prompt", message: "follow-one", streamingBehavior: "followUp" });
    const deadline = Date.now() + 10_000;
    while ((await lab.state()).queuedMessageCount < 2) {
      assert.ok(Date.now() < deadline, "both messages queued");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  try {
    await queueTwo();
    const restored = await lab.send({ type: "abort_and_restore_queue" });
    assert.deepEqual(restored.data.steering.map((m) => m.text), ["steer-one"]);
    assert.deepEqual(restored.data.followUp.map((m) => m.text), ["follow-one"]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const idle = await lab.state();
    assert.equal(idle.queuedMessageCount, 0);
    assert.equal(idle.isStreaming, false);
    assert.equal(lab.mock.requests.length, 1, "nothing queued ran");
    if (!has191) return;

    lab.mock.setDelay(4000);
    await queueTwo();
    lab.mock.setDelay(0);
    const delivered = await lab.send({ type: "abort_and_deliver_queue" });
    assert.deepEqual(delivered.data, { aborted: true });
    await lab.settled();
    const texts = lab.mock.requests.map((r) => r.lastUserText);
    assert.ok(texts.some((t) => t.includes("steer-one")) && texts.some((t) => t.includes("follow-one")), "both queued messages ran");

    const before = lab.mock.requests.length;
    const from = lab.frames.length;
    assert.equal((await lab.send({ type: "resume" })).success, true);
    await lab.settled({ from });
    assert.equal(lab.mock.requests.length, before + 1, "resume asked the model to continue");
  } finally {
    await lab.stop();
  }
});
