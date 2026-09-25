import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { modelCategories, modelCategoryBucket, modelMatchesCategories } = await jiti.import("./model-categories.ts");

const categorySet = (...categories) => new Set(categories);

test("recognizes the whole versioned SWE family", () => {
  for (const id of ["swe-1.6", "swe1.7", "swe-2", "SWE-3.1"]) {
    assert.deepEqual(modelCategories({ id }), ["SWE"], id);
  }
  assert.deepEqual(modelCategories({ id: "sweeper" }), ["Other"]);
});

test("keeps Fusion plus SWE models in the Fusion bucket", () => {
  const model = { id: "fusion-claude-opus-swe-2-high", name: "Fusion Claude + SWE-2" };
  assert.deepEqual(modelCategories(model), ["SWE", "Fusion"]);
  assert.equal(modelCategoryBucket(model), "Fusion");
  assert.equal(modelMatchesCategories(model, categorySet("SWE")), false);
  assert.equal(modelMatchesCategories(model, categorySet("Fusion")), true);
  assert.equal(modelMatchesCategories(model, categorySet("SWE", "Fusion")), true);
});

test("does not hide ordinary SWE models from the SWE-only filter", () => {
  const model = { id: "swe-2-medium" };
  assert.equal(modelCategoryBucket(model), "SWE");
  assert.equal(modelMatchesCategories(model, categorySet("SWE")), true);
  assert.equal(modelMatchesCategories(model, categorySet("Fusion")), false);
});
