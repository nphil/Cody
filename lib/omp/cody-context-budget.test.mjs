import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The one line a helper agent reads about its own memory limit
 * (lib/omp/extensions/cody-context-budget.ts). omp loads that file under Bun
 * with no Cody imports; these tests hand it a fake config and drive the real
 * handler the way omp does.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const extension = await jiti.import("./extensions/cody-context-budget.ts");

/** Register the extension over `config` (a parsed config.yml, or null) and return its handler and the events it subscribed to. */
function register(config, { throws = false } = {}) {
  const events = [];
  let handler;
  // `file` stands for config.yml: `stamp` is its mtime, `config` its parsed content.
  const file = { config, stamp: 1, reads: 0 };
  extension.createContextBudget({
    stamp: () => file.stamp,
    readConfig: () => {
      file.reads += 1;
      if (throws) throw new Error("no such file");
      return file.config;
    },
  })({ on: (event, fn) => { events.push(event); if (event === "before_agent_start") handler = fn; } });
  return { handler, events, file, reads: () => file.reads };
}

const sub = (name, contextWindow, model = {}) => ({ agent: { kind: "sub", name }, model: contextWindow === undefined ? undefined : { contextWindow, ...model } });
const lineOf = (result) => result.systemPrompt.at(-1);

const CONFIG = {
  compaction: { thresholdPercent: 70 },
  task: { agentCompactionThresholdOverrides: { task: "20%", "deep-task": "30%", scout: 90000, sonic: "oops" } },
};

test("a helper agent gets the one line, once, and the exact text for a 1M-window task agent at 20%", () => {
  const { handler } = register(CONFIG);
  const first = handler({ systemPrompt: ["base"] }, sub("task", 1_000_000));
  assert.equal(first.systemPrompt.length, 2);
  assert.equal(
    lineOf(first),
    "Context budget: your history is summarised automatically at about 200k tokens (20% of this model's 1M-token window). Work in steps that each leave a clear result. When the context-window reminder arrives, bring context_notes up to date (task, decisions, changed files, evidence, exact next steps) before continuing, and after a summary check your notes before re-reading files or re-running work.",
  );
  // Already present: left as it is, never twice.
  const again = handler({ systemPrompt: first.systemPrompt }, sub("task", 1_000_000));
  assert.deepEqual(again.systemPrompt, first.systemPrompt);
  // The same agent and model always read the same words (the provider's prompt cache).
  assert.equal(lineOf(handler({ systemPrompt: [] }, sub("task", 1_000_000))), lineOf(first));
});

test("a main chat gets nothing from this extension", () => {
  const { handler } = register(CONFIG);
  assert.deepEqual(handler({ systemPrompt: ["base"] }, { agent: { kind: "main", name: "main" }, model: { contextWindow: 1_000_000 } }), {});
  assert.deepEqual(handler({ systemPrompt: ["base"] }, {}), {});
});

test("the numbers are the agent's own override, converted with the model's window", () => {
  const { handler } = register(CONFIG);
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("deep-task", 1_000_000))), /at about 300k tokens \(30% of this model's 1M-token window\)/);
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("task", 272_000))), /at about 54k tokens \(20% of this model's 272k-token window\)/);
  // A fixed token count at or past the window is the window less omp's reserve (16384 here: 15% of 50k is less).
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("scout", 1_000_000))), /at about 90k tokens \(this model's window is 1M tokens\)/);
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("scout", 50_000))), /at about 34k tokens \(this model's window is 50k tokens\)/);
  // The agent name is matched in lower case.
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("Task", 1_000_000))), /20% of this model's 1M-token window/);
});

test("a compaction.modelThresholds entry sets the number for helpers on that model, unless the helper has its own override", () => {
  const config = {
    compaction: { thresholdPercent: 70, modelThresholds: { "anthropic/claude-opus*": "f400000", "openai/*": "50%", "google/gemini": 300000 } },
    task: { agentCompactionThresholdOverrides: { scout: "20%" } },
  };
  const { handler } = register(config);
  const opus = { provider: "anthropic", id: "claude-opus-4" };
  // "f400000" is an exact trigger.
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("reviewer", 1_000_000, opus))), /at about 400k tokens \(this model's window is 1M tokens\)/);
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("reviewer", 1_000_000, { provider: "openai", id: "gpt-5" }))), /at about 500k tokens \(50% of this model's 1M-token window\)/);
  // A plain token count is a base: the root 70% is applied to it, not to the window.
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("reviewer", 1_000_000, { provider: "google", id: "gemini" }))), /at about 210k tokens \(this model's window is 1M tokens\)/);
  // No entry for the model, or no model name: the root.
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("reviewer", 1_000_000, { provider: "xai", id: "grok" }))), /at about 700k tokens \(70% of this model's 1M-token window\)/);
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("reviewer", 1_000_000))), /70%/);
  // The agent's own override outranks the model's entry.
  assert.match(lineOf(handler({ systemPrompt: [] }, sub("scout", 1_000_000, opus))), /at about 200k tokens \(20% of this model's 1M-token window\)/);
  // Turned off, the entries are ignored.
  const off = register({ ...config, compaction: { ...config.compaction, modelThresholdsEnabled: false } }).handler;
  assert.match(lineOf(off({ systemPrompt: [] }, sub("reviewer", 1_000_000, opus))), /at about 700k tokens \(70% of this model's 1M-token window\)/);
});

test("an agent without an override falls back to the root tokens, else the root percent; a bad override counts as none", () => {
  const percent = register(CONFIG).handler;
  assert.match(lineOf(percent({ systemPrompt: [] }, sub("reviewer", 1_000_000))), /at about 700k tokens \(70% of this model's 1M-token window\)/);
  assert.match(lineOf(percent({ systemPrompt: [] }, sub("sonic", 1_000_000))), /70%/, "\"oops\" is not a limit, so the root applies");

  const tokens = register({ compaction: { thresholdTokens: 150000, thresholdPercent: 70 } }).handler;
  assert.match(lineOf(tokens({ systemPrompt: [] }, sub("reviewer", 1_000_000))), /at about 150k tokens \(this model's window is 1M tokens\)/);

  const unknownWindow = register(CONFIG).handler;
  assert.match(lineOf(unknownWindow({ systemPrompt: [] }, sub("task"))), /at about 20% of this model's context window\./);
});

test("with no config, or no limit in it, the line is generic and still given", () => {
  for (const config of [null, {}, { compaction: { thresholdPercent: -1, thresholdTokens: -1 } }]) {
    const line = lineOf(register(config).handler({ systemPrompt: [] }, sub("task", 1_000_000)));
    assert.match(line, /^Context budget: your history is summarised automatically\. Work in steps/);
    assert.doesNotMatch(line, /at about/);
  }
  const unreadable = register(null, { throws: true });
  assert.match(lineOf(unreadable.handler({ systemPrompt: [] }, sub("task", 1_000_000))), /^Context budget: your history is summarised automatically\. /);
});

test("the config is read again only when the file's mtime changes, and the extension never subscribes to tool events", () => {
  const { handler, events, reads } = register(CONFIG);
  handler({ systemPrompt: [] }, sub("task", 1_000_000));
  handler({ systemPrompt: [] }, sub("scout", 1_000_000));
  assert.equal(reads(), 1);
  // A tool_call or tool_result handler would turn off omp's speculative subagent launch.
  assert.deepEqual(events, ["before_agent_start"]);
});

test("a change to config.yml mid-chat gives the next helper the new number, and a stale line is replaced, not stacked", () => {
  const { handler, file } = register(CONFIG);
  const first = handler({ systemPrompt: ["base"] }, sub("task", 1_000_000));
  assert.match(lineOf(first), /at about 200k tokens \(20% of this model's 1M-token window\)/);

  file.config = { task: { agentCompactionThresholdOverrides: { task: "40%" } } };
  file.stamp = 2;
  const next = handler({ systemPrompt: ["base"] }, sub("task", 1_000_000));
  assert.match(lineOf(next), /at about 400k tokens \(40% of this model's 1M-token window\)/);

  // The same helper starting again with the old line already in its prompt ends with one line, the new one.
  const again = handler({ systemPrompt: first.systemPrompt }, sub("task", 1_000_000));
  assert.deepEqual(again.systemPrompt, next.systemPrompt);
});

test("a prompt it cannot read is never replaced", () => {
  const { handler } = register(CONFIG);
  assert.deepEqual(handler({}, sub("task", 1_000_000)), {});
});
