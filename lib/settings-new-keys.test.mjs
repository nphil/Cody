import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The rules behind the "New" badge on engine settings: what an engine update
 * added, and when the badge fades for one person. Pure functions, so the whole
 * product rule is covered here without a disk, a server or a browser.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  FADE_AFTER_SEEN,
  MAX_OPEN_ID_CHARS,
  MAX_REPORT_KEYS,
  MAX_REPORT_KEY_CHARS,
  UNKNOWN_ENGINE_VERSION,
  applyChanged,
  applySeen,
  diffEngineKeys,
  isFaded,
  normalizeKeys,
  normalizeVersion,
  parseCounter,
  parseSeenReport,
  parseSnapshot,
  pruneCounters,
  syncSnapshot,
  visibleNewKeys,
} = await jiti.import("./settings-new-keys.ts");

const V_OLD = "18.8.3";
const V_NEW = "18.19.0";
const V_NEWER = "18.20.0";
const BASE = ["a.one", "a.two", "b.three"];

// ── what an engine update added ─────────────────────────────────────

test("the first look records the keys and badges nothing — a fresh install never lights up every setting", () => {
  assert.deepEqual(diffEngineKeys(null, BASE), { firstRun: true, added: [] });
  assert.deepEqual(diffEngineKeys(undefined, BASE), { firstRun: true, added: [] });

  const sync = syncSnapshot(null, V_OLD, BASE);
  assert.equal(sync.firstRun, true);
  assert.deepEqual(sync.added, []);
  assert.equal(sync.changed, true, "the snapshot is new, so it has to be written");
  assert.deepEqual(sync.snapshot, { engineVersion: V_OLD, previousVersion: null, keys: BASE, introduced: {} });
});

test("an update badges exactly the keys the previous snapshot did not have, labelled with the version that brought them", () => {
  const first = syncSnapshot(null, V_OLD, BASE).snapshot;
  const sync = syncSnapshot(first, V_NEW, [...BASE, "c.four", "a.five"]);
  assert.equal(sync.firstRun, false);
  assert.deepEqual(sync.added, ["a.five", "c.four"]);
  assert.equal(sync.changed, true);
  assert.deepEqual(sync.snapshot, {
    engineVersion: V_NEW,
    previousVersion: V_OLD,
    keys: ["a.five", "a.one", "a.two", "b.three", "c.four"],
    introduced: { "c.four": V_NEW, "a.five": V_NEW },
  });
  assert.deepEqual(diffEngineKeys(first.keys, [...BASE, "c.four"]), { firstRun: false, added: ["c.four"] });
});

test("new keys accumulate across successive upgrades while still unfaded, each keeping its own version", () => {
  const first = syncSnapshot(null, V_OLD, BASE).snapshot;
  const second = syncSnapshot(first, V_NEW, [...BASE, "c.four"]).snapshot;
  const third = syncSnapshot(second, V_NEWER, [...BASE, "c.four", "d.six"]);
  assert.deepEqual(third.added, ["d.six"], "only what is new relative to the LAST snapshot");
  assert.deepEqual(third.snapshot.introduced, { "c.four": V_NEW, "d.six": V_NEWER });
  assert.equal(third.snapshot.previousVersion, V_NEW);
});

test("a key that leaves the schema drops out of the new set; one that returns is new again", () => {
  const first = syncSnapshot(null, V_OLD, BASE).snapshot;
  const second = syncSnapshot(first, V_NEW, [...BASE, "c.four", "d.six"]).snapshot;
  const third = syncSnapshot(second, V_NEWER, [...BASE, "d.six"]);
  assert.deepEqual(third.added, []);
  assert.deepEqual(third.snapshot.introduced, { "d.six": V_NEW }, "c.four left the schema and is no longer badged");
  assert.deepEqual(third.snapshot.keys, ["a.one", "a.two", "b.three", "d.six"]);

  const fourth = syncSnapshot(third.snapshot, "18.21.0", [...BASE, "c.four", "d.six"]);
  assert.deepEqual(fourth.added, ["c.four"]);
  assert.deepEqual(fourth.snapshot.introduced, { "d.six": V_NEW, "c.four": "18.21.0" });
});

test("looking again at the same version and keys is a no-op that needs no write", () => {
  const first = syncSnapshot(null, V_OLD, BASE).snapshot;
  const again = syncSnapshot(first, V_OLD, [...BASE].reverse());
  assert.equal(again.changed, false);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.snapshot, first);

  const upgraded = syncSnapshot(first, V_NEW, [...BASE, "c.four"]).snapshot;
  const upgradedAgain = syncSnapshot(upgraded, V_NEW, [...BASE, "c.four"]);
  assert.equal(upgradedAgain.changed, false, "the introduced keys survive a second look at the same version");
  assert.deepEqual(upgradedAgain.snapshot.introduced, { "c.four": V_NEW });
});

test("a new version with the same keys moves the label and badges nothing", () => {
  const first = syncSnapshot(null, V_OLD, BASE).snapshot;
  const sync = syncSnapshot(first, V_NEW, BASE);
  assert.equal(sync.changed, true);
  assert.deepEqual(sync.added, []);
  assert.deepEqual(sync.snapshot.introduced, {});
  assert.equal(sync.snapshot.engineVersion, V_NEW);
  assert.equal(sync.snapshot.previousVersion, V_OLD);
});

test("a downgrade adds nothing and drops what vanished; the snapshot is replaced by the current one", () => {
  const first = syncSnapshot(null, V_OLD, BASE).snapshot;
  const upgraded = syncSnapshot(first, V_NEW, [...BASE, "c.four", "d.six"]).snapshot;
  const downgraded = syncSnapshot(upgraded, V_OLD, [...BASE, "c.four"]);
  assert.deepEqual(downgraded.added, []);
  assert.deepEqual(downgraded.snapshot.introduced, { "c.four": V_NEW }, "d.six is gone; c.four was introduced before and keeps its label");
  assert.deepEqual(downgraded.snapshot.keys, ["a.one", "a.two", "b.three", "c.four"]);
  assert.equal(downgraded.snapshot.engineVersion, V_OLD);
  assert.equal(downgraded.snapshot.previousVersion, V_NEW);
});

test("an engine whose version cannot be read still diffs by key set, under a stable placeholder", () => {
  assert.equal(normalizeVersion(null), UNKNOWN_ENGINE_VERSION);
  assert.equal(normalizeVersion("   "), UNKNOWN_ENGINE_VERSION);
  assert.equal(normalizeVersion(" 18.19.0 "), "18.19.0");

  const first = syncSnapshot(null, null, BASE);
  assert.equal(first.snapshot.engineVersion, UNKNOWN_ENGINE_VERSION);
  const sync = syncSnapshot(first.snapshot, undefined, [...BASE, "c.four"]);
  assert.deepEqual(sync.added, ["c.four"]);
  assert.equal(sync.snapshot.previousVersion, null, "an unchanged placeholder is not a version change");
  assert.deepEqual(sync.snapshot.introduced, { "c.four": UNKNOWN_ENGINE_VERSION });
});

test("key sets are canonical: trimmed, deduplicated, sorted, strings only", () => {
  assert.deepEqual(normalizeKeys(["b", " a ", "b", "", "  ", 7, null, "a"]), ["a", "b"]);
  assert.deepEqual(normalizeKeys(new Set(["z", "y"])), ["y", "z"]);
});

// ── when the badge fades for one person ─────────────────────────────

test("a Settings open counts once, however many times the report repeats", () => {
  const first = applySeen(null, "open-1");
  assert.deepEqual(first, { seen: 1, openId: "open-1", changed: false });
  assert.equal(applySeen(first, "open-1"), first, "a retried or duplicated report of the same open returns the very same counter");

  const second = applySeen(first, "open-2");
  assert.deepEqual(second, { seen: 2, openId: "open-2", changed: false });
  assert.equal(applySeen(second, "open-2"), second);
  assert.equal(isFaded(second), false);
});

test("the badge fades on the third counted open, not before", () => {
  let counter = null;
  for (let open = 1; open < FADE_AFTER_SEEN; open += 1) {
    counter = applySeen(counter, `open-${open}`);
    assert.equal(isFaded(counter), false, `still badged after ${open} opens`);
  }
  counter = applySeen(counter, `open-${FADE_AFTER_SEEN}`);
  assert.equal(counter.seen, FADE_AFTER_SEEN);
  assert.equal(isFaded(counter), true);
  assert.equal(FADE_AFTER_SEEN, 3, "the product rule: three counted opens");
});

test("a faded counter never moves again — the count stops at the limit", () => {
  const faded = { seen: FADE_AFTER_SEEN, openId: "open-3", changed: false };
  assert.equal(applySeen(faded, "open-4"), faded);
  assert.equal(applySeen(applyChanged(null), "open-9").seen, 0, "a changed key does not start counting");
});

test("changing the key fades the badge at once and for good", () => {
  const changed = applyChanged(null);
  assert.deepEqual(changed, { seen: 0, openId: null, changed: true });
  assert.equal(isFaded(changed), true);
  assert.equal(applyChanged(changed), changed, "idempotent");

  const afterSeeing = applyChanged(applySeen(null, "open-1"));
  assert.deepEqual(afterSeeing, { seen: 1, openId: "open-1", changed: true }, "keeps what was counted");
});

test("what is still badged is decided per person: one person's views never fade another's chip", () => {
  const introduced = { "c.four": V_NEW, "d.six": V_NEW, "e.seven": V_NEWER };
  const ana = { "c.four": { seen: FADE_AFTER_SEEN, openId: "x", changed: false }, "d.six": applyChanged(null) };
  const ben = { "c.four": { seen: 1, openId: "y", changed: false } };

  assert.deepEqual(visibleNewKeys(introduced, ana), ["e.seven"]);
  assert.deepEqual(visibleNewKeys(introduced, ben), ["c.four", "d.six", "e.seven"]);
  assert.deepEqual(visibleNewKeys(introduced, null), ["c.four", "d.six", "e.seven"], "a person with no counters yet sees every new key");
  assert.deepEqual(visibleNewKeys({}, ana), []);
});

test("a counter follows its key: pruned when the key leaves the new set", () => {
  const counters = { "c.four": { seen: 2, openId: "x", changed: false }, "gone.key": { seen: 1, openId: "y", changed: false } };
  assert.deepEqual(pruneCounters(counters, { "c.four": V_NEW }), { "c.four": counters["c.four"] });
  assert.deepEqual(pruneCounters(counters, {}), {});
});

// ── tolerance of what is on disk ────────────────────────────────────

test("a snapshot read from disk is repaired or rejected, never trusted", () => {
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot("nope"), null);
  assert.equal(parseSnapshot([]), null);
  assert.equal(parseSnapshot({ engineVersion: "1" }), null, "no key list is not a snapshot");

  assert.deepEqual(
    parseSnapshot({
      engineVersion: " 18.19.0 ",
      previousVersion: "18.8.3",
      keys: ["b", "a", "a", 3],
      introduced: { a: "18.19.0", stray: "18.19.0", b: "", c: 4 },
    }),
    { engineVersion: "18.19.0", previousVersion: "18.8.3", keys: ["a", "b"], introduced: { a: "18.19.0" } },
    "introduced keys the snapshot does not list, or with no version, are dropped",
  );
  assert.deepEqual(parseSnapshot({ keys: [] }), { engineVersion: UNKNOWN_ENGINE_VERSION, previousVersion: null, keys: [], introduced: {} });
});

test("a counter read from disk is clamped and defaulted", () => {
  assert.equal(parseCounter(undefined), null);
  assert.equal(parseCounter(3), null);
  assert.deepEqual(parseCounter({}), { seen: 0, openId: null, changed: false });
  assert.deepEqual(parseCounter({ seen: 99, openId: "o", changed: true }), { seen: FADE_AFTER_SEEN, openId: "o", changed: true });
  assert.deepEqual(parseCounter({ seen: -4, openId: "", changed: "yes" }), { seen: 0, openId: null, changed: false });
  assert.deepEqual(parseCounter({ seen: 1.9, openId: 7 }), { seen: 1, openId: null, changed: false });
});

// ── what the Settings dialog may report ─────────────────────────────

test("a report is normalized: one openId, deduplicated trimmed keys, either list optional", () => {
  assert.deepEqual(parseSeenReport({ openId: "open-1", seen: ["b", " a ", "b"], changed: ["c"] }), {
    report: { openId: "open-1", seen: ["a", "b"], changed: ["c"] },
  });
  assert.deepEqual(parseSeenReport({ openId: "open-1" }), { report: { openId: "open-1", seen: [], changed: [] } });
  assert.deepEqual(parseSeenReport({ openId: "open-1", seen: [] }), { report: { openId: "open-1", seen: [], changed: [] } });
});

test("a report that is not shaped like one, or is out of bounds, is refused", () => {
  for (const body of [null, undefined, "x", 7, [], { seen: ["a"] }, { openId: "" }, { openId: "   " }, { openId: 5 }, { openId: "x".repeat(MAX_OPEN_ID_CHARS + 1) }]) {
    assert.ok("error" in parseSeenReport(body), `refused: ${JSON.stringify(body)}`);
  }
  assert.ok("report" in parseSeenReport({ openId: "x".repeat(MAX_OPEN_ID_CHARS) }));

  for (const list of ["seen", "changed"]) {
    assert.ok("error" in parseSeenReport({ openId: "o", [list]: "a.one" }), `${list} must be an array`);
    assert.ok("error" in parseSeenReport({ openId: "o", [list]: ["a", 3] }), `${list} must hold strings`);
    assert.ok("error" in parseSeenReport({ openId: "o", [list]: ["x".repeat(MAX_REPORT_KEY_CHARS + 1)] }), `${list} keys are bounded`);
    assert.ok("error" in parseSeenReport({ openId: "o", [list]: Array.from({ length: MAX_REPORT_KEYS + 1 }, (_, index) => `k${index}`) }), `${list} is bounded`);
    assert.ok("report" in parseSeenReport({ openId: "o", [list]: Array.from({ length: MAX_REPORT_KEYS }, (_, index) => `k${index}`) }));
  }
});
