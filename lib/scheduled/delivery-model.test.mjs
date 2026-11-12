import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

/**
 * A scheduled message that carries a model, delivered by the real delivery
 * module and the real scheduler to a scripted live chat that records every
 * frame the engine receives, in order: the model switch (and the reasoning
 * level) must reach the engine BEFORE the prompt; a chat already on that model
 * and level gets no switch; a chat that is running a reply is not switched
 * (the message waits); a switch the engine refuses, or a level it refuses,
 * fails the message and no prompt is ever sent; a message with no model never
 * touches the chat's model.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-scheduled-delivery-model-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.TZ = "America/New_York";
// No omp binary: a chat with no live engine could not be started, deterministically and without spawning anything.
process.env.CODY_OMP_BIN = path.join(root, "no-such-omp");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.CODY_HARNESS;
delete process.env.OMP_WEB_HARNESS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deliverScheduledMessage } = await jiti.import("./delivery.ts");
const { findItem, insertItem } = await jiti.import("./store.ts");
const scheduler = await jiti.import("./scheduler.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");

const NOW = Date.now();
const MINUTE = 60_000;

const SONNET = { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" } };
const OPUS_48 = { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh"], defaultLevel: "high" } };
const LOCAL = { provider: "local", id: "qwen3-8b", name: "Qwen3 8B", reasoning: false };
const MODELS = [SONNET, OPUS_48, LOCAL];
const OPUS_CHOICE = { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "high" };

/** A chat that exists on disk (a delivery reads it as an owner/zone lookup, and `openChat` needs a live engine). */
function writeChat(id) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, cwd: "/proj", title: id, created: "2026-01-01", modified: "2026-01-01" })}\n`);
  invalidateSessionListCache();
}

/**
 * A chat with a live engine in the registry. The omp dialect answers get_state / get_available_models, applies
 * set_model the way omp does (the new model's own default level replaces the current one) and set_thinking_level,
 * and answers `prompt` as an idle chat that starts it. `refuse` makes one command type throw (with a code);
 * `log` is every frame received, in order, including the announced switch marker.
 */
function liveChat(id, { running = false, model = SONNET, level = "medium", models = MODELS, refuse = {} } = {}) {
  writeChat(id);
  const log = [];
  let current = model;
  let thinking = level;
  const session = {
    sessionId: id,
    cwd: path.join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => running,
    waitUntilReady: async () => {},
    send: async (command) => {
      log.push(command);
      const failure = refuse[command.type];
      if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
      switch (command.type) {
        case "get_state":
          return { model: { ...current }, thinkingLevel: thinking };
        case "get_available_models":
          return { models };
        case "set_model": {
          const target = models.find((entry) => entry.provider === command.provider && entry.id === command.modelId);
          if (!target) throw Object.assign(new Error("no such model"), { code: "invalid_model" });
          current = target;
          thinking = target.thinking?.defaultLevel ?? "off";
          return { provider: target.provider, id: target.id };
        }
        case "set_thinking_level":
          thinking = command.level;
          return null;
        case "prompt":
          return { delivery: "started", clientMessageId: command.clientMessageId };
        default:
          throw new Error(`unexpected command ${command.type}`);
      }
    },
    announce: (event) => { log.push({ announce: event }); },
    observeEvents: () => () => {},
    onClose: () => () => {},
    destroy: () => {},
    destroyAndWait: async () => {},
    getDeliveryLedger: (ids) => ids.map((clientMessageId) => ({ clientMessageId, status: "started" })),
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return { log, state: () => ({ model: current, level: thinking }) };
}

/** What reached the engine besides reading: the announced marker and each command that changes something or sends, in order. */
const frames = (chat) => chat.log
  .filter((entry) => entry.announce || (entry.type && entry.type !== "get_state" && entry.type !== "get_available_models"))
  .map((entry) => {
    if (entry.announce) return "announce";
    if (entry.type === "set_model") return `set_model:${entry.modelId}`;
    if (entry.type === "set_thinking_level") return `set_thinking_level:${entry.level}`;
    return entry.type;
  });

const item = (sessionId, overrides = {}) => ({
  id: "sch_model",
  sessionId,
  accountKey: "",
  message: "carry on with the migration",
  mode: "at",
  dueAt: NOW,
  source: "agent",
  status: "sending",
  createdAt: NOW - 1000,
  updatedAt: NOW,
  rev: 1,
  deliveryNo: 0,
  attempts: 0,
  ...overrides,
});

const failure = (promise) => promise.then(() => assert.fail("expected the delivery to fail"), (error) => error);

afterEach(() => {
  globalThis.__ompSessions?.clear();
  globalThis.__codyModelSwitchWaiting?.clear();
});

test("a message with another model than the chat's: the engine is switched (model, then level) BEFORE the prompt, and the prompt is delivered", async () => {
  const chat = liveChat("chat-switch", { model: SONNET, level: "medium" });
  const result = await deliverScheduledMessage(item("chat-switch", { model: OPUS_CHOICE }));
  assert.equal(result, "delivered");
  assert.deepEqual(frames(chat), ["announce", "set_model:claude-opus-4-8", "set_thinking_level:high", "prompt"]);
  const prompt = chat.log.find((entry) => entry.type === "prompt");
  assert.equal(prompt.message, "carry on with the migration");
  assert.equal(prompt.streamingBehavior, "followUp");
  assert.equal(prompt.clientMessageId, "sched-sch_model");
  assert.deepEqual(chat.state(), { model: OPUS_48, level: "high" }, "the chat really ends up on the chosen model and level");
  assert.deepEqual(chat.log.find((entry) => entry.announce).announce, {
    type: "cody_agent_model_switch",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    thinkingLevel: "high",
    modelChanges: true,
  });
});

test("a reasoning level alone is applied before the prompt when the chat is already on the model", async () => {
  const chat = liveChat("chat-level-only", { model: OPUS_48, level: "medium" });
  assert.equal(await deliverScheduledMessage(item("chat-level-only", { model: { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "xhigh" } })), "delivered");
  assert.deepEqual(frames(chat), ["announce", "set_thinking_level:xhigh", "prompt"], "no set_model: the model is already right");
});

test("a model with no level of its own is switched to and the engine's default level stands", async () => {
  const chat = liveChat("chat-no-level", { model: SONNET, level: "medium" });
  assert.equal(await deliverScheduledMessage(item("chat-no-level", { model: { provider: "anthropic", modelId: "claude-opus-4-8" } })), "delivered");
  assert.deepEqual(frames(chat), ["announce", "set_model:claude-opus-4-8", "prompt"]);
  assert.equal(chat.state().level, "high", "Opus 4.8's own default");
});

test("a chat already on that model and level gets no switch: just the prompt", async () => {
  const chat = liveChat("chat-same", { model: OPUS_48, level: "high" });
  assert.equal(await deliverScheduledMessage(item("chat-same", { model: OPUS_CHOICE })), "delivered");
  assert.deepEqual(frames(chat), ["prompt"]);

  const noLevel = liveChat("chat-same-nolevel", { model: OPUS_48, level: "low" });
  assert.equal(await deliverScheduledMessage(item("chat-same-nolevel", { model: { provider: "anthropic", modelId: "claude-opus-4-8" } })), "delivered");
  assert.deepEqual(frames(noLevel), ["prompt"], "a message that names no level accepts whatever level the chat is on");
});

test("a chat that is running a reply is not switched out from under it: no switch, no prompt, the delivery says busy", async () => {
  const chat = liveChat("chat-running", { running: true, model: SONNET, level: "medium" });
  const result = await deliverScheduledMessage(item("chat-running", { model: OPUS_CHOICE }));
  assert.equal(result, "busy");
  assert.deepEqual(frames(chat), [], "nothing was announced, switched or sent");
  assert.equal(chat.state().model, SONNET);
  assert.equal(globalThis.__codyModelSwitchWaiting?.size ?? 0, 0, "and no deferred switch was left behind waiting on the chat");
});

test("a running chat that is already on the model and level is simply sent to: the chosen model needs no switch, so nothing waits", async () => {
  const chat = liveChat("chat-running-same", { running: true, model: OPUS_48, level: "high" });
  assert.equal(await deliverScheduledMessage(item("chat-running-same", { model: OPUS_CHOICE })), "delivered");
  assert.deepEqual(frames(chat), ["prompt"]);
});

test("a switch the engine refuses fails the message with that reason and NO prompt is sent", async () => {
  // The model is gone from the chat's catalog.
  const gone = liveChat("chat-gone", { models: [SONNET, LOCAL] });
  const unknown = await failure(deliverScheduledMessage(item("chat-gone", { model: OPUS_CHOICE })));
  assert.equal(unknown.name, "ScheduledDeliveryError");
  assert.equal(unknown.retryable, false, "another try would only repeat it");
  assert.match(unknown.message, /Could not switch this chat to anthropic\/claude-opus-4-8/);
  assert.match(unknown.message, /not among the models this chat can use/);
  assert.match(unknown.message, /The message was not sent\.$/);
  assert.deepEqual(frames(gone), [], "no switch frame and no prompt");

  // The model is listed but the engine refuses it (no credentials).
  const noKey = liveChat("chat-no-credentials", { refuse: { set_model: { code: "no_credentials", message: "No credentials for anthropic." } } });
  const refused = await failure(deliverScheduledMessage(item("chat-no-credentials", { model: OPUS_CHOICE })));
  assert.equal(refused.retryable, false);
  assert.match(refused.message, /No credentials for anthropic\./);
  assert.match(refused.message, /The message was not sent\./);
  assert.ok(!frames(noKey).includes("prompt"), "never goes out on another model");
  assert.equal(noKey.state().model, SONNET, "and the chat stayed where it was");

  // A level the chosen model does not offer is refused before anything is touched.
  const badLevel = liveChat("chat-bad-level");
  const invalid = await failure(deliverScheduledMessage(item("chat-bad-level", { model: { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "ludicrous" } })));
  assert.equal(invalid.retryable, false);
  assert.match(invalid.message, /offers these reasoning levels: .*low, medium, high, xhigh\./);
  assert.deepEqual(frames(badLevel), []);

  // A transient refusal (the engine is restarting) is worth another try.
  const restarting = liveChat("chat-restarting", { refuse: { set_model: { code: "session_restarting", message: "The chat is restarting." } } });
  const again = await failure(deliverScheduledMessage(item("chat-restarting", { model: OPUS_CHOICE })));
  assert.equal(again.retryable, true);
  assert.ok(!frames(restarting).includes("prompt"));
});

test("a model switched but its reasoning level refused: the message is not sent at the wrong level — it fails (a retryable engine error)", async () => {
  const chat = liveChat("chat-level-refused", { refuse: { set_thinking_level: { code: "engine_error", message: "The engine rejected the level." } } });
  const error = await failure(deliverScheduledMessage(item("chat-level-refused", { model: OPUS_CHOICE })));
  assert.equal(error.name, "ScheduledDeliveryError");
  assert.equal(error.retryable, true, "another try can set the level");
  assert.match(error.message, /could not be set: The engine rejected the level\./);
  assert.match(error.message, /The message was not sent\./);
  assert.deepEqual(frames(chat), ["announce", "set_model:claude-opus-4-8", "set_thinking_level:high"], "the switch was attempted, and no prompt followed");
});

test("a message with no model of its own never touches the chat's model: no state read, no switch, just the prompt", async () => {
  const chat = liveChat("chat-plain", { model: SONNET, level: "medium" });
  assert.equal(await deliverScheduledMessage(item("chat-plain")), "delivered");
  assert.deepEqual(chat.log.map((entry) => entry.type), ["prompt"], "not even a catalog read");
  assert.equal(chat.state().model, SONNET);

  const running = liveChat("chat-plain-running", { running: true });
  assert.equal(await deliverScheduledMessage(item("chat-plain-running")), "delivered");
  assert.deepEqual(running.log.map((entry) => entry.type), ["prompt"], "a running chat only queues the follow-up, as it always did");
});

// ---------------------------------------------------------------------------
// Through the real scheduler
// ---------------------------------------------------------------------------

function round() {
  const clock = { now: NOW };
  const notes = [];
  const deps = {
    now: () => clock.now,
    deliver: deliverScheduledMessage,
    checkHandedOver: async () => ({ state: "waiting" }),
    readUsage: async () => { throw new Error("no quota message here"); },
    notify: async (outcome) => { notes.push(outcome.kind); },
  };
  return { clock, notes, run: () => scheduler.runDue(deps) };
}

const schedule = (sessionId, overrides = {}) => insertItem({ sessionId, accountKey: "", message: "check the build", mode: "at", dueAt: NOW - 1000, source: "agent", model: OPUS_CHOICE, ...overrides }, NOW).item;

test("the scheduler: a busy chat leaves the message pending with its note, then the next round switches and sends once the reply is over", async () => {
  const id = "chat-sched-busy";
  let running = true;
  const chat = liveChat(id, { running: true });
  Object.assign(globalThis.__ompSessions.get(id), { isRunning: () => running });
  const created = schedule(id);
  const { clock, notes, run } = round();

  await run();
  const waiting = findItem(created.id, NOW);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.attempts, 0);
  assert.match(waiting.error, /Waiting for this chat's current reply to finish before switching to anthropic\/claude-opus-4-8/);
  assert.deepEqual(frames(chat), []);
  assert.deepEqual(notes, []);

  running = false;
  clock.now += scheduler.HANDED_CHECK_MS;
  await run();
  assert.deepEqual(frames(chat), ["announce", "set_model:claude-opus-4-8", "set_thinking_level:high", "prompt"]);
  assert.equal(findItem(created.id, NOW), null);
  assert.deepEqual(notes, ["sent"]);
});

test("the scheduler: a refused switch ends the message failed with the reason (nothing sent, Retry/Edit possible), and the owner is told", async () => {
  const id = "chat-sched-refused";
  const chat = liveChat(id, { models: [SONNET, LOCAL] });
  const created = schedule(id);
  const { notes, run } = round();
  await run();
  const failed = findItem(created.id, NOW);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Could not switch this chat to anthropic\/claude-opus-4-8/);
  assert.deepEqual(failed.model, OPUS_CHOICE, "the choice is kept so Edit can change it");
  assert.deepEqual(frames(chat), []);
  assert.deepEqual(notes, ["failed"]);
});
