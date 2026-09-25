import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, SafeMarkdownBody, TaskResultPanel, getStructuredActivityStatus, isInterruptedMessage } = await jiti.import("./MessageView.tsx");
const { CodeBlock } = await jiti.import("./MermaidBlock.tsx");

test("large message content avoids the markdown pipeline until requested", () => {
  const largeMessage = "x".repeat(100_001);
  const html = renderToStaticMarkup(React.createElement(SafeMarkdownBody, null, largeMessage));

  assert.match(html, /Large message \(100 KB\)/);
  assert.doesNotMatch(html, /markdown-body/);
});

test("streaming code blocks avoid syntax-highlighter line markup", () => {
  const html = renderToStaticMarkup(React.createElement(CodeBlock, {
    code: "const value = 1;",
    lang: "ts",
    isStreaming: true,
  }));

  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /linenumber/);
});

test("streaming text renders the full buffer at once with a live indicator, no word-by-word reveal", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "The quick brown fox jumps over the lazy dog." }],
    },
  }));

  assert.match(html, /The quick brown fox jumps over the lazy dog/);
  assert.doesNotMatch(html, /stream-word/);
  assert.match(html, /live-dot/);
});

test("MCP mount notices stay out of the transcript", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "xdev-mount-notice",
      content: "The xd:// device inventory changed.",
      display: false,
    },
  }));

  assert.equal(html, "");
});

test("streaming tool calls start collapsed when the interface preference is enabled", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    activityDisplayMode: "compact",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("streaming tool calls can still start expanded when the preference is disabled", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<pre/);
});

test("running tool results show an explicit live state and spinner", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-live", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-live",
      { role: "toolResult", toolCallId: "call-live", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-state="running"/);
  assert.match(html, /icon-spin/);
  assert.match(html, /data-tool-running="true"/);
});

test("running tool results render the latest partial output before commit", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-live", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-live",
      { role: "toolResult", toolCallId: "call-live", toolName: "bash", content: [{ type: "text", text: "line-1\nline-2" }], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-state="running"/);
  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /line-1/);
  assert.match(html, /line-2/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
});

test("committed tool results replace the live affordances", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-live", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-live",
      { role: "toolResult", toolCallId: "call-live", toolName: "bash", content: [{ type: "text", text: "done" }] },
    ]]),
  }));

  assert.match(html, /data-tool-state="complete"/);
  assert.doesNotMatch(html, /icon-spin/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
  assert.match(html, /done/);
});

test("thinking blocks stay collapsed by default", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "weighing the options" }],
    },
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /weighing the options/);
});

test("thinking blocks render open when the interface preference is enabled", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    thinkingDefaultExpanded: true,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "weighing the options" }],
    },
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /weighing the options/);
});

test("thinking blocks auto-expand while actively streaming, even when collapsed by preference", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "weighing the options" }],
    },
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /weighing the options/);
});

test("assistant errors render as an alert even without response content", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [],
      model: "model",
      provider: "provider",
      stopReason: "error",
      errorMessage: "provider failed",
    },
  }));

  assert.match(html, /role="alert"/);
  assert.match(html, /provider failed/);
});

test("user interruptions render a neutral status instead of an error", () => {
  assert.equal(isInterruptedMessage("interrupted by user"), true);
  assert.equal(isInterruptedMessage("request aborted"), true);
  assert.equal(isInterruptedMessage("provider failed"), false);

  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "hidden",
    message: {
      role: "assistant",
      content: [],
      model: "model",
      provider: "provider",
      stopReason: "aborted",
      errorMessage: "aborted",
    },
  }));

  assert.match(html, /role="status"/);
  assert.match(html, /Generation stopped by user/);
  assert.doesNotMatch(html, />aborted</);
});


test("task tool results render a per-subagent summary panel", () => {
  const html = renderToStaticMarkup(React.createElement(TaskResultPanel, {
    details: {
      totalDurationMs: 360000,
      async: { state: "completed", jobId: "Scout", type: "task" },
      results: [
        { id: "Scout", agent: "scout", task: "Map the surface", exitCode: 0, tokens: 999000, cost: 1.25, durationMs: 360000, resolvedModel: "provider/gpt-5.6:medium" },
        { id: "Worker", agent: "worker", task: "Write the code", exitCode: 1, error: "Test failed", tokens: 500 },
      ],
    },
  }));

  assert.match(html, /Subagents/);
  assert.match(html, /Map the surface/);
  assert.match(html, /Write the code/);
  assert.match(html, /2 subagents/);
  assert.match(html, /999k tok/);
  assert.match(html, /GPT-5.6/);
  assert.match(html, /\u23a4|⤴/);
});

test("task panel renders nothing without task details", () => {
  assert.equal(renderToStaticMarkup(React.createElement(TaskResultPanel, { details: undefined })), "");
  assert.equal(renderToStaticMarkup(React.createElement(TaskResultPanel, { details: { patch: "p" } })), "");
});

test("async-only task details render the job as one started row", () => {
  const html = renderToStaticMarkup(React.createElement(TaskResultPanel, {
    details: { async: { state: "running", jobId: "AsyncAudit", type: "task" } },
  }));
  assert.match(html, /1 subagent/);
  assert.match(html, /AsyncAudit/);
  assert.doesNotMatch(html, /0 subagents/);
});

test("hub send results render the IRC target and hide generic delivery output", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "hub-send",
        toolName: "hub",
        input: { op: "send", to: "VisualFix", message: "Please check the current tree." },
      }],
    },
    toolResults: new Map([[
      "hub-send",
      {
        role: "toolResult",
        toolCallId: "hub-send",
        toolName: "hub",
        content: [{ type: "text", text: "Delivered to VisualFix" }],
        details: { op: "send", receipts: [{ to: "VisualFix", outcome: "injected" }] },
      },
    ]]),
  }));

  assert.match(html, /data-hub-result="send"/);
  assert.match(html, /IRC → VisualFix injected/);
  assert.match(html, /Please check the current tree/);
  assert.doesNotMatch(html, /Delivered to VisualFix/);
});

test("hub jobs results render the waiting roster and duration", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "hub-jobs", toolName: "hub", input: { op: "jobs" } }],
    },
    toolResults: new Map([[
      "hub-jobs",
      {
        role: "toolResult",
        toolCallId: "hub-jobs",
        toolName: "hub",
        content: [{ type: "text", text: "raw jobs response" }],
        details: {
          op: "jobs",
          jobs: [
            { id: "Audit", type: "task", status: "running", label: "Audit workspace", durationMs: 1_890_000 },
            { id: "Fix", type: "task", status: "completed", label: "Apply fix", durationMs: 45_000 },
          ],
        },
      },
    ]]),
  }));

  assert.match(html, /data-hub-result="jobs"/);
  assert.match(html, /waiting on 2 jobs/);
  assert.match(html, /Audit workspace/);
  assert.match(html, /31m30s/);
  assert.doesNotMatch(html, /raw jobs response/);
});

test("hub results retain raw output when structured details are absent", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    activityDisplayMode: "full",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "hub-fallback", toolName: "hub", input: { op: "unknown" } }],
    },
    toolResults: new Map([[
      "hub-fallback",
      { role: "toolResult", toolCallId: "hub-fallback", toolName: "hub", content: [{ type: "text", text: "unstructured hub output" }] },
    ]]),
  }));

  assert.match(html, /unstructured hub output/);
});

test("irc:incoming custom messages title with the sender name", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "irc:incoming",
      content: "<irc>\nIncoming IRC message from agent `AuditUiComponents`:\n\nPlease review the current tree.\nThanks.",
      display: true,
    },
  }));
  assert.match(html, /AuditUiComponents/);
  assert.doesNotMatch(html, /irc:incoming/);
  assert.match(html, /Please review the current tree/);
  assert.doesNotMatch(html, /Incoming IRC message from agent/);
});

test("advisor custom messages use the localized advisor label", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "custom", customType: "advisor", content: "Consider handling the edge case.", display: true },
  }));
  assert.match(html, /Advisor/);
  assert.match(html, /Consider handling the edge case/);
  assert.doesNotMatch(html, /customType/);
});


test("activity modes leave user prose and assistant thinking/text untouched", () => {
  const user = renderToStaticMarkup(React.createElement(MessageView, { activityDisplayMode: "hidden", message: { role: "user", content: "ordinary user prose" } }));
  assert.match(user, /ordinary user prose/);
  const assistant = renderToStaticMarkup(React.createElement(MessageView, { activityDisplayMode: "hidden", thinkingDefaultExpanded: true, message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "ordinary assistant prose" }, { type: "toolCall", toolCallId: "call-hidden", toolName: "read", input: { path: "x" } }] } }));
  assert.match(assistant, /private reasoning/);
  assert.match(assistant, /ordinary assistant prose/);
  assert.doesNotMatch(assistant, /call-hidden/);
});

test("structured async task status is compact, expandable in full, and hidden without losing errors", () => {
  const result = { role: "toolResult", toolCallId: "task-1", toolName: "task", content: [{ type: "text", text: "full task output" }], details: { async: { state: "completed", jobId: "Audit" } } };
  assert.equal(getStructuredActivityStatus(result), "completed");
  const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "task-1", toolName: "task", input: { task: "Audit" } }] };
  const compact = renderToStaticMarkup(React.createElement(MessageView, { activityDisplayMode: "compact", message, toolResults: new Map([["task-1", result]]) }));
  assert.match(compact, /completed/);
  assert.doesNotMatch(compact, /full task output/);
  const full = renderToStaticMarkup(React.createElement(MessageView, { activityDisplayMode: "full", message, toolResults: new Map([["task-1", result]]) }));
  assert.match(full, /full task output/);
  const hidden = renderToStaticMarkup(React.createElement(MessageView, { activityDisplayMode: "hidden", message, toolResults: new Map([["task-1", result]]) }));
  assert.equal(hidden, "");
  const error = { ...result, isError: true, content: [{ type: "text", text: "actionable tool failure" }] };
  const visibleError = renderToStaticMarkup(React.createElement(MessageView, { activityDisplayMode: "hidden", message, toolResults: new Map([["task-1", error]]) }));
  assert.match(visibleError, /actionable tool failure/);
});
