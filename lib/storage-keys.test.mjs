import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ENGINE_SCOPED_KEYS, LEGACY_STORAGE_KEYS, SESSION_STORAGE_PREFIXES, STORAGE_EVENTS, STORAGE_KEYS, engineScopedKey, migrateLegacyStorage } =
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

test("legacy map targets are unique, current keys", () => {
  // Keys born after the fork have no legacy ancestor, so this is a subset
  // check, not a bijection: every migration target must be a current key and
  // no two legacy keys may collide onto one target.
  const migrated = LEGACY_STORAGE_KEYS.map(([, current]) => current);
  assert.deepEqual([...migrated].sort(), [...new Set(migrated)].sort(), "no duplicate targets");
  const current = new Set(Object.values(STORAGE_KEYS));
  for (const target of migrated) assert.ok(current.has(target), `unknown target ${target}`);
});

test("migration copies a pre-fork value onto the new key and drops the old one", () => {
  const storage = createStorage({ "omp-web:sidebar-width": "420", "cody-theme": "gruvbox-dark" });
  migrateLegacyStorage(storage);

  assert.equal(storage.getItem(STORAGE_KEYS.sidebarWidth), "420");
  assert.equal(storage.getItem(STORAGE_KEYS.theme), "gruvbox-dark");
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

test("engine-scoped keys address one engine's world and nothing when it is unknown", () => {
  // A pinned model list written against omp's catalog left pi's composer
  // saying "No models"; omp's session ids left pi's unread badges pointing at
  // sessions that do not exist. Both are addressed per engine now.
  assert.equal(engineScopedKey(STORAGE_KEYS.composerModels, "omp"), "cody:composer-models:omp");
  assert.notEqual(
    engineScopedKey(STORAGE_KEYS.unreadSessions, "omp"),
    engineScopedKey(STORAGE_KEYS.unreadSessions, "pi"),
  );
  // Unknown engine (/api/info still in flight) has no honest address: callers
  // must read "nothing stored", never fall back to the unscoped key, which is
  // another engine's data by definition.
  assert.equal(engineScopedKey(STORAGE_KEYS.composerModels, null), null);
  assert.equal(engineScopedKey(STORAGE_KEYS.composerModels, undefined), null);
  assert.equal(engineScopedKey(STORAGE_KEYS.composerModels, ""), null);
});

test("every engine-scoped key is a real key, and none of them is a shared preference", () => {
  const current = new Set(Object.values(STORAGE_KEYS));
  for (const key of ENGINE_SCOPED_KEYS) assert.ok(current.has(key), `unknown key ${key}`);
  // Theme, language and layout belong to the human, not the engine — scoping
  // them would silently reset the UI on every switch.
  for (const key of [STORAGE_KEYS.theme, STORAGE_KEYS.lang, STORAGE_KEYS.sidebarWidth]) {
    assert.ok(!ENGINE_SCOPED_KEYS.includes(key), `${key} must stay global`);
  }
});
