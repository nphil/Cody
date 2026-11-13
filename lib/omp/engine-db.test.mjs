import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Before the import: the module resolves the instance data dir when called,
// and a test must never write the operator's live appdata.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-engine-db-svc-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const engineDb = await jiti.import("./engine-db.ts");

const check = (verdict, tables = [], at = 1_000) => ({ at, verdict, problems: verdict === "ok" ? 0 : 3, tables, sample: [] });

function resetState() {
  fs.rmSync(path.join(agentDir, engineDb.ENGINE_DB_STATE_FILE), { force: true });
}

test("damage to refillable tables is repaired automatically and the healthy result is what gets recorded", async () => {
  resetState();
  const calls = [];
  const status = await engineDb.runEngineDbCheck("auto", {
    now: () => 5_000,
    helper: async (args) => {
      calls.push(args[0]);
      if (args[0] === "check") return check("derived", ["cache"]);
      return { outcome: "repaired", rebuilt: [{ table: "cache", kept: 10, complete: true }], after: check("ok", [], 2_000) };
    },
  });
  assert.deepEqual(calls, ["check", "repair"]);
  assert.equal(status.lastCheck.verdict, "ok");
  assert.equal(status.lastRepair.outcome, "repaired");
  assert.deepEqual(status.lastRepair.rebuilt, [{ table: "cache", kept: 10, complete: true }]);
});

test("damage that reaches logins is never repaired, and 'check only' never repairs anything", async () => {
  resetState();
  const calls = [];
  const helper = (answer) => async (args) => {
    calls.push(args[0]);
    return answer;
  };
  const critical = await engineDb.runEngineDbCheck("auto", { helper: helper(check("critical", ["auth_credentials"])) });
  assert.equal(critical.lastCheck.verdict, "critical");
  const looked = await engineDb.runEngineDbCheck("never", { helper: helper(check("derived", ["cache"])) });
  assert.equal(looked.lastCheck.verdict, "derived");
  assert.deepEqual(calls, ["check", "check"]);
  assert.equal(looked.lastRepair, null);
});

test("a helper that answers nothing usable leaves the last reading alone", async () => {
  resetState();
  await engineDb.runEngineDbCheck("never", { helper: async () => check("ok", [], 7_000) });
  const after = await engineDb.runEngineDbCheck("never", { helper: async () => ({ nonsense: true }) });
  assert.equal(after.lastCheck.at, 7_000);
});

test("the owner hears about damage Cody will not fix and about a repair that failed, not about what it fixed", () => {
  assert.equal(engineDb.describeEngineDbFault(check("ok"), null), null);
  assert.equal(engineDb.describeEngineDbFault(check("derived", ["cache"]), { at: 1, outcome: "repaired" }), null);
  assert.equal(engineDb.describeEngineDbFault(check("derived", ["cache"]), null), null);
  const failed = engineDb.describeEngineDbFault(check("derived", ["cache"]), { at: 1, outcome: "failed" });
  const critical = engineDb.describeEngineDbFault(check("critical", ["auth_credentials"]), null);
  assert.ok(failed && critical && failed.key !== critical.key);
  assert.equal(engineDb.describeEngineDbFault(check("unreadable"), null)?.title, critical.title);
});

test("the engine is flagged at risk only below the release that fixed its file locks", () => {
  assert.equal(engineDb.isOlderRelease("18.8.3", engineDb.ENGINE_DB_SAFE_OMP), true);
  assert.equal(engineDb.isOlderRelease("18.15.9", engineDb.ENGINE_DB_SAFE_OMP), true);
  assert.equal(engineDb.isOlderRelease("18.16.0", engineDb.ENGINE_DB_SAFE_OMP), false);
  assert.equal(engineDb.isOlderRelease("18.19.0", engineDb.ENGINE_DB_SAFE_OMP), false);
  assert.equal(engineDb.isOlderRelease("19.0", engineDb.ENGINE_DB_SAFE_OMP), false);
  assert.equal(engineDb.isOlderRelease(null, engineDb.ENGINE_DB_SAFE_OMP), false);
  assert.equal(engineDb.isOlderRelease("dev", engineDb.ENGINE_DB_SAFE_OMP), false);
});
