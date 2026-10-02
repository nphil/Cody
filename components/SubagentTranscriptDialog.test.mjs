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
const { TranscriptView } = await jiti.import("./SubagentTranscript.tsx");
const { translate } = await jiti.import("../lib/i18n/index.tsx");

test("renders the task as markdown with its label once opened", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, {
    task: "# Target\nReview the changes.",
    defaultOpen: true,
  }));
  assert.match(html, /Task/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Target/);
  assert.match(html, /Review the changes\./);
});

test("the task starts collapsed: its label and a one-line preview, no markdown parsed yet", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, {
    task: "# Target\nReview the changes.\n\nMore detail below.",
  }));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Task/);
  // The preview is the first line without its heading marks…
  assert.match(html, />Target</);
  // …and nothing below it is rendered until the reader opens the block.
  assert.doesNotMatch(html, /Review the changes/);
  assert.doesNotMatch(html, /<h1/);
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

test("a result that is one JSON string shows the prose without its quotes", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '"Completed 5 of 8 calls.\\nSee notes."',
    truncated: false,
  }));
  assert.match(html, />Completed 5 of 8 calls\.\nSee notes\.</);
  assert.doesNotMatch(html, /&quot;Completed/);
});

test("shows the truncation note when the output was capped", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "partial",
    truncated: true,
  }));
  assert.match(html, /Output truncated/);
});

test("renders nothing while there is no completion (the transcript is the content then)", () => {
  assert.equal(renderToStaticMarkup(React.createElement(CompletionBlock, { completion: null, truncated: false })), "");
  assert.equal(renderToStaticMarkup(React.createElement(CompletionBlock, { completion: "", truncated: false })), "");
});

test("a long result is folded behind a Show more toggle; a short one is shown whole", () => {
  const short = renderToStaticMarkup(React.createElement(CompletionBlock, { completion: "Everything passes.", truncated: false }));
  assert.doesNotMatch(short, /Show more/);
  assert.doesNotMatch(short, /aria-expanded/);

  const longText = Array.from({ length: 30 }, (_, i) => `Finding ${i + 1}: something worth reading.`).join("\n");
  const long = renderToStaticMarkup(React.createElement(CompletionBlock, { completion: longText, truncated: false }));
  assert.match(long, /Show more/);
  assert.match(long, /aria-expanded="false"/);
  assert.match(long, /max-height:156px/);

  const manyChars = renderToStaticMarkup(React.createElement(CompletionBlock, { completion: "x".repeat(900), truncated: false }));
  assert.match(manyChars, /Show more/);
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

// ── The transcript section (what the dialog shows under Result and Task) ──

const transcriptRows = [
  { key: "100", message: { role: "user", content: [{ type: "text", text: "Map the surface of the plugin" }] } },
  {
    key: "300",
    message: {
      role: "assistant",
      provider: "p",
      model: "m",
      content: [
        { type: "thinking", thinking: "SECRET-THINKING planning the approach" },
        { type: "toolCall", toolCallId: "c1", toolName: "read", input: { path: "src/main.ts" } },
      ],
    },
  },
  { key: "900", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "All done: found 3 files." }] } },
];
const transcriptResults = new Map([["c1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "RESULT-BODY" }] }]]);

function renderTranscript(overrides = {}) {
  return renderToStaticMarkup(React.createElement(TranscriptView, {
    phase: "ready",
    error: null,
    rows: transcriptRows,
    toolResults: transcriptResults,
    active: false,
    hasEarlier: false,
    loadingEarlier: false,
    earlierError: null,
    loadingLater: false,
    laterError: null,
    showJump: false,
    rowsContainerRef: () => {},
    onShowEarlier: () => {},
    onJump: () => {},
    onRetry: () => {},
    onRefresh: () => {},
    ...overrides,
  }));
}

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}

test("rows are drawn by the chat's own components: collapsed thinking, tool cards, user bubbles", () => {
  const html = renderTranscript();
  assert.equal(count(html, /data-row-key="/g), 3);
  assert.match(html, /Map the surface of the plugin/);
  assert.match(html, /All done: found 3 files\./);
  // Thinking shows its header only; the reasoning opens on demand.
  assert.match(html, />Thinking</);
  assert.doesNotMatch(html, /SECRET-THINKING/);
  // The tool call is the normal collapsible card (named, collapsed), not raw JSON.
  assert.match(html, />read</);
  assert.doesNotMatch(html, /src\/main\.ts"\}/);
  assert.doesNotMatch(html, /RESULT-BODY/);
});

test("rows keep their identity: the key on each row is the line's offset, whatever is prepended", () => {
  const before = renderTranscript({ rows: transcriptRows.slice(1) });
  const after = renderTranscript({ rows: [{ key: "40", message: transcriptRows[0].message }, ...transcriptRows.slice(1)] });
  for (const key of ["300", "900"]) {
    assert.match(before, new RegExp(`data-row-key="${key}"`));
    assert.match(after, new RegExp(`data-row-key="${key}"`));
  }
  assert.match(after, /data-row-key="40"/);
});

test("Show earlier appears once, at the top, only while earlier content exists — and there is never a forward Load more", () => {
  const withEarlier = renderTranscript({ hasEarlier: true });
  assert.equal(count(withEarlier, /data-testid="subagent-show-earlier"/g), 1);
  assert.match(withEarlier, /Show earlier/);
  assert.ok(withEarlier.indexOf("subagent-show-earlier") < withEarlier.indexOf("data-row-key"), "the control sits above the rows");

  const withoutEarlier = renderTranscript({ hasEarlier: false });
  assert.doesNotMatch(withoutEarlier, /subagent-show-earlier/);

  for (const state of [
    { hasEarlier: true }, { hasEarlier: false }, { hasEarlier: true, showJump: true }, { loadingLater: true },
    { laterError: "HTTP 500" }, { phase: "loading" }, { phase: "missing" }, { rows: [] },
  ]) {
    assert.doesNotMatch(renderTranscript(state), /Load more/i);
  }
});

test("the earlier control says it is loading and cannot be pressed twice", () => {
  const html = renderTranscript({ hasEarlier: true, loadingEarlier: true });
  assert.match(html, /Loading earlier/);
  assert.match(html, /<button[^>]*data-testid="subagent-show-earlier"[^>]*disabled|<button[^>]*disabled[^>]*data-testid="subagent-show-earlier"/);
});

test("a failed earlier load keeps the rows and offers Retry in its place", () => {
  const html = renderTranscript({ hasEarlier: true, earlierError: "HTTP 500" });
  assert.match(html, /Couldn(?:'|&#x27;)t load earlier messages\./);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /subagent-show-earlier/);
  assert.equal(count(html, /data-row-key="/g), 3);
});

test("Jump to latest shows only when the newest rows are off screen", () => {
  assert.match(renderTranscript({ showJump: true }), /data-testid="subagent-jump-latest"[^>]*>.*Jump to latest/s);
  assert.doesNotMatch(renderTranscript({ showJump: false }), /Jump to latest/);
});

test("loading shows a skeleton, not rows or controls", () => {
  const html = renderTranscript({ phase: "loading", rows: [] });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /class="skeleton"/);
  assert.doesNotMatch(html, /data-row-key/);
  assert.doesNotMatch(html, /<button/);
});

test("a failed first load says so, with the reason and a Retry", () => {
  const html = renderTranscript({ phase: "error", error: "HTTP 502", rows: [] });
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn(?:'|&#x27;)t load the transcript\./);
  assert.match(html, /HTTP 502/);
  assert.match(html, />Retry</);
});

test("an empty transcript is told apart: a running child has not written yet, a finished one saved nothing", () => {
  assert.match(renderTranscript({ phase: "missing", rows: [], active: true }), /No messages yet/);
  assert.match(renderTranscript({ phase: "missing", rows: [], active: false }), /No transcript was saved for this subagent/);
  assert.match(renderTranscript({ rows: [], active: true }), /No messages yet/);
  // Rows that exist but are all off the loaded page are not "empty": earlier content is one click away.
  assert.doesNotMatch(renderTranscript({ rows: [], hasEarlier: true }), /No messages yet|No transcript/);
});

test("a failed refresh keeps the rows and offers a Retry", () => {
  const html = renderTranscript({ laterError: "HTTP 500", active: true });
  assert.match(html, /Couldn(?:'|&#x27;)t load new messages\./);
  assert.match(html, />Retry</);
  assert.equal(count(html, /data-row-key="/g), 3);
});
