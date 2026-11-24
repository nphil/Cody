import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * omp 19.1 runs the model's ask as ONE html form: a plain top-level `ask` call carrying `html`, a `form` dialog frame
 * for the host, and a result whose details list every answer. The entries and frames are recorded from the real
 * 19.1.0 engine (lib/fixtures/); the answered card and the dock read them with the same helpers as older engines.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { askAnswersFromDetails, askCallInput, askCallPreview } = await jiti.import("./ask-result.ts");
const { dialogBelongsToAsk } = await jiti.import("./ask-walk.ts");
const { parseHtmlForm } = await jiti.import("./ask-form.ts");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const entries = fixture("omp-19.1.0-ask-form-entries.json");
const frames = fixture("omp-19.1.0-ask-form-frames.json");
const call = entries[0].message.content.find((block) => block.type === "toolCall");
const result = entries[1].message;

test("omp 19.1: the model's ask is a plain top-level ask whose arguments are the form's html", () => {
  assert.equal(call.name, "ask");
  const input = askCallInput(call.name, call.arguments);
  assert.equal(typeof input.html, "string");
  const preview = askCallPreview(input, { more: (count) => `(+${count} more)` });
  assert.ok(preview.length > 0, "the card header says what was asked");
  assert.ok(!/[<>]/.test(preview), "and never shows markup");
});

test("omp 19.1: the answered card gets one row per answered field of the form, from the result's details", () => {
  assert.equal(result.toolName, "ask");
  assert.equal(result.isError, false);
  const named = new Set(parseHtmlForm(call.arguments.html).fields.filter((field) => field.name).map((field) => field.name));
  const { rows, notes, timedOut } = askAnswersFromDetails(result.details);
  assert.equal(timedOut, false);
  assert.deepEqual(notes, []);
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.ok(named.has(row.name), `${row.name} is a field of the form`);
    assert.ok(row.question && row.answer);
  }
});

test("omp 19.1: the form frame is a dialog of the ask and carries the html the model sent", () => {
  const [frame] = frames.uiFrames;
  assert.equal(frame.type, "extension_ui_request");
  assert.equal(frame.method, "form");
  assert.match(frame.id, /^[0-9a-f]{16}$/);
  assert.equal(frame.html, call.arguments.html);
  assert.equal(dialogBelongsToAsk(frame, false), true, "it needs no running-tool check, unlike omp 18.x's field-by-field dialogs");
  assert.deepEqual(frames.ready.supportedProtocolVersions, [1, 2]);
});

// ---- omp 19.1.1: a fieldset of radios that each carry their own name is refused before any form ------------------

const split = fixture("omp-19.1.1-ask-split-radios.json");
const [refused, shared] = split.cases;

test("omp 19.1.1: radios with one name each are refused with plain text and no form frame, so no dock opens", () => {
  assert.equal(refused.formFrameOn19_1_1, null, "the engine answers before it sends a form request");
  assert.equal(refused.formFrameOn19_1_0.method, "form", "omp 19.1.0 sent the same html as a form request");
  const [end] = refused.toolEnd;
  assert.equal(end.toolName, "ask");
  assert.equal(end.isError, false);
  const [, toolResult] = refused.entries.map((entry) => entry.message);
  assert.equal(toolResult.toolName, "ask");
  assert.match(toolResult.content[0].text, /^Error: a <fieldset> holds radios that each carry a different `name`/);
  // The card has no answers to list, so it keeps the call's own arguments and the engine's text (MessageView shows both).
  const { rows, notes, timedOut } = askAnswersFromDetails(toolResult.details);
  assert.deepEqual([rows, notes, timedOut], [[], [], false]);
});

test("omp 19.1.1: radios that share one name still arrive as a form request carrying the model's html", () => {
  assert.equal(shared.formFrameOn19_1_1.method, "form");
  assert.equal(shared.formFrameOn19_1_1.sameHtml, true);
  const form = parseHtmlForm(shared.html);
  assert.deepEqual(form.fields.map((field) => field.name), ["store"]);
});
