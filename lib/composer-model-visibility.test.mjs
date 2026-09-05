import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const lib = await jiti.import("./composer-model-visibility.ts");
const { STORAGE_KEYS } = await jiti.import("./storage-keys.ts");

/**
 * The composer picker's browser-side lists: the mirror of the account's
 * hidden and pinned models, the recents, and the one-time conversion of the
 * retired allowlist into a hidden list.
 */

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    entries,
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
  };
}

const HIDDEN = `${STORAGE_KEYS.composerHiddenModels}:omp`;
const PINNED = `${STORAGE_KEYS.composerPinnedModels}:omp`;
const RECENT = `${STORAGE_KEYS.recentModels}:omp`;
const LEGACY = `${STORAGE_KEYS.composerModels}:omp`;

test("an empty store reads as nothing hidden, pinned or recent, and an unknown engine reads the same", () => {
  const storage = createStorage();
  const empty = lib.readComposerVisibility("omp", storage);
  assert.deepEqual([...empty.hidden], []);
  assert.deepEqual([...empty.instanceHidden], []);
  assert.deepEqual([...empty.pinned], []);
  assert.deepEqual(empty.recent, []);
  const unknown = lib.readComposerVisibility(null, createStorage({ [HIDDEN]: JSON.stringify(["a/1"]) }));
  assert.deepEqual([...unknown.hidden], [], "no engine yet means no list, never another engine's");
});

test("lists are stored per engine and the hidden mirror keeps the instance list beside the user's", () => {
  const storage = createStorage();
  lib.writeComposerVisibility("omp", { hidden: ["b/2", "a/1", "b/2"], instanceHidden: ["z/9"], pinned: ["a/1"] }, storage);
  assert.deepEqual(JSON.parse(storage.getItem(HIDDEN)), { mine: ["a/1", "b/2"], instance: ["z/9"] });
  assert.deepEqual(JSON.parse(storage.getItem(PINNED)), ["a/1"]);
  assert.equal(storage.getItem(`${STORAGE_KEYS.composerHiddenModels}:pi`), null, "pi's mirror is untouched");
  // A patch that names only one list leaves the others alone.
  lib.writeComposerVisibility("omp", { pinned: [] }, storage);
  assert.deepEqual(JSON.parse(storage.getItem(HIDDEN)), { mine: ["a/1", "b/2"], instance: ["z/9"] });
  assert.deepEqual(JSON.parse(storage.getItem(PINNED)), []);
  // The early bare-array shape still reads as the user's own list.
  const legacyShape = createStorage({ [HIDDEN]: JSON.stringify(["c/3"]) });
  assert.deepEqual([...lib.readComposerVisibility("omp", legacyShape).hidden], ["c/3"]);
});

test("mirroring the server's answer writes only when something changed", () => {
  const storage = createStorage();
  assert.equal(lib.mirrorServerVisibility("omp", { hidden: ["a/1"], instanceHidden: [], pinned: ["b/2"] }, storage), true);
  assert.equal(lib.mirrorServerVisibility("omp", { hidden: ["a/1"], instanceHidden: [], pinned: ["b/2"] }, storage), false, "same answer, no write");
  assert.equal(lib.mirrorServerVisibility("omp", { hidden: ["a/1"], instanceHidden: ["c/3"], pinned: ["b/2"] }, storage), true);
  assert.deepEqual([...lib.readComposerVisibility("omp", storage).instanceHidden], ["c/3"]);
  assert.equal(lib.mirrorServerVisibility(null, { hidden: [] }, storage), false);
});

test("recents are newest first, deduplicated and capped at five", () => {
  const storage = createStorage();
  for (const key of ["a/1", "a/2", "a/3", "a/1", "a/4", "a/5", "a/6"]) lib.pushRecentModel("omp", key, storage);
  assert.deepEqual(JSON.parse(storage.getItem(RECENT)), ["a/6", "a/5", "a/4", "a/1", "a/3"]);
  assert.deepEqual(lib.readComposerVisibility("omp", storage).recent, ["a/6", "a/5", "a/4", "a/1", "a/3"]);
  assert.deepEqual(lib.pushRecentModel(null, "a/1", storage), [], "no engine, no list");
});

test("the retired allowlist key converts at the first colon, model ids keep theirs", () => {
  assert.equal(lib.convertLegacyAllowlistKey("anthropic:claude-x"), "anthropic/claude-x");
  assert.equal(lib.convertLegacyAllowlistKey("openrouter:vendor/model:free"), "openrouter/vendor/model:free");
  assert.equal(lib.convertLegacyAllowlistKey("nocolon"), null);
  assert.equal(lib.convertLegacyAllowlistKey(":x"), null);
  assert.equal(lib.convertLegacyAllowlistKey("x:"), null);
  assert.equal(lib.modelVisibilityKey({ provider: "p", id: "m" }), "p/m");
  assert.equal(lib.modelVisibilityKey({ provider: "p", modelId: "m" }), "p/m");
});

test("migration turns the allowlist into a hidden list on the account, deletes the old key and runs once", async () => {
  const storage = createStorage({ [LEGACY]: JSON.stringify(["acme:alpha", "zeta:one"]) });
  const puts = [];
  const fetchImpl = async (url, init) => {
    puts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const catalog = ["acme/alpha", "acme/beta", "zeta/one", "zeta/two"];
  const result = await lib.migrateComposerAllowlist("omp", catalog, { storage, fetchImpl, serverHidden: ["old/hidden"] });
  assert.deepEqual(result, { migrated: true, hidden: ["acme/beta", "old/hidden", "zeta/two"], savedTo: "account" });
  assert.deepEqual(puts, [{ url: "/api/models/visibility", body: { hidden: ["acme/beta", "old/hidden", "zeta/two"] } }], "one PUT of the union");
  assert.equal(storage.getItem(LEGACY), null, "the allowlist is gone");
  assert.deepEqual([...lib.readComposerVisibility("omp", storage).hidden], ["acme/beta", "old/hidden", "zeta/two"], "the mirror is written so the composer paints now");

  const again = await lib.migrateComposerAllowlist("omp", catalog, { storage, fetchImpl });
  assert.equal(again.migrated, false, "nothing left to migrate");
  assert.equal(puts.length, 1);
});

test("migration stays in the browser when the server refuses the write, and waits for a catalog", async () => {
  const storage = createStorage({ [LEGACY]: JSON.stringify(["acme:alpha"]) });
  const unauthenticated = async () => ({ ok: false, status: 401, json: async () => ({ code: "auth_required" }) });
  const waiting = await lib.migrateComposerAllowlist("omp", [], { storage, fetchImpl: unauthenticated });
  assert.equal(waiting.migrated, false, "no catalog yet, nothing to diff against");
  assert.notEqual(storage.getItem(LEGACY), null, "the key waits for a load that has a catalog");

  const result = await lib.migrateComposerAllowlist("omp", ["acme/alpha", "acme/beta"], { storage, fetchImpl: unauthenticated });
  assert.deepEqual(result, { migrated: true, hidden: ["acme/beta"], savedTo: "browser" });
  assert.equal(storage.getItem(LEGACY), null);
  assert.deepEqual([...lib.readComposerVisibility("omp", storage).hidden], ["acme/beta"]);

  // Offline entirely: same outcome, no throw.
  const offline = createStorage({ [LEGACY]: JSON.stringify(["acme:alpha"]) });
  const thrown = async () => { throw new Error("network down"); };
  assert.deepEqual(await lib.migrateComposerAllowlist("omp", ["acme/alpha", "acme/beta"], { storage: offline, fetchImpl: thrown }), { migrated: true, hidden: ["acme/beta"], savedTo: "browser" });
});

test("an empty or malformed allowlist migrates as nothing hidden", async () => {
  // The old rule hid everything for an empty allowlist, which no one meant.
  const storage = createStorage({ [LEGACY]: "[]" });
  const noop = async () => ({ ok: true, status: 200, json: async () => ({}) });
  assert.deepEqual(await lib.migrateComposerAllowlist("omp", ["a/1"], { storage, fetchImpl: noop }), { migrated: true, hidden: [], savedTo: "account" });
  assert.equal(storage.getItem(LEGACY), null);
  const junk = createStorage({ [LEGACY]: "{ not json" });
  assert.deepEqual(await lib.migrateComposerAllowlist("omp", ["a/1"], { storage: junk, fetchImpl: noop }), { migrated: true, hidden: [], savedTo: "account" });
  assert.equal(junk.getItem(LEGACY), null);
  assert.equal((await lib.migrateComposerAllowlist(null, ["a/1"], { storage, fetchImpl: noop })).migrated, false);
});
