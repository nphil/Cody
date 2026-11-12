import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SWITCH_WINDOW_MS,
  agentSwitchNotice,
  agentSwitchSettledByLevel,
  agentSwitchSettledByModel,
  readAgentModelSwitch,
} from "./agent-model-switch.ts";

const frame = { type: "cody_agent_model_switch", provider: "anthropic", modelId: "claude-opus-4-8", name: "Claude Opus 4.8", thinkingLevel: "high", modelChanges: true };

test("the announcement frame is read into the switch the page waits for", () => {
  assert.deepEqual(readAgentModelSwitch(frame, "chat-1", 1_000), {
    sessionId: "chat-1",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    thinkingLevel: "high",
    modelChanges: true,
    at: 1_000,
  });
});

test("a frame without a display name is called by provider/id, and one that names no model or arrives with no chat open is ignored", () => {
  assert.equal(readAgentModelSwitch({ ...frame, name: undefined }, "chat-1", 0)?.name, "anthropic/claude-opus-4-8");
  assert.equal(readAgentModelSwitch({ ...frame, name: "  " }, "chat-1", 0)?.name, "anthropic/claude-opus-4-8");
  assert.equal(readAgentModelSwitch({ ...frame, modelId: "" }, "chat-1", 0), null);
  assert.equal(readAgentModelSwitch({ ...frame, provider: undefined }, "chat-1", 0), null);
  assert.equal(readAgentModelSwitch(frame, null, 0), null);
});

test("a reasoning-only announcement says the model stays; an announcement with no level carries none", () => {
  assert.equal(readAgentModelSwitch({ ...frame, modelChanges: false }, "chat-1", 0)?.modelChanges, false);
  assert.equal("thinkingLevel" in readAgentModelSwitch({ ...frame, thinkingLevel: undefined }, "chat-1", 0), false);
});

test("the engine reporting the announced model of the same chat settles the switch, once it is inside the window", () => {
  const pending = readAgentModelSwitch(frame, "chat-1", 10_000);
  const target = { provider: "anthropic", modelId: "claude-opus-4-8" };
  assert.equal(agentSwitchSettledByModel(pending, "chat-1", target, 10_000 + 500), pending);
  assert.equal(agentSwitchSettledByModel(pending, "chat-1", target, 10_000 + AGENT_SWITCH_WINDOW_MS - 1), pending);
  assert.equal(agentSwitchSettledByModel(pending, "chat-1", target, 10_000 + AGENT_SWITCH_WINDOW_MS), null, "an announcement nothing confirmed does not excuse a later fallback");
});

test("a different model, another chat, a reasoning-only switch or nothing pending never settles a model report", () => {
  const pending = readAgentModelSwitch(frame, "chat-1", 0);
  assert.equal(agentSwitchSettledByModel(pending, "chat-1", { provider: "openai", modelId: "gpt-5" }, 1), null, "the engine moved somewhere else: that is a fallback");
  assert.equal(agentSwitchSettledByModel(pending, "chat-2", { provider: "anthropic", modelId: "claude-opus-4-8" }, 1), null);
  assert.equal(agentSwitchSettledByModel(pending, "chat-1", null, 1), null);
  assert.equal(agentSwitchSettledByModel(null, "chat-1", { provider: "anthropic", modelId: "claude-opus-4-8" }, 1), null);
  const levelOnly = readAgentModelSwitch({ ...frame, modelChanges: false }, "chat-1", 0);
  assert.equal(agentSwitchSettledByModel(levelOnly, "chat-1", { provider: "anthropic", modelId: "claude-opus-4-8" }, 1), null);
});

test("a reasoning report settles only a reasoning-only switch of the same chat inside the window", () => {
  const levelOnly = readAgentModelSwitch({ ...frame, modelChanges: false }, "chat-1", 0);
  assert.equal(agentSwitchSettledByLevel(levelOnly, "chat-1", 1), levelOnly);
  assert.equal(agentSwitchSettledByLevel(levelOnly, "chat-2", 1), null);
  assert.equal(agentSwitchSettledByLevel(levelOnly, "chat-1", AGENT_SWITCH_WINDOW_MS), null);
  const withModel = readAgentModelSwitch(frame, "chat-1", 0);
  assert.equal(agentSwitchSettledByLevel(withModel, "chat-1", 1), null, "a model switch is settled by the model report, not by the level echo that comes with it");
  assert.equal(agentSwitchSettledByLevel(null, "chat-1", 1), null);
});

test("the notice names the model, adds the level when one was asked for, and says only the level when the model stayed", () => {
  const model = readAgentModelSwitch({ ...frame, thinkingLevel: undefined }, "chat-1", 0);
  assert.deepEqual(agentSwitchNotice(model, ""), { key: "agentSession.modelSwitchedByAgent", values: { name: "Claude Opus 4.8", level: "" } });
  const withLevel = readAgentModelSwitch(frame, "chat-1", 0);
  assert.deepEqual(agentSwitchNotice(withLevel, "High"), { key: "agentSession.modelSwitchedByAgentWithLevel", values: { name: "Claude Opus 4.8", level: "High" } });
  const levelOnly = readAgentModelSwitch({ ...frame, modelChanges: false }, "chat-1", 0);
  assert.deepEqual(agentSwitchNotice(levelOnly, "High"), { key: "agentSession.thinkingLevelSetByAgent", values: { name: "Claude Opus 4.8", level: "High" } });
});
