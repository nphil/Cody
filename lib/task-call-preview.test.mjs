import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskCallPreview } = await jiti.import("./task-call-preview.ts");

const labels = { subagents: (n) => `${n} subagent${n === 1 ? "" : "s"}`, steps: (n) => `${n} steps` };

test("a batch call shows how many subagents and who they are, not its shared context", () => {
  const input = {
    context: "Long shared background the generic preview used to show",
    tasks: [
      { name: "Auditor", agent: "task", task: "Check the auth code", solutionSpace: "x" },
      { agent: "scout", task: "Find the settings reader\nand list its callers", solutionSpace: "x" },
    ],
  };
  assert.equal(taskCallPreview(input, labels), "2 subagents: Auditor, Find the settings reader and list its callers");
});

test("a single flat call shows its name, else the start of its instruction", () => {
  assert.equal(taskCallPreview({ name: "Fixer", agent: "task", task: "Fix it", solutionSpace: "x" }, labels), "Fixer");
  assert.equal(taskCallPreview({ agent: "task", task: "Fix it", solutionSpace: "x" }, labels), "Fix it");
});

test("omp 18.19 steps: the first step leads and the step count is named", () => {
  const steps = ["Read the module", "Change it", "Run its tests"];
  assert.equal(taskCallPreview({ agent: "task", steps, solutionSpace: "x" }, labels), "Read the module (3 steps)");
  assert.equal(taskCallPreview({ context: "c", tasks: [{ name: "Chain", agent: "task", steps, solutionSpace: "x" }] }, labels), "1 subagent: Chain (3 steps)");
  assert.equal(taskCallPreview({ agent: "task", steps: ["Only one"], solutionSpace: "x" }, labels), "Only one");
});

test("nothing summarisable returns null so the generic preview takes over", () => {
  assert.equal(taskCallPreview({}, labels), null);
  assert.equal(taskCallPreview(null, labels), null);
  assert.equal(taskCallPreview({ tasks: [] }, labels), "0 subagents");
});

test("a very long instruction is cut to one line", () => {
  const line = taskCallPreview({ agent: "task", task: "word ".repeat(100), solutionSpace: "x" }, labels);
  assert.ok(line.length <= 120 && line.endsWith("…"));
});
