import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const limit = await jiti.import("./helper-memory-limit.ts");
const format = await jiti.import("./subagent-format.ts");

const M = 1_000_000;

test("a percent override is that share of the model's window", () => {
  const config = { task: { agentCompactionThresholdOverrides: { task: "20%" } } };
  assert.deepEqual(limit.effectiveHelperLimit(config, "task", M), { tokens: 200_000, percent: 20 });
});

test("a token override is the count, at or past the window the window less omp's reserve, and reports its share", () => {
  const config = { task: { agentCompactionThresholdOverrides: { scout: 90_000, sonic: 5_000_000 } } };
  assert.deepEqual(limit.effectiveHelperLimit(config, "scout", M), { tokens: 90_000, percent: 9 });
  // 200k window: the reserve is 15% (30k), more than the 16384 default.
  assert.deepEqual(limit.effectiveHelperLimit(config, "sonic", 200_000), { tokens: 170_000, percent: 85 });
});

test("a token limit at the window or past it is the window less the larger of 15% and compaction.reserveTokens", () => {
  const root = (thresholdTokens, reserveTokens) => ({ compaction: { thresholdTokens, ...(reserveTokens === undefined ? {} : { reserveTokens }) } });
  const tokens = (config, window) => limit.effectiveHelperLimit(config, "scout", window)?.tokens;
  assert.equal(tokens(root(500_000), 400_000), 340_000);
  assert.equal(tokens(root(400_000), 400_000), 340_000, "exactly the window counts as past it");
  assert.equal(tokens(root(399_999), 400_000), 399_999, "below the window it is exact");
  assert.equal(tokens(root(500_000, 100_000), 400_000), 300_000, "an explicit reserve above the 15% wins");
  assert.equal(tokens(root(500_000, 900_000), 400_000), 340_000, "a reserve as big as the window is replaced by the 15%");
  assert.equal(tokens(root(20_000), 16_000), 13_600, "the default 16384 reserve cannot fit a 16k window: the 15% is used");
});

test("a share is clamped to 1-99% and floored, as omp does", () => {
  const override = (value) => ({ task: { agentCompactionThresholdOverrides: { task: value } } });
  assert.deepEqual(limit.effectiveHelperLimit(override("100%"), "task", M), { tokens: 990_000, percent: 99 });
  assert.deepEqual(limit.effectiveHelperLimit(override("0.5%"), "task", M), { tokens: 10_000, percent: 1 });
  assert.equal(limit.effectiveHelperLimit({ compaction: { thresholdPercent: 33.3 } }, "task", 1001)?.tokens, 333);
});

test("a compaction.modelThresholds entry applies below an agent's own override and above the root, the longest prefix winning", () => {
  const config = { compaction: { thresholdPercent: 70, modelThresholds: { "anthropic/claude-opus*": "f400000", "anthropic/*": "50%", "openai/gpt-5": 300_000 } } };
  const on = (provider, id, agentConfig = config) => limit.effectiveHelperLimit(agentConfig, "scout", M, { provider, id });
  assert.deepEqual(on("anthropic", "claude-opus-4"), { tokens: 400_000, percent: 40 }, "\"f400000\" is an exact trigger");
  assert.deepEqual(on("anthropic", "claude-sonnet-4"), { tokens: 500_000, percent: 50 });
  assert.deepEqual(on("openai", "gpt-5"), { tokens: 210_000, percent: 21 }, "a plain token count is a base the root 70% is applied to");
  assert.deepEqual(on("google", "gemini"), { tokens: 700_000, percent: 70 }, "no entry: the root");
  assert.deepEqual(limit.effectiveHelperLimit(config, "scout", M), { tokens: 700_000, percent: 70 }, "no model: the root");
  const own = { ...config, task: { agentCompactionThresholdOverrides: { scout: "20%" } } };
  assert.deepEqual(on("anthropic", "claude-opus-4", own), { tokens: 200_000, percent: 20 }, "the agent's override outranks the model entry");
});

test("a plain token entry with no root percentage is that base less its reserve, and replaces the root token limit for its model", () => {
  const config = { compaction: { thresholdTokens: 150_000, modelThresholds: { "openai/gpt-5": 400_000 } } };
  assert.deepEqual(limit.effectiveHelperLimit(config, "scout", M, { provider: "openai", id: "gpt-5" }), { tokens: 340_000, percent: 34 });
  assert.deepEqual(limit.effectiveHelperLimit(config, "scout", M, { provider: "openai", id: "gpt-4" }), { tokens: 150_000, percent: 15 });
  const beyond = { compaction: { modelThresholds: { "openai/gpt-5": 2_000_000 } } };
  assert.deepEqual(limit.effectiveHelperLimit(beyond, "scout", 200_000, { provider: "openai", id: "gpt-5" }), { tokens: 170_000, percent: 85 }, "a base past the window is the window");
});

test("model entries are off when compaction.modelThresholdsEnabled is false; cleared and invalid entries do not count", () => {
  const compaction = { thresholdPercent: 70, modelThresholds: { "anthropic/claude-opus-4": null, "anthropic/*": "f250000", "anthropic/claude-opus*": "oops" } };
  const model = { provider: "anthropic", id: "claude-opus-4" };
  assert.equal(limit.effectiveHelperLimit({ compaction }, "scout", M, model)?.tokens, 250_000);
  assert.equal(limit.effectiveHelperLimit({ compaction: { ...compaction, modelThresholdsEnabled: false } }, "scout", M, model)?.tokens, 700_000);
});

test("no override and no root setting is no limit", () => {
  assert.equal(limit.effectiveHelperLimit({ task: { agentCompactionThresholdOverrides: { scout: "20%" } } }, "task", M), null);
  assert.equal(limit.effectiveHelperLimit({}, "task", M), null);
  assert.equal(limit.effectiveHelperLimit(null, "task", M), null);
});

test("root tokens beat root percent, an agent's own override beats both", () => {
  const both = { compaction: { thresholdTokens: 150_000, thresholdPercent: 70 }, task: { agentCompactionThresholdOverrides: { task: "20%" } } };
  assert.deepEqual(limit.effectiveHelperLimit(both, "scout", M), { tokens: 150_000, percent: 15 });
  assert.deepEqual(limit.effectiveHelperLimit(both, "task", M), { tokens: 200_000, percent: 20 });
  assert.deepEqual(limit.effectiveHelperLimit({ compaction: { thresholdPercent: 70 } }, "scout", M), { tokens: 700_000, percent: 70 });
});

test("entries omp would reject are not limits", () => {
  const bad = { task: { agentCompactionThresholdOverrides: { task: "0%", scout: "101%", sonic: 1.5, luna: "oops", reviewer: null } } };
  for (const agent of ["task", "scout", "sonic", "luna", "reviewer"]) assert.equal(limit.effectiveHelperLimit(bad, agent, M), null);
  assert.equal(limit.effectiveHelperLimit({ compaction: { thresholdPercent: 0 } }, "task", M), null);
});

test("an unknown window is no limit", () => {
  const config = { task: { agentCompactionThresholdOverrides: { task: "20%", scout: 90_000 } } };
  for (const window of [undefined, null, 0, 1, Number.NaN]) {
    assert.equal(limit.effectiveHelperLimit(config, "task", window), null);
    assert.equal(limit.effectiveHelperLimit(config, "scout", window), null);
  }
});

test("the chip gauge shows the cap and its explanation, or the full window when there is none", () => {
  const config = { task: { agentCompactionThresholdOverrides: { task: "20%" } } };
  const progress = { contextTokens: 95_000, contextWindow: M };
  assert.deepEqual(format.subagentContextGauge(progress, "task", config), { used: "95k", total: "200k", limit: { percent: 20, window: "1000k" } });
  assert.deepEqual(format.subagentContextGauge(progress, "Task", config), { used: "95k", total: "200k", limit: { percent: 20, window: "1000k" } });
  assert.deepEqual(format.subagentContextGauge(progress, "scout", config), { used: "95k", total: "1000k", limit: null });
  assert.deepEqual(format.subagentContextGauge(progress, "task", null), { used: "95k", total: "1000k", limit: null });
  assert.deepEqual(format.subagentContextGauge({ contextTokens: 95_000 }, "task", config), { used: "95k", total: "?", limit: null });
  assert.equal(format.subagentContextGauge({ contextWindow: M }, "task", config), null);
});
