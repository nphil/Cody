import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getModelPageWindow } = await jiti.import("./model-catalog-pagination.ts");

test("splits a large catalog into stable pages", () => {
  assert.deepEqual(getModelPageWindow(223, 0, 60), { pageIndex: 0, pageCount: 4, start: 0, end: 60 });
  assert.deepEqual(getModelPageWindow(223, 2, 60), { pageIndex: 2, pageCount: 4, start: 120, end: 180 });
  assert.deepEqual(getModelPageWindow(223, 3, 60), { pageIndex: 3, pageCount: 4, start: 180, end: 223 });
});

test("clamps stale pages after filtering and handles empty results", () => {
  assert.deepEqual(getModelPageWindow(12, 9, 60), { pageIndex: 0, pageCount: 1, start: 0, end: 12 });
  assert.deepEqual(getModelPageWindow(0, 4, 60), { pageIndex: 0, pageCount: 1, start: 0, end: 0 });
});
