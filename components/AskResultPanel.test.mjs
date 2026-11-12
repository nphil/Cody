import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The `ask` answers card: the same rows for omp 18.19 and 18.8 results, a
 * timed-out badge, password answers masked, and nothing injected as markup.
 * MessageView's wiring is pinned at the source (house style).
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AskResultPanel } = await jiti.import("./AskResultPanel.tsx");

const render = (props) => renderToStaticMarkup(React.createElement(AskResultPanel, props));

test("18.19 answers render question over answer, with notes under their option", () => {
  const html = render({
    details: {
      answers: [
        { name: "plan", question: "Which plan?", answer: "Pro" },
        { name: "skip", question: "Anything else?", answer: "" },
      ],
      notes: [{ name: "plan", question: "Which plan?", option: "Pro", value: "pro", text: "billed yearly" }],
    },
    input: { i: "Ask", html: '<form><input name="plan"></form>' },
  });
  assert.match(html, /Which plan\?/);
  assert.match(html, />Pro</);
  assert.match(html, /Pro: billed yearly/);
  assert.match(html, /\(no answer\)/);
  assert.doesNotMatch(html, /Timed out/);
});

test("18.8 single and several-question results render the same way", () => {
  const single = render({ details: { question: "Pick one", options: [{ label: "A" }], selectedOptions: ["A"], note: "because" }, input: { questions: [] } });
  assert.match(single, /Pick one/);
  assert.match(single, />A</);
  assert.match(single, /Note: because/);

  const many = render({
    details: {
      results: [
        { id: "q1", question: "First?", selectedOptions: ["A", "B"] },
        { id: "q2", question: "Second?", selectedOptions: [], customInput: "typed" },
      ],
    },
  });
  assert.match(many, /First\?/);
  assert.match(many, /A, B/);
  assert.match(many, /Second\?/);
  assert.match(many, /&quot;typed&quot;/);
});

test("a timed-out ask shows the badge", () => {
  const html = render({ details: { answers: [{ name: "a", question: "Q?", answer: "preselected" }], timedOut: true } });
  assert.match(html, /role="status"/);
  assert.match(html, /Timed out/);
});

test("a password answer is masked and never present in clear text", () => {
  const html = render({
    details: { answers: [{ name: "pw", question: "Password?", answer: "hunter2" }, { name: "user", question: "User?", answer: "bob" }] },
    input: { html: '<form><input type="password" name="pw"><input type="text" name="user"></form>' },
  });
  assert.doesNotMatch(html, /hunter2/);
  assert.match(html, /•••••••/);
  assert.match(html, />bob</);
});

test("model-authored text is escaped, never injected as markup", () => {
  const html = render({ details: { answers: [{ name: "x", question: "<img src=x onerror=alert(1)>", answer: "<b>bold</b>" }] } });
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;bold/);
});

test("nothing understood renders nothing", () => {
  for (const details of [undefined, null, {}, { cancelled: true }, { answers: [] }]) {
    assert.equal(render({ details }), "");
  }
});

test("MessageView uses the panel and the preview for the ask tool", async () => {
  const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ AskResultPanel \} from "\.\/AskResultPanel"/);
  assert.match(source, /block\.toolName === "ask"[^;]*askAnswersFromDetails\(result\.details\)\.rows\.length > 0/s);
  assert.match(source, /<AskResultPanel details=\{result\.details\} input=\{block\.input\} \/>/);
  assert.match(source, /block\.toolName === "ask"\)\s*\{\s*const preview = askCallPreview\(/);
});
