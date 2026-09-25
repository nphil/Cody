import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./models/ModelCurationDialog.tsx", import.meta.url), "utf8");

test("model curation keeps its category and pagination controls", () => {
  assert.match(source, /MODEL_CATEGORY_OPTIONS/);
  assert.match(source, /modelMatchesCategories/);
  assert.match(source, /selectedCategories/);
  assert.match(source, /getModelPageWindow/);
  assert.match(source, /page\.pageCount/);
  assert.match(source, /aria-label=\{`Page/);
});

test("model curation keeps composer visibility reconciliation", () => {
  assert.match(source, /hiddenForMe/);
  assert.match(source, /selectedHiddenCount/);
  assert.match(source, /will be shown when you save/);
});
