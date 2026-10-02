import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const {
  parseSubagentProgress,
  parseSubagentSnapshot,
  activityFromProgressChange,
  subagentActivityIntent,
  isUnsupportedCommandError,
} = await jiti.import("./subagent-types.ts");

test("parseSubagentProgress copies telemetry and retry state defensively", () => {
  const progress = parseSubagentProgress({
    index: 1,
    id: "Scout",
    agent: "scout",
    agentSource: "bundled",
    status: "running",
    currentTool: "read",
    lastIntent: "Inspect foo.ts",
    tokens: 1234,
    cost: 0.004,
    contextTokens: 8000,
    contextWindow: 32000,
    resolvedModel: "provider/gpt-x:high",
    resolvedModelIsFallback: true,
    retryState: { attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429", startedAtMs: 1 },
  });
  assert.equal(progress?.currentTool, "read");
  assert.equal(progress?.lastIntent, "Inspect foo.ts");
  assert.equal(progress?.tokens, 1234);
  assert.equal(progress?.cost, 0.004);
  assert.equal(progress?.contextWindow, 32000);
  assert.equal(progress?.retryState?.attempt, 2);
  assert.equal(progress?.resolvedModelIsFallback, true);
  assert.equal(progress?.resolvedModel, "provider/gpt-x");
  assert.equal(progress?.thinkingLevel, "high");
  assert.equal(parseSubagentProgress({ resolvedModel: "openrouter/model:free" })?.resolvedModel, "openrouter/model:free");
  // Garbage fields are ignored, not fatal.
  assert.equal(parseSubagentProgress({ id: "x", tokens: "nope" })?.tokens, undefined);
  assert.equal(parseSubagentProgress(null), undefined);
  assert.equal(parseSubagentProgress({}), undefined);
});

test("parseSubagentSnapshot maps registry statuses and carries progress", () => {
  const snapshot = parseSubagentSnapshot({
    id: "Scout",
    index: 0,
    agent: "scout",
    agentSource: "user",
    status: "running",
    task: "Map",
    sessionFile: "C:\\work\\artifacts\\Scout.jsonl",
    lastUpdate: 123,
    progress: { id: "Scout", status: "running", tokens: 10 },
  });
  assert.equal(snapshot?.id, "Scout");
  assert.equal(snapshot?.status, "started");
  assert.equal(snapshot?.agentSource, "user");
  assert.equal(snapshot?.progress?.tokens, 10);
  assert.equal(snapshot?.sessionFile, "C:\\work\\artifacts\\Scout.jsonl");
  assert.equal(snapshot?.lastUpdate, 123);
  // Terminal registry statuses pass through.
  assert.equal(parseSubagentSnapshot({ id: "a", agent: "b", status: "completed" })?.status, "completed");
  assert.equal(parseSubagentSnapshot({ id: "a" }), undefined);
});

test("a child's progress change becomes activity: new tool, model switch, fallback, reasoning", () => {
  const running = { id: "s", currentTool: "read", currentToolStartMs: 1, lastIntent: "Inspect foo.ts", resolvedModel: "openai/large", thinkingLevel: "high" };

  // A child seen for the first time reports the tool it is in, nothing else.
  const first = activityFromProgressChange(undefined, running, 5);
  assert.deepEqual(first.map((entry) => entry.kind), ["tool"]);
  assert.match(first[0].label, /read: Inspect foo\.ts/);

  // The same tool call in the next frame is not a new activity.
  assert.deepEqual(activityFromProgressChange(running, { ...running }, 6), []);
  // The same tool name started again is.
  assert.equal(activityFromProgressChange(running, { ...running, currentToolStartMs: 2 }, 6).length, 1);

  // A switch onto a model marked as a fallback reads as a fallback, from → to.
  const fallback = activityFromProgressChange(running, { ...running, resolvedModel: "openai/small", resolvedModelIsFallback: true }, 7);
  const applied = fallback.find((entry) => entry.kind === "retry_fallback_applied");
  assert.equal(applied?.from, "openai/large");
  assert.equal(applied?.to, "openai/small");
  // A plain switch (a prewalk handoff) is a model change, not a fallback.
  const handoff = activityFromProgressChange(running, { ...running, resolvedModel: "openai/small" }, 7);
  assert.deepEqual(handoff.filter((entry) => entry.kind !== "tool").map((entry) => [entry.kind, entry.to]), [["model_changed", "openai/small"]]);

  const reasoning = activityFromProgressChange(running, { ...running, thinkingLevel: "low" }, 8);
  assert.deepEqual(reasoning.map((entry) => [entry.kind, entry.thinkingLevel]), [["thinking_level_changed", "low"]]);
});

test("omp 18.4 per-call intent is parsed, preferred over the stale last intent, and malformed entries are dropped", () => {
  const progress = parseSubagentProgress({
    id: "s",
    currentTool: "grep",
    currentToolArgs: "TODO",
    currentToolArgsKey: "pattern",
    currentToolIntent: "  Find leftovers  ",
    lastIntent: "Inspect foo.ts",
    recentTools: [
      { tool: "read", args: "a.ts", endMs: 5, intent: "Read a", argsKey: "path", isError: true },
      { tool: "edit", args: 7 },
      { args: "no tool" },
      "junk",
    ],
  });
  assert.equal(progress?.currentToolIntent, "Find leftovers");
  assert.equal(progress?.currentToolArgsKey, "pattern");
  assert.deepEqual(progress?.recentTools, [
    { tool: "read", args: "a.ts", endMs: 5, intent: "Read a", argsKey: "path", isError: true },
    { tool: "edit", args: "", endMs: 0 },
  ]);
  assert.equal(subagentActivityIntent(progress), "Find leftovers");
  assert.match(activityFromProgressChange(undefined, progress, 1)[0].label, /grep: Find leftovers$/);

  // An 18.3 frame has neither field: the last intent still labels the call.
  const legacy = parseSubagentProgress({ currentTool: "read", lastIntent: "Inspect foo.ts" });
  assert.equal(legacy?.currentToolIntent, undefined);
  assert.equal(subagentActivityIntent(legacy), "Inspect foo.ts");
  assert.match(activityFromProgressChange(undefined, legacy, 1)[0].label, /read: Inspect foo\.ts$/);
  assert.equal(subagentActivityIntent(undefined), undefined);
});

test("an engine that does not know a command is recognised, other failures are not", () => {
  assert.equal(isUnsupportedCommandError(new Error("Unknown command: cancel_subagent")), true);
  assert.equal(isUnsupportedCommandError(Object.assign(new Error("x"), { code: "unsupported" })), true);
  assert.equal(isUnsupportedCommandError(new Error("steer_subagent is not supported by this engine's RPC protocol")), true);
  assert.equal(isUnsupportedCommandError(new Error("Subagent not running: abc")), false);
  assert.equal(isUnsupportedCommandError(undefined), false);
});
