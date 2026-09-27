import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TaskBlock, CompletionBlock, ModelAndReasoningBlock, CancelSubtaskButton, cancelSubtaskSteerText, subagentActivityLabel } = await jiti.import("./SubagentTranscriptDialog.tsx");
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
