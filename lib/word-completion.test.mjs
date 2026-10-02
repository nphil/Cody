import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { shouldRequestWordSuggestion, readSuffix, isSuggestionCurrent, acceptSuggestion } = await jiti.import("./word-completion.ts");

test("asks only for a prose word ending at the end of a line", () => {
  assert.equal(shouldRequestWordSuggestion("hello wor", 9), true);
  // Followed by a newline still counts as end of line; followed by text does not.
  assert.equal(shouldRequestWordSuggestion("hello wor\nnext", 9), true);
  assert.equal(shouldRequestWordSuggestion("hello wor and more", 9), false);
  // Nothing to finish: blank composer, caret at 0, right after a space.
  assert.equal(shouldRequestWordSuggestion("", 0), false);
  assert.equal(shouldRequestWordSuggestion("   ", 3), false);
  assert.equal(shouldRequestWordSuggestion("hello ", 6), false);
  assert.equal(shouldRequestWordSuggestion("hello\n", 6), false);
  // Slash commands and bash lines are not prose.
  assert.equal(shouldRequestWordSuggestion("/mod", 4), false);
  assert.equal(shouldRequestWordSuggestion("!ls -l", 6), false);
  // An offset outside the text is never sent (the engine rejects it).
  assert.equal(shouldRequestWordSuggestion("abc", 9), false);
});

test("a late answer only applies while the composer is exactly as asked about", () => {
  const s = { text: "hello wor", cursor: 9, suffix: "ld" };
  assert.equal(isSuggestionCurrent(s, "hello wor", 9, 9), true);
  assert.equal(isSuggestionCurrent(s, "hello worl", 10, 10), false, "typed on");
  assert.equal(isSuggestionCurrent(s, "hello wor", 5, 5), false, "caret moved");
  assert.equal(isSuggestionCurrent(s, "hello wor", 9, 4), false, "a selection is not a caret");
  assert.equal(isSuggestionCurrent(s, "hello wo", 9, 9), false, "text deleted");
});

test("accepting inserts at the caret: Tab adds a space, Right-arrow does not", () => {
  const s = { text: "say hello wor\nnext line", cursor: 13, suffix: "ld" };
  assert.deepEqual(acceptSuggestion(s, true), { value: "say hello world \nnext line", cursor: 16, inserted: "ld " });
  assert.deepEqual(acceptSuggestion(s, false), { value: "say hello world\nnext line", cursor: 15, inserted: "ld" });
});

test("reads the engine's answer defensively", () => {
  assert.equal(readSuffix({ suffix: "ld" }), "ld");
  assert.equal(readSuffix({ suffix: null }), null);
  assert.equal(readSuffix({ suffix: "" }), null);
  assert.equal(readSuffix({ suffix: "a\nb" }), null);
  assert.equal(readSuffix(undefined), null);
  assert.equal(readSuffix({ suffix: 5 }), null);
});
