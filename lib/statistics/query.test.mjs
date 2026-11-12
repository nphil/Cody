import assert from "node:assert/strict";
import test from "node:test";
import { IDLE, NOW, addCall, load, scratch } from "./test-helpers.mjs";

const query = await load("./query.ts");
const { StatsStore } = await load("./store.ts");
const { customPeriod, presetPeriod } = await load("./days.ts");
const { OTHER_KEY, GROUP_BY_DIMS } = await load("./types.ts");

const { buildStatistics, buildDeepDive, projectLabels, MAX_NODES, NO_LABELS } = query;

const PERIOD = customPeriod("2026-11-06", "2026-11-12");
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} != ${b}`);

function openStore(t) {
  return StatsStore.open(scratch(t), "UTC");
}

function stats(store, over = {}) {
  return buildStatistics({ store, now: NOW, period: PERIOD, groupBy: "provider", visible: () => true, labels: NO_LABELS, status: IDLE, ...over });
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function assertSumsHold(node) {
  walk(node, (n) => {
    if (!n.children?.length) return;
    for (const field of ["cost", "tokens", "input", "output", "cacheRead", "cacheWrite", "unpricedTokens", "messages", "paygCost"]) {
      near(
        n.children.reduce((sum, c) => sum + c[field], 0),
        n[field],
        `${n.dim}:${n.key} ${field}`,
      );
    }
  });
}

const main = (chat, extra = {}) => ({ kind: "main", chat, cwd: `/proj/${chat}`, ...extra });

test("previousTotals is exactly the preceding window of the same length, boundary days on the right side", (t) => {
  const store = openStore(t);
  const w = main("c");
  for (const [day, input] of [["2026-10-29", 1], ["2026-10-30", 2], ["2026-11-05", 4], ["2026-11-06", 8], ["2026-11-12", 16], ["2026-11-13", 32]]) {
    addCall(store, w, day, { input, cost: 0.1 });
  }
  const res = stats(store);
  assert.deepEqual(res.previous, { from: "2026-10-30", to: "2026-11-05", days: 7, preset: null });
  assert.equal(res.totals.input, 24, "11-06 and 11-12 only");
  assert.equal(res.previousTotals.input, 6, "10-30 and 11-05 only");
  assert.equal(res.totals.messages, 2);
  assert.equal(res.previousTotals.messages, 2);
  assert.equal(res.dataFrom, "2026-10-29");
  assert.equal(res.dataTo, "2026-11-13");
  near(res.tree.cost, res.totals.cost);
  assert.equal(res.tree.tokens, res.totals.tokens);
});

test("previous window across a month boundary", (t) => {
  const store = openStore(t);
  const w = main("c");
  addCall(store, w, "2026-02-26", { input: 1, cost: 0.1 });
  addCall(store, w, "2026-02-28", { input: 2, cost: 0.1 });
  addCall(store, w, "2026-02-25", { input: 100, cost: 0.1 });
  addCall(store, w, "2026-03-01", { input: 4, cost: 0.1 });
  const res = stats(store, { period: customPeriod("2026-03-01", "2026-03-03") });
  assert.equal(res.previousTotals.input, 3);
  assert.equal(res.totals.input, 4);
  assert.equal(res.timeline.length, 3);
});

test("tree totals equal totals and every node's children add up to it", (t) => {
  const store = openStore(t);
  for (let i = 0; i < 6; i += 1) {
    addCall(store, main(`c${i}`), "2026-11-10", { provider: i % 2 ? "anthropic" : "openai", model: `m${i % 3}`, input: 100 + i, output: 10, cacheRead: 5, cost: 0.1 * (i + 1) });
    addCall(store, { kind: "subagent", chat: `c${i}`, agent: "explore", name: `t${i}` }, "2026-11-11", { provider: "anthropic", model: "m1", input: 3, cost: 0.01 });
  }
  addCall(store, main("c0"), "2026-11-11", { provider: "mystery", model: "mm", input: 50 });
  for (const groupBy of ["provider", "project", "model", "worker"]) {
    const res = stats(store, { groupBy });
    assertSumsHold(res.tree);
    near(res.tree.cost, res.totals.cost, groupBy);
    assert.equal(res.tree.tokens, res.totals.tokens);
    assert.equal(res.tree.unpricedTokens, res.totals.unpricedTokens);
    assert.deepEqual(res.dims, [...GROUP_BY_DIMS[groupBy]]);
    assert.equal(res.tree.children[0].dim, GROUP_BY_DIMS[groupBy][0]);
  }
});

test("groupBy decides the ring order down the first branch", (t) => {
  const store = openStore(t);
  addCall(store, main("c1"), "2026-11-10", { provider: "anthropic", model: "claude-x", input: 10, cost: 1 });
  for (const groupBy of ["provider", "project", "model", "worker"]) {
    const res = stats(store, { groupBy });
    const dims = [];
    let node = res.tree;
    while (node.children?.length) {
      node = node.children[0];
      dims.push(node.dim);
    }
    assert.deepEqual(dims, [...GROUP_BY_DIMS[groupBy]], groupBy);
  }
});

function providerStore(t, count) {
  const store = openStore(t);
  for (let i = 1; i <= count; i += 1) addCall(store, main(`c${i}`), "2026-11-10", { provider: `prov${String(i).padStart(2, "0")}`, model: "m", input: i, cost: i });
  return store;
}

test("the root keeps ROOT_KEEP children and folds the rest into one 'other'", (t) => {
  const res = stats(providerStore(t, 12));
  const kids = res.tree.children;
  assert.equal(kids.length, 10);
  const other = kids.at(-1);
  assert.equal(other.key, OTHER_KEY);
  assert.equal(other.other, true);
  near(other.cost, 1 + 2 + 3);
  assert.deepEqual(kids.slice(0, 9).map((k) => k.key), ["prov12", "prov11", "prov10", "prov09", "prov08", "prov07", "prov06", "prov05", "prov04"]);
  assert.ok(kids.slice(0, 9).every((k) => !k.other));
  assert.equal(other.children, undefined);
  assert.equal(res.series.length, 10);
  assert.equal(res.series.at(-1).other, true);
  assertSumsHold(res.tree);
});

test("a single leftover is not folded into 'other', two are", (t) => {
  const ten = stats(providerStore(t, 10)).tree.children;
  assert.equal(ten.length, 10);
  assert.ok(ten.every((k) => !k.other));
  const eleven = stats(providerStore(t, 11)).tree.children;
  assert.equal(eleven.length, 10);
  assert.equal(eleven.at(-1).other, true);
  near(eleven.at(-1).cost, 1 + 2);
});

test("a wide store (3000 chats) stays within MAX_NODES and keeps the totals", (t) => {
  const store = openStore(t);
  for (let i = 0; i < 3000; i += 1) {
    addCall(store, { kind: "main", chat: `chat-${i}`, cwd: `/p/${i % 300}` }, "2026-11-10", { provider: `prov${i % 12}`, model: `model${i % 7}`, input: 10 + (i % 13), cost: 0.01 * (1 + (i % 17)) });
  }
  for (const groupBy of ["provider", "project", "model", "worker"]) {
    const res = stats(store, { groupBy });
    let count = 0;
    walk(res.tree, () => {
      count += 1;
    });
    assert.ok(count <= MAX_NODES, `${groupBy}: ${count} nodes`);
    assert.ok(count > 10);
    assert.equal(res.totals.messages, 3000);
    assert.equal(res.totals.chats, 3000);
    assert.equal(res.tree.messages, 3000);
    assertSumsHold(res.tree);
  }
});

test("timeline has one entry per day, cells parallel to series, and adds up to the total", (t) => {
  const store = providerStore(t, 12);
  addCall(store, main("late"), "2026-11-12", { provider: "prov01", model: "m", input: 1, cost: 2 });
  const res = stats(store);
  assert.deepEqual(res.timeline.map((d) => d.day), ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
  for (const day of res.timeline) assert.equal(day.cells.length, res.series.length);
  near(res.timeline.reduce((s, d) => s + d.cells.reduce((c, cell) => c + cell.cost, 0), 0), res.totals.cost);
  const otherAt = res.series.findIndex((s) => s.other);
  near(res.timeline[4].cells[otherAt].cost, 1 + 2 + 3, "folded providers land in the other series");
  near(res.timeline[6].cells[otherAt].cost, 2, "prov01 was folded, so its later spend goes there too");
});

test("project labels disambiguate equal basenames", () => {
  const labels = projectLabels(["/x/web/app", "/y/web/app", "/z/other", "slug:-data-agent-thing", "slug:-data-agent-thing2", ""]);
  assert.equal(labels.get("/z/other"), "other");
  assert.equal(labels.get("/x/web/app"), "x/web/app");
  assert.equal(labels.get("/y/web/app"), "y/web/app");
  assert.equal(labels.get("slug:-data-agent-thing"), "thing");
  assert.equal(labels.has(""), false);
  assert.equal(projectLabels(["/a/web/app", "/b/other/app"]).get("/a/web/app"), "web/app");
  assert.equal(projectLabels(["/solo/app"]).get("/solo/app"), "app");
});

test("a project node is labelled with the disambiguated name and carries its path", (t) => {
  const store = openStore(t);
  addCall(store, { kind: "main", chat: "a", cwd: "/x/web/app" }, "2026-11-10", { input: 5, cost: 1 });
  addCall(store, { kind: "main", chat: "b", cwd: "/y/web/app" }, "2026-11-10", { input: 5, cost: 2 });
  addCall(store, { kind: "main", chat: "s", cwd: "", slug: "-data-agent" }, "2026-11-10", { input: 5, cost: 3 });
  const res = stats(store, { groupBy: "project" });
  const byKey = new Map(res.tree.children.map((n) => [n.key, n]));
  assert.equal(byKey.get("/x/web/app").label, "x/web/app");
  assert.equal(byKey.get("/y/web/app").detail, "/y/web/app");
  assert.equal(byKey.get("slug:-data-agent").label, "agent");
  assert.equal(byKey.get("slug:-data-agent").detail, undefined);
});

test("project labels map worktrees to their project through labels.projectOf", (t) => {
  const store = openStore(t);
  addCall(store, { kind: "main", chat: "a", cwd: "/repo/wt1" }, "2026-11-10", { input: 5, cost: 1 });
  addCall(store, { kind: "main", chat: "b", cwd: "/repo/wt2" }, "2026-11-10", { input: 5, cost: 1 });
  const labels = { titles: new Map([["a", "My chat"]]), projectOf: new Map([["/repo/wt1", "/repo"], ["/repo/wt2", "/repo"]]) };
  const res = stats(store, { groupBy: "project", labels });
  assert.equal(res.tree.children.length, 1);
  assert.equal(res.tree.children[0].key, "/repo");
  const chats = res.tree.children[0].children[0].children;
  assert.equal(chats.find((c) => c.key === "a").label, "My chat");
  assert.equal(chats.find((c) => c.key === "a").chat, "a");
});

test("a subagent is filed under its parent chat's project, not where it ran", (t) => {
  const store = openStore(t);
  addCall(store, { kind: "main", chat: "c", cwd: "/proj/c" }, "2026-11-10", { input: 5, cost: 1 });
  addCall(store, { kind: "subagent", chat: "c", agent: "explore", name: "t1", cwd: "/somewhere/else" }, "2026-11-10", { input: 5, cost: 1 });
  const res = stats(store, { groupBy: "project" });
  assert.deepEqual(res.tree.children.map((n) => n.key), ["/proj/c"]);
  assert.equal(res.tree.children[0].cost, 2);
});

test("a visible predicate hides other owners' chats everywhere", (t) => {
  const store = openStore(t);
  addCall(store, main("mine"), "2026-11-10", { provider: "anthropic", model: "claude-mine", input: 10, cost: 1 });
  addCall(store, main("bob-chat"), "2026-10-31", { provider: "bobprov", model: "bobmodel", input: 1000, cost: 50 });
  addCall(store, main("bob-chat"), "2026-11-10", { provider: "bobprov", model: "bobmodel", input: 1000, cost: 50 });
  addCall(store, main("bob-chat"), "2026-11-11", { provider: "bobprov", model: "bobunpriced", input: 777 });
  addCall(store, { kind: "subagent", chat: "bob-chat", agent: "explore", name: "bt" }, "2026-11-11", { provider: "bobprov", model: "bobsub", input: 500, cost: 9 });
  addCall(store, { kind: "oneshot", chat: "bob-chat" }, "2026-11-11", { provider: "bobprov", model: "bobbg", worker: "background:title", input: 500, cost: 9 });
  addCall(store, { kind: "main", chat: "mine", cwd: "/proj/mine", path: "/fake/early.jsonl" }, "2026-11-01", { input: 2, cost: 0.5 });

  const everyone = stats(store);
  assert.ok(everyone.totals.cost > 60);
  const res = stats(store, { visible: (chat) => chat !== "bob-chat" });
  near(res.totals.cost, 1);
  assert.equal(res.totals.tokens, 10);
  assert.equal(res.totals.chats, 1);
  assert.equal(res.totals.unpricedTokens, 0);
  assert.equal(res.previousTotals.input, 2, "the earlier own row is still seen; bob's 10-31 row is not");
  assert.equal(res.dataFrom, "2026-11-01");
  assert.deepEqual(res.unpricedModels, []);
  const text = JSON.stringify(res);
  for (const needle of ["bob", "Bobprov"]) assert.equal(text.includes(needle), false, `leaked ${needle}`);
  assert.ok(res.insights.every((i) => i.id !== "backgroundShare" && i.id !== "subagentShare" && i.id !== "unpriced"));
  assert.equal(res.tree.children.length, 1);
});

test("a message with no price is unpriced tokens and never a $0 cost; totals and nodes say so", (t) => {
  const store = openStore(t);
  addCall(store, main("c"), "2026-11-10", { provider: "anthropic", model: "priced", input: 100, cost: 2 });
  addCall(store, main("c"), "2026-11-10", { provider: "anthropic", model: "mystery-model", input: 70, output: 30 });
  addCall(store, main("c"), "2026-11-10", { provider: "ollama", model: "llama", input: 400 });
  const res = stats(store);
  assert.equal(res.totals.unpricedTokens, 100, "the local model is not flagged");
  assert.equal(res.totals.cost, 2);
  assert.equal(res.totals.tokens, 600);
  const anthropic = res.tree.children.find((n) => n.key === "anthropic");
  assert.equal(anthropic.unpricedTokens, 100);
  assert.equal(anthropic.billing, "subscription");
  const models = new Map(anthropic.children.map((n) => [n.label, n]));
  assert.equal(models.get("mystery-model").unpricedTokens, 100);
  assert.equal(models.get("mystery-model").cost, 0);
  assert.equal(models.get("priced").unpricedTokens, 0);
  assert.equal(res.tree.children.find((n) => n.key === "ollama").billing, "local");
  assert.equal(res.tree.children.find((n) => n.key === "ollama").unpricedTokens, 0);
  assert.deepEqual(res.unpricedModels, ["mystery-model"]);
  const unpriced = res.insights.find((i) => i.id === "unpriced");
  assert.deepEqual(unpriced.values, { tokens: 100, models: 1 });
});

test("payg spend is split out from subscription estimates", (t) => {
  const store = openStore(t);
  addCall(store, main("c"), "2026-11-10", { provider: "anthropic", input: 1, cost: 3 });
  addCall(store, main("c"), "2026-11-10", { provider: "anthropic-api", input: 1, cost: 4 });
  const res = stats(store);
  assert.equal(res.totals.cost, 7);
  assert.equal(res.totals.paygCost, 4);
});

test("insights appear only when their numbers say something", (t) => {
  const quiet = openStore(t);
  addCall(quiet, main("c"), "2026-11-10", { input: 10, cost: 1 });
  const none = stats(quiet);
  assert.deepEqual(none.insights.map((i) => i.id), ["priciestDay"], "one provider, no helpers, no cache savings, nothing unpriced");
  assert.deepEqual(stats(quiet, { period: presetPeriod("today", "2026-11-10") }).insights, [], "priciest day needs a multi-day period");

  const loud = openStore(t);
  addCall(loud, main("c"), "2026-11-09", { provider: "anthropic", model: "a", input: 1_000_000, cacheRead: 1_000_000, costInput: 3, costCacheRead: 0.3, cost: 3.3 });
  addCall(loud, main("c"), "2026-11-10", { provider: "openai", model: "o", input: 10, cost: 1 });
  addCall(loud, { kind: "subagent", chat: "c", agent: "explore", name: "t" }, "2026-11-10", { provider: "openai", model: "o", input: 100, cost: 0.5 });
  addCall(loud, { kind: "oneshot", chat: "" }, "2026-11-10", { provider: "openai", model: "o", worker: "background:title", input: 40, cost: 0.1 });
  addCall(loud, main("c"), "2026-11-10", { provider: "openai", model: "nopr", input: 60 });
  const res = stats(loud);
  const byId = new Map(res.insights.map((i) => [i.id, i.values]));
  assert.deepEqual([...byId.keys()].sort(), ["backgroundShare", "cacheSaved", "priciestDay", "subagentShare", "topSpender", "unpriced"]);
  near(byId.get("cacheSaved").amount, 2.7);
  assert.equal(byId.get("subagentShare").tokenShare, 100 / res.totals.tokens);
  assert.equal(byId.get("backgroundShare").tokens, 40);
  assert.equal(byId.get("topSpender").key, "anthropic");
  assert.equal(byId.get("priciestDay").day, "2026-11-09");
  assert.equal(byId.get("unpriced").tokens, 60);
});

test("deep dive: top turns by cost, subagents, openable flag, in-period totals, null for an unknown chat", (t) => {
  const store = openStore(t);
  const home = main("c1");
  addCall(store, home, "2026-11-01", { id: "t1", input: 10, cost: 0.5 });
  addCall(store, home, "2026-11-10", { id: "t2", input: 20, cost: 0.1 });
  addCall(store, home, "2026-11-11", { id: "t3", input: 30, cost: 0.9 });
  addCall(store, home, "2026-11-11", { id: "t4", input: 40, model: "np" });
  addCall(store, { kind: "subagent", chat: "c1", agent: "explore", name: "task-a" }, "2026-11-11", { id: "s1", input: 5, cost: 0.7 });
  addCall(store, { kind: "subagent", chat: "c1", agent: "plan", name: "task-b" }, "2026-11-11", { id: "s2", input: 6, cost: 0.2 });
  addCall(store, { kind: "sidebar", chat: "side", cwd: "/proj/side" }, "2026-11-11", { worker: "sidebar", input: 1, cost: 1 });
  addCall(store, main("c2"), "2026-11-11", { input: 1, cost: 100 });

  const dive = buildDeepDive({ store, chat: "c1", period: PERIOD, labels: { titles: new Map([["c1", "Title"]]), projectOf: new Map() }, status: IDLE });
  assert.equal(dive.title, "Title");
  assert.equal(dive.openable, true);
  assert.equal(dive.cwd, "/proj/c1");
  assert.equal(dive.project, "c1");
  assert.deepEqual(dive.topTurns.map((turn) => turn.cost), [0.9, 0.7, 0.5, 0.2, 0.1, 0]);
  assert.deepEqual(dive.subagents.map((s) => [s.name, s.agent, s.kind]), [["task-a", "explore", "subagent"], ["task-b", "plan", "subagent"]]);
  near(dive.lifetime.cost, 0.5 + 0.1 + 0.9 + 0.7 + 0.2);
  near(dive.inPeriod.cost, 0.1 + 0.9 + 0.7 + 0.2, "the 11-01 turn is outside the period");
  assert.equal(dive.inPeriod.unpricedTokens, 40);
  assert.equal(dive.workers[0].worker, "main");
  assert.ok(dive.workers.some((w) => w.worker === "subagent:explore"));
  assert.equal(buildDeepDive({ store, chat: "c1", period: null, labels: NO_LABELS, status: IDLE }).inPeriod, null);
  assert.equal(buildDeepDive({ store, chat: "nope", period: PERIOD, labels: NO_LABELS, status: IDLE }), null);
  assert.equal(buildDeepDive({ store, chat: "side", period: PERIOD, labels: NO_LABELS, status: IDLE }).openable, false, "a side chat cannot be opened");
  for (const file of store.files.values()) if (file.chat === "c1") file.gone = true;
  assert.equal(buildDeepDive({ store, chat: "c1", period: PERIOD, labels: NO_LABELS, status: IDLE }).openable, false, "a deleted chat cannot be opened");
});
