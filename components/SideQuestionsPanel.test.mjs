import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SideQuestionsPanel } = await jiti.import("./SideQuestionsPanel.tsx");

const noop = () => {};

function turn(overrides = {}) {
  return { question: "What is a monad?", answer: "", status: "complete", createdAt: 1, updatedAt: 1, ...overrides };
}

function record(id, overrides = {}) {
  return { ...turn(), id, leafId: null, ...overrides };
}

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(SideQuestionsPanel, {
    records: [],
    runActive: false,
    answering: false,
    asking: false,
    open: false,
    onOpenChange: noop,
    error: null,
    onDismissError: noop,
    focusRequest: 0,
    onAsk: async () => true,
    onCancel: noop,
    ...props,
  }));
}

/** The <input> carrying this aria-label, as markup. */
function inputFor(html, label) {
  const match = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`));
  assert.ok(match, `input "${label}" is rendered`);
  return match[0];
}

test("nothing renders when there is nothing to show", () => {
  assert.equal(render(), "");
});

test("the slim bar shows while the main reply runs, even with no topics", () => {
  const html = render({ runActive: true });
  assert.match(html, /aria-label="Side questions"/);
  assert.match(html, /aria-expanded="false"/);
  // The bar reads as the box it opens, but the box itself is only in the body.
  assert.match(html, /Ask a side question…/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /topic/);
});

test("the panel stays on screen while open or holding an error, even with no topics", () => {
  assert.match(render({ open: true }), /Ask something without interrupting the main reply/);
  const collapsed = render({ error: "The side question failed." });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /The side question failed\./);
});

test("collapsed by default: the header carries the topic count and no body", () => {
  const html = render({ records: [record("a", { answer: "A monad is a burrito." }), record("b")] });
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /2 topics/);
  assert.doesNotMatch(html, /burrito/);
  assert.doesNotMatch(html, /<input/);
  assert.match(render({ records: [record("a")] }), /1 topic</);
});

test("while answering, the collapsed header shows the live status", () => {
  const html = render({
    records: [record("a", { status: "running", answer: "Partial words" })],
    answering: true,
  });
  assert.match(html, /live-status-dot live-pulse/);
  assert.match(html, /Answering…/);
  assert.doesNotMatch(html, /1 topic/);
  assert.doesNotMatch(html, /Partial words/);
});

test("an open running topic streams its text, offers Cancel, no follow-up, and a disabled ask box", () => {
  const html = render({
    open: true,
    answering: true,
    records: [record("a", { status: "running", answer: "Partial **words**" })],
  });
  assert.match(html, /Partial <strong>words<\/strong>/);
  assert.match(html, /What is a monad\?/);
  assert.match(html, />Cancel</);
  assert.match(html, /title="Stop this answer"/);
  assert.doesNotMatch(html, /Follow-up question/);
  assert.match(inputFor(html, "Side question"), /disabled=""/);
  assert.match(html, />Copy</, "words already written can be copied");
});

test("a running topic with no words yet says so", () => {
  const html = render({ open: true, answering: true, records: [record("a", { status: "running", answer: "" })] });
  assert.match(html, /Waiting for the first words…/);
  assert.doesNotMatch(html, />Copy</, "nothing written yet, nothing to copy");
});

test("a question sent but not yet acknowledged disables the box and says Asking", () => {
  const html = render({ open: true, asking: true });
  assert.match(inputFor(html, "Side question"), /disabled=""/);
  assert.match(html, />Asking…</);
});

test("an idle open panel has an enabled ask box", () => {
  const html = render({ open: true, records: [record("a", { answer: "Done." })] });
  assert.doesNotMatch(inputFor(html, "Side question"), /disabled/);
  assert.match(html, /placeholder="Ask a side question…"/);
  assert.match(html, />Ask</);
});

test("a finished topic shows its answer, Copy and a follow-up form", () => {
  const html = render({ open: true, records: [record("a", { answer: "A monad is a burrito." })] });
  assert.match(html, /A monad is a burrito\./);
  assert.match(html, />Answered</);
  assert.match(html, />Copy</);
  assert.match(html, /title="Copy the answer"/);
  assert.doesNotMatch(html, />Cancel</);
  assert.doesNotMatch(inputFor(html, "Follow-up question"), /disabled/);
  assert.match(html, /placeholder="Ask a follow-up…"/);
});

test("no follow-up form while any topic is being answered, even on a finished one", () => {
  const html = render({
    open: true,
    answering: true,
    records: [
      record("run", { status: "running", answer: "x" }),
      record("old", { answer: "An old answer." }),
    ],
  });
  assert.match(html, /An old answer\./);
  assert.doesNotMatch(html, /Follow-up question/);
});

test("a cancelled, interrupted or failed topic shows its note and cannot be followed up", () => {
  const cancelled = render({ open: true, records: [record("a", { status: "cancelled", answer: "Half an ans" })] });
  assert.match(cancelled, /This answer was cancelled\./);
  assert.match(cancelled, />Cancelled</);
  assert.match(cancelled, /Half an ans/);
  assert.doesNotMatch(cancelled, /Follow-up question/);

  const interrupted = render({ open: true, records: [record("a", { status: "interrupted" })] });
  assert.match(interrupted, /The engine stopped before this answer finished\./);
  assert.match(interrupted, />Interrupted</);
  assert.doesNotMatch(interrupted, /Follow-up question/);

  const failed = render({ open: true, records: [record("a", { status: "error", error: "rate limited" })] });
  assert.match(failed, /The answer failed: rate limited/);
  assert.match(failed, />Failed</);
  assert.doesNotMatch(failed, /Follow-up question/);

  const failedNoDetail = render({ open: true, records: [record("a", { status: "error" })] });
  assert.match(failedNoDetail, /The answer failed\./);
});

test("a topic whose first turn finished badly but has no answer hides Copy", () => {
  const html = render({ open: true, records: [record("a", { status: "cancelled", answer: "  " })] });
  assert.doesNotMatch(html, />Copy</);
});

test("more than three topics fold behind Show all, newest first", () => {
  const records = ["d", "c", "b", "a"].map((id, index) => record(id, { question: `Question ${id}`, createdAt: 10 - index }));
  const html = render({ open: true, records });
  assert.match(html, /Show all \(4\)/);
  assert.ok(html.indexOf("Question d") < html.indexOf("Question c"));
  assert.ok(html.indexOf("Question c") < html.indexOf("Question b"));
  assert.doesNotMatch(html, /Question a/);

  const few = render({ open: true, records: records.slice(0, 3) });
  assert.doesNotMatch(few, /Show all/);
});

test("follow-up turns render in order under their topic", () => {
  const html = render({
    open: true,
    records: [record("a", {
      question: "First question",
      answer: "First answer",
      followUps: [
        turn({ question: "Second question", answer: "Second answer" }),
        turn({ question: "Third question", answer: "Third answer" }),
      ],
    })],
  });
  const order = ["First question", "First answer", "Second question", "Second answer", "Third question", "Third answer"]
    .map((text) => html.indexOf(text));
  assert.ok(order.every((index) => index >= 0), "every turn renders");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((html.match(/<article/g) ?? []).length, 1, "one card for the whole topic");
});

test("the footer status and Cancel follow the LATEST turn of a topic", () => {
  const html = render({
    open: true,
    answering: true,
    records: [record("a", {
      answer: "First answer",
      followUps: [turn({ question: "Follow", status: "running", answer: "" })],
    })],
  });
  assert.match(html, />Answering…</);
  assert.match(html, />Cancel</);
  assert.match(html, /First answer/);
  assert.match(html, /Waiting for the first words…/);
});

test("questions are announced as questions for screen readers", () => {
  const html = render({ open: true, records: [record("a", { answer: "ok" })] });
  assert.match(html, /class="sr-only">Question: <\/span>What is a monad\?/);
});

test("an error shows as an alert with a dismiss button", () => {
  const html = render({ open: true, error: "Another side question is still answering." });
  assert.match(html, /role="alert"[^>]*>[\s\S]*Another side question is still answering\./);
  assert.match(html, />Dismiss</);
  assert.doesNotMatch(render({ open: true }), /role="alert"/);
});

test("an answer over 100,000 characters skips the markdown pipeline", () => {
  const html = render({ open: true, records: [record("a", { answer: `**${"x".repeat(100_001)}**` })] });
  assert.match(html, /<pre/);
  assert.match(html, /\*\*x/);
  assert.doesNotMatch(html, /<strong>/);
});

test("the body scrolls inside a capped height so a long thread never pushes the composer off a phone", () => {
  const html = render({ open: true, records: [record("a", { answer: "ok" })] });
  assert.match(html, /max-height:min\(36vh, 320px\);overflow-y:auto/);
});

test("the header cannot wrap on a 360px phone: one nowrap row whose summary ellipsises", () => {
  const html = render({ records: [record("a")], answering: true });
  const header = html.match(/<button[^>]*aria-expanded[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(header, /flex-wrap:nowrap/);
  assert.match(header, /whitespace-nowrap/);
  assert.match(header, /text-ellipsis/);
  assert.match(header, /overflow-hidden/);
});

test("inputs use 16px text and every control is at least 38px tall", () => {
  const html = render({ open: true, error: "oops", records: [record("a", { answer: "ok" })] });
  for (const label of ["Side question", "Follow-up question"]) {
    const input = inputFor(html, label);
    assert.match(input, /font-size:16px/);
    assert.match(input, /min-height:38px/);
  }
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 5);
  for (const button of buttons) assert.match(button, /min-height:38px/);
});
