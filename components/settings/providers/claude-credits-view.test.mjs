import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { maskKey, planTitle, creditsCoverage, formatAddedDate } = await jiti.import("./claude-credits-view.ts");

test("maskKey shows only the last four characters behind dots", () => {
  assert.equal(maskKey("a1B2"), "••••a1B2");
});

test("planTitle follows the plan card: Primary, Secondary, then Account N", () => {
  assert.deepEqual(planTitle(0), { kind: "primary" });
  assert.deepEqual(planTitle(1), { kind: "secondary" });
  assert.deepEqual(planTitle(2), { kind: "other", n: 3 });
});

test("creditsCoverage is null until a key is saved", () => {
  assert.equal(creditsCoverage(["limited", "limited"], 0), null);
});

test("creditsCoverage covers only when every plan is limited", () => {
  assert.equal(creditsCoverage(["limited", "limited"], 1), "covering");
  assert.equal(creditsCoverage(["limited"], 2), "covering");
  assert.equal(creditsCoverage(["limited", "in_use"], 2), "standby");
  assert.equal(creditsCoverage(["limited", "standby"], 1), "standby");
  assert.equal(creditsCoverage(["in_use", "standby"], 1), "standby");
});

test("creditsCoverage treats a disabled account as unable to serve, but needs a real limit", () => {
  assert.equal(creditsCoverage(["limited", "disabled"], 1), "covering");
  assert.equal(creditsCoverage(["disabled", "disabled"], 1), "standby");
  assert.equal(creditsCoverage([], 1), "standby");
});

test("formatAddedDate gives null for an unreadable stamp", () => {
  assert.equal(formatAddedDate("not a date"), null);
  assert.equal(formatAddedDate(null), null);
  assert.equal(typeof formatAddedDate("2026-10-13T08:00:00.000Z"), "string");
});
