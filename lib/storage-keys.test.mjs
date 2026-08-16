import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LEGACY_STORAGE_KEYS, SESSION_STORAGE_PREFIXES, STORAGE_EVENTS, STORAGE_KEYS, migrateLegacyStorage } =
  await jiti.import("./storage-keys.ts");

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    entries,
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
  };
}

test("every key, prefix and event lives under the cody namespace", () => {
  for (const value of Object.values(STORAGE_KEYS)) assert.match(value, /^cody:/);
  for (const value of Object.values(SESSION_STORAGE_PREFIXES)) assert.match(value, /^cody:/);
  for (const value of Object.values(STORAGE_EVENTS)) assert.match(value, /^cody:/);
});

test("legacy map covers every persistent key exactly once", () => {
  const migrated = LEGACY_STORAGE_KEYS.map(([, current]) => current);
  assert.deepEqual([...migrated].sort(), [...new Set(migrated)].sort(), "no duplicate targets");
  assert.deepEqual([...migrated].sort(), [...Object.values(STORAGE_KEYS)].sort());
});

test("migration copies a pre-fork value onto the new key and drops the old one", () => {
  const storage = createStorage({ "omp-web:sidebar-width": "420", "cody-theme": "sage-dark" });
  migrateLegacyStorage(storage);

  assert.equal(storage.getItem(STORAGE_KEYS.sidebarWidth), "420");
  assert.equal(storage.getItem(STORAGE_KEYS.theme), "sage-dark");
  assert.equal(storage.getItem("omp-web:sidebar-width"), null);
  assert.equal(storage.getItem("cody-theme"), null);
});

test("an existing new-key value wins and the stale legacy key is discarded", () => {
  const storage = createStorage({ "omp-lang": "ja", [STORAGE_KEYS.lang]: "en" });
  migrateLegacyStorage(storage);

  assert.equal(storage.getItem(STORAGE_KEYS.lang), "en");
  assert.equal(storage.getItem("omp-lang"), null);
});

test("migration is idempotent and leaves unrelated keys alone", () => {
  const storage = createStorage({ "omp-sound-enabled": "true", "unrelated": "keep" });
  migrateLegacyStorage(storage);
  migrateLegacyStorage(storage);

  assert.equal(storage.getItem(STORAGE_KEYS.soundEnabled), "true");
  assert.equal(storage.getItem("unrelated"), "keep");
  assert.equal(storage.entries.size, 2);
});

test("a throwing storage never breaks startup", () => {
  const storage = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.doesNotThrow(() => migrateLegacyStorage(storage));
});
