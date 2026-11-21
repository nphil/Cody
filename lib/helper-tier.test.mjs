import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isExpensiveHelper, parseTierReason, helperTierNote, tierCostTotals, formatTierTotals } = await jiti.import("./helper-tier.ts");

test("heavy-task, deep-task and the default/slow roles are expensive; task and smol are not", () => {
  assert.equal(isExpensiveHelper({ agent: "heavy-task" }), true);
  assert.equal(isExpensiveHelper({ agent: "Deep-Task" }), true);
  assert.equal(isExpensiveHelper({ agent: "reviewer", progress: { modelRole: "slow" } }), true);
  assert.equal(isExpensiveHelper({ agent: "explore", progress: { modelRole: "pi/default" } }), true);
  assert.equal(isExpensiveHelper({ agent: "x", progress: { modelOverride: ["pi/slow"] } }), true);
  assert.equal(isExpensiveHelper({ agent: "task", progress: { modelRole: "task" } }), false);
  assert.equal(isExpensiveHelper({ agent: "explore", progress: { modelRole: "smol" } }), false);
  assert.equal(isExpensiveHelper({ agent: "constructor", progress: { modelRole: "constructor" } }), false);
  assert.equal(isExpensiveHelper({}), false);
});

test("a labelled line gives the reason, with markdown marks stripped", () => {
  assert.equal(parseTierReason("Do it.\n\nWhy heavy-task: perf work on the parser.\nMore."), "perf work on the parser.");
  assert.equal(parseTierReason("**Why this tier:** a hard root cause `task` could not find"), "a hard root cause task could not find");
  assert.equal(parseTierReason("- Tier reason — multi-hour investigation"), "multi-hour investigation");
  assert.equal(parseTierReason("Reason for using deep-task: Nitin asked for it."), "Nitin asked for it.");
  assert.equal(parseTierReason("Escalation: task failed twice"), "task failed twice");
});

test("a heading with the reason underneath reads the first paragraph only", () => {
  const text = "# Why heavy-task\n\nIt is a multi-hour\ninvestigation.\n\n# Change\nDo things.";
  assert.equal(parseTierReason(text), "It is a multi-hour investigation.");
});

test("a because-sentence naming the tier counts", () => {
  assert.equal(parseTierReason("Fix the bug. Using heavy-task because task already failed. Then test."), "task already failed.");
});

test("a bare Reason/Why in the task's own text is not a tier reason", () => {
  assert.equal(parseTierReason("Reason: the cache is stale.\nWhy: the clock skews."), null);
  assert.equal(parseTierReason("Fix the thing.\nWhy this is slow: it loops."), null);
  assert.equal(parseTierReason(""), null);
  assert.equal(parseTierReason(undefined), null);
});

test("long reasons are clipped", () => {
  const reason = parseTierReason(`Why heavy-task: ${"word ".repeat(100)}`);
  assert.ok(reason.length <= 200);
  assert.ok(reason.endsWith("…"));
});

test("helperTierNote: null for cheap helpers and before text arrives; given or missing otherwise", () => {
  assert.equal(helperTierNote({ agent: "task", assignment: "x" }), null);
  assert.equal(helperTierNote({ agent: "heavy-task" }), null);
  assert.equal(helperTierNote({ agent: "heavy-task", assignment: "   " }), null);
  assert.deepEqual(helperTierNote({ agent: "heavy-task", assignment: "Do it." }), { kind: "missing" });
  assert.deepEqual(
    helperTierNote({ agent: "heavy-task", assignment: "Do it.", task: "Complete assignment thoroughly:\nWhy heavy-task: perf work" }),
    { kind: "given", reason: "perf work" },
  );
});

test("tierCostTotals sums per kind, dearest first, skipping kinds without cost", () => {
  const totals = tierCostTotals([
    { agent: "task", progress: { cost: 0.7 } },
    { agent: "task", progress: { cost: 0.5 } },
    { agent: "heavy-task", progress: { cost: 8.4 } },
    { agent: "scout", progress: { cost: 0 } },
    { agent: "explore" },
    { agent: "oracle", progress: { cost: Number.NaN } },
    { agent: "reviewer", progress: { cost: 1, modelRole: "slow" } },
  ]);
  assert.deepEqual(totals.map((entry) => [entry.agent, Math.round(entry.cost * 100) / 100, entry.expensive]), [
    ["heavy-task", 8.4, true],
    ["task", 1.2, false],
    ["reviewer", 1, true],
  ]);
  assert.equal(formatTierTotals(totals), "heavy-task $8.40 · task $1.20 · reviewer $1.00");
  assert.deepEqual(tierCostTotals([]), []);
});
