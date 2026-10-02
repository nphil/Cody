import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isUnpriced } = await jiti.import("./models-effective.ts");

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test("a zero-rate model omp marks free, included or variable is not unpriced", () => {
  for (const pricingStatus of ["free", "included", "variable"]) {
    assert.equal(isUnpriced({ id: "m", name: "m", provider: "p", cost: ZERO, pricingStatus }), false, pricingStatus);
  }
});

test("a zero-rate model with no status, or an unknown one, is still unpriced", () => {
  // Older engines send no pricingStatus at all: the price-fill logic keeps judging by omp's bundled catalog.
  assert.equal(isUnpriced({ id: "m", name: "m", provider: "p", cost: ZERO }), true);
  assert.equal(isUnpriced({ id: "m", name: "m", provider: "p", cost: ZERO, pricingStatus: "unknown" }), true);
  assert.equal(isUnpriced({ id: "m", name: "m", provider: "p" }), true);
});

test("a model with any real rate is priced whatever its status says", () => {
  assert.equal(isUnpriced({ id: "m", name: "m", provider: "p", cost: { ...ZERO, output: 3 }, pricingStatus: "unknown" }), false);
  assert.equal(isUnpriced({ id: "m", name: "m", provider: "p", cost: { input: 1 } }), false);
});
