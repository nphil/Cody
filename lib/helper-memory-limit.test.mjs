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

test("a token override is the count, never above the window, and reports its share", () => {
  const config = { task: { agentCompactionThresholdOverrides: { scout: 90_000, sonic: 5_000_000 } } };
  assert.deepEqual(limit.effectiveHelperLimit(config, "scout", M), { tokens: 90_000, percent: 9 });
  assert.deepEqual(limit.effectiveHelperLimit(config, "sonic", 200_000), { tokens: 199_999, percent: 100 });
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
