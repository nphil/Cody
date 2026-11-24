import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { newFirstSnapshot, newFirstEntries, liftNewFirst, nextNewFirstSnapshot } = await jiti.import("./new-first.ts");
const { isBadgedRow } = await jiti.import("../new-badges.ts");

const row = (key, extra = {}) => ({ key, visible: true, modified: false, ...extra });
function group(id, rows) {
  return { id, label: id.toUpperCase(), rows, changed: rows.filter((entry) => entry.modified).length };
}
function tab(id, groups, ungrouped = []) {
  const rows = [...groups, ...ungrouped].flatMap((entry) => entry.rows);
  return { id, label: `Tab ${id}`, rows, groups, ungrouped, changed: rows.filter((entry) => entry.modified).length };
}

const a1 = row("a.one");
const a2 = row("a.two", { modified: true });
const b1 = row("b.one");
const b2 = row("b.two");
const c1 = row("c.one");
const tabs = [tab("t1", [group("a", [a1, a2]), group("b", [b1, b2])]), tab("t2", [], [group("c", [c1])])];
const rows = [a1, a2, b1, b2, c1];

test("snapshot is the badged rows in the engine's own order", () => {
  const fresh = new Set(["c.one", "a.two", "b.one"]);
  assert.deepEqual(newFirstSnapshot(rows, (entry) => isBadgedRow(entry, (key) => fresh.has(key))), ["a.two", "b.one", "c.one"]);
});

test("the chip's own rules decide: hidden rows and terminal-only rows are not in it", () => {
  const list = [row("x.visible"), row("x.hidden", { visible: false }), row("x.terminal", { terminalOnly: true })];
  assert.deepEqual(newFirstSnapshot(list, (entry) => isBadgedRow(entry, () => true)), ["x.visible"]);
});

test("nothing new: no entries and the very same tabs", () => {
  assert.deepEqual(newFirstSnapshot(rows, () => false), []);
  assert.deepEqual(newFirstEntries(tabs, []), []);
  const lifted = liftNewFirst(tabs, []);
  assert.equal(lifted.length, tabs.length);
  assert.equal(lifted[0], tabs[0]);
  assert.equal(lifted[1], tabs[1]);
});

test("entries keep snapshot order and name their section", () => {
  const entries = newFirstEntries(tabs, ["c.one", "a.one", "b.two"]);
  assert.deepEqual(entries.map((entry) => entry.row.key), ["c.one", "a.one", "b.two"]);
  assert.deepEqual(entries.map((entry) => entry.section), ["Tab t2 › C", "Tab t1 › A", "Tab t1 › B"]);
});

test("a single-tab engine names the group alone", () => {
  const single = [tabs[0]];
  assert.deepEqual(newFirstEntries(single, ["b.one"]).map((entry) => entry.section), ["B"]);
});

test("a snapshot row that is gone or has no control on screen is left out", () => {
  const hidden = row("h.one", { visible: false });
  const withHidden = [tab("t", [group("h", [hidden, b1])])];
  assert.deepEqual(newFirstEntries(withHidden, ["gone.key", "h.one", "b.one"]).map((entry) => entry.row.key), ["b.one"]);
});

test("a row changed after the snapshot stays in the group: the snapshot, not the chip, decides", () => {
  const snapshot = ["a.one"];
  const edited = { ...a1, modified: true };
  const after = [tab("t1", [group("a", [edited, a2])])];
  assert.deepEqual(newFirstEntries(after, snapshot).map((entry) => entry.row), [edited]);
});

test("lifting removes each snapshot row once and keeps the rest in order, counts following", () => {
  const lifted = liftNewFirst(tabs, ["a.two", "c.one"]);
  assert.deepEqual(lifted[0].groups.map((entry) => entry.rows.map((r) => r.key)), [["a.one"], ["b.one", "b.two"]]);
  assert.equal(lifted[0].groups[0].changed, 0);
  assert.equal(lifted[0].changed, 0);
  assert.deepEqual(lifted[0].rows.map((r) => r.key), ["a.one", "b.one", "b.two"]);
  assert.equal(lifted[0].groups[1], tabs[0].groups[1], "an untouched group is the same object");
  assert.deepEqual(lifted[1].ungrouped, [], "a group left empty goes");
  assert.deepEqual(lifted[1].rows, []);
  assert.equal(tabs[0].groups[0].rows.length, 2, "the input is not mutated");
});

test("every row is listed exactly once across the group and the lifted tabs", () => {
  const snapshot = ["b.two", "a.one"];
  const shown = [
    ...newFirstEntries(tabs, snapshot).map((entry) => entry.row.key),
    ...liftNewFirst(tabs, snapshot).flatMap((entry) => [...entry.groups, ...entry.ungrouped].flatMap((g) => g.rows.map((r) => r.key))),
  ];
  assert.deepEqual([...shown].sort(), rows.map((entry) => entry.key).sort());
});

test("the snapshot is taken once when ready and never moves mid-open", () => {
  let badged = ["a.one", "b.one"];
  const take = () => [...badged];
  assert.equal(nextNewFirstSnapshot(null, false, take), null, "not ready: no snapshot (an empty answer is not an answer)");
  const first = nextNewFirstSnapshot(null, true, take);
  assert.deepEqual(first, ["a.one", "b.one"]);
  badged = ["b.one"]; // a.one was changed: its chip is gone, its place is not
  assert.equal(nextNewFirstSnapshot(first, true, take), first);
  assert.equal(nextNewFirstSnapshot(first, false, take), null, "an engine switch or reload starts over");
  assert.deepEqual(nextNewFirstSnapshot(null, true, take), ["b.one"], "the next open sees the faded state");
  assert.deepEqual(nextNewFirstSnapshot(null, true, () => []), [], "zero new: an empty snapshot, no group");
});
