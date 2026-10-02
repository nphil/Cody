import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ask-dialog.ts");
}

const opts = (...labels) => labels.map((label) => ({ label }));
const single = { id: "db", question: "Which database?", options: opts("Postgres", "SQLite", "MySQL"), recommended: 1 };
const multi = { id: "feat", question: "Which features?", multi: true, options: opts("Auth", "Billing", "Search"), recommended: 0 };

test("the recommended option (an index) starts selected, in both modes", async () => {
  const { initialAskDrafts, buildAskAnswers } = await loadSubject();
  const drafts = initialAskDrafts([single, multi, { ...single, id: "bad", recommended: 9 }]);
  assert.deepEqual(drafts.map((draft) => draft.selected), [[1], [0], []]);
  assert.deepEqual(buildAskAnswers([single, multi], drafts.slice(0, 2)), [
    { id: "db", selectedOptions: ["SQLite"] },
    { id: "feat", selectedOptions: ["Auth"] },
  ]);
});

test("single-select carries exactly one of a choice or custom text, whichever was touched last", async () => {
  const { initialAskDrafts, setAskCustom, toggleAskOption, buildAskAnswer } = await loadSubject();
  let draft = initialAskDrafts([single])[0];
  draft = setAskCustom(single, draft, "  CockroachDB ");
  assert.deepEqual(buildAskAnswer(single, draft), { id: "db", selectedOptions: [], customInput: "CockroachDB" });
  draft = toggleAskOption(single, draft, 2);
  assert.deepEqual(buildAskAnswer(single, draft), { id: "db", selectedOptions: ["MySQL"] });
  // Even a hand-built draft that breaks the rule is normalised, never emitted.
  assert.deepEqual(
    buildAskAnswer(single, { selected: [0, 2], custom: "x" }),
    { id: "db", selectedOptions: [], customInput: "x" },
  );
  assert.deepEqual(buildAskAnswer(single, { selected: [0, 2], custom: "" }), { id: "db", selectedOptions: ["Postgres"] });
});

test("multi-select keeps any labels plus custom text, toggles off, and never repeats a label", async () => {
  const { setAskCustom, toggleAskOption, buildAskAnswer } = await loadSubject();
  let draft = { selected: [], custom: "" };
  draft = toggleAskOption(multi, draft, 2);
  draft = toggleAskOption(multi, draft, 0);
  draft = setAskCustom(multi, draft, "Audit log");
  assert.deepEqual(buildAskAnswer(multi, draft), { id: "feat", selectedOptions: ["Auth", "Search"], customInput: "Audit log" });
  draft = toggleAskOption(multi, draft, 2);
  assert.deepEqual(draft.selected, [0]);
  const dupes = { id: "d", question: "?", multi: true, options: opts("A", "A") };
  assert.deepEqual(buildAskAnswer(dupes, { selected: [0, 1], custom: "" }), { id: "d", selectedOptions: ["A"] });
});

test("a question with neither a choice nor non-blank text blocks the whole submit", async () => {
  const { buildAskAnswers, isAskAnswered } = await loadSubject();
  const drafts = [{ selected: [0], custom: "" }, { selected: [], custom: "   " }];
  assert.equal(isAskAnswered(multi, drafts[1]), false);
  assert.equal(buildAskAnswers([single, multi], drafts), null);
  assert.equal(buildAskAnswers([single, multi], [drafts[0], { selected: [], custom: "Other thing" }])?.length, 2);
});
