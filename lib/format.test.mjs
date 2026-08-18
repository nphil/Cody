import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { formatApiCost, formatCompactNumber, formatPercent, formatRelativeTime, usageToneColor } =
  await jiti.import("./format.ts");

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

test("formatRelativeTime narrows to the largest whole unit, from an injected clock", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const at = (iso) => formatRelativeTime(iso, "en-US", now);

  assert.equal(at("2026-08-18T12:00:00.000Z"), "this minute");
  assert.equal(at("2026-08-18T11:59:31.000Z"), "this minute");
  assert.equal(at("2026-08-18T11:57:00.000Z"), "3m ago");
  assert.equal(at("2026-08-18T11:01:00.000Z"), "59m ago");
  assert.equal(at("2026-08-18T11:00:00.000Z"), "1h ago");
  assert.equal(at("2026-08-17T13:00:00.000Z"), "23h ago");
  assert.equal(at("2026-08-17T12:00:00.000Z"), "yesterday");
  assert.equal(at("2026-08-14T12:00:00.000Z"), "4d ago");

  // A clock behind the timestamp reads as "now" rather than counting forward.
  assert.equal(at("2026-08-18T12:05:00.000Z"), "this minute");
});

test("formatRelativeTime returns null for a timestamp it cannot parse", () => {
  // The palette's private copy threw a RangeError here: NaN minutes fell
  // through every branch into Intl.RelativeTimeFormat.format(NaN), taking the
  // whole session list down with one malformed `modified` field.
  const now = Date.now();
  assert.equal(formatRelativeTime("not a date", "en-US", now), null);
  assert.equal(formatRelativeTime("", "en-US", now), null);
});

test("usageToneColor keeps one 70/90 threshold pair for every surface", () => {
  assert.equal(usageToneColor(0), "var(--accent)");
  assert.equal(usageToneColor(69.9), "var(--accent)");
  // The boundary the two surfaces used to disagree about: `>= 70` and `>= 90`
  // are inclusive, so exactly-on-the-line reads the same everywhere.
  assert.equal(usageToneColor(70), "var(--status-warning)");
  assert.equal(usageToneColor(89.9), "var(--status-warning)");
  assert.equal(usageToneColor(90), "var(--status-error)");
  assert.equal(usageToneColor(100), "var(--status-error)");
});

test("usageToneColor lets an engine state raise the tone but never lower it", () => {
  // A window nothing can be spent on must not read as "plenty left", however
  // low its percentage. (Moved here with the helper, which the composer's quota
  // ring, the context ring and the top bar's context chip now share.)
  assert.equal(usageToneColor(12, "exhausted"), "var(--status-error)");
  assert.equal(usageToneColor(0, "exhausted"), "var(--status-error)");
  assert.equal(usageToneColor(12, "warning"), "var(--status-warning)");
  // ...and a milder state cannot talk a full window down.
  assert.equal(usageToneColor(95, "warning"), "var(--status-error)");
  assert.equal(usageToneColor(95, "ok"), "var(--status-error)");
  assert.equal(usageToneColor(75, "ok"), "var(--status-warning)");
  assert.equal(usageToneColor(12, "ok"), "var(--accent)");
});
