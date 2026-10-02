import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TaskBlock, CompletionBlock, ModelAndReasoningBlock, CancelSubtaskButton, SteerSubagentBox, runSubtaskCancel, resetSubagentControlSupport, cancelSubtaskSteerText, subagentActivityLabel } = await jiti.import("./SubagentTranscriptDialog.tsx");
const { translate } = await jiti.import("../lib/i18n/index.tsx");

test("renders the task as markdown with its label", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, {
    task: "# Target\nReview the changes.",
  }));
  assert.match(html, /Task/);
  assert.match(html, /Target/);
  assert.match(html, /Review the changes\./);
});

test("renders nothing for an empty task", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, { task: "" }));
  assert.equal(html, "");
});

test("renders plain-text completion with its label", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "Everything passes.",
    truncated: false,
  }));
  assert.match(html, /Result/);
  assert.match(html, /Everything passes\./);
  assert.doesNotMatch(html, /Output truncated/);
});

test("renders structured JSON completions as key/value rows", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"overall_correctness":"incorrect","explanation":"x"}',
    truncated: false,
  }));
  assert.match(html, /overall_correctness/);
  assert.match(html, />incorrect</);
  assert.match(html, /explanation/);
  assert.match(html, />x</);
});

test("renders single-value JSON completions with unescaped line breaks", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"report":"Line one\\nLine two"}',
    truncated: false,
  }));
  assert.match(html, /Line one\nLine two/);
  assert.doesNotMatch(html, /\\n/);
});

test("shows the truncation note when the output was capped", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "partial",
    truncated: true,
  }));
  assert.match(html, /Output truncated/);
});

test("shows an empty state when no completion exists yet", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: null,
    truncated: false,
  }));
  assert.match(html, /No output yet/);
});

test("exposes the resolved model, fallback state, role, and reasoning", () => {
  const html = renderToStaticMarkup(React.createElement(ModelAndReasoningBlock, {
    progress: {
      resolvedModel: "openai-codex/gpt-5.6",
      resolvedModelIsFallback: true,
      modelRole: "task",
      thinkingLevel: "high",
    },
  }));

  assert.match(html, /openai-codex\/gpt-5\.6/);
  assert.match(html, /fallback/);
  assert.match(html, />task</);
  assert.match(html, />High</);
});

test("formats structured model, reasoning, and fallback activity", () => {
  assert.equal(subagentActivityLabel({ kind: "model_changed", label: "raw", to: "new-model", ts: 1 }, translate), "Switched model to new-model.");
  assert.equal(subagentActivityLabel({ kind: "thinking_level_changed", label: "raw", thinkingLevel: "high", ts: 1 }, translate), "Set reasoning to High.");
  assert.equal(subagentActivityLabel({ kind: "retry_fallback_applied", label: "raw", from: "first", to: "second", ts: 1 }, translate), "Fell back from first to second.");
});

const cancelProps = {
  subagent: { id: "task_abc123", agent: "reviewer", description: "Review the diff" },
  requested: false,
  onRequested: () => {},
  onSteer: async () => {},
};

test("offers Cancel subtask only while the child runs and the parent can be steered", () => {
  const shown = renderToStaticMarkup(React.createElement(CancelSubtaskButton, { ...cancelProps, status: "started", canSteer: true }));
  assert.match(shown, /aria-label="Cancel subtask"/);
  assert.doesNotMatch(shown, /disabled/);

  assert.equal(renderToStaticMarkup(React.createElement(CancelSubtaskButton, { ...cancelProps, status: "completed", canSteer: true })), "");
  assert.equal(renderToStaticMarkup(React.createElement(CancelSubtaskButton, { ...cancelProps, status: "started", canSteer: false })), "");
  assert.equal(renderToStaticMarkup(React.createElement(CancelSubtaskButton, { ...cancelProps, status: "started", canSteer: true, onSteer: undefined })), "");
});

test("a requested cancel stays visible but muted and disabled", () => {
  const html = renderToStaticMarkup(React.createElement(CancelSubtaskButton, { ...cancelProps, status: "started", canSteer: true, requested: true }));
  assert.match(html, /aria-label="Cancel requested"/);
  assert.match(html, /disabled/);
  assert.match(html, /data-cancel-subtask="requested"/);
});

test("the cancel steer names the subagent id, agent, and a one-line summary", () => {
  const text = cancelSubtaskSteerText({ id: "task_abc123", agent: "reviewer", task: "# Target\nReview   the\n\ndiff." });
  assert.match(text, /cancelled subtask "task_abc123" \(reviewer: # Target Review the diff\.\)/);
  assert.ok(text.includes("write proc://task_abc123/kill"));
  assert.ok(text.includes("OMP 18.3+; if this older engine does not support proc://, use hub cancel (ids: [\"task_abc123\"])") );
  assert.match(text, /do not wait for or use anything it produces\.$/);
  assert.doesNotMatch(text, /\n/);

  const long = cancelSubtaskSteerText({ id: "x", agent: "task", task: "a".repeat(400) });
  const summary = /\(task: ([^)]*)\)/.exec(long)[1];
  assert.ok(summary.length <= 160, `summary is ${summary.length} chars`);
  assert.match(summary, /…$/);
});

const cancelSubject = { id: "task_abc123", agent: "reviewer", task: "Review the diff" };

test("cancel kills the child itself when the engine can, and says so when it already finished", async () => {
  const steers = [];
  const steer = async (message) => { steers.push(message); };
  const asked = [];
  const ask = (answer) => async (id) => { asked.push(id); return answer; };
  const unsupported = () => assert.fail("engine supports the command");

  assert.equal(await runSubtaskCancel({ subagent: cancelSubject, cancelSubagent: ask({ cancelled: true }), steer, onCancelUnsupported: unsupported }), "cancelled");
  assert.equal(await runSubtaskCancel({ subagent: cancelSubject, cancelSubagent: ask({ cancelled: false }), steer, onCancelUnsupported: unsupported }), "already_finished");
  assert.deepEqual(asked, ["task_abc123", "task_abc123"]);
  assert.deepEqual(steers, []);
});

test("cancel falls back to steering the parent only for an engine that does not know the command", async () => {
  const steers = [];
  const steer = async (message) => { steers.push(message); };
  let marked = 0;
  const old = async () => { throw new Error("Unknown command: cancel_subagent"); };

  assert.equal(await runSubtaskCancel({ subagent: cancelSubject, cancelSubagent: old, steer, onCancelUnsupported: () => { marked += 1; } }), "parent_steered");
  assert.equal(marked, 1);
  assert.equal(steers.length, 1);
  assert.equal(steers[0], cancelSubtaskSteerText(cancelSubject));

  // Any other failure is the user's to see; the parent is not bothered.
  const refused = async () => { throw new Error("Subagent event bus is unavailable"); };
  await assert.rejects(runSubtaskCancel({ subagent: cancelSubject, cancelSubagent: refused, steer, onCancelUnsupported: () => { marked += 1; } }), /event bus/);
  assert.equal(marked, 1);
  assert.equal(steers.length, 1);

  // Old engine and nobody to steer: the original error surfaces.
  await assert.rejects(runSubtaskCancel({ subagent: cancelSubject, cancelSubagent: old, onCancelUnsupported: () => {} }), /Unknown command/);
});

test("a native cancel is offered even when the parent cannot be steered, until the engine says it cannot", () => {
  resetSubagentControlSupport();
  const native = { ...cancelProps, status: "started", canSteer: false, onSteer: undefined, onCancelSubagent: async () => ({ cancelled: true }) };
  assert.match(renderToStaticMarkup(React.createElement(CancelSubtaskButton, native)), /aria-label="Cancel subtask"/);
  assert.equal(renderToStaticMarkup(React.createElement(CancelSubtaskButton, { ...native, status: "completed" })), "");
});

test("the subagent message box shows a labelled input and a send button that waits for text", () => {
  resetSubagentControlSupport();
  const html = renderToStaticMarkup(React.createElement(SteerSubagentBox, { subagentId: "task_abc123", onSend: async () => {} }));
  assert.match(html, /placeholder="Message this subagent"/);
  assert.match(html, /aria-label="Send message to this subagent"[^>]*disabled|disabled[^>]*aria-label="Send message to this subagent"/);
});
