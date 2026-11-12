import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin } from "../omp/omp-test-package.mjs";
import { apiKeyCredential, findBun, oauthCredential, packageRootOf, seedOmpStore } from "../omp/omp-test-store.mjs";

/**
 * omp 18.19 scopes each rate-limit block (`blockScope`); Cody's credential helper
 * used to fold every block of an account into one deadline, so a Fable-only
 * block read as the whole Claude account being refused. The helper now lists
 * every unexpired block with its scope beside the merged `blockedUntil`.
 *
 * Run against a REAL omp store (the engine's own AuthStorage creates and reads
 * it) in a throwaway agent dir, never the live agent.db. Point it at either
 * engine with CODY_OMP_BIN; omp 18.8.3 and 18.19.0 are both expected to pass.
 */

const ompBin = ompTestPackageBin();
const packageRoot = ompBin ? packageRootOf(ompBin) : null;
const bun = findBun();
const skip = (!packageRoot && "no omp package available") || (!bun && "bun is not installed");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listOmpCredentials, listOmpCredentialsKeepingLast } = await jiti.import("./omp-credentials.ts");

const HOUR = 3_600_000;
let dir;
let ids;
let deps;
let now;

test.before(async () => {
  if (skip) return;
  const seeded = await seedOmpStore({
    bun,
    packageRoot,
    steps: [
      { op: "upsert", provider: "anthropic", credential: oauthCredential("claude@example.com"), as: "claude" },
      { op: "upsert", provider: "openai-codex", credential: oauthCredential("codex@example.com"), as: "codex" },
      { op: "upsert", provider: "openrouter", credential: apiKeyCredential("sk-or-fake-0001"), as: "key" },
      { op: "upsert", provider: "anthropic", credential: oauthCredential("quiet@example.com"), as: "quiet" },
    ],
  });
  dir = seeded.dir;
  ids = seeded.ids;
  now = Date.now();
  const db = new DatabaseSync(path.join(dir, "agent.db"));
  try {
    const insert = db.prepare("INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)");
    insert.run(ids.claude, "anthropic", "tier:fable", now + 3 * HOUR, now);
    insert.run(ids.claude, "anthropic", "tier:mythos", now + HOUR, now);
    insert.run(ids.codex, "openai-codex", "spark", now + 2 * HOUR, now);
    insert.run(ids.codex, "openai-codex", "chat", now - HOUR, now - 2 * HOUR); // expired: not a block
    insert.run(ids.key, "openrouter", "", now + HOUR, now);
  } finally { db.close(); }
  deps = { helperPath: path.resolve(process.cwd(), "bin/cody-omp-credentials.mjs"), bunBin: bun, packageRoot: () => packageRoot, agentDir: () => dir };
});
test.after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const rowOf = (snapshot, id) => snapshot.credentials.find((row) => row.id === id);
const byScope = (row) => Object.fromEntries(row.blocks.map((block) => [block.scope, block.until]));

test("every unexpired block comes back with its scope, beside the merged blockedUntil", { skip }, async () => {
  const snapshot = await listOmpCredentials(deps);
  assert.equal(snapshot.available, true);

  const claude = rowOf(snapshot, ids.claude);
  assert.deepEqual(Object.keys(byScope(claude)).sort(), ["tier:fable", "tier:mythos"]);
  assert.equal(byScope(claude)["tier:fable"], now + 3 * HOUR);
  assert.equal(claude.blockedUntil, new Date(now + 3 * HOUR).toISOString(), "the merged deadline is still the latest of them");

  const codex = rowOf(snapshot, ids.codex);
  assert.deepEqual(codex.blocks.map((block) => block.scope), ["spark"], "an expired scope is dropped");
  assert.equal(codex.blockedUntil, new Date(now + 2 * HOUR).toISOString());
});

test("an unscoped block reads as scope '' and an unblocked account has none", { skip }, async () => {
  const snapshot = await listOmpCredentials(deps);
  assert.deepEqual(rowOf(snapshot, ids.key).blocks, [{ scope: "", until: now + HOUR }]);
  assert.equal(rowOf(snapshot, ids.key).blockedUntil, new Date(now + HOUR).toISOString());
  const quiet = rowOf(snapshot, ids.quiet);
  assert.deepEqual(quiet.blocks, []);
  assert.equal(quiet.blockedUntil, null);
});

test("the last good list is kept when a later read fails", { skip }, async () => {
  const first = await listOmpCredentialsKeepingLast(deps);
  assert.equal(first.available, true);
  assert.equal(first.stale, undefined);
  const broken = await listOmpCredentialsKeepingLast({ ...deps, helperPath: path.join(dir, "missing-helper.mjs") });
  assert.equal(broken.available, true);
  assert.equal(broken.stale, true);
  assert.deepEqual(byScope(rowOf(broken, ids.claude)), byScope(rowOf(first, ids.claude)), "block information survives a failed read");
});
