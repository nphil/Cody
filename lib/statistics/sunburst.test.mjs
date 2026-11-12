import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./test-helpers.mjs";

const sb = await load("./sunburst.ts");
const { OTHER_KEY } = await load("./types.ts");
const { TAU } = sb;

const EPS = 1e-9;
const OPTIONS = { innerRadius: 40, outerRadius: 200 };

/** A node whose own value is the sum of its children's unless given. */
function node(key, cost, tokens, children, extra = {}) {
  return {
    key,
    dim: "provider",
    label: key,
    cost,
    paygCost: 0,
    tokens,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    unpricedTokens: 0,
    messages: 1,
    ...(children ? { children } : {}),
    ...extra,
  };
}

function tree() {
  const a1 = node("a1", 3, 30);
  const a2 = node("a2", 1, 10);
  const a = node("a", 4, 40, [a1, a2]);
  const b = node("b", 2, 20, [node("b1", 2, 20)]);
  const c = node("c", 0, 50, [node("c1", 0, 50)]);
  const other = node(OTHER_KEY, 1, 5, undefined, { other: true });
  return node("", 7, 115, [a, b, c, other], { dim: "root" });
}

function childrenOf(layout, arc) {
  return layout.arcs.filter((x) => x.path.length === arc.path.length + 1 && x.path.slice(0, arc.path.length).join("/") === arc.path.join("/"));
}

test("the first ring fills the circle, clockwise from 12 o'clock, without overlap", () => {
  const layout = sb.layoutSunburst(tree(), [], "cost", OPTIONS);
  const ring1 = layout.arcs.filter((a) => a.ring === 1);
  assert.deepEqual(ring1.map((a) => a.node.key), ["a", "b", OTHER_KEY], "c has no cost and takes no room");
  assert.equal(ring1[0].a0, 0);
  for (let i = 1; i < ring1.length; i += 1) assert.ok(Math.abs(ring1[i].a0 - ring1[i - 1].a1) < EPS, "contiguous and ordered");
  assert.ok(Math.abs(ring1.at(-1).a1 - TAU) < EPS);
  assert.ok(Math.abs(ring1.reduce((s, a) => s + (a.a1 - a.a0), 0) - TAU) < EPS);
  assert.ok(Math.abs(ring1[0].a1 - (TAU * 4) / 7) < EPS);
  assert.equal(layout.total, 7);
  assert.equal(layout.rings, 2);
});

test("every node's children take at most the node's own angle, inside its span", () => {
  for (const metric of ["cost", "tokens"]) {
    const layout = sb.layoutSunburst(tree(), [], metric, OPTIONS);
    for (const arc of layout.arcs) {
      const kids = childrenOf(layout, arc);
      const sum = kids.reduce((s, k) => s + (k.a1 - k.a0), 0);
      assert.ok(sum <= arc.a1 - arc.a0 + EPS, `${metric} ${arc.id}`);
      for (const kid of kids) assert.ok(kid.a0 >= arc.a0 - EPS && kid.a1 <= arc.a1 + EPS);
      for (let i = 1; i < kids.length; i += 1) assert.ok(kids[i].a0 >= kids[i - 1].a1 - EPS);
      assert.equal(kids.every((k) => k.ring === arc.ring + 1), true);
    }
  }
});

test("a node with no value under the metric takes no room, and gets it back under the other metric", () => {
  const costMode = sb.layoutSunburst(tree(), [], "cost", OPTIONS);
  assert.equal(costMode.arcs.some((a) => a.node.key === "c" || a.node.key === "c1"), false);
  const tokenMode = sb.layoutSunburst(tree(), [], "tokens", OPTIONS);
  assert.equal(tokenMode.arcs.some((a) => a.node.key === "c1"), true);
  const c = tokenMode.arcs.find((a) => a.node.key === "c");
  assert.ok(Math.abs(c.a1 - c.a0 - (TAU * 50) / 115) < EPS);
  assert.ok(Math.abs(tokenMode.arcs.filter((a) => a.ring === 1).at(-1).a1 - TAU) < EPS);
});

test("rings are drawn only as deep as there is value", () => {
  const flat = node("", 3, 3, [node("x", 3, 3, [node("y", 0, 3)])], { dim: "root" });
  assert.equal(sb.layoutSunburst(flat, [], "cost", OPTIONS).rings, 1);
  assert.equal(sb.layoutSunburst(flat, [], "tokens", OPTIONS).rings, 2);
  assert.equal(sb.layoutSunburst(tree(), [], "cost", { ...OPTIONS, maxRings: 1 }).arcs.every((a) => a.ring === 1), true);
  const layout = sb.layoutSunburst(tree(), [], "cost", OPTIONS);
  const ring2 = layout.arcs.find((a) => a.ring === 2);
  assert.equal(ring2.r0, 40 + 80);
  assert.equal(ring2.r1, 200);
});

test("arcs narrower than minAngle are left out", () => {
  const wide = node("", 1001, 1001, [node("big", 1000, 1000), node("tiny", 1, 1)], { dim: "root" });
  const layout = sb.layoutSunburst(wide, [], "cost", { ...OPTIONS, minAngle: 0.01 });
  assert.deepEqual(layout.arcs.map((a) => a.node.key), ["big"]);
});

test("re-rooting at a child makes its children fill the circle and their shares sum to 1", () => {
  const t = tree();
  assert.equal(sb.rerootAt(t, ["a"]).key, "a");
  assert.equal(sb.rerootAt(t, ["a", "a2"]).key, "a2");
  assert.equal(sb.rerootAt(t, []), t);
  const layout = sb.layoutSunburst(t, ["a"], "cost", OPTIONS);
  assert.equal(layout.focus.node.key, "a");
  assert.equal(layout.total, 4);
  const ring1 = layout.arcs.filter((a) => a.ring === 1);
  assert.deepEqual(ring1.map((a) => a.path), [["a", "a1"], ["a", "a2"]]);
  assert.ok(Math.abs(ring1.at(-1).a1 - TAU) < EPS);
  assert.ok(Math.abs(ring1.reduce((s, a) => s + a.share, 0) - 1) < EPS);
  assert.equal(layout.focusPaint.family, 0);
});

test("a stale path falls back to the deepest surviving ancestor", () => {
  const t = tree();
  const focus = sb.resolveFocus(t, ["a", "vanished", "deeper"]);
  assert.deepEqual(focus.path, ["a"]);
  assert.equal(focus.node.key, "a");
  assert.deepEqual(focus.trail.map((n) => n.key), ["", "a"]);
  assert.equal(sb.rerootAt(t, ["a", "vanished"]), null);
  assert.equal(sb.resolveFocus(t, ["gone"]).node, t);
  const layout = sb.layoutSunburst(t, ["gone"], "cost", OPTIONS);
  assert.deepEqual(layout.focus.path, []);
  assert.ok(layout.arcs.length > 0, "the circle is never empty because of a stale path");
});

test("rankChildren: biggest first, 'other' always last, ties keep server order", () => {
  const big = node(OTHER_KEY, 100, 100, undefined, { other: true });
  const parent = node("p", 0, 0, [big, node("x", 1, 9), node("y", 5, 1), node("z", 5, 2)], { dim: "root" });
  assert.deepEqual(sb.rankChildren(parent, "cost").map((n) => n.key), ["y", "z", "x", OTHER_KEY]);
  assert.deepEqual(sb.rankChildren(parent, "tokens").map((n) => n.key), ["x", "z", "y", OTHER_KEY]);
  assert.deepEqual(parent.children.map((n) => n.key), [OTHER_KEY, "x", "y", "z"], "the input is not reordered");
  assert.deepEqual(sb.rankChildren(node("leaf", 1, 1), "cost"), []);
});

test("paint: first-ring hue by server index, 8th and later tinted, other grey, stable", () => {
  const p0 = sb.paintFor(0, false, 1, 0);
  assert.deepEqual(p0, { family: 0, other: false, fade: 0 });
  assert.deepEqual(sb.paintFor(0, false, 1, 0), p0);
  assert.equal(sb.paintCss(p0), "var(--todo-color-blue)");
  assert.equal(sb.paintCss(sb.paintFor(1, false, 1, 1)), "var(--todo-color-orange)");
  const tinted = sb.paintFor(7, false, 1, 7);
  assert.equal(tinted.fade, 0.28);
  assert.equal(sb.paintCss(tinted), "color-mix(in srgb, var(--todo-color-blue) 72%, var(--bg-panel))");
  assert.equal(sb.paintCss(sb.paintFor(3, true, 1, 3)), "var(--todo-color-gray)");
  assert.ok(sb.paintFor(0, false, 3, 1).fade > sb.paintFor(0, false, 3, 0).fade, "siblings alternate");
  assert.ok(sb.paintFor(0, false, 4, 0).fade > sb.paintFor(0, false, 2, 0).fade, "deeper rings fade more");
  assert.ok(sb.paintFor(9, false, 6, 1).fade <= 0.78);
  assert.deepEqual(sb.seriesPaint(2, false), sb.paintFor(2, false, 1, 0));

  const many = node("", 0, 0, Array.from({ length: 9 }, (_, i) => node(`k${i}`, 10 - i, 10 - i)).concat(node(OTHER_KEY, 1, 1, undefined, { other: true })), { dim: "root" });
  const layout = sb.layoutSunburst(many, [], "cost", OPTIONS);
  const first = layout.arcs.filter((a) => a.ring === 1);
  assert.deepEqual(first.slice(0, 7).map((a) => a.paint.family), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(first[7].paint.fade, 0.28);
  assert.equal(first.at(-1).paint.other, true);
  assert.deepEqual(first[2].paint, sb.childPaint(many, [], 2, false));
});

test("arcPath of a full circle is not degenerate; a partial arc is a closed sector", () => {
  const full = sb.arcPath(0, TAU, 50, 100);
  const m = /^M(-?[\d.]+) (-?[\d.]+)A100 100 0 (\d) 1 (-?[\d.]+) (-?[\d.]+)L/.exec(full);
  assert.ok(m, full);
  assert.notDeepEqual([m[1], m[2]], [m[4], m[5]], "start and end differ so the arc has a direction");
  assert.equal(m[3], "1");
  assert.ok(full.endsWith("Z"));
  assert.ok(sb.arcPath(0, TAU, 0, 100).includes("L0 0Z"), "a disc sector closes at the centre");
  const quarter = sb.arcPath(0, Math.PI / 2, 50, 100);
  assert.ok(quarter.startsWith("M0 -100A100 100 0 0 1 100 0L50 0A50 50 0 0 0 0 -50Z"), quarter);
  assert.deepEqual(sb.polar(10, 0), [0, -10]);
});

test("arcLabel: null on tiny arcs, shortened long text, CJK counted wide", () => {
  const thin = { a0: 0, a1: 0.01, r0: 100, r1: 140 };
  assert.equal(sb.arcLabel(thin, "Anthropic", 12), null);
  assert.equal(sb.arcLabel({ a0: 0, a1: 1, r0: 100, r1: 110 }, "Anthropic", 12), null, "ring too thin for the font");
  assert.equal(sb.arcLabel({ a0: 0, a1: 1, r0: 100, r1: 140 }, "", 12), null);
  const roomy = { a0: 0, a1: 1, r0: 100, r1: 140 };
  assert.equal(sb.arcLabel(roomy, "Claude", 12).text, "Claude");
  const latin = "a-very-long-model-name-indeed";
  const cut = sb.arcLabel(roomy, latin, 12);
  assert.ok(cut.text.endsWith("…") && cut.text.length < latin.length);
  assert.ok(sb.textWidth(cut.text, 12) <= 1 * 120 - 10);
  assert.equal(sb.textWidth("日本", 10), 20);
  assert.ok(Math.abs(sb.textWidth("ab", 10) - 11.2) < EPS);
  const cjkText = "日本語のとても長い名前ですよね本当に";
  const cjk = sb.arcLabel(roomy, cjkText, 12);
  assert.ok(cjk.text.endsWith("…"));
  assert.ok(sb.textWidth(cjk.text, 12) <= 110);
  assert.ok(Array.from(cjk.text).length < Array.from(cut.text).length, "wide characters leave room for fewer of them");
  assert.ok(cut.d.startsWith("M"));
});

test("a label on the lower half runs against the sweep so it reads upright", () => {
  const top = sb.arcLabel({ a0: -0.5, a1: 0.5, r0: 100, r1: 140 }, "Claude", 12);
  const bottom = sb.arcLabel({ a0: Math.PI - 0.5, a1: Math.PI + 0.5, r0: 100, r1: 140 }, "Claude", 12);
  assert.ok(top.d.includes(" 0 0 1 "));
  assert.ok(bottom.d.includes(" 0 0 0 "));
});
