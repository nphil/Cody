import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SidebarSideQuestions } = await jiti.import("./SidebarSideQuestions.tsx");

const noop = () => {};

function turn(overrides = {}) {
  return { question: "What is a monad?", answer: "", status: "complete", createdAt: 1, updatedAt: 1, ...overrides };
}

function record(id, overrides = {}) {
  return { ...turn(), id, leafId: null, ...overrides };
}

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(SidebarSideQuestions, {
    records: [],
    answering: false,
    asking: false,
    error: null,
    onDismissError: noop,
    onAsk: async () => true,
    onCancel: noop,
    visible: true,
    focusPending: false,
    onFocused: noop,
    ...props,
  }));
}

/** An element carrying this aria-label, as markup. */
function elementFor(html, tag, label) {
  const match = html.match(new RegExp(`<${tag}[^>]*aria-label="${label}"[^>]*>`));
  assert.ok(match, `${tag} "${label}" is rendered`);
  return match[0];
}

test("before anything is asked it says what this is and offers an empty, usable box", () => {
  const html = render();
  assert.match(html, /Ask about this chat while it keeps working\. Answers stay here and never join the conversation\./);
  const box = elementFor(html, "textarea", "Side question");
  assert.match(box, /placeholder="Ask about this chat…"/);
  assert.doesNotMatch(box, /readOnly/);
  assert.doesNotMatch(box, /disabled/);
  assert.match(elementFor(html, "button", "Ask"), /disabled=""/, "nothing typed, nothing to send");
  assert.doesNotMatch(html, /<article/);
});

test("side questions are text only: the box has no attach control", () => {
  assert.doesNotMatch(render(), /type="file"/);
});

test("an answering topic streams its text and offers Cancel, but no follow-up", () => {
  const html = render({
    answering: true,
    records: [record("a", { status: "running", answer: "Partial **words**" })],
  });
  assert.match(html, /Partial <strong>words<\/strong>/);
  assert.match(html, /What is a monad\?/);
  assert.match(html, />Cancel</);
  assert.match(html, /title="Stop this answer"/);
  assert.match(html, />Answering…</);
  assert.match(html, /live-status-dot live-pulse/);
  assert.doesNotMatch(html, /Follow-up question/);
  assert.match(html, />Copy</, "words already written can be copied");
});

test("while one is being answered the box stays editable but cannot send, and says why", () => {
  const html = render({ answering: true, records: [record("a", { status: "running", answer: "x" })] });
  assert.doesNotMatch(elementFor(html, "textarea", "Side question"), /readOnly|disabled/);
  const send = elementFor(html, "button", "Ask");
  assert.match(send, /disabled=""/);
  assert.match(send, /title="Another side question is still answering\. Wait for it, or cancel it first\."/);
});

test("a running topic with no words yet says so and has nothing to copy", () => {
  const html = render({ answering: true, records: [record("a", { status: "running", answer: "" })] });
  assert.match(html, /Waiting for the first words…/);
  assert.doesNotMatch(html, />Copy</);
});

test("a question sent but not yet taken makes the box read-only and the button say Asking", () => {
  const html = render({ asking: true });
  assert.match(elementFor(html, "textarea", "Side question"), /readOnly=""/);
  assert.match(elementFor(html, "button", "Asking…"), /disabled=""/);
});

test("a finished topic shows its answer, Copy and a follow-up form", () => {
  const html = render({ records: [record("a", { answer: "A monad is a burrito." })] });
  assert.match(html, /A monad is a burrito\./);
  assert.match(html, />Answered</);
  assert.match(html, />Copy</);
  assert.match(html, /title="Copy the answer"/);
  assert.doesNotMatch(html, />Cancel</);
  assert.match(elementFor(html, "input", "Follow-up question"), /placeholder="Ask a follow-up…"/);
  assert.doesNotMatch(html, /Waiting for the first words/);
  assert.doesNotMatch(html, /Ask about this chat while it keeps working/, "the hint is only for an empty list");
});

test("no follow-up form while any topic is being answered, even on a finished one", () => {
  const html = render({
    answering: true,
    records: [
      record("run", { status: "running", answer: "x" }),
      record("old", { answer: "An old answer." }),
    ],
  });
  assert.match(html, /An old answer\./);
  assert.doesNotMatch(html, /Follow-up question/);
});

test("no follow-up form while a question is waiting to be taken", () => {
  const html = render({ asking: true, records: [record("old", { answer: "An old answer." })] });
  assert.match(html, /An old answer\./);
  assert.doesNotMatch(html, /Follow-up question/);
});

test("a cancelled, interrupted or failed topic says so once, and cannot be followed up", () => {
  // The footer line is the status; a note appears only when it adds something the footer cannot say.
  const cancelled = render({ records: [record("a", { status: "cancelled", answer: "Half an ans" })] });
  assert.match(cancelled, />Cancelled</);
  assert.doesNotMatch(cancelled, /This answer was cancelled/);
  assert.match(cancelled, /Half an ans/);
  assert.doesNotMatch(cancelled, /Follow-up question/);

  const interrupted = render({ records: [record("a", { status: "interrupted" })] });
  assert.match(interrupted, /The engine stopped before this answer finished\./);
  assert.match(interrupted, />Interrupted</);
  assert.doesNotMatch(interrupted, /Follow-up question/);

  const failed = render({ records: [record("a", { status: "error", error: "rate limited" })] });
  assert.match(failed, />rate limited</, "the reason, not a second 'failed'");
  assert.doesNotMatch(failed, /The answer failed/);
  assert.match(failed, />Failed</);
  assert.doesNotMatch(failed, /Follow-up question/);

  const noReason = render({ records: [record("a", { status: "error" })] });
  assert.match(noReason, />Failed</);
  assert.doesNotMatch(noReason, /The answer failed/);
});

test("a topic whose first turn finished badly but has no answer hides Copy", () => {
  assert.doesNotMatch(render({ records: [record("a", { status: "cancelled", answer: "  " })] }), />Copy</);
});

test("topics are listed newest first, and past ten the rest fold behind Show all", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `t${String(11 - index).padStart(2, "0")}`);
  const records = ids.map((id, index) => record(id, { question: `Question ${id}`, createdAt: 100 - index }));
  const html = render({ records });
  assert.match(html, /Show all \(12\)/);
  assert.ok(html.indexOf("Question t11") < html.indexOf("Question t10"), "newest first");
  assert.ok(html.indexOf("Question t10") < html.indexOf("Question t02"));
  assert.match(html, /Question t02/, "the tenth newest still shows");
  assert.doesNotMatch(html, /Question t01/);
  assert.doesNotMatch(html, /Question t00/);
  assert.equal((html.match(/<article/g) ?? []).length, 10);

  const few = render({ records: records.slice(0, 10) });
  assert.doesNotMatch(few, /Show all/);
});

test("follow-up turns render in order under their topic", () => {
  const html = render({
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
  const html = render({ records: [record("a", { answer: "ok" })] });
  assert.match(html, /class="sr-only">Question: <\/span>What is a monad\?/);
});

test("an error shows as an alert with a dismiss button, just above the box", () => {
  const html = render({ error: "Another side question is still answering." });
  assert.match(html, /role="alert"[^>]*>[\s\S]*Another side question is still answering\./);
  assert.match(html, />Dismiss</);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
  assert.doesNotMatch(render(), /role="alert"/);
});

test("an answer over 100,000 characters skips the markdown pipeline", () => {
  const html = render({ records: [record("a", { answer: `**${"x".repeat(100_001)}**` })] });
  assert.match(html, /<pre/);
  assert.match(html, /\*\*x/);
  assert.doesNotMatch(html, /<strong>/);
});

test("the box is the Side Bar's own composer: a growing text area with a send button, 16px on touch", () => {
  const html = render({ records: [record("a", { answer: "ok" })] });
  const box = elementFor(html, "textarea", "Side question");
  assert.match(box, /class="composer-textarea"/, "the class that holds the text at 16px on a touch screen");
  assert.match(box, /field-sizing:content/);
  assert.match(html, /class="chat-input-shell"/, "the same focus glow as the main composer");
});

test("on a phone the follow-up box uses 16px text and every control in a topic is at least 38px tall", () => {
  const html = render({ touch: true, error: "oops", records: [record("a", { answer: "ok" })] });
  const followUp = elementFor(html, "input", "Follow-up question");
  assert.match(followUp, /font-size:16px/);
  assert.match(followUp, /min-height:38px/);
  const buttons = (html.match(/<button[^>]*>/g) ?? []).filter((button) => !/aria-label="Ask"/.test(button));
  assert.equal(buttons.length, 3, "Copy, the follow-up Ask and Dismiss (the composer's Send is sized separately)");
  for (const button of buttons) assert.match(button, /min-height:38px/);
  assert.match(elementFor(html, "button", "Ask"), /width:38px;height:38px/);
});

test("with a mouse the same controls shrink to the 30px the New chat composer's Send button uses", () => {
  const html = render({ touch: false, error: "oops", records: [record("a", { answer: "ok" })] });
  const followUp = elementFor(html, "input", "Follow-up question");
  assert.match(followUp, /font-size:13px/);
  assert.match(followUp, /min-height:30px/);
  const buttons = (html.match(/<button[^>]*>/g) ?? []).filter((button) => !/aria-label="Ask"/.test(button));
  for (const button of buttons) assert.match(button, /min-height:30px/);
  assert.match(elementFor(html, "button", "Ask"), /width:30px;height:30px/);
});
