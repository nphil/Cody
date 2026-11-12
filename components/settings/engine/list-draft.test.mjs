import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { parseListDraft, formatListDraft, LIST_DRAFT_HINT } = await jiti.import("./list-draft.ts");

test("one entry per line, trimmed, blanks dropped", () => {
  assert.deepEqual(parseListDraft("~/secrets\n  /etc/ssh  \n\n"), { ok: true, entries: ["~/secrets", "/etc/ssh"] });
  assert.deepEqual(parseListDraft(""), { ok: true, entries: [] });
  assert.deepEqual(parseListDraft("   \n  "), { ok: true, entries: [] });
});

test("a pasted JSON list of strings is the list, not one literal entry", () => {
  // omp 18.13.1's own description for tools.restrictedFolders: A JSON list of paths, e.g. ["~/secrets"].
  assert.deepEqual(parseListDraft('["~/secrets"]'), { ok: true, entries: ["~/secrets"] });
  assert.deepEqual(parseListDraft('  [ "AGENTS.local.md" ,\n "NOTES.md" ]  '), { ok: true, entries: ["AGENTS.local.md", "NOTES.md"] });
  assert.deepEqual(parseListDraft("[]"), { ok: true, entries: [] }, "an empty list clears the setting");
  assert.deepEqual(parseListDraft('[" a ", ""]'), { ok: true, entries: ["a"] });
});

test("text that starts like a JSON list but is not one is refused, not saved as a stray entry", () => {
  for (const draft of ['["~/secrets"', '["a", 3]', "[a, b]", '{"a":1}'.replace("{", "[")]) {
    const result = parseListDraft(draft);
    assert.equal(result.ok, false, `${draft} is refused`);
    assert.match(result.reason, /one entry per line/);
  }
  // Only a leading bracket triggers the JSON reading: ordinary lines pass through untouched.
  assert.deepEqual(parseListDraft("a[1]\n{x}"), { ok: true, entries: ["a[1]", "{x}"] });
});

test("a saved list shows one entry per line, and the hint names both forms", () => {
  assert.equal(formatListDraft(["a", "b"]), "a\nb");
  assert.equal(formatListDraft([]), "");
  assert.match(LIST_DRAFT_HINT, /One entry per line/);
  assert.match(LIST_DRAFT_HINT, /JSON list/);
});
