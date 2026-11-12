import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The `ask` card's pure half: both omp result shapes (18.19 answers[] and 18.8
 * selectedOptions / results[]) end up as the same rows, password answers are
 * found in the call's form HTML, and the header preview never shows markup.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { askAnswersFromDetails, askAnswerShown, askCallPreview, passwordFieldNames, keepAskToolResultDetails, ASK_NO_ANSWER } =
  await jiti.import("./ask-result.ts");

const labels = { more: (count) => `(+${count} more)` };

test("18.19 details: answers, notes and timedOut", () => {
  const out = askAnswersFromDetails({
    answers: [{ name: "plan", question: "Which plan?", answer: "Pro" }, { question: "bad" }, "junk"],
    notes: [{ name: "plan", question: "Which plan?", option: "Pro", value: "pro", text: "annual" }, { text: "no question" }],
    timedOut: true,
  });
  assert.deepEqual(out.rows, [{ question: "Which plan?", answer: "Pro", name: "plan" }]);
  assert.deepEqual(out.notes, [{ question: "Which plan?", option: "Pro", text: "annual", name: "plan" }]);
  assert.equal(out.timedOut, true);
});

test("18.8 single question details", () => {
  const out = askAnswersFromDetails({ question: "Pick", options: [{ label: "A" }], selectedOptions: ["A", "B"], customInput: "mine", note: "why", timedOut: true });
  assert.deepEqual(out.rows, [{ question: "Pick", answer: 'A, B + "mine"' }]);
  assert.deepEqual(out.notes, [{ question: "Pick", option: "", text: "why" }]);
  assert.equal(out.timedOut, true);
});

test("18.8 several questions details, with an unanswered one", () => {
  const out = askAnswersFromDetails({
    results: [
      { id: "q1", question: "One?", selectedOptions: ["A"] },
      { id: "q2", question: "Two?", selectedOptions: [] },
      { id: "q3", question: "Three?", selectedOptions: [], customInput: "typed", timedOut: true },
    ],
  });
  assert.deepEqual(out.rows.map((row) => row.answer), ["A", ASK_NO_ANSWER, '"typed"']);
  assert.equal(out.timedOut, true);
});

test("cancelled, empty or malformed details yield nothing", () => {
  for (const details of [undefined, null, "x", 3, [], {}, { cancelled: true }, { answers: [] }, { answers: "no" }, { results: [1, null] }]) {
    const out = askAnswersFromDetails(details);
    assert.deepEqual(out.rows, [], JSON.stringify(details));
    assert.equal(out.timedOut, false);
  }
});

test("password fields are found by name, whatever the quoting or order", () => {
  const html = `<form>
    <input type="text" name="user">
    <input name='pw' type='password'>
    <INPUT TYPE=password NAME=token>
    <input type="password" data-name="x" name="a>b">
    <input type="passwordish" name="nope">
    <input type="checkbox" name="remember">
  </form>`;
  assert.deepEqual([...passwordFieldNames(html)].sort(), ["a>b", "pw", "token"]);
  assert.equal(passwordFieldNames(undefined).size, 0);
  assert.equal(passwordFieldNames({ not: "a string" }).size, 0);
});

test("a password answer shows as bullets, never the typed value", () => {
  const passwords = new Set(["pw"]);
  assert.equal(askAnswerShown({ question: "Password?", answer: "hunter2", name: "pw" }, passwords), "•••••••");
  assert.equal(askAnswerShown({ question: "Password?", answer: "x".repeat(100), name: "pw" }, passwords), "•".repeat(12));
  assert.equal(askAnswerShown({ question: "User?", answer: "bob", name: "user" }, passwords), "bob");
  assert.equal(askAnswerShown({ question: "User?", answer: "bob" }, passwords), "bob");
});

test("call preview: first 18.8 question plus +N more; never HTML or [object Object]", () => {
  assert.equal(askCallPreview({ questions: [{ question: "Which db?" }] }, labels), "Which db?");
  assert.equal(askCallPreview({ questions: [{ question: "Which db?" }, { question: "Why?" }, { question: "When?" }] }, labels), "Which db? (+2 more)");
  const form = '<form><label>Token <input type="password" name="t" value="s3cret"></label></form>';
  const fromForm = askCallPreview({ html: form }, labels);
  assert.doesNotMatch(fromForm, /[<>]/);
  assert.doesNotMatch(fromForm, /s3cret/);
  assert.equal(askCallPreview({ i: "Collecting the token", html: form }, labels), "Collecting the token");
  assert.equal(askCallPreview({ html: "<form><legend>A &amp; B</legend></form>" }, labels), "A & B");
  assert.equal(askCallPreview({ html: "x".repeat(500) }, labels).length <= 100, true);
  for (const input of [undefined, null, "s", [], {}, { questions: [] }, { questions: [{}] }, { html: 5 }]) {
    const preview = askCallPreview(input, labels);
    assert.equal(preview, "");
    assert.doesNotMatch(String(preview), /object Object/);
  }
});

test("history projection keeps only the whitelisted, bounded keys", () => {
  const kept = keepAskToolResultDetails({
    answers: Array.from({ length: 80 }, (_, i) => ({ name: `n${i}`, question: "q", answer: "a", extra: 1 })),
    timedOut: true,
    html: "<form></form>",
  });
  assert.equal(kept.answers.length, 50);
  assert.equal("extra" in kept.answers[0], false);
  assert.equal(kept.timedOut, true);
  assert.equal("html" in kept, false);
  assert.equal(keepAskToolResultDetails({ cancelled: true }), null);
});
