import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * omp 19.1's `ask` sends the model's HTML form as ONE `form` request and THROWS (failing the model's tool call) on
 * any answer that does not fit the form it parsed itself. These tests replay verdicts recorded from the real
 * omp 19.1.0 binary (lib/fixtures/omp-19.1.0-ask-form-cases.json) against Cody's port of the parser and the
 * acceptance rules, so a drift between the two shows up here instead of as a failed tool call in a chat.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseHtmlForm, parseFormSubmission, formDataError, formAnswers, defaultFormData, choiceValue, textValue, fieldError, fieldQuestions, isArrayChoice } = await jiti.import("./ask-form.ts");
const { spansText } = await jiti.import("./ask-form-parse.ts");
const { parseHtml, decodeEntities, outerHtml } = await jiti.import("./ask-form-dom.ts");
const recorded = JSON.parse(readFileSync(new URL("./fixtures/omp-19.1.0-ask-form-cases.json", import.meta.url), "utf8"));

test("Cody's check gives the verdict, the text and the answers the real omp 19.1.0 gave, for every recorded case", () => {
  assert.ok(recorded.cases.length >= 60);
  for (const recordedCase of recorded.cases) {
    if (recordedCase.cancel) continue;
    const form = parseHtmlForm(recorded.forms[recordedCase.form]);
    const parsed = parseFormSubmission(form, recordedCase.data);
    if (recordedCase.isError) {
      assert.ok("error" in parsed, `${recordedCase.id}: omp rejected it, Cody accepted it`);
      assert.equal(parsed.error, recordedCase.text, recordedCase.id);
      continue;
    }
    assert.ok("data" in parsed, `${recordedCase.id}: omp accepted it, Cody rejected it: ${parsed.error}`);
    assert.equal(`User answers:\n${JSON.stringify(parsed.data, null, 2)}`, recordedCase.text, recordedCase.id);
    assert.deepEqual(formAnswers(form, parsed.data), recordedCase.details.answers, recordedCase.id);
  }
});

test("the data the view starts from is what was recorded, and omp's verdict on it is Cody's", () => {
  for (const recordedCase of recorded.cases.filter((entry) => entry.id.startsWith("view-default-"))) {
    const form = parseHtmlForm(recorded.forms[recordedCase.form]);
    assert.deepEqual({ ...defaultFormData(form) }, recordedCase.data, recordedCase.id);
    assert.equal(formDataError(form, defaultFormData(form)), recordedCase.isError ? recordedCase.text : undefined, recordedCase.id);
  }
});

test("cancelling is recorded as omp's aborting error (the view answers it with {cancelled:true})", () => {
  const cancelled = recorded.cases.find((entry) => entry.cancel);
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.text, /cancelled/i);
});

const FORM = (body) => parseHtmlForm(`<form>${body}</form>`);

test("sections, blocks and groups: fieldsets titled by their legend, one group per type+name, text between options kept", () => {
  const form = parseHtmlForm(recorded.forms.rich);
  const [loose, ...fieldsets] = form.sections;
  assert.equal(loose.fieldset, false);
  assert.deepEqual(loose.blocks.map((block) => block.kind), ["text", "text", "list", "list", "pre", "table", "image"]);
  assert.equal(loose.blocks[0].heading, true);
  assert.deepEqual(loose.blocks[1].spans.map((span) => span.style ?? "plain"), ["plain", "strong", "plain", "em", "plain", "code", "plain"]);
  assert.equal(loose.blocks[2].ordered, false);
  assert.equal(loose.blocks[3].ordered, true);
  assert.equal(loose.blocks[4].text, "ALTER TABLE users ADD COLUMN plan text;\nUPDATE users SET plan = 'free';");
  assert.equal(loose.blocks[5].headerRows, 1);
  assert.equal(loose.blocks[5].rows.length, 3);
  assert.equal(loose.blocks[6].alt, "Diagram of the two paths");
  assert.match(loose.blocks[6].src, /^data:image\/png;base64,/);
  assert.deepEqual(fieldsets.filter((section) => section.fieldset).map((section) => spansText(section.title)), ["How should we migrate?", "Which checks should run?"]);
  assert.equal(fieldsets.at(-1).fieldset, false, "the textarea after the last fieldset sits in a loose section");
  assert.deepEqual(form.fields.map((field) => [field.name, field.kind, field.kind === "choice" ? field.multi : field.multiline]), [["path", "choice", false], ["checks", "choice", true], ["comments", "text", true]]);
  const split = FORM(`<p>Pick</p><input type="radio" name="a" value="1"> One <p>between</p><input type="radio" name="a" value="2"> Two`);
  assert.equal(split.fields.length, 1);
  assert.equal(split.fields[0].options.length, 2);
  const block = split.sections[0].blocks.find((entry) => entry.kind === "field");
  assert.equal(block.optionsEnd, 4);
});

test("Other: added to radio/checkbox groups of 2+ options unless one is already labelled Other", () => {
  const form = parseHtmlForm(recorded.forms.other);
  assert.deepEqual(form.fields.map((field) => [field.name, field.other]), [["db", true], ["langs", false], ["own", false]]);
  assert.equal(FORM(`<label><input type="checkbox" name="solo" value="x"> Only</label>`).fields[0].other, false);
  assert.equal(FORM(`<select name="s"><option>a</option><option>b</option></select>`).fields[0].other, false);
});

test("labels: wrapping label, label for, aria-label, title, then the name", () => {
  const form = FORM(`
    <label for="a">From for</label><input id="a" name="a">
    <label>Wrapped <input name="b"></label>
    <input name="c" aria-label="From aria">
    <input name="d" title="From title">
    <input name="sentry_dsn-url">`);
  assert.deepEqual(form.fields.map((field) => spansText(field.label)), ["From for", "Wrapped", "From aria", "From title", "sentry dsn url"]);
});

test("the question of a field: own label, preceding text, section title, lone option, name", () => {
  const form = parseHtmlForm(recorded.forms.req);
  const questions = fieldQuestions(form);
  assert.deepEqual(form.fields.map((field) => questions.get(field)), ["Environment", "Regions", "Contact email", "Replicas (1 to 10)", "Service slug", "Size", "Notes"]);
  const lone = FORM(`<p>Intro</p><input type="checkbox" name="agree" value="y"> I agree`);
  assert.equal(fieldQuestions(lone).get(lone.fields[0]), "Intro");
  const alone = FORM(`<label><input type="checkbox" name="agree" value="y"> I agree</label>`);
  assert.equal(fieldQuestions(alone).get(alone.fields[0]), "I agree");
});

test("controls: select defaults, hidden inputs, ignored input types, disabled options", () => {
  const form = parseHtmlForm(recorded.forms.sel);
  const [size, tags, role] = form.fields;
  assert.equal(size.select, true);
  assert.deepEqual(size.options.map((option) => option.checked), [true, false, false]);
  assert.equal(tags.multi, true);
  assert.deepEqual(tags.options.map((option) => option.checked), [false, true, false]);
  assert.equal(role.required, true);
  assert.deepEqual(role.options.map((option) => [option.checked, option.disabled]), [[true, true], [false, false], [false, false]]);
  const mixed = FORM(`<input type="hidden" name="h" value="1"><input type="submit"><input type="file" name="f"><button name="b">Go</button><input name="">`);
  assert.deepEqual(mixed.hidden, [["h", "1"]]);
  assert.deepEqual(mixed.fields.map((field) => field.name), [""]);
});

test("values: choiceValue / textValue / isArrayChoice follow omp", () => {
  const group = FORM(`<input type="checkbox" name="g" value="a"><input type="checkbox" name="g" value="b" disabled><input type="checkbox" name="g" value="c">`).fields[0];
  assert.equal(isArrayChoice(group), true);
  assert.deepEqual(choiceValue(group, new Set([0, 1, 2])), ["a", "c"]);
  assert.deepEqual(choiceValue(group, new Set(), "  free "), ["free"]);
  const radio = FORM(`<input type="radio" name="r" value="a"><input type="radio" name="r" value="b">`).fields[0];
  assert.equal(choiceValue(radio, new Set([1])), "b");
  assert.equal(choiceValue(radio, new Set([1]), "typed"), "typed");
  assert.equal(choiceValue(radio, new Set([1]), "   "), "b");
  assert.equal(choiceValue(radio, new Set()), undefined);
  const lone = FORM(`<input type="checkbox" name="one" value="yes">`).fields[0];
  assert.equal(isArrayChoice(lone), false);
  assert.equal(choiceValue(lone, new Set([0])), "yes");
  const number = FORM(`<input type="number" name="n">`).fields[0];
  assert.equal(textValue(number, " 4 "), 4);
  assert.equal(textValue(number, ""), "");
  assert.equal(textValue(number, "x"), "x");
});

test("field rules: required, range, length, email, url, pattern (anchored; an invalid pattern is ignored like omp does)", () => {
  const f = (attrs, type = "text") => FORM(`<input type="${type}" name="x" ${attrs}>`).fields[0];
  assert.equal(fieldError(f("required"), "  "), "Required");
  assert.equal(fieldError(f(""), "  "), undefined);
  assert.equal(fieldError(f("min=2 max=4", "number"), 5), "Must be at most 4");
  assert.equal(fieldError(f("min=2 max=4", "number"), "x"), "Enter a number");
  assert.equal(fieldError(f("minlength=3"), "ab"), "Needs at least 3 characters");
  assert.equal(fieldError(f("", "email"), "a@b"), undefined);
  assert.equal(fieldError(f("", "email"), "a b"), "Enter an email address");
  assert.equal(fieldError(f("", "url"), "nope"), "Enter a full URL");
  assert.equal(fieldError(f("", "url"), "https://example.com/x"), undefined);
  assert.equal(fieldError(f('pattern="[a-z]+"'), "abc"), undefined);
  assert.equal(fieldError(f('pattern="[a-z]+"'), "abc1"), "Must match [a-z]+");
  assert.equal(fieldError(f('pattern="[a-z0-9-]+"'), "My Service"), undefined, "invalid under the v flag: omp ignores it");
  assert.equal(fieldError(f('pattern="(["'), "anything"), undefined);
});

test("the HTML reader: implicit closing, void tags, entities, svg case, comments, raw script text", () => {
  const form = FORM(`<p>One<p>Two<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><td>3</table><select name="s"><option>x<option>y</select>`);
  assert.deepEqual(form.sections[0].blocks.map((block) => block.kind), ["text", "text", "list", "table", "field"]);
  assert.equal(form.sections[0].blocks[3].rows.length, 2);
  assert.deepEqual(form.fields[0].options.map((option) => option.value), ["x", "y"]);
  assert.equal(decodeEntities("a &amp; b &#x41; &#65; &eacute; &unknown; &#0;"), "a & b A A \u00e9 &unknown; \ufffd");
  const [svgBlock] = FORM(`<svg viewBox="0 0 10 10"><title>Dot</title><circle cx="5" cy="5" r="4"/><linearGradient id="g"/></svg>`).sections[0].blocks;
  assert.equal(svgBlock.kind, "svg");
  assert.equal(svgBlock.alt, "Dot");
  assert.match(svgBlock.markup, /^<svg viewBox="0 0 10 10"><title>Dot<\/title><circle cx="5" cy="5" r="4"><\/circle><linearGradient id="g"><\/linearGradient><\/svg>$/);
  const root = parseHtml(`<!-- hi --><script>if (a < b) { x = "</p>"; }</script><p>after</p>`);
  assert.equal(root.children.length, 3);
  assert.equal(outerHtml(root.children[2]), "<p>after</p>");
  const loose = FORM(`line one\nline two<br>after break`);
  assert.deepEqual(loose.sections[0].blocks[0].spans, [{ text: "line one line two\nafter break" }]);
});

test("a table of controls becomes lines of text plus labelled fields (a decision matrix)", () => {
  const form = parseHtmlForm(recorded.forms.matrix);
  assert.deepEqual(form.fields.map((field) => [field.name, field.options.map((option) => spansText(option.label))]), [["a", ["Keep", "Drop"]], ["b", ["Keep", "Drop"]]], "each control borrows its column header");
  assert.deepEqual(form.sections[0].blocks.filter((block) => block.kind === "text").map((block) => spansText(block.spans)), ["Rate each option.", "Feature A", "Feature B"]);
});
