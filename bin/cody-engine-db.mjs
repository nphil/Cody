#!/usr/bin/env node
/**
 * Health check and guarded repair for the engine's SQLite store (omp's
 * `agent.db`: logins, credential blocks, settings, caches, usage history).
 *
 * Run as its own process, never inside the Cody server (a 30 MB integrity
 * check would stall every request) and never inside the engine (before omp
 * 18.16.0 a second open of this file in the engine's own process dropped its
 * locks, which is how the file got damaged: omp issue #15586).
 *
 *   node bin/cody-engine-db.mjs check  <agent.db>
 *   node bin/cody-engine-db.mjs repair <agent.db> <backup dir>
 *
 * Prints one JSON object. Exit code 0 whenever a verdict was reached.
 *
 * Repair is in place and all-or-nothing. In ONE write transaction it empties
 * and rebuilds only the tables the engine can refill (`DERIVED_TABLES`), keeps
 * every row of them it can still read, and commits only when the file then
 * passes its integrity check AND every other table reads byte-for-byte as it
 * did before. Anything else rolls back and leaves the file untouched. No file
 * is renamed, so engines that have the store open keep working; SQLite's own
 * locking orders them behind the transaction.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Tables the engine refills by itself; losing rows here loses nothing a person entered. */
export const DERIVED_TABLES = ["cache", "usage_history", "client_usage", "notice_claims"];

export const KEEP_BACKUPS = 3;
const SAMPLE_LINES = 12;
const BUSY_TIMEOUT_MS = 15_000;

async function openDatabase(file, readOnly) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * One problem per entry: SQLite packs several into its first row and heads
 * them with a banner. A check that SQLite itself gives up on part-way keeps
 * what it found and adds a line saying so, which no verdict treats as harmless.
 */
function integrityLines(db, pragma) {
  const raw = [];
  try {
    for (const row of db.prepare(`PRAGMA ${pragma}`).iterate()) raw.push(String(Object.values(row)[0]));
  } catch (error) {
    raw.push(`check stopped early: ${String(error?.message ?? error)}`);
  }
  return raw
    .flatMap((entry) => entry.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("***"));
}

/** rootpage -> owning table, and index name -> owning table, from the schema. */
function schemaOwners(db) {
  const byRoot = new Map();
  const byIndex = new Map();
  for (const row of db.prepare("SELECT type, name, tbl_name, rootpage FROM sqlite_master").all()) {
    if (row.type !== "table" && row.type !== "index") continue;
    if (Number(row.rootpage) > 0) byRoot.set(Number(row.rootpage), String(row.tbl_name));
    if (row.type === "index") byIndex.set(String(row.name), String(row.tbl_name));
  }
  return { byRoot, byIndex };
}

/**
 * Which tables an integrity report blames.
 *
 * `tables` are the ones named through a tree's root page or an index; `loose`
 * counts lines tied to no table (unused pages, freelist). A line that names a
 * tree or index the schema does not know is `unknown`: never assumed harmless.
 */
export function classifyIntegrity(lines, owners) {
  const tables = new Set();
  let loose = 0;
  let unknown = 0;
  for (const line of lines) {
    if (line === "ok") continue;
    const tree = /\bTree (\d+) page\b/.exec(line);
    const index = /\bindex ([A-Za-z0-9_]+)/.exec(line);
    if (tree) {
      const owner = owners.byRoot.get(Number(tree[1]));
      if (owner) tables.add(owner);
      else unknown += 1;
    } else if (index) {
      const owner = owners.byIndex.get(index[1]);
      if (owner) tables.add(owner);
      else unknown += 1;
    } else if (/never used|Freelist|free-list|freelist/i.test(line)) {
      loose += 1;
    } else {
      unknown += 1;
    }
  }
  const damaged = [...tables].sort();
  const outside = damaged.filter((table) => !DERIVED_TABLES.includes(table));
  const problems = lines.filter((line) => line !== "ok").length;
  const verdict = problems === 0 ? "ok" : outside.length > 0 || unknown > 0 ? "critical" : "derived";
  return { verdict, problems, tables: damaged, loose, unknown };
}

/** Read-only verdict on one store. Never throws. */
export async function checkDb(file) {
  const at = Date.now();
  if (!existsSync(file)) return { at, verdict: "absent", problems: 0, tables: [], sample: [] };
  let db;
  try {
    db = await openDatabase(file, true);
    // The full check, not quick_check: the quick one skips index contents,
    // which is exactly where this file was first damaged.
    const lines = integrityLines(db, "integrity_check");
    const result = classifyIntegrity(lines, schemaOwners(db));
    return { at, ...result, sample: lines.filter((line) => line !== "ok").slice(0, SAMPLE_LINES) };
  } catch (error) {
    return { at, verdict: "unreadable", problems: 1, tables: [], sample: [String(error?.message ?? error).slice(0, 300)] };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function quoteName(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function userTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
}

/** One hash over every row of every table that must not change. Rows are sorted, so storage order never matters. */
function protectedFingerprint(db) {
  const hash = createHash("sha256");
  for (const table of userTables(db)) {
    if (DERIVED_TABLES.includes(table)) continue;
    hash.update(`\0table:${table}\0`);
    const rows = db.prepare(`SELECT * FROM ${quoteName(table)}`).all().map((row) => JSON.stringify(
      Object.entries(row).map(([key, value]) => [key, typeof value, value instanceof Uint8Array ? Buffer.from(value).toString("base64") : String(value)]),
    ));
    rows.sort();
    for (const row of rows) hash.update(row);
  }
  return hash.digest("hex");
}

/** Every row of a damaged table that still reads; a scan that breaks keeps what it had. */
function salvageRows(db, table) {
  const rows = [];
  let complete = true;
  try {
    for (const row of db.prepare(`SELECT * FROM ${quoteName(table)} NOT INDEXED`).iterate()) rows.push(row);
  } catch {
    complete = false;
  }
  return { rows, complete };
}

/**
 * Replace one damaged table with a fresh copy of itself.
 *
 * The old table and its indexes are NOT dropped: DROP walks the damaged trees
 * to free their pages and fails on the very damage being repaired (a page two
 * indexes both claim). Their schema rows are removed instead, which abandons
 * the old pages untouched; the VACUUM after the commit reclaims them.
 */
function rebuildTable(db, table) {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type = 'table' DESC").all(table);
  const create = objects.find((object) => object.type === "table");
  if (!create) return { table, kept: 0, complete: true, skipped: true };
  const { rows, complete } = salvageRows(db, table);
  db.exec("PRAGMA writable_schema = ON");
  db.prepare("DELETE FROM sqlite_master WHERE tbl_name = ? AND type IN ('table', 'index')").run(table);
  db.exec("PRAGMA writable_schema = RESET");
  db.exec(String(create.sql));
  let kept = 0;
  if (rows.length > 0) {
    const columns = Object.keys(rows[0]);
    const insert = db.prepare(`INSERT OR IGNORE INTO ${quoteName(table)} (${columns.map(quoteName).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of rows) {
      try {
        kept += Number(insert.run(...columns.map((column) => row[column])).changes);
      } catch { /* one unreadable row is not worth the repair */ }
    }
  }
  for (const object of objects) if (object.type !== "table") db.exec(String(object.sql));
  return { table, kept, complete };
}

function pruneBackups(dir) {
  const files = readdirSync(dir).filter((name) => /^agent-\d+\.db$/.test(name)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) rmSync(path.join(dir, name), { force: true });
}

async function backupFile(file, backupDir) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(backupDir, `agent-${Date.now()}.db`);
  const sqlite = await import("node:sqlite");
  const source = await openDatabase(file, true);
  try {
    // SQLite's own page copy: consistent with writers and unaffected by damage.
    await sqlite.backup(source, target);
  } finally {
    source.close();
  }
  chmodSync(target, 0o600);
  pruneBackups(backupDir);
  return target;
}

/**
 * Repair a store whose damage is confined to derived tables. Never throws.
 * `outcome`: "repaired", "not_needed", "refused" (damage outside the derived
 * tables), or "failed" (rolled back; the file is as it was).
 */
export async function repairDb(file, backupDir) {
  const before = await checkDb(file);
  if (before.verdict === "ok" || before.verdict === "absent") return { outcome: "not_needed", before, after: before };
  if (before.verdict !== "derived") return { outcome: "refused", before, after: before, reason: "Damage reaches tables that hold logins or settings." };

  let backup = null;
  let db;
  let open = false;
  try {
    backup = await backupFile(file, backupDir);
    db = await openDatabase(file, false);
    db.exec("BEGIN IMMEDIATE");
    open = true;
    const fingerprint = protectedFingerprint(db);
    const targets = before.tables.length > 0 ? before.tables : [];
    const rebuilt = targets.map((table) => rebuildTable(db, table));
    const lines = integrityLines(db, "integrity_check");
    const inside = classifyIntegrity(lines, schemaOwners(db));
    // Pages no table uses are harmless and are reclaimed by the VACUUM below;
    // anything else means the rebuild did not cure the file.
    if (inside.tables.length > 0 || inside.unknown > 0 || /Freelist|free-list/i.test(lines.join("\n"))) {
      throw new Error(`still damaged after the rebuild: ${lines.slice(0, 3).join("; ")}`);
    }
    if (protectedFingerprint(db) !== fingerprint) throw new Error("a protected table changed during the rebuild");
    db.exec("COMMIT");
    open = false;
    if (inside.problems > 0) {
      try { db.exec("VACUUM"); } catch { /* busy readers: the next pass retries */ }
    }
    db.close();
    db = undefined;
    const after = await checkDb(file);
    return { outcome: after.verdict === "ok" ? "repaired" : "failed", before, after, backup, rebuilt, reason: after.verdict === "ok" ? undefined : "The file still fails its check after the repair." };
  } catch (error) {
    if (open) {
      try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    }
    return { outcome: "failed", before, after: await checkDb(file), backup, reason: String(error?.message ?? error).slice(0, 300) };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

async function main(argv) {
  const [command, file, backupDir] = argv;
  if (command === "check" && file) return checkDb(file);
  if (command === "repair" && file && backupDir) return repairDb(file, backupDir);
  return { error: "usage: cody-engine-db.mjs check <db> | repair <db> <backup dir>" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.removeAllListeners("warning");
  process.on("warning", () => {});
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = "error" in result ? 2 : 0;
  });
}
