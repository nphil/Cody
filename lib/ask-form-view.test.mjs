import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The pure half of the omp 19.1 `ask` form view (lib/ask-form-view.ts): what each tap and keystroke does to the
 * drafts, and the data they turn into. omp refuses an answer that does not fit its own parse of the form, so the
 * data built here is checked against omp's verdicts recorded from the real 19.1.0 binary.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseHtmlForm, formDataError, defaultFormData, parseFormSubmission } = await jiti.import("./ask-form.ts");
const view = await jiti.import("./ask-form-view.ts");
const recorded = JSON.parse(readFileSync(new URL("./fixtures/omp-19.1.0-ask-form-cases.json", import.meta.url), "utf8"));

const FORM = (body) => parseHtmlForm(`<form>${body}</form>`);

test("a form starts on what its HTML preselected: first checked radio, every checked box, prefilled text, never a disabled option", () => {
  const form = FORM(`
    <label><input type="radio" name="a" value="1"> One</label>
    <label><input type="radio" name="a" value="2" checked> Two</label>
    <label><input type="radio" name="a" value="3" checked> Three</label>
    <label><input type="checkbox" name="b" value="x" checked> X</label>
    <label><input type="checkbox" name="b" value="y" checked disabled> Y</label>
    <label><input type="checkbox" name="b" value="z" checked> Z</label>
    <label>Name <input name="n" value="Ada"></label>
    <select name="s"><option value="p">P</option><option value="q" selected>Q</option></select>`);
  assert.deepEqual(view.initialDrafts(form), [
    { kind: "choice", checked: [1], other: "" },
    { kind: "choice", checked: [0, 2], other: "" },
    { kind: "text", text: "Ada" },
    { kind: "choice", checked: [1], other: "" },
  ]);
});

test("a tap: a radio takes the pick and drops the typed Other answer, a checkbox flips, a disabled option does nothing", () => {
  const form = FORM(`
    <label><input type="radio" name="r" value="a"> A</label><label><input type="radio" name="r" value="b"> B</label>
    <label><input type="checkbox" name="c" value="x"> X</label><label><input type="checkbox" name="c" value="y"> Y</label><label><input type="checkbox" name="c" value="z" disabled> Z</label>`);
  const [radio, boxes] = form.fields;
  let r = { kind: "choice", checked: [], other: "typed" };
  r = view.pickOption(radio, r, 1);
  assert.deepEqual(r, { kind: "choice", checked: [1], other: "" });
  r = view.pickOption(radio, r, 0);
  assert.deepEqual(r.checked, [0]);
  let c = { kind: "choice", checked: [], other: "typed" };
  c = view.pickOption(boxes, c, 1);
  c = view.pickOption(boxes, c, 0);
  assert.deepEqual(c, { kind: "choice", checked: [0, 1], other: "typed" }, "ticks stay in option order and the Other answer stays");
  c = view.pickOption(boxes, c, 1);
  assert.deepEqual(c.checked, [0]);
  assert.equal(view.pickOption(boxes, c, 2), c, "a disabled option is not pickable");
  assert.equal(view.pickOption(boxes, c, 9), c, "an unknown option is not pickable");
});

test("typing an Other answer: it replaces a radio's pick (a blank one leaves it) and joins a checkbox group", () => {
  const form = FORM(`
    <label><input type="radio" name="r" value="a"> A</label><label><input type="radio" name="r" value="b"> B</label>
    <label><input type="checkbox" name="c" value="x"> X</label><label><input type="checkbox" name="c" value="y"> Y</label>`);
  const [radio, boxes] = form.fields;
  assert.deepEqual(view.typeOther(radio, { kind: "choice", checked: [0], other: "" }, "mine"), { kind: "choice", checked: [], other: "mine" });
  assert.deepEqual(view.typeOther(radio, { kind: "choice", checked: [0], other: "" }, "   "), { kind: "choice", checked: [0], other: "   " });
  assert.deepEqual(view.typeOther(boxes, { kind: "choice", checked: [1], other: "" }, "mine"), { kind: "choice", checked: [1], other: "mine" });
  const data = view.buildFormData(form, [
    view.typeOther(radio, { kind: "choice", checked: [0], other: "" }, "mine"),
    view.typeOther(boxes, { kind: "choice", checked: [1], other: "" }, "mine too"),
  ]);
  assert.deepEqual({ ...data }, { r: "mine", c: ["y", "mine too"] });
  assert.equal(formDataError(form, data), undefined);
});

test("the data built from the starting drafts is what omp took from the form's defaults, form by form", () => {
  const defaults = recorded.cases.filter((entry) => entry.id.startsWith("view-default-"));
  assert.ok(defaults.length >= 8);
  for (const entry of defaults) {
    const form = parseHtmlForm(recorded.forms[entry.form]);
    const built = view.buildFormData(form, view.initialDrafts(form));
    // Hidden inputs are left to omp, which fills them in itself.
    const expected = { ...defaultFormData(form) };
    for (const [name] of form.hidden) if (!form.fields.some((field) => field.name === name)) delete expected[name];
    assert.deepEqual({ ...built }, expected, entry.id);
    assert.equal(view.submitError(form, view.initialDrafts(form)), entry.isError ? entry.text : undefined, entry.id);
  }
});

test("every field of every recorded form: whatever the view builds from a pick is accepted or refused exactly as omp would", () => {
  for (const [name, html] of Object.entries(recorded.forms)) {
    const form = parseHtmlForm(html);
    const drafts = view.initialDrafts(form).map((draft, index) => {
      const field = form.fields[index];
      if (draft.kind === "text") return draft.text === "" && field.required ? { kind: "text", text: field.type === "email" ? "a@b.co" : field.type === "url" ? "https://x.test" : field.type === "number" || field.type === "range" ? String(field.min ?? 1) : "ok" } : draft;
      if (draft.checked.length === 0 && field.required) {
        const first = field.options.findIndex((option) => !option.disabled);
        return first >= 0 ? view.pickOption(field, draft, first) : draft;
      }
      return draft;
    });
    const data = view.buildFormData(form, drafts);
    const problems = view.fieldProblems(form, drafts).filter(Boolean);
    const refused = formDataError(form, data);
    if (problems.length === 0) assert.equal(refused, undefined, `${name}: the view would send ${JSON.stringify(data)} and omp refuses it: ${refused}`);
    else assert.notEqual(refused, undefined, `${name}: the view flags ${JSON.stringify(problems)} but omp takes ${JSON.stringify(data)}`);
    const parsed = parseFormSubmission(form, JSON.parse(JSON.stringify(data)));
    assert.equal("error" in parsed, refused !== undefined, `${name}: a JSON round trip changes the verdict`);
  }
});

test("two controls under one name: a later empty one does not wipe an earlier answer; an unnamed control is never sent", () => {
  const form = FORM(`<input name="note" value="first"><input name="note"><input value="stray"><input type="radio" value="u"> U`);
  const drafts = view.initialDrafts(form);
  assert.deepEqual({ ...view.buildFormData(form, drafts) }, { note: "first" });
  assert.deepEqual(view.fieldProblems(form, drafts), form.fields.map(() => undefined));
});

test("a required field with nothing in it is a problem of that field only; filling it clears it", () => {
  const form = FORM(`
    <fieldset><legend>Env</legend><label><input type="radio" name="env" value="p" required> Prod</label><label><input type="radio" name="env" value="s"> Stage</label></fieldset>
    <label>Email <input type="email" name="mail" required></label>
    <label>Age <input type="number" name="age" min="18" max="99"></label>`);
  let drafts = view.initialDrafts(form);
  assert.deepEqual(view.fieldProblems(form, drafts), [{ kind: "required" }, { kind: "required" }, undefined]);
  drafts = drafts.map((draft, index) => (index === 0 ? view.pickOption(form.fields[0], draft, 1) : index === 1 ? { kind: "text", text: "nope" } : { kind: "text", text: "7" }));
  assert.deepEqual(view.fieldProblems(form, drafts), [undefined, { kind: "email" }, { kind: "min", limit: 18 }]);
  drafts = drafts.map((draft, index) => (index === 1 ? { kind: "text", text: "a@b.co" } : index === 2 ? { kind: "text", text: "42" } : draft));
  assert.deepEqual(view.fieldProblems(form, drafts), [undefined, undefined, undefined]);
  assert.deepEqual({ ...view.buildFormData(form, drafts) }, { env: "s", mail: "a@b.co", age: 42 });
  assert.equal(view.submitError(form, drafts), undefined);
});

test("the dock header: the form's heading, else a fieldset title, else its first paragraph, else the first question; clipped", () => {
  assert.equal(view.formHeadline(FORM(`<p>Intro</p><h2>Pick a plan</h2><label><input type="radio" name="a" value="1"> One</label>`)), "Pick a plan");
  assert.equal(view.formHeadline(FORM(`<fieldset><legend>Which plan?</legend><label><input type="radio" name="a" value="1"> One</label></fieldset>`)), "Which plan?");
  assert.equal(view.formHeadline(FORM(`<p>Shall we <b>deploy</b>   now?</p><input name="x">`)), "Shall we deploy now?");
  assert.equal(view.formHeadline(FORM(`<input name="sentry_dsn">`)), "sentry dsn");
  assert.equal(view.formHeadline(FORM("")), "");
  const long = view.formHeadline(FORM(`<p>${"word ".repeat(100)}</p>`));
  assert.ok(long.length <= 200 && long.endsWith("\u2026"));
});

test("a notification can answer a form that is one single-pick question, with only options omp takes", () => {
  const radio = FORM(`<p>Which database?</p><label><input type="radio" name="db" value="pg"> Postgres</label><label><input type="radio" name="db" value="my"> MySQL</label><label><input type="radio" name="db" value="x" disabled> Gone</label>`);
  assert.deepEqual(view.simpleChoice(radio), {
    name: "db",
    question: "Which database?",
    options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }],
  });
  for (const answer of view.simpleChoice(radio).options) assert.equal(formDataError(radio, { db: answer.value }), undefined);
  const select = FORM(`<label>Env <select name="env"><option value="a">Alpha</option><option value="b">Beta</option></select></label>`);
  assert.deepEqual(view.simpleChoice(select)?.options.map((option) => option.value), ["a", "b"]);
  assert.equal(view.simpleChoice(FORM(`<label><input type="checkbox" name="c" value="1"> A</label><label><input type="checkbox" name="c" value="2"> B</label>`)), null, "a checkbox group takes several answers");
  assert.equal(view.simpleChoice(FORM(`<label><input type="radio" name="a" value="1"> A</label><label><input type="radio" name="a" value="2"> B</label><input name="why">`)), null, "a second field needs the chat");
  assert.equal(view.simpleChoice(FORM(`<label><input type="radio" name="a" value="1"> A</label>`)), null, "one option is not a choice");
  assert.equal(view.simpleChoice(FORM(`<textarea name="t"></textarea>`)), null);
});

test("images: http(s), data:image, file URLs and absolute paths load; scripts, blobs and relative paths do not", () => {
  assert.equal(view.formImageUrl("https://example.test/a.png"), "https://example.test/a.png");
  assert.equal(view.formImageUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(view.formImageUrl("file:///tmp/my%20chart.png"), "/api/files/tmp/my%20chart.png?type=read");
  assert.equal(view.formImageUrl("/home/me/shot.png"), "/api/files/home/me/shot.png?type=read");
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "blob:https://x/1", "chart.png", "./chart.png", "", "//evil.test/x.png", "/api/files/x"]) {
    assert.equal(view.formImageUrl(bad), null, bad);
  }
});

test("an inline svg becomes an image URL: namespace added when missing, kept when present, markup safe to carry in a URL", () => {
  const bare = view.svgDataUrl(`<svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>`);
  assert.match(bare, /^data:image\/svg\+xml;charset=utf-8,/);
  const decoded = decodeURIComponent(bare.slice(bare.indexOf(",") + 1));
  assert.match(decoded, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="10"/);
  const named = decodeURIComponent(view.svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>`).split(",")[1]);
  assert.equal(named.match(/xmlns=/g).length, 1);
  const linked = decodeURIComponent(view.svgDataUrl(`<svg><use xlink:href="#a"/></svg>`).split(",")[1]);
  assert.match(linked, /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
  assert.ok(!/[<>"# ]/.test(view.svgDataUrl(`<svg><text>a # b "q"</text></svg>`).split(",")[1]));
});

test("the drafts of an open form are kept for the same form only, and the store stays small", () => {
  view.rememberDrafts("req-1", "<form></form>", [{ kind: "text", text: "kept" }]);
  assert.deepEqual(view.recalledDrafts("req-1", "<form></form>"), [{ kind: "text", text: "kept" }]);
  assert.equal(view.recalledDrafts("req-1", "<form>other</form>"), undefined, "another form under the same id is not the same form");
  assert.equal(view.recalledDrafts("req-2", "<form></form>"), undefined);
  view.forgetDrafts("req-1");
  assert.equal(view.recalledDrafts("req-1", "<form></form>"), undefined);
  for (let i = 0; i < 40; i++) view.rememberDrafts(`many-${i}`, "h", []);
  assert.equal(view.recalledDrafts("many-0", "h"), undefined, "the oldest are dropped");
  assert.deepEqual(view.recalledDrafts("many-39", "h"), []);
});

test("one parse serves the dock header and the view", () => {
  const html = `<form><p>Hi</p><input name="x"></form>`;
  assert.equal(view.parseFormCached(html), view.parseFormCached(html));
  assert.notEqual(view.parseFormCached(html), view.parseFormCached(`${html} `));
});
