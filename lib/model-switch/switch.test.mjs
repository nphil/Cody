import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

/**
 * Moving a chat onto another model, and the `switch_model` tool over it, against
 * scripted engine sessions that record every command and frame they receive:
 * WHEN a switch reaches the engine (idle, the chat's own agent mid tool call,
 * another chat mid-turn, an engine with only turn boundaries), in which ORDER
 * (model before level — omp resets the level on a model change), what is
 * refused before anything is sent, and that `scope: everywhere` rewrites only
 * `modelRoles.default` and hands back what it replaced.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-model-switch-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
// No omp binary: a chat with no live engine could not be started, deterministically and without spawning anything.
process.env.CODY_OMP_BIN = path.join(root, "no-such-omp");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.CODY_HARNESS;
delete process.env.OMP_WEB_HARNESS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { setEverywhereDefault, switchChatModel } = await jiti.import("./switch.ts");
const { MODEL_SWITCH_TOOLS, MODEL_SWITCH_TOOL_NAMES } = await jiti.import("./tool.ts");
const { readModelRoles } = await jiti.import("../omp/model-roles.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const CONFIG = path.join(AGENT_DIR, "config.yml");

function writeChat(id, title) {
  const dir = path.join(AGENT_DIR, "sessions", "-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, cwd: "/proj", title, created: "2026-01-01", modified: "2026-01-01" })}\n`);
}
writeChat("own", "Current work");
writeChat("other-chat", "Refactor billing");
invalidateSessionListCache();

const SONNET = { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" } };
const OPUS_48 = { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh"], defaultLevel: "high" } };
const OPUS_47 = { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true, thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" } };
const LOCAL = { provider: "local", id: "qwen3-8b", name: "Qwen3 8B", reasoning: false };
const MODELS = [SONNET, OPUS_48, OPUS_47, LOCAL];

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A chat with a live engine, registered where the server looks chats up. The
 * omp dialect answers get_state / get_available_models and applies set_model
 * the way omp does (the new model's own default level replaces the current one);
 * the acp dialect lists its models inside get_state and says they may be switched.
 * `refuse` makes one command type throw; `stuck` makes set_model accept and change nothing.
 */
function liveChat(id, { running = false, dialect = "omp", model = SONNET, level = "medium", models = MODELS, refuse = {}, stuck = false } = {}) {
  const log = [];
  const observers = new Set();
  const closers = new Set();
  let current = model;
  let thinking = level;
  const session = {
    sessionId: id,
    isAlive: () => true,
    isRunning: () => running,
    waitUntilReady: async () => {},
    send: async (command) => {
      log.push(command);
      const failure = refuse[command.type];
      if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
      switch (command.type) {
        case "get_state":
          return dialect === "acp"
            ? { model: { provider: current.provider, id: current.id, name: current.name }, modelSelectable: true, availableModels: models.map(({ provider, id, name }) => ({ provider, id, name })) }
            : { model: { ...current }, thinkingLevel: thinking };
        case "get_available_models":
          return { models };
        case "set_model": {
          const target = models.find((entry) => entry.provider === command.provider && entry.id === command.modelId);
          if (!target) throw Object.assign(new Error("no such model"), { code: "invalid_model" });
          if (!stuck) {
            current = target;
            thinking = target.thinking?.defaultLevel ?? "off";
          }
          return { provider: target.provider, id: target.id };
        }
        case "set_thinking_level":
          thinking = command.level;
          return null;
        default:
          throw new Error(`unexpected command ${command.type}`);
      }
    },
    announce: (event) => { log.push({ announce: event }); },
    observeEvents: (observer) => { observers.add(observer); return () => observers.delete(observer); },
    onClose: (listener) => { closers.add(listener); return () => closers.delete(listener); },
    destroy: () => { log.push({ destroyed: true }); },
    destroyAndWait: async () => { log.push({ destroyed: true }); },
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return {
    log,
    emit: (event) => { for (const observer of [...observers]) observer(event); },
    close: () => { for (const listener of [...closers]) listener(); },
    watching: () => observers.size,
  };
}

/** What reached the engine besides reading: the announced frame and each command that changes something, in order. */
const writes = (chat) => chat.log
  .filter((entry) => entry.announce || (entry.type && entry.type !== "get_state" && entry.type !== "get_available_models"))
  .map((entry) => (entry.announce ? "announce" : entry.type));
const sentModels = (chat) => chat.log.filter((entry) => entry.type === "set_model").map((entry) => entry.modelId);

afterEach(() => {
  globalThis.__ompSessions?.clear();
  globalThis.__codyModelSwitchWaiting?.clear();
  fs.rmSync(CONFIG, { force: true });
});

test("an idle chat is switched at once: the page is told first, then the model, then the level — so the level survives the model's own default", async () => {
  const chat = liveChat("idle", { model: SONNET, level: "medium" });
  const result = await switchChatModel("idle", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low" });
  assert.equal(result.status, "applied");
  assert.equal(result.applies, "next-turn");
  assert.deepEqual(writes(chat), ["announce", "set_model", "set_thinking_level"]);
  assert.deepEqual(chat.log.find((entry) => entry.announce).announce, {
    type: "cody_agent_model_switch",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    thinkingLevel: "low",
    modelChanges: true,
  });
  assert.equal(result.previous.modelId, "claude-sonnet-4-6");
  assert.equal(result.current.modelId, "claude-opus-4-8");
  assert.equal(result.current.thinkingLevel, "low", "Opus 4.8 starts on high; sent before the model, low would have been overwritten");
});

test("the chat's own agent, inside a tool call, is switched at once and the next request of the turn uses it", async () => {
  const chat = liveChat("own-turn", { running: true });
  const result = await switchChatModel("own-turn", { provider: "anthropic", modelId: "claude-opus-4-8" }, { atStepBoundary: true });
  assert.equal(result.status, "applied");
  assert.equal(result.applies, "next-step");
  assert.deepEqual(writes(chat), ["announce", "set_model"], "no level asked for: the engine's own choice stands");
  assert.equal(result.current.thinkingLevel, "high", "what the engine reports, not what was assumed");
});

test("another chat that is mid-turn gets the switch at its next step boundary — not at a streamed chunk, not at a user message", async () => {
  const chat = liveChat("busy", { running: true });
  const result = await switchChatModel("busy", { provider: "anthropic", modelId: "claude-opus-4-8" });
  assert.equal(result.status, "deferred");
  assert.equal(result.applies, "next-step");
  assert.deepEqual(result.current, result.previous, "still on the old model");
  assert.deepEqual(writes(chat), [], "nothing is sent while a provider stream may be open");

  chat.emit({ type: "message_update", message: { role: "assistant" } });
  chat.emit({ type: "message_end", message: { role: "user" } });
  await flush();
  assert.deepEqual(writes(chat), []);

  chat.emit({ type: "message_end", message: { role: "assistant" } });
  await flush();
  assert.deepEqual(writes(chat), ["announce", "set_model"]);
  assert.equal(chat.watching(), 0, "the wait is over");
  chat.emit({ type: "turn_end" });
  await flush();
  assert.deepEqual(sentModels(chat), ["claude-opus-4-8"], "applied once, however many boundaries follow");
});

test("a newer switch for the same chat replaces one still waiting, and a chat that closes drops it", async () => {
  const chat = liveChat("busy", { running: true });
  await switchChatModel("busy", { provider: "anthropic", modelId: "claude-opus-4-8" });
  await switchChatModel("busy", { provider: "anthropic", modelId: "claude-opus-4-7" });
  assert.equal(chat.watching(), 1, "one wait per chat");
  chat.emit({ type: "tool_execution_start" });
  await flush();
  assert.deepEqual(sentModels(chat), ["claude-opus-4-7"]);

  const closing = liveChat("closing", { running: true });
  await switchChatModel("closing", { provider: "anthropic", modelId: "claude-opus-4-8" });
  closing.close();
  closing.emit({ type: "turn_end" });
  await flush();
  assert.deepEqual(writes(closing), [], "a closed chat is left alone");
  assert.equal(closing.watching(), 0);
});

test("a deferred switch the engine then refuses is announced on the chat's own stream, because its caller has already been answered", async () => {
  const chat = liveChat("late-refusal", { running: true, refuse: { set_model: { code: "local_routing_forbidden", message: "This chat may only use local models." } } });
  const result = await switchChatModel("late-refusal", { provider: "anthropic", modelId: "claude-opus-4-8" });
  assert.equal(result.status, "deferred");
  chat.emit({ type: "turn_end" });
  await flush();
  const notice = chat.log.map((entry) => entry.announce).find((frame) => frame?.type === "notice");
  assert.ok(notice, "a notice reached the page");
  assert.equal(notice.level, "info");
  assert.match(notice.message, /anthropic\/claude-opus-4-8 that was waiting for this chat's next step could not be applied: This chat may only use local models\./);
});

test("an engine with only turn boundaries waits for the turn to end, and cannot set reasoning", async () => {
  const chat = liveChat("acp", { dialect: "acp", running: true });
  const refused = await switchChatModel("acp", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "high" });
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "unsupported");

  const result = await switchChatModel("acp", { provider: "anthropic", modelId: "claude-opus-4-8" });
  assert.equal(result.status, "deferred");
  assert.equal(result.applies, "next-turn");
  chat.emit({ type: "message_end", message: { role: "assistant" } });
  chat.emit({ type: "tool_execution_start" });
  await flush();
  assert.deepEqual(writes(chat), [], "an ACP message_end is a streamed chunk, not a finished message");
  chat.emit({ type: "turn_end" });
  await flush();
  assert.deepEqual(writes(chat), ["announce", "set_model"]);
});

test("asking for what the chat already has changes nothing; a level alone is applied at once even mid-turn, with no model command", async () => {
  const same = liveChat("same", { model: OPUS_48, level: "high" });
  const unchanged = await switchChatModel("same", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "HIGH" });
  assert.equal(unchanged.status, "unchanged");
  assert.deepEqual(writes(same), []);

  const busy = liveChat("level-only", { model: OPUS_48, level: "high", running: true });
  const result = await switchChatModel("level-only", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "extra high" });
  assert.equal(result.status, "applied");
  assert.equal(result.applies, "next-step");
  assert.deepEqual(writes(busy), ["announce", "set_thinking_level"]);
  assert.equal(busy.log.find((entry) => entry.type === "set_thinking_level").level, "xhigh", "the engine's own word for it");
  assert.equal(busy.log.find((entry) => entry.announce).announce.modelChanges, false);
});

test("a model the chat cannot use and a level the model lacks are refused before anything is sent", async () => {
  const chat = liveChat("strict");
  const unknown = await switchChatModel("strict", { provider: "anthropic", modelId: "claude-opus-9" });
  assert.equal(unknown.status, "refused");
  assert.equal(unknown.code, "unknown_model");

  const tooHigh = await switchChatModel("strict", { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "xhigh" });
  assert.equal(tooHigh.code, "invalid_level");
  assert.match(tooHigh.message, /anthropic\/claude-sonnet-4-6 offers these reasoning levels: auto, off, low, medium, high\./);

  const local = await switchChatModel("strict", { provider: "local", modelId: "qwen3-8b", thinkingLevel: "high" });
  assert.equal(local.code, "invalid_level");
  assert.match(local.message, /levels: off\./, "a model without reasoning takes only off");
  assert.deepEqual(writes(chat), []);
});

test("what the engine refuses is refused with its own code and the level is not sent after it; a level that fails after the model moved is reported as applied with the failure; a switch the engine ignores is not_applied", async () => {
  const refusing = liveChat("refusing", { refuse: { set_model: { code: "local_routing_forbidden", message: "This chat may only use local models." } } });
  const refused = await switchChatModel("refusing", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low" });
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "local_routing_forbidden");
  assert.ok(!refusing.log.some((entry) => entry.type === "set_thinking_level"));

  liveChat("halfway", { refuse: { set_thinking_level: { code: "engine_error", message: "engine says no" } } });
  const partly = await switchChatModel("halfway", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low" });
  assert.equal(partly.status, "applied");
  assert.equal(partly.code, "reasoning_failed");
  assert.match(partly.message, /engine says no/);
  assert.equal(partly.current.modelId, "claude-opus-4-8");

  liveChat("stuck", { stuck: true });
  const ignored = await switchChatModel("stuck", { provider: "anthropic", modelId: "claude-opus-4-8" });
  assert.equal(ignored.status, "refused");
  assert.equal(ignored.code, "not_applied");
  assert.match(ignored.message, /still on anthropic\/claude-sonnet-4-6/);
});

test("scope everywhere writes only modelRoles.default, returns what it replaced, and restarts only the idle engines", async () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, [
    "theme: dark",
    "disabledProviders:",
    "  - groq",
    "modelRoles:",
    "  default: anthropic/claude-sonnet-4-6:medium",
    "  smol: openai/gpt-5.5-mini",
    "  slow: anthropic/claude-opus-4-8:high",
    "",
  ].join("\n"));
  const idle = liveChat("idle-chat");
  const busy = liveChat("busy-chat", { running: true });

  const result = await setEverywhereDefault({ provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low" });
  assert.deepEqual(result, { previousDefault: "anthropic/claude-sonnet-4-6:medium", newDefault: "anthropic/claude-opus-4-8:low", restarted: 1, active: 1 });
  assert.deepEqual(readModelRoles().roles, { default: "anthropic/claude-opus-4-8:low", smol: "openai/gpt-5.5-mini", slow: "anthropic/claude-opus-4-8:high" }, "the other roles are untouched");
  const file = fs.readFileSync(CONFIG, "utf8");
  assert.match(file, /theme: dark/);
  assert.match(file, /groq/, "settings outside modelRoles survive");
  assert.equal(idle.log.filter((entry) => entry.destroyed).length, 1, "the idle engine restarts to read it");
  assert.equal(busy.log.filter((entry) => entry.destroyed).length, 0, "a running one is never cut off");

  const undone = await setEverywhereDefault({ provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" });
  assert.equal(undone.previousDefault, "anthropic/claude-opus-4-8:low");
  assert.equal(readModelRoles().roles.default, "anthropic/claude-sonnet-4-6:medium", "what it returned is exactly what undoes it");
});

test("scope everywhere with no default set before reports that, and writes no level when none was given", async () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, "theme: dark\n");
  const result = await setEverywhereDefault({ provider: "anthropic", modelId: "claude-opus-4-8" });
  assert.equal(result.previousDefault, null);
  assert.equal(result.newDefault, "anthropic/claude-opus-4-8");
  assert.deepEqual(readModelRoles().roles, { default: "anthropic/claude-opus-4-8" });
  assert.match(fs.readFileSync(CONFIG, "utf8"), /theme: dark/);
});

const tool = MODEL_SWITCH_TOOLS[0];
const ctx = { user: null, defaultSessionId: "own", restrictToUnowned: false };
const call = (args, context = ctx) => tool.handler(args, context);

test("the agent gets one tool, scoped to this chat by default and pointing at schedule_message for a later switch", () => {
  assert.deepEqual(MODEL_SWITCH_TOOL_NAMES, ["switch_model"]);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["model", "reasoning", "scope", "session"]);
  assert.equal(tool.parameters.required, undefined, "calling with nothing lists what is available");
  assert.deepEqual(tool.parameters.properties.scope.enum, ["chat", "everywhere"]);
  assert.match(tool.description, /By default this changes ONLY this chat/);
  assert.match(tool.description, /schedule_message/);
  assert.equal(typeof tool.handler, "function");
});

test("'switch to Opus 4.8 with high reasoning' moves the calling chat and says what, from when, and what it was", async () => {
  const chat = liveChat("own", { running: true });
  const text = await call({ model: "opus 4.8", reasoning: "high" });
  assert.match(text, /^This chat is now on anthropic\/claude-opus-4-8 \(Claude Opus 4\.8\), reasoning high\. It applies from your next step in this turn: your next request already uses it\. It was on anthropic\/claude-sonnet-4-6 \(Claude Sonnet 4\.6\), reasoning medium\.$/, text);
  assert.deepEqual(sentModels(chat), ["claude-opus-4-8"]);
});

test("a name that fits several models answers with all of them and changes nothing; an unknown one with the closest names", async () => {
  const chat = liveChat("own", { running: true });
  const ambiguous = await call({ model: "opus" });
  assert.match(ambiguous, /^"opus" fits 2 models, so nothing was changed\./);
  assert.match(ambiguous, /anthropic\/claude-opus-4-8 \(Claude Opus 4\.8\)/);
  assert.match(ambiguous, /anthropic\/claude-opus-4-7 \(Claude Opus 4\.7\)/);

  const typo = await call({ model: "opuss 4.8" });
  assert.match(typo, /^No model matches "opuss 4\.8", so nothing was changed\./);
  assert.match(typo, /The closest are:\nanthropic\/claude-opus-4-8/);

  const levelInName = await call({ model: "gpt 5 high" });
  assert.match(levelInName, /If "high" was meant as the reasoning level, pass it as `reasoning`/);
  assert.deepEqual(writes(chat), [], "none of these touched the chat");
});

test("a reasoning level the model lacks is refused with the ones it has", async () => {
  const chat = liveChat("own", { running: true });
  const text = await call({ model: "sonnet", reasoning: "xhigh" });
  assert.equal(text, "\"xhigh\" is not a reasoning level of anthropic/claude-sonnet-4-6, so nothing was changed. It offers: auto, off, low, medium, high.");
  assert.deepEqual(writes(chat), []);
});

test("called with nothing, it reports the chat's model, its levels and what can be switched to", async () => {
  liveChat("own", { running: true });
  const text = await call({});
  assert.match(text, /^This chat is on anthropic\/claude-sonnet-4-6 \(Claude Sonnet 4\.6\), reasoning medium\./);
  assert.match(text, /Reasoning levels it offers: auto, off, low, medium, high\./);
  assert.match(text, /4 models can be switched to — anthropic \(3\), local \(1\)\./);
});

test("another chat is addressed by title, and one that is mid-turn is told the switch is queued, not done", async () => {
  const other = liveChat("other-chat", { running: true });
  liveChat("own", { running: true });
  const text = await call({ session: "billing", model: "opus 4.8" });
  assert.match(text, /^Chat other-chat is mid-turn, so the switch is queued: it moves to anthropic\/claude-opus-4-8 \(Claude Opus 4\.8\) at its next step boundary, normally within seconds\./, text);
  assert.match(text, /Nothing has changed yet; it is still on anthropic\/claude-sonnet-4-6/);
  assert.deepEqual(writes(other), []);
});

test("scope everywhere changes the default and not the chat, and tells how to undo it with this tool's own arguments", async () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, "modelRoles:\n  default: anthropic/claude-sonnet-4-6:medium\n  smol: openai/gpt-5.5-mini\n");
  const own = liveChat("own", { running: true });
  const text = await call({ scope: "everywhere", model: "opus 4.8", reasoning: "high" });
  assert.match(text, /^The default model for new chats and helper agents is now anthropic\/claude-opus-4-8:high \(Claude Opus 4\.8\)\. It was anthropic\/claude-sonnet-4-6:medium\./, text);
  assert.match(text, /Chats that are already open keep the model they are on/);
  assert.match(text, /1 running one picks it up the next time it restarts\./);
  assert.match(text, /To undo: call switch_model with scope "everywhere", model "anthropic\/claude-sonnet-4-6" and reasoning "medium"\./);
  assert.deepEqual(readModelRoles().roles, { default: "anthropic/claude-opus-4-8:high", smol: "openai/gpt-5.5-mini" });
  assert.deepEqual(writes(own), [], "the calling chat is not switched by an everywhere call");
});

test("scope everywhere is refused for a chat, without a model, on an engine without default-model settings, and with a bad scope — and changes nothing", async () => {
  liveChat("own", { running: true });
  assert.match(await call({ scope: "everywhere", model: "opus 4.8", session: "billing" }), /cannot be combined with `session`/);
  assert.match(await call({ scope: "everywhere" }), /needs `model`/);
  assert.match(await call({ scope: "global", model: "opus 4.8" }), /^scope must be "chat"/);
  const before = process.env.CODY_HARNESS;
  process.env.CODY_HARNESS = "claude";
  try {
    assert.match(await call({ scope: "everywhere", model: "opus 4.8" }), /not available for this engine: only omp has default-model settings/);
  } finally {
    if (before === undefined) delete process.env.CODY_HARNESS;
    else process.env.CODY_HARNESS = before;
  }
  assert.equal(fs.existsSync(CONFIG), false, "nothing was written");
});
