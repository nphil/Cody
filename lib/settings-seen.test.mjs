import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The ledger behind the "New" badge on engine settings: per-engine snapshots of
 * the key set Cody last saw, and per-person counters for the keys that arrived
 * after. The rules are covered in settings-new-keys.test.mjs; this file covers
 * what the disk adds: where it lives, how it is written, what a damaged file
 * reads as, and that two people never share a counter.
 */
const root = mkdtempSync(join(tmpdir(), "cody-settings-seen-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
// The instance dir does not exist yet: the ledger has to create it (0700).
const agentDir = join(root, "instance");
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const ledger = await jiti.import("./settings-seen.ts");
const rules = await jiti.import("./settings-new-keys.ts");

const ledgerPath = join(agentDir, "cody-settings-seen.json");
const BASE = ["a.one", "a.two", "b.three"];
const UPGRADED = [...BASE, "c.four", "d.five"];
const ANA = "account-ana";
const BEN = "account-ben";

function reset() {
  rmSync(ledgerPath, { force: true });
}

/** Record the first look at omp 18.8.3, then the upgrade that brings c.four and d.five. */
function upgrade(engineId = "omp") {
  ledger.syncEngineKeys(engineId, "18.8.3", BASE);
  return ledger.syncEngineKeys(engineId, "18.19.0", UPGRADED);
}

test("the ledger lives in the instance data dir, which it creates private, and is written private", () => {
  assert.equal(existsSync(agentDir), false, "nothing exists before the first write");
  assert.equal(ledger.getSettingsSeenPath(), ledgerPath);
  assert.equal(ledger.SETTINGS_SEEN_FILE, "cody-settings-seen.json");

  ledger.syncEngineKeys("omp", "18.8.3", BASE);
  assert.equal(statSync(agentDir).mode & 0o777, 0o700, "the instance dir is 0700");
  assert.equal(statSync(ledgerPath).mode & 0o777, 0o600, "the ledger is 0600");
  assert.deepEqual(readdirSync(agentDir), ["cody-settings-seen.json"], "the temp file of the atomic write is renamed away");

  ledger.syncEngineKeys("omp", "18.19.0", UPGRADED);
  assert.equal(statSync(ledgerPath).mode & 0o777, 0o600, "a later write keeps the mode");
  assert.deepEqual(readdirSync(agentDir), ["cody-settings-seen.json"]);
});

test("the first look records every key and badges nothing, for anyone", () => {
  reset();
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp"), { newKeys: [], since: {} }, "no ledger: nothing is new");

  const first = ledger.syncEngineKeys("omp", "18.8.3", BASE);
  assert.deepEqual(first, { engineVersion: "18.8.3", previousVersion: null, firstRun: true, introduced: {} });
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp"), { newKeys: [], since: {} });
  assert.deepEqual(ledger.readUserNewKeys(ledger.INSTANCE_SETTINGS_KEY, "omp"), { newKeys: [], since: {} });

  const file = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(file.engines.omp, { engineVersion: "18.8.3", previousVersion: null, keys: BASE, introduced: {} });

  const again = ledger.syncEngineKeys("omp", "18.8.3", BASE);
  assert.equal(again.firstRun, false, "only the look that created the snapshot is the first run");
  assert.deepEqual(again.introduced, {});
});

test("an upgrade badges exactly the added keys, for every person, labelled with the version that brought them", () => {
  reset();
  const sync = upgrade();
  assert.equal(sync.firstRun, false);
  assert.equal(sync.previousVersion, "18.8.3");
  assert.equal(sync.engineVersion, "18.19.0");
  assert.deepEqual(sync.introduced, { "c.four": "18.19.0", "d.five": "18.19.0" });

  for (const owner of [ANA, BEN, ledger.INSTANCE_SETTINGS_KEY]) {
    assert.deepEqual(ledger.readUserNewKeys(owner, "omp"), {
      newKeys: ["c.four", "d.five"],
      since: { "c.four": "18.19.0", "d.five": "18.19.0" },
    });
  }
  assert.deepEqual(ledger.syncEngineKeys("omp", "18.19.0", UPGRADED).introduced, sync.introduced, "a second look at the same version keeps them");
});

test("new keys accumulate across upgrades and a key that leaves the schema takes its counters with it", () => {
  reset();
  upgrade();
  ledger.recordSeen(ANA, "omp", ["c.four", "d.five"], "open-1");
  ledger.recordChanged(BEN, "omp", ["d.five"]);

  const next = ledger.syncEngineKeys("omp", "18.20.0", [...BASE, "d.five", "e.six"]);
  assert.deepEqual(next.introduced, { "d.five": "18.19.0", "e.six": "18.20.0" }, "d.five is still new, c.four left, e.six arrived");
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp").newKeys, ["d.five", "e.six"], "Ana has seen d.five once and it is still badged");
  assert.deepEqual(ledger.readUserNewKeys(BEN, "omp").newKeys, ["e.six"], "Ben changed d.five");

  const file = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(Object.keys(file.users[ANA].omp), ["d.five"], "the counter of the key that left the schema is gone");

  // c.four coming back is new again, from zero.
  ledger.syncEngineKeys("omp", "18.21.0", [...BASE, "c.four", "d.five", "e.six"]);
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp").newKeys, ["c.four", "d.five", "e.six"]);
});

test("a Settings open counts once per person and key, and the badge fades on the third open", () => {
  reset();
  upgrade();

  const first = ledger.recordSeen(ANA, "omp", ["c.four"], "open-1");
  assert.deepEqual(first.newKeys, ["c.four", "d.five"]);
  const duplicate = ledger.recordSeen(ANA, "omp", ["c.four"], "open-1");
  assert.deepEqual(duplicate.newKeys, ["c.four", "d.five"], "a retried or duplicated POST of the same open does not count");
  ledger.recordSeen(ANA, "omp", ["c.four", "c.four"], "open-1");
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).users[ANA].omp["c.four"].seen, 1);

  const second = ledger.recordSeen(ANA, "omp", ["c.four"], "open-2");
  assert.deepEqual(second.newKeys, ["c.four", "d.five"], "two opens: still badged");
  const third = ledger.recordSeen(ANA, "omp", ["c.four"], "open-3");
  assert.deepEqual(third.newKeys, ["d.five"], "the third counted open fades it");
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).users[ANA].omp["c.four"].seen, rules.FADE_AFTER_SEEN);

  const after = ledger.recordSeen(ANA, "omp", ["c.four"], "open-4");
  assert.deepEqual(after.newKeys, ["d.five"]);
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).users[ANA].omp["c.four"].seen, rules.FADE_AFTER_SEEN, "a faded counter stops");
});

test("the counter is per person: Ana's views and changes never fade Ben's chip, nor the open instance's", () => {
  reset();
  upgrade();
  for (const open of ["open-1", "open-2", "open-3"]) ledger.recordSeen(ANA, "omp", ["c.four"], open);
  ledger.recordChanged(ANA, "omp", ["d.five"]);
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp").newKeys, []);

  assert.deepEqual(ledger.readUserNewKeys(BEN, "omp").newKeys, ["c.four", "d.five"]);
  assert.deepEqual(ledger.readUserNewKeys(ledger.INSTANCE_SETTINGS_KEY, "omp").newKeys, ["c.four", "d.five"]);

  ledger.recordSeen(BEN, "omp", ["c.four"], "open-1");
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).users[BEN].omp["c.four"].seen, 1, "Ben counts from his own zero; the same openId string means nothing across people");

  assert.equal(ledger.settingsOwnerKeyFor({ id: ANA }), ANA);
  assert.equal(ledger.settingsOwnerKeyFor(null), ledger.INSTANCE_SETTINGS_KEY);
  assert.equal(ledger.settingsOwnerKeyFor(undefined), "__instance");
});

test("changing a key fades its badge at once and for good", () => {
  reset();
  upgrade();
  const changed = ledger.recordChanged(ANA, "omp", ["c.four"]);
  assert.deepEqual(changed.newKeys, ["d.five"]);
  assert.deepEqual(changed.since, { "d.five": "18.19.0" });
  assert.deepEqual(ledger.recordChanged(ANA, "omp", ["c.four"]).newKeys, ["d.five"], "idempotent");
  assert.deepEqual(ledger.recordSeen(ANA, "omp", ["c.four"], "open-7").newKeys, ["d.five"], "seeing a changed key does not bring it back");
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).users[ANA].omp["c.four"].seen, 0, "a changed key does not start counting");
});

test("only keys that are new count: anything else is ignored and cannot grow the ledger", () => {
  reset();
  upgrade();
  const before = readFileSync(ledgerPath, "utf8");
  ledger.recordSeen(ANA, "omp", ["a.one", "not.a.setting", "", 7], "open-1");
  ledger.recordChanged(ANA, "omp", ["b.three", "not.a.setting"]);
  assert.equal(readFileSync(ledgerPath, "utf8"), before, "nothing was written");
  assert.deepEqual(ledger.recordSeen(ANA, "omp", ["a.one"], "open-1").newKeys, ["c.four", "d.five"]);

  // An engine that was never looked at has no new keys to count.
  assert.deepEqual(ledger.recordSeen(ANA, "codex", ["c.four"], "open-1"), { newKeys: [], since: {} });
  assert.equal(readFileSync(ledgerPath, "utf8"), before, "still nothing written");
});

test("keys a browser has no use for (terminal-only) never badge and are never counted, but stay recorded", () => {
  reset();
  upgrade();
  const eligible = new Set(["c.four"]); // d.five is terminal-only
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp", eligible), { newKeys: ["c.four"], since: { "c.four": "18.19.0" } });
  assert.deepEqual(ledger.recordSeen(ANA, "omp", ["c.four", "d.five"], "open-1", eligible).newKeys, ["c.four"]);
  const file = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(Object.keys(file.users[ANA].omp), ["c.four"], "no counter for the terminal-only key");
  assert.deepEqual(file.engines.omp.keys, ["a.one", "a.two", "b.three", "c.four", "d.five"], "still recorded in the key set");
  assert.deepEqual(ledger.recordChanged(ANA, "omp", ["d.five"], eligible).newKeys, ["c.four"]);
});

test("engines keep separate snapshots, and a look at one leaves the other intact", () => {
  reset();
  upgrade("omp");
  ledger.syncEngineKeys("pi", "0.9.0", ["pi.alpha"]);
  assert.deepEqual(ledger.readUserNewKeys(ANA, "pi").newKeys, [], "pi's first look badges nothing");
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp").newKeys, ["c.four", "d.five"]);

  ledger.recordSeen(ANA, "omp", ["c.four"], "open-1");
  ledger.syncEngineKeys("pi", "0.10.0", ["pi.alpha", "pi.beta"]);
  assert.deepEqual(ledger.readUserNewKeys(ANA, "pi").newKeys, ["pi.beta"]);
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp").newKeys, ["c.four", "d.five"], "omp's counters are untouched");
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).users[ANA].omp["c.four"].seen, 1);
});

test("an engine whose version cannot be read still records and diffs by key set", () => {
  reset();
  ledger.syncEngineKeys("omp", null, BASE);
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).engines.omp.engineVersion, "unknown");
  const sync = ledger.syncEngineKeys("omp", undefined, UPGRADED);
  assert.deepEqual(sync.introduced, { "c.four": "unknown", "d.five": "unknown" });
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp").newKeys, ["c.four", "d.five"]);
});

test("a schema that reads as empty never wipes the snapshot, and an engine with no snapshot has nothing to report", () => {
  reset();
  assert.deepEqual(ledger.syncEngineKeys("omp", "18.8.3", []), { engineVersion: "18.8.3", previousVersion: null, firstRun: false, introduced: {} });
  assert.equal(existsSync(ledgerPath), false, "an empty first look writes nothing");

  upgrade();
  const before = readFileSync(ledgerPath, "utf8");
  const empty = ledger.syncEngineKeys("omp", "18.19.0", []);
  assert.deepEqual(empty, {
    engineVersion: "18.19.0",
    previousVersion: "18.8.3",
    firstRun: false,
    introduced: { "c.four": "18.19.0", "d.five": "18.19.0" },
  });
  assert.equal(readFileSync(ledgerPath, "utf8"), before, "the snapshot and counters are untouched");
});

test("a corrupt or missing ledger reads as never looked: nothing is badged, and the next look repairs it", () => {
  reset();
  upgrade();
  writeFileSync(ledgerPath, "{ not json", "utf8");
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp"), { newKeys: [], since: {} });
  const repaired = ledger.syncEngineKeys("omp", "18.19.0", UPGRADED);
  assert.equal(repaired.firstRun, true, "a lost ledger is a first run: it never badges every setting");
  assert.deepEqual(repaired.introduced, {});
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).engines.omp.keys.length, UPGRADED.length);

  for (const shape of ["[]", "null", "\"text\"", "{\"engines\":7,\"users\":8}"]) {
    writeFileSync(ledgerPath, shape, "utf8");
    assert.deepEqual(ledger.readUserNewKeys(ANA, "omp"), { newKeys: [], since: {} }, `shape ${shape} reads as empty`);
  }
});

test("a malformed entry is dropped and its well-formed neighbours survive", () => {
  reset();
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      version: 1,
      engines: {
        omp: { engineVersion: "18.19.0", previousVersion: "18.8.3", keys: BASE.concat(["c.four"]), introduced: { "c.four": "18.19.0", stray: "18.19.0" } },
        pi: { keys: "nope" },
      },
      users: {
        [ANA]: { omp: { "c.four": { seen: 2, openId: "open-2", changed: false }, "a.one": "junk" }, pi: 5 },
        [BEN]: "junk",
      },
    }),
    "utf8",
  );
  assert.deepEqual(ledger.readUserNewKeys(ANA, "omp"), { newKeys: ["c.four"], since: { "c.four": "18.19.0" } }, "the stray introduced entry is dropped");
  assert.deepEqual(ledger.readUserNewKeys(ANA, "pi").newKeys, []);
  assert.deepEqual(ledger.readUserNewKeys(BEN, "omp").newKeys, ["c.four"]);

  // Ana's stored count of 2 carries on: one more open fades the key.
  assert.deepEqual(ledger.recordSeen(ANA, "omp", ["c.four"], "open-3").newKeys, []);
});
