import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { formatApiCost, formatCompactNumber, formatPercent } = await jiti.import("./format.ts");

test("formatCompactNumber and formatPercent keep their shipped shapes", () => {
  assert.equal(formatCompactNumber(999), "999");
  assert.equal(formatCompactNumber(1_500), "2k");
  assert.equal(formatCompactNumber(1_500_000), "1.5M");
  assert.equal(formatCompactNumber(1_234, "en-US"), "1k");
  assert.equal(formatCompactNumber(12, "en-US"), "12");
  assert.equal(formatPercent(42.35), "42.4%");
});

test("formatApiCost never announces a figure smaller than the one it can print", () => {
  // The regression this pins: a four-decimal formatter behind a two-decimal
  // guard rendered 0.0042 (0.42 cents) as "<$0.0001" — understating it 100x,
  // and contradicting the same session's two-decimal "<$0.01".
  assert.equal(formatApiCost(0.0042, 4), "$0.0042");
  assert.equal(formatApiCost(0.0042, 2), "<$0.01");

  // Exactly at each precision's floor, the figure prints rather than hides.
  assert.equal(formatApiCost(0.0001, 4), "$0.0001");
  assert.equal(formatApiCost(0.01, 2), "$0.01");

  // Below the floor: honestly "less than", at the same precision as the guard.
  assert.equal(formatApiCost(0.00009, 4), "<$0.0001");
  assert.equal(formatApiCost(0.009, 2), "<$0.01");

  // Ordinary sums round at their own precision.
  assert.equal(formatApiCost(1.23456, 4), "$1.2346");
  assert.equal(formatApiCost(1.23456, 2), "$1.23");
  assert.equal(formatApiCost(12, 2), "$12.00");

  // Zero and nonsense are a plain zero — callers decide whether "no cost
  // computed" should even reach a formatter (it should not).
  assert.equal(formatApiCost(0, 4), "$0.0000");
  assert.equal(formatApiCost(0, 2), "$0.00");
  assert.equal(formatApiCost(-1, 2), "$0.00");
  assert.equal(formatApiCost(Number.NaN, 4), "$0.0000");
});

test("formatApiCost's two precisions never disagree about whether a cost is visible", () => {
  // Any cost the coarse chip renders as a real figure must render as a real
  // figure in the precise readout too — never as "<".
  for (const cost of [0.0001, 0.0005, 0.004, 0.0099, 0.01, 0.42, 7.5]) {
    const coarse = formatApiCost(cost, 2);
    const precise = formatApiCost(cost, 4);
    assert.equal(precise.startsWith("<"), false, `precise cost hid ${cost}`);
    if (!coarse.startsWith("<")) {
      assert.equal(coarse.startsWith("$"), true, `coarse cost malformed for ${cost}`);
    }
  }
});
