import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DERIVED_TABLES, KEEP_BACKUPS, checkDb, classifyIntegrity, repairDb } from "./cody-engine-db.mjs";

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-engine-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A small store shaped like omp's: one protected table, one derived table with an index, enough rows for multi-page trees. */
function makeStore(dir) {
  const file = path.join(dir, "agent.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE INDEX idx_auth_provider ON auth_credentials(provider)");
  db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  db.exec("CREATE INDEX idx_cache_expires ON cache(expires_at)");
  db.exec("CREATE INDEX idx_cache_value ON cache(value)");
  db.exec("CREATE INDEX idx_auth_data ON auth_credentials(data)");
  db.exec("BEGIN");
  const login = db.prepare("INSERT INTO auth_credentials (provider, data) VALUES (?, ?)");
  for (let i = 0; i < 400; i += 1) login.run(`provider-${i % 7}`, `secret-${i}-${"x".repeat(200)}`);
  const cache = db.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)");
  for (let i = 0; i < 3000; i += 1) cache.run(`key-${i}`, `value-${i}-${"y".repeat(120)}`, 1_000_000 + i);
  db.exec("COMMIT");
  db.close();
  return { file };
}

/**
 * Make two indexes of one table point at each other's pages. Every page stays
 * well formed, so the check reports "row missing from index" for that table,
 * the same kind of line the real incident produced.
 */
function crossIndexes(file, first, second) {
  const db = new DatabaseSync(file);
  const root = (name) => Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name = ?").get(name).rootpage);
  const a = root(first);
  const b = root(second);
  db.exec("PRAGMA writable_schema = ON");
  db.prepare("UPDATE sqlite_master SET rootpage = ? WHERE name = ?").run(b, first);
  db.prepare("UPDATE sqlite_master SET rootpage = ? WHERE name = ?").run(a, second);
  db.close();
}

function logins(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT id, provider, data FROM auth_credentials ORDER BY id").all();
  } finally {
    db.close();
  }
}

const OWNERS = {
  byRoot: new Map([[5, "cache"], [6, "cache"], [7, "cache"], [10, "usage_history"], [17, "auth_credentials"]]),
  byIndex: new Map([["idx_usage_history_recorded", "usage_history"], ["sqlite_autoindex_cache_1", "cache"], ["idx_auth_provider", "auth_credentials"]]),
};

test("the report from the 2026-11 incident reads as damage to refillable tables only", () => {
  const result = classifyIntegrity([
    "Tree 10 page 10 cell 1: Child page depth differs",
    "Tree 7 page 4682 cell 6: 2nd reference to page 312",
    "Tree 6 page 7107 cell 26: 2nd reference to page 313",
    "Page 165: never used",
    "wrong # of entries in index idx_usage_history_recorded",
    "row 18 missing from index sqlite_autoindex_cache_1",
  ], OWNERS);
  assert.equal(result.verdict, "derived");
  assert.deepEqual(result.tables, ["cache", "usage_history"]);
  assert.equal(result.problems, 6);
  assert.equal(result.loose, 1);
});

test("a problem in a login table, an unknown tree or an unrecognised line is never called harmless", () => {
  assert.equal(classifyIntegrity(["ok"], OWNERS).verdict, "ok");
  assert.equal(classifyIntegrity(["Tree 17 page 40 cell 2: invalid page number 9"], OWNERS).verdict, "critical");
  assert.equal(classifyIntegrity(["row 3 missing from index idx_auth_provider"], OWNERS).verdict, "critical");
  assert.equal(classifyIntegrity(["Tree 999 page 12 cell 0: Rowid out of order"], OWNERS).verdict, "critical");
  assert.equal(classifyIntegrity(["On tree page 198 cell 11: 2nd reference to page 312"], OWNERS).verdict, "critical");
  assert.equal(classifyIntegrity(["Tree 7 page 9 cell 1: bad", "Tree 17 page 40 cell 2: bad"], OWNERS).verdict, "critical");
  assert.equal(classifyIntegrity(["row 18 missing from index sqlite_autoindex_cache_1", "check stopped early: database disk image is malformed"], OWNERS).verdict, "critical");
  assert.ok(DERIVED_TABLES.includes("cache") && !DERIVED_TABLES.includes("auth_credentials"));
});

test("a healthy store checks ok, a missing one is absent, and neither is repaired", async (t) => {
  const dir = tempDir(t);
  const { file } = makeStore(dir);
  assert.equal((await checkDb(file)).verdict, "ok");
  assert.equal((await checkDb(path.join(dir, "nope.db"))).verdict, "absent");
  const result = await repairDb(file, path.join(dir, "backups"));
  assert.equal(result.outcome, "not_needed");
});

test("damage in a cache index is repaired in place: file whole again, cache rows kept, logins byte-identical, a backup left", async (t) => {
  const dir = tempDir(t);
  const { file } = makeStore(dir);
  const before = logins(file);
  crossIndexes(file, "idx_cache_expires", "idx_cache_value");

  const check = await checkDb(file);
  assert.equal(check.verdict, "derived");
  assert.deepEqual(check.tables, ["cache"]);

  const result = await repairDb(file, path.join(dir, "backups"));
  assert.equal(result.outcome, "repaired", result.reason);
  assert.equal(result.after.verdict, "ok");
  assert.deepEqual(result.rebuilt.map((row) => [row.table, row.kept]), [["cache", 3000]]);
  assert.deepEqual(logins(file), before);
  assert.equal(readdirSync(path.join(dir, "backups")).length, 1);

  // The rebuilt table still has its indexes and takes new rows.
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO cache (key, value, expires_at) VALUES ('new', 'v', 5)").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM cache WHERE expires_at = 5").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE tbl_name = 'cache' AND type = 'index'").get().n, 3);
  db.close();
});

test("damage that reaches the login table is refused and the file is left exactly as it was", async (t) => {
  const dir = tempDir(t);
  const { file } = makeStore(dir);
  crossIndexes(file, "idx_auth_provider", "idx_auth_data");
  const check = await checkDb(file);
  assert.equal(check.verdict, "critical");
  assert.ok(check.tables.includes("auth_credentials"));

  const result = await repairDb(file, path.join(dir, "backups"));
  assert.equal(result.outcome, "refused");
  assert.equal((await checkDb(file)).verdict, "critical");
  assert.throws(() => readdirSync(path.join(dir, "backups")), /ENOENT/);
});

test("only the newest backups are kept", async (t) => {
  const dir = tempDir(t);
  const backups = path.join(dir, "backups");
  for (let round = 0; round < KEEP_BACKUPS + 2; round += 1) {
    const store = makeStore(mkdtempSync(path.join(dir, "s-")));
    crossIndexes(store.file, "idx_cache_expires", "idx_cache_value");
    assert.equal((await repairDb(store.file, backups)).outcome, "repaired");
  }
  assert.equal(readdirSync(backups).length, KEEP_BACKUPS);
});
