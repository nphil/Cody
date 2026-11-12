import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./test-helpers.mjs";

const present = await load("./present.ts");

/** A translator that shows which key and variables were asked for, so a test reads the choice the helper made. */
const t = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const tn = (key, count, vars) => `${key}.${count === 1 ? "one" : "other"}${JSON.stringify({ count, ...vars })}`;

test("dollars: cents below $1,000, whole dollars above, a visible floor for a tiny real amount", () => {
  assert.equal(present.formatUsd(12.34, "en"), "$12.34");
  assert.equal(present.formatUsd(1234.56, "en"), "$1,235");
  assert.equal(present.formatUsd(0.004, "en"), "<$0.01");
  assert.equal(present.formatUsd(0, "en"), "$0.00");
  assert.equal(present.formatUsd(Number.NaN, "en"), "$0.00");
  assert.equal(present.formatUsd(-3, "en"), "$0.00", "a negative spend is not a thing to print");
});

test("token counts use the language's own short form and exact counts keep separators", () => {
  assert.equal(present.formatTokens(1_200_000, "en"), "1.2M");
  assert.equal(present.formatTokens(950, "en"), "950");
  assert.equal(present.formatTokens(1_200_000, "ja"), "120万");
  assert.equal(present.formatTokens(Number.POSITIVE_INFINITY, "en"), "0");
  assert.equal(present.formatCount(1234567, "en"), "1,234,567");
});

test("shares: one decimal below 10%, whole percent above, a floor for a sliver", () => {
  assert.equal(present.formatShare(0.62, "en"), "62%");
  assert.equal(present.formatShare(0.052, "en"), "5.2%");
  assert.equal(present.formatShare(0.0004, "en"), "<0.1%");
  assert.equal(present.formatShare(0, "en"), "0%");
  assert.equal(present.formatShare(Number.NaN, "en"), "0%");
  assert.equal(present.shareOf(1, 4), 0.25);
  assert.equal(present.shareOf(1, 0), 0);
});

test("cache hit rate is cache reads over everything the prompts carried, or null with no prompts", () => {
  assert.equal(present.cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: 10 }), 0.8);
  assert.equal(present.cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test("change against the period before: new, flat, up, down, or nothing to say", () => {
  assert.deepEqual(present.deltaOf(0, 0), { kind: "none", ratio: 0 });
  assert.deepEqual(present.deltaOf(5, 0), { kind: "new", ratio: 0 });
  assert.deepEqual(present.deltaOf(100.2, 100), { kind: "flat", ratio: 0 });
  assert.equal(present.deltaOf(118, 100).kind, "up");
  assert.ok(Math.abs(present.deltaOf(118, 100).ratio - 0.18) < 1e-9);
  assert.deepEqual(present.deltaOf(50, 100), { kind: "down", ratio: -0.5 });
  assert.equal(present.deltaOf(0, 10).kind, "down", "everything stopped is a drop, not 'nothing'");
});

test("a change is worded as a signed percentage with a real minus sign", () => {
  assert.equal(present.formatDelta(present.deltaOf(118, 100), "en", t), "+18%");
  assert.equal(present.formatDelta(present.deltaOf(50, 100), "en", t), "\u221250%");
  assert.equal(present.formatDelta(present.deltaOf(103.4, 100), "en", t), "+3.4%");
  assert.equal(present.formatDelta(present.deltaOf(5, 0), "en", t), "statistics.delta.new");
  assert.equal(present.formatDelta(present.deltaOf(100, 100), "en", t), "statistics.delta.flat");
  assert.equal(present.formatDelta(present.deltaOf(0, 0), "en", t), null);
});

test("the comparison and the span an insight talks about follow the period", () => {
  const period = (preset, count) => ({ from: "2026-11-01", to: "2026-11-07", days: count, preset });
  assert.equal(present.compareLabel(period("today", 1), tn, t), "statistics.vsYesterday");
  assert.equal(present.compareLabel(period("7d", 7), tn, t), "statistics.vsLastWeek");
  assert.equal(present.compareLabel(period("30d", 30), tn, t), 'statistics.vsDays.other{"count":30}');
  assert.equal(present.compareLabel(period(null, 3), tn, t), 'statistics.vsDays.other{"count":3}');
  assert.equal(present.compareLabel(period(null, 1), tn, t), 'statistics.vsDays.one{"count":1}');
  assert.equal(present.periodWhen(period("today", 1), t), "statistics.when.today");
  assert.equal(present.periodWhen(period("7d", 7), t), "statistics.when.week");
  assert.equal(present.periodWhen(period("90d", 90), t), 'statistics.when.days{"count":90}');
  assert.equal(present.periodWhen(period(null, 4), t), "statistics.when.period");
});

test("a day label stays on its own day whatever zone the machine is in, and a moment reads in the index's zone", () => {
  assert.equal(present.formatDay("2026-11-12", "en"), "Nov 12");
  assert.equal(present.formatDay("2026-11-12", "en", true), "Thu, Nov 12");
  const late = Date.parse("2026-11-12T01:30:00Z");
  assert.match(present.formatMoment(late, "en", "America/Los_Angeles"), /Nov 11/);
  assert.match(present.formatMoment(late, "en", "Asia/Tokyo"), /Nov 12/);
});

test("who did the work reads as a name the viewer's language can translate", () => {
  assert.equal(present.workerLabel("main", t), "statistics.worker.main");
  assert.equal(present.workerLabel("sidebar", t), "statistics.worker.sidebar");
  assert.equal(present.workerLabel("advisor", t), "statistics.worker.advisor");
  assert.equal(present.workerLabel("compaction", t), "statistics.worker.compaction");
  assert.equal(present.workerLabel("subagent", t), "statistics.worker.subagent");
  assert.equal(present.workerLabel("subagent:explore", t), 'statistics.worker.subagentType{"type":"explore"}');
  assert.equal(present.workerLabel("engine:memory", t), "statistics.worker.engine.memory");
  assert.equal(present.workerLabel("engine:cache-warm", t), "statistics.worker.engine.cache-warm");
  assert.equal(present.workerLabel("engine:brand-new", t), 'statistics.worker.engineOther{"purpose":"brand-new"}');
  assert.equal(present.workerLabel("background", t), "statistics.worker.background");
  assert.equal(present.workerLabel("background:title", t), "statistics.worker.background.title");
  assert.equal(present.workerLabel("background:plan-keeper", t), "statistics.worker.background.plan-keeper");
  assert.equal(present.workerLabel("background:odd-job", t), 'statistics.worker.backgroundOther{"purpose":"odd-job"}');
  assert.equal(present.workerLabel("something-new", t), "something-new", "an id this version does not know is shown as it is");
  assert.equal(present.workerLabel("engine:constructor", t), 'statistics.worker.engineOther{"purpose":"constructor"}', "inherited object keys are not purposes");
});

test("a node is named by what the server knew, then by the viewer's language, then by its key", () => {
  const node = (dim, key, label = "", other = false) => ({ dim, key, label, other });
  assert.equal(present.nodeLabel(node("model", "~other", "", true), t), "statistics.other");
  assert.equal(present.nodeLabel(node("model", "~other"), t), "statistics.other");
  assert.equal(present.nodeLabel(node("worker", "subagent:plan"), t), 'statistics.worker.subagentType{"type":"plan"}');
  assert.equal(present.nodeLabel(node("project", ""), t), "statistics.noProject");
  assert.equal(present.nodeLabel(node("chat", ""), t), "statistics.noChat");
  assert.equal(present.nodeLabel(node("chat", "c1", ""), t), "statistics.untitledChat");
  assert.equal(present.nodeLabel(node("chat", "c1", "Fix the login bug"), t), "Fix the login bug");
  assert.equal(present.nodeLabel(node("project", "slug:--home-me-app--", ""), t), "--home-me-app--");
  assert.equal(present.nodeLabel(node("model", "claude-opus-5-5"), t), "claude-opus-5-5");
});

test("a cost is a figure, a floor, 'price unknown' or 'local' - never a made-up $0", () => {
  const cost = (cost, tokens, unpricedTokens) => present.costFigure({ cost, tokens, unpricedTokens });
  assert.deepEqual(cost(4.5, 1000, 0), { kind: "priced", amount: 4.5 });
  assert.deepEqual(cost(4.5, 1000, 200), { kind: "partial", amount: 4.5 });
  assert.deepEqual(cost(0, 1000, 1000), { kind: "unknown", amount: 0 });
  assert.deepEqual(cost(0, 1000, 0), { kind: "local", amount: 0 });
  assert.deepEqual(cost(0, 0, 0), { kind: "none", amount: 0 });

  assert.equal(present.costText(cost(4.5, 1000, 0), "en", t), "$4.50");
  assert.equal(present.costText(cost(4.5, 1000, 200), "en", t), "$4.50+", "a floor is marked as one");
  assert.equal(present.costText(cost(0, 1000, 1000), "en", t), "statistics.cost.unknown");
  assert.equal(present.costText(cost(0, 1000, 0), "en", t), "statistics.cost.local");
  assert.equal(present.costText(cost(0, 0, 0), "en", t), "\u2014");
});

test("every way a provider can bill has a label and a one-line explanation key", () => {
  for (const kind of ["subscription", "payg", "local", "unknown"]) {
    assert.equal(present.BILLING_KEYS[kind].label, `statistics.billing.${kind}`);
    assert.equal(present.BILLING_KEYS[kind].note, `statistics.billing.${kind}Note`);
  }
});
