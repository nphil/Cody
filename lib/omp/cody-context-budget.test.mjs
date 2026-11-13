import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The one line a helper agent reads about its own memory limit
 * (lib/omp/extensions/cody-context-budget.ts). omp loads that file under Bun
 * with no Cody imports; these tests hand it a fake config and drive the real
 * handler the way omp does: one hidden message per live context, and never a
 * change to the system prompt (omp answers any replaced system prompt by
 * re-announcing its whole tool list as a user message).
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const extension = await jiti.import("./extensions/cody-context-budget.ts");
const display = await jiti.import("../message-display.ts");

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

/** A helper agent as omp hands it to the handler; `branch` is the conversation so far. */
const sub = (name, contextWindow, model = {}, branch = []) => ({
  agent: { kind: "sub", name },
  model: contextWindow === undefined ? undefined : { contextWindow, ...model },
  sessionManager: { getBranch: () => branch },
});
const lineOf = (result) => result.message.content;
/** What omp keeps of a message a handler returned: a `custom_message` entry of the conversation. */
const kept = (message, id = "m1") => ({ type: "custom_message", id, ...message });

const CONFIG = {
  compaction: { thresholdPercent: 70 },
  task: { agentCompactionThresholdOverrides: { task: "20%", "deep-task": "30%", scout: 90000, sonic: "oops" } },
};

const TASK_LINE =
  "Context budget: your history is summarised automatically at about 200k tokens (20% of this model's 1M-token window). Work in steps that each leave a clear result. When the context-window reminder arrives, bring context_notes up to date (task, decisions, changed files, evidence, exact next steps) before continuing, and after a summary check your notes before re-reading files or re-running work.";

test("a helper agent gets the one line as a hidden message, the exact text for a 1M-window task agent at 20%, and never a system-prompt change", () => {
  const { handler } = register(CONFIG);
  const first = handler({ systemPrompt: ["base"] }, sub("task", 1_000_000));
  assert.deepEqual(Object.keys(first), ["message"], "a systemPrompt in the result is a replaced prompt, which makes omp re-announce its whole tool list");
  assert.deepEqual(first.message, { customType: "cody-context-budget", content: TASK_LINE, display: false, attribution: "agent" });
  // The same agent and model always read the same words (the provider's prompt cache).
  assert.equal(lineOf(handler({}, sub("task", 1_000_000))), TASK_LINE);
});

test("the line is given once while the conversation still holds it, and again once it does not", () => {
  const { handler } = register(CONFIG);
  const turn = { type: "message", id: "u1", message: { role: "user", content: "carry on" } };
  const summary = { type: "compaction", id: "c1", summary: "…" };
  const note = kept({ customType: "cody-context-budget", content: TASK_LINE, display: false, attribution: "agent" });
  const given = (branch) => handler({}, sub("task", 1_000_000, {}, branch)).message !== undefined;

  assert.equal(given([]), true, "a conversation that has none gets it");
  assert.equal(given([note, turn, turn]), false, "one that holds it, however long since, gets nothing");
  assert.equal(given([note, summary]), true, "a compaction folded it into a summary");
  assert.equal(given([note, summary, { ...note, id: "m2" }, turn]), false, "and the copy given after the compaction is the live one");
  assert.equal(given([note, { type: "reset_boundary", id: "r1" }]), true, "/clear drops it");
  assert.equal(given([{ ...note, customType: "cody-disk-rule" }]), true, "a neighbour's note is not this one");
  assert.equal(given([note, null, 3, "x", { type: "custom_message" }]), false, "entries after it that are not notes are skipped");
});

test("a conversation that cannot be read is given the line, never left without it", () => {
  const { handler } = register(CONFIG);
  const agent = { kind: "sub", name: "task" };
  const model = { contextWindow: 1_000_000 };
  for (const ctx of [{ agent, model }, { agent, model, sessionManager: {} }, { agent, model, sessionManager: { getBranch: () => "not a list" } }, { agent, model, sessionManager: { getBranch: () => { throw new Error("closed"); } } }]) {
    assert.equal(lineOf(handler({}, ctx)), TASK_LINE, JSON.stringify(ctx));
  }
});

test("the message is the kind the transcript never shows", () => {
  assert.equal(extension.CONTEXT_BUDGET_CUSTOM_TYPE, "cody-context-budget");
  assert.equal(display.isHiddenFromTranscript({ role: "custom", customType: extension.CONTEXT_BUDGET_CUSTOM_TYPE }), true);
  assert.equal(display.isHiddenFromTranscript({ role: "user", customType: extension.CONTEXT_BUDGET_CUSTOM_TYPE }), false);
});

test("a main chat gets nothing from this extension", () => {
  const { handler } = register(CONFIG);
  assert.deepEqual(handler({ systemPrompt: ["base"] }, { agent: { kind: "main", name: "main" }, model: { contextWindow: 1_000_000 }, sessionManager: { getBranch: () => [] } }), {});
  assert.deepEqual(handler({ systemPrompt: ["base"] }, {}), {});
});

test("the numbers are the agent's own override, converted with the model's window", () => {
  const { handler } = register(CONFIG);
  assert.match(lineOf(handler({}, sub("deep-task", 1_000_000))), /at about 300k tokens \(30% of this model's 1M-token window\)/);
  assert.match(lineOf(handler({}, sub("task", 272_000))), /at about 54k tokens \(20% of this model's 272k-token window\)/);
  // A fixed token count at or past the window is the window less omp's reserve (16384 here: 15% of 50k is less).
  assert.match(lineOf(handler({}, sub("scout", 1_000_000))), /at about 90k tokens \(this model's window is 1M tokens\)/);
  assert.match(lineOf(handler({}, sub("scout", 50_000))), /at about 34k tokens \(this model's window is 50k tokens\)/);
  // The agent name is matched in lower case.
  assert.match(lineOf(handler({}, sub("Task", 1_000_000))), /20% of this model's 1M-token window/);
});

test("a compaction.modelThresholds entry sets the number for helpers on that model, unless the helper has its own override", () => {
  const config = {
    compaction: { thresholdPercent: 70, modelThresholds: { "anthropic/claude-opus*": "f400000", "openai/*": "50%", "google/gemini": 300000 } },
    task: { agentCompactionThresholdOverrides: { scout: "20%" } },
  };
  const { handler } = register(config);
  const opus = { provider: "anthropic", id: "claude-opus-4" };
  // "f400000" is an exact trigger.
  assert.match(lineOf(handler({}, sub("reviewer", 1_000_000, opus))), /at about 400k tokens \(this model's window is 1M tokens\)/);
  assert.match(lineOf(handler({}, sub("reviewer", 1_000_000, { provider: "openai", id: "gpt-5" }))), /at about 500k tokens \(50% of this model's 1M-token window\)/);
  // A plain token count is a base: the root 70% is applied to it, not to the window.
  assert.match(lineOf(handler({}, sub("reviewer", 1_000_000, { provider: "google", id: "gemini" }))), /at about 210k tokens \(this model's window is 1M tokens\)/);
  // No entry for the model, or no model name: the root.
  assert.match(lineOf(handler({}, sub("reviewer", 1_000_000, { provider: "xai", id: "grok" }))), /at about 700k tokens \(70% of this model's 1M-token window\)/);
  assert.match(lineOf(handler({}, sub("reviewer", 1_000_000))), /70%/);
  // The agent's own override outranks the model's entry.
  assert.match(lineOf(handler({}, sub("scout", 1_000_000, opus))), /at about 200k tokens \(20% of this model's 1M-token window\)/);
  // Turned off, the entries are ignored.
  const off = register({ ...config, compaction: { ...config.compaction, modelThresholdsEnabled: false } }).handler;
  assert.match(lineOf(off({}, sub("reviewer", 1_000_000, opus))), /at about 700k tokens \(70% of this model's 1M-token window\)/);
});

test("an agent without an override falls back to the root tokens, else the root percent; a bad override counts as none", () => {
  const percent = register(CONFIG).handler;
  assert.match(lineOf(percent({}, sub("reviewer", 1_000_000))), /at about 700k tokens \(70% of this model's 1M-token window\)/);
  assert.match(lineOf(percent({}, sub("sonic", 1_000_000))), /70%/, "\"oops\" is not a limit, so the root applies");

  const tokens = register({ compaction: { thresholdTokens: 150000, thresholdPercent: 70 } }).handler;
  assert.match(lineOf(tokens({}, sub("reviewer", 1_000_000))), /at about 150k tokens \(this model's window is 1M tokens\)/);

  const unknownWindow = register(CONFIG).handler;
  assert.match(lineOf(unknownWindow({}, sub("task"))), /at about 20% of this model's context window\./);
});

test("with no config, or no limit in it, the line is generic and still given", () => {
  for (const config of [null, {}, { compaction: { thresholdPercent: -1, thresholdTokens: -1 } }]) {
    const line = lineOf(register(config).handler({}, sub("task", 1_000_000)));
    assert.match(line, /^Context budget: your history is summarised automatically\. Work in steps/);
    assert.doesNotMatch(line, /at about/);
  }
  const unreadable = register(null, { throws: true });
  assert.match(lineOf(unreadable.handler({}, sub("task", 1_000_000))), /^Context budget: your history is summarised automatically\. /);
});

test("the config is read again only when the file's mtime changes, and the extension never subscribes to tool events", () => {
  const { handler, events, reads } = register(CONFIG);
  handler({}, sub("task", 1_000_000));
  handler({}, sub("scout", 1_000_000));
  assert.equal(reads(), 1);
  // A tool_call or tool_result handler would turn off omp's speculative subagent launch.
  assert.deepEqual(events, ["before_agent_start"]);
});

test("a change to config.yml mid-chat gives the next prompt the new number as a newer note, and an unchanged line is not repeated", () => {
  const { handler, file } = register(CONFIG);
  const conversation = [];
  const prompt = () => handler({}, sub("task", 1_000_000, {}, conversation));

  const first = prompt();
  assert.match(lineOf(first), /at about 200k tokens \(20% of this model's 1M-token window\)/);
  conversation.push(kept(first.message, "m1"));
  assert.deepEqual(prompt(), {}, "the line is in the conversation: nothing is added");

  file.config = { task: { agentCompactionThresholdOverrides: { task: "40%" } } };
  file.stamp = 2;
  const next = prompt();
  assert.match(lineOf(next), /at about 400k tokens \(40% of this model's 1M-token window\)/);
  conversation.push(kept(next.message, "m2"));
  assert.deepEqual(prompt(), {}, "the new line is the newest note: it is the one the model reads last, and it is not repeated");

  // The newest note decides, not an older one that happens to say the same: going back gives the old line again, last.
  file.config = CONFIG;
  file.stamp = 3;
  assert.equal(lineOf(prompt()), lineOf(first));
});
