import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ompTestPackageBin } from "../omp/omp-test-package.mjs";
import { apiKeyCredential as apiKey, findBun, oauthCredential as oauth, packageRootOf, REFRESH_FAILED, seedOmpStore, storedRows } from "../omp/omp-test-store.mjs";

/**
 * The credential, reset and unblock helpers run against the INSTALLED omp's
 * AuthStorage, and every other test of them uses a hand-written fixture of
 * that API. omp 18.3.4 renamed the whole surface into namespaces; the
 * fixtures kept passing while every real call failed, and the failure was
 * soft by design — the composer quietly lost the account a conversation is on
 * and gauged the idle sibling at 0%. So each helper is run here against the
 * real package, on an empty store in a throwaway agent dir.
 */

const ompBin = ompTestPackageBin();
const packageRoot = ompBin ? packageRootOf(ompBin) : null;
const bun = findBun();
const skip = (!packageRoot && "no omp package available") || (!bun && "bun is not installed");

let agentDir;
test.before(async () => { if (!skip) agentDir = await mkdtemp(path.join(os.tmpdir(), "cody-omp-auth-")); });
test.after(async () => { if (agentDir) await rm(agentDir, { recursive: true, force: true }); });

function run(helper, request) {
  const result = spawnSync(bun, [path.resolve(process.cwd(), "bin", helper), JSON.stringify({ packageRoot, agentDir, ...request })], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  return JSON.parse(result.stdout);
}

test("the credential helper lists the installed omp's store", { skip }, () => {
  const frame = run("cody-omp-credentials.mjs", { operation: "list" });
  assert.equal(frame.ok, true, frame.message);
  assert.deepEqual(frame.credentials, []);
});

test("the reset-credit helper lists the installed omp's saved resets", { skip }, () => {
  const frame = run("cody-omp-reset-credits.mjs", { operation: "list" });
  assert.equal(frame.ok, true, frame.message);
  assert.deepEqual(frame.accounts, []);
});

test("the unblock helper reads the installed omp's credential blocks", { skip }, () => {
  const frame = run("cody-omp-unblock.mjs", { operation: "unblock", credentialId: 999 });
  assert.equal(frame.ok, true, frame.message);
  assert.equal(frame.outcome, "not_blocked");
});

// ── Removing credentials ────────────────────────────────────────────────────
//
// omp's own remove calls only SOFT-delete (the row stays with `disabled_cause`
// set, key or refresh token still inside) and can only act on ACTIVE rows. Cody
// listed those tombstones as removable accounts, so Remove answered "no
// account matching that id" forever — an OpenRouter key deleted weeks earlier
// could not be removed from Settings — and the old key kept being read. Every
// case below runs the helper against a REAL omp store seeded through omp's own
// API (lib/omp/omp-test-store.mjs), because a hand-written fixture cannot
// soft-delete.

const seededDirs = [];
test.after(async () => { for (const dir of seededDirs) await rm(dir, { recursive: true, force: true }); });

async function seededStore(steps) {
  const seeded = await seedOmpStore({ bun, packageRoot, steps });
  seededDirs.push(seeded.dir);
  return seeded;
}

function runIn(dir, helper, request) {
  const result = spawnSync(bun, [path.resolve(process.cwd(), "bin", helper), JSON.stringify({ packageRoot, agentDir: dir, ...request })], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
  return JSON.parse(result.stdout);
}

test("the list hides an account the user already deleted, and the deleted key is purged from disk", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "anthropic", as: "first", credential: oauth("first@example.test") },
    { op: "upsert", provider: "anthropic", as: "expired", credential: oauth("expired@example.test") },
    { op: "disable", ref: "expired", cause: REFRESH_FAILED },
    { op: "upsert", provider: "openrouter", as: "orKey", credential: apiKey("sk-or-v1-FAKEFAKEFAKE") },
    { op: "removeById", provider: "openrouter", ref: "orKey" },
  ]);
  assert.ok(storedRows(dir).some((row) => row.id === ids.orKey && row.disabled_cause === "deleted by user"), "precondition: omp kept the removed key as a tombstone");

  const frame = runIn(dir, "cody-omp-credentials.mjs", { operation: "list" });
  assert.equal(frame.ok, true, frame.message);
  // The auto-disabled account IS lost capacity worth showing; the deleted key is not.
  assert.deepEqual(frame.credentials.map((row) => [row.id, row.provider, row.disabledCause]), [
    [ids.first, "anthropic", null],
    [ids.expired, "anthropic", REFRESH_FAILED],
  ]);
  assert.equal(storedRows(dir).some((row) => row.id === ids.orKey), false, "the removed key no longer sits in agent.db");
  assert.doesNotMatch(JSON.stringify(frame), /sk-or-v1|fake-refresh|fake-access/, "no secret ever leaves the helper");
});

test("an account omp disabled can be removed — this is the 'no account matching that id' case", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "anthropic", as: "first", credential: oauth("first@example.test") },
    { op: "upsert", provider: "anthropic", as: "expired", credential: oauth("expired@example.test") },
    { op: "disable", ref: "expired", cause: REFRESH_FAILED },
  ]);
  const removed = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove", provider: "anthropic", credentialId: ids.expired });
  assert.equal(removed.ok, true, removed.message);
  assert.equal(removed.removed, true, "a tombstone used to answer removed:false, which the route turned into a 404");
  assert.equal(removed.providerRemoved, false, "the other account is still signed in");
  assert.deepEqual(storedRows(dir).map((row) => row.id), [ids.first]);

  const again = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove", provider: "anthropic", credentialId: ids.expired });
  assert.equal(again.ok, true);
  assert.equal(again.removed, false, "a second click finds nothing — an honest 'already gone'");
});

test("a store another process has locked is a plain failure, and the account is never reported removed", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "anthropic", as: "first", credential: oauth("first@example.test") },
    { op: "upsert", provider: "anthropic", as: "expired", credential: oauth("expired@example.test") },
    { op: "disable", ref: "expired", cause: REFRESH_FAILED },
  ]);
  // Another writer holds the store (a live omp mid-write): the purge waits its turn, then gives up.
  const writer = new DatabaseSync(path.join(dir, "agent.db"));
  writer.exec("BEGIN IMMEDIATE");
  let frame;
  try {
    frame = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove", provider: "anthropic", credentialId: ids.expired });
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  assert.equal(frame.ok, false, "a removal that could not happen must not read as success");
  assert.notEqual(frame.removed, true);
  assert.match(frame.message, /locked|try again/i, "in words the owner can act on");
  assert.ok(storedRows(dir).some((row) => row.id === ids.expired), "nothing was deleted behind the user's back");
});

test("removing a live account deletes its row, not just disables it, and reports the last one", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "anthropic", as: "first", credential: oauth("first@example.test") },
    { op: "upsert", provider: "anthropic", as: "second", credential: oauth("second@example.test") },
    { op: "upsert", provider: "openai-codex", as: "bystander", credential: oauth("codex@example.test") },
  ]);
  const one = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove", provider: "anthropic", credentialId: ids.first });
  assert.deepEqual([one.ok, one.removed, one.providerRemoved], [true, true, false]);
  assert.deepEqual(storedRows(dir).map((row) => row.id), [ids.second, ids.bystander], "no tombstone left behind holding the refresh token");

  const last = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove", provider: "anthropic", credentialId: ids.second });
  assert.deepEqual([last.ok, last.removed, last.providerRemoved], [true, true, true]);
  assert.deepEqual(storedRows(dir).map((row) => row.id), [ids.bystander], "another provider's account is never touched");

  const listed = runIn(dir, "cody-omp-credentials.mjs", { operation: "list" });
  assert.deepEqual(listed.credentials.map((row) => row.id), [ids.bystander], "a removed account stays gone after a refresh");
});

test("signing out of a provider removes every row for it — live, disabled and deleted — and nothing else", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "anthropic", as: "first", credential: oauth("first@example.test") },
    { op: "upsert", provider: "anthropic", as: "second", credential: oauth("second@example.test") },
    { op: "upsert", provider: "anthropic", as: "expired", credential: oauth("expired@example.test") },
    { op: "disable", ref: "expired", cause: REFRESH_FAILED },
    { op: "upsert", provider: "anthropic-api", as: "apiKey", credential: apiKey("sk-ant-api-FAKE") },
    { op: "upsert", provider: "openrouter", as: "orKey", credential: apiKey("sk-or-v1-FAKEFAKEFAKE") },
  ]);
  const out = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove_provider", provider: "anthropic" });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.removed, true);
  assert.equal(out.count, 2, "two live accounts signed out; the disabled one is not 'an account that signed out'");
  assert.deepEqual(storedRows(dir).map((row) => row.id), [ids.apiKey, ids.orKey], "other providers — even a sibling id like anthropic-api — keep their rows");

  const nothing = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove_provider", provider: "anthropic" });
  assert.equal(nothing.ok, true);
  assert.equal(nothing.removed, false, "signing out of something already signed out says so instead of pretending");
  assert.equal(nothing.count, 0);
});

test("a provider that only has leftovers is reported as nothing to remove, and the leftovers are purged", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "openrouter", as: "orKey", credential: apiKey("sk-or-v1-FAKEFAKEFAKE") },
    { op: "removeById", provider: "openrouter", ref: "orKey" },
  ]);
  const out = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove_provider", provider: "openrouter" });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.removed, false);
  assert.equal(storedRows(dir).some((row) => row.id === ids.orKey), false);
});

test("a block recorded against a removed credential goes with it", { skip }, async () => {
  const { dir, ids } = await seededStore([
    { op: "upsert", provider: "anthropic", as: "first", credential: oauth("first@example.test") },
    { op: "upsert", provider: "anthropic", as: "second", credential: oauth("second@example.test") },
  ]);
  const db = new DatabaseSync(path.join(dir, "agent.db"));
  try {
    const insert = db.prepare("INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, 'anthropic:oauth', 'account', ?, ?)");
    insert.run(ids.first, Date.now() + 3_600_000, 1);
    insert.run(ids.second, Date.now() + 3_600_000, 1);
  } finally { db.close(); }

  const removed = runIn(dir, "cody-omp-credentials.mjs", { operation: "remove", provider: "anthropic", credentialId: ids.first });
  assert.equal(removed.removed, true, removed.message);
  const check = new DatabaseSync(path.join(dir, "agent.db"), { readOnly: true });
  try {
    assert.deepEqual(check.prepare("SELECT credential_id FROM auth_credential_blocks ORDER BY credential_id").all().map((row) => row.credential_id), [ids.second]);
  } finally { check.close(); }
  // ...and the listing never reports a block for an account that is not there.
  const listed = runIn(dir, "cody-omp-credentials.mjs", { operation: "list" });
  assert.deepEqual(listed.credentials.map((row) => [row.id, row.blockedUntil === null]), [[ids.second, false]]);
});
