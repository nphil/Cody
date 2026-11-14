import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The `ask` card's pure half: both omp result shapes (18.19 answers[] and 18.8
 * selectedOptions / results[]) end up as the same rows, password answers are
 * found in the call's form HTML, and the header preview never shows markup.
 * omp 18.19 and 18.20 run the model's ask as `write xd://ask`; those results and
 * calls (recorded from real engines, lib/fixtures/) read the same way.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  askAnswersFromDetails, askAnswerShown, askCallInput, askCallPreview, isAskXdevDetails, passwordFieldNames,
  keepAskToolResultDetails, ASK_NO_ANSWER,
} = await jiti.import("./ask-result.ts");

/** The two session entries (the assistant's `write xd://ask` call, then its tool result) an engine wrote. */
const recorded = (version) => JSON.parse(readFileSync(new URL(`./fixtures/omp-${version}-ask-xdev-entries.json`, import.meta.url), "utf8"));
const recordedCall = (version) => recorded(version)[0].message.content.find((block) => block.type === "toolCall");
const recordedDetails = (version) => recorded(version)[1].message.details;
const RECORDED_ROWS = [
  { question: "Which plan do you want?", answer: "Team", name: "plan" },
  { question: "Which extras should be switched on?", answer: "Export, Alerts, Other: Weekly digest", name: "extras" },
  { question: "Anything else we should know?", answer: "Please keep it quiet.\nThanks.", name: "notes" },
];

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

test("a recorded `write xd://ask` call and result read as the same ask card on omp 18.20 and 18.19", () => {
  for (const version of ["18.20.0", "18.19.0"]) {
    const call = recordedCall(version);
    assert.equal(call.name, "write", version);
    assert.equal(call.arguments.path, "xd://ask", version);
    const input = askCallInput(call.name, call.arguments);
    assert.match(input.html, /^<form>/, version);
    // the intent sits beside `path` on the write; the ask's own args are the JSON text in `content`
    assert.equal(input.i, "Asking the owner", version);
    assert.equal(askCallPreview(input, labels), "Asking the owner", version);

    const details = recordedDetails(version);
    assert.equal(details.xdev.tool, "ask", version);
    assert.equal(isAskXdevDetails(details), true, version);
    const out = askAnswersFromDetails(details);
    assert.deepEqual(out.rows, RECORDED_ROWS, version);
    assert.equal(out.timedOut, false, version);
  }
});

test("the header preview of an xd://ask call falls back to the form's text, as a plain ask's does", () => {
  const call = recordedCall("18.20.0");
  const withoutIntent = { path: call.arguments.path, content: call.arguments.content };
  const preview = askCallPreview(askCallInput("write", withoutIntent), labels);
  assert.match(preview, /^Project setup /);
  assert.doesNotMatch(preview, /[<>]/);
  // an intent inside the ask's own content wins over the write's
  const inner = { path: "xd://ask", content: JSON.stringify({ html: "<form></form>", i: "Inner intent" }), i: "Outer intent" };
  assert.equal(askCallPreview(askCallInput("write", inner), labels), "Inner intent");
});

test("askCallInput: plain asks are untouched, other calls are not asks, unreadable content gives no arguments", () => {
  const plain = { html: "<form></form>", i: "Plain" };
  assert.equal(askCallInput("ask", plain), plain);
  assert.deepEqual(askCallInput("ask", undefined), {});
  assert.deepEqual(askCallInput("ask", "junk"), {});
  assert.equal(askCallInput("write", { path: "xd://github", content: "{}" }), null);
  assert.equal(askCallInput("write", { path: "notes.txt", content: "xd://ask" }), null);
  assert.equal(askCallInput("bash", { path: "xd://ask" }), null);
  assert.equal(askCallInput(undefined, undefined), null);
  // still an ask, only without arguments: a call that streams in has cut-off JSON, a model may write anything
  for (const content of ['{"html":"<form><p>Wh', "not json", "[1,2]", "7", "null", undefined, 5]) {
    assert.deepEqual(askCallInput("write", { path: "xd://ask", content }), {}, String(content));
  }
  assert.deepEqual(askCallInput("write", { path: " XD://Ask ", content: '{"html":"<form></form>"}' }), { html: "<form></form>" });
  assert.equal(askCallPreview(askCallInput("write", { path: "xd://ask", content: '{"html":"<form><p>Wh' }), labels), "");
});

test("a password field in an xd://ask form is found, so its answer still shows as bullets", () => {
  const html = '<form><input type="password" name="pw"><input name="user"></form>';
  const input = askCallInput("write", { path: "xd://ask", content: JSON.stringify({ html }) });
  assert.deepEqual([...passwordFieldNames(input.html)], ["pw"]);
});

test("history projection of an xd://ask result: the bounded answers under xdev.inner, none of the envelope", () => {
  for (const version of ["18.20.0", "18.19.0"]) {
    const kept = keepAskToolResultDetails(recordedDetails(version));
    assert.deepEqual(kept, { xdev: { tool: "ask", inner: { answers: RECORDED_ROWS } } }, version);
    assert.deepEqual(askAnswersFromDetails(kept).rows, RECORDED_ROWS, version);
  }
  const big = keepAskToolResultDetails({
    xdev: {
      tool: "ask",
      mode: "execute",
      args: { html: "x".repeat(9000) },
      inner: { answers: Array.from({ length: 80 }, (_, i) => ({ name: `n${i}`, question: "q", answer: "a", extra: 1 })), timedOut: true },
    },
  });
  assert.equal(big.xdev.inner.answers.length, 50);
  assert.equal("extra" in big.xdev.inner.answers[0], false);
  assert.equal(big.xdev.inner.timedOut, true);
  assert.deepEqual(Object.keys(big.xdev).sort(), ["inner", "tool"]);
});

test("only a `write xd://ask` that ran has answers: a help read, a failed dispatch or another device has none", () => {
  const help = { xdev: { tool: "ask", mode: "help" } };
  const failed = { xdev: { tool: "ask", mode: "execute", args: { html: "<form></form>" } } };
  const cancelled = { xdev: { tool: "ask", mode: "execute", inner: { cancelled: true } } };
  const other = { xdev: { tool: "github", mode: "execute", inner: { answers: [{ question: "q", answer: "a" }] } } };
  for (const details of [help, failed, cancelled, other]) {
    assert.deepEqual(askAnswersFromDetails(details).rows, [], JSON.stringify(details));
  }
  for (const details of [help, failed, other]) {
    assert.equal(isAskXdevDetails(details), false, JSON.stringify(details));
    assert.equal(keepAskToolResultDetails(details), null, JSON.stringify(details));
  }
  assert.equal(isAskXdevDetails(cancelled), true);
  assert.equal(keepAskToolResultDetails(cancelled), null);
  for (const junk of [undefined, null, "x", 3, [], { xdev: "ask" }, { xdev: { tool: "ask", inner: [] } }]) {
    assert.equal(isAskXdevDetails(junk), false, JSON.stringify(junk));
  }
});
