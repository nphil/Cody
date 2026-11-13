import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  EMPTY_ID_SET,
  MAX_STORED_IDS,
  createPrefStore,
  parseStoredFlag,
  parseStoredIdSet,
  serializeFlag,
  serializeIdSet,
  withIdMembership,
} = await jiti.import("./sidebar-prefs.ts");
const { ENGINE_SCOPED_KEYS, STORAGE_KEYS, engineScopedKey } = await jiti.import("./storage-keys.ts");

function fakeStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: (key) => { entries.delete(key); },
  };
}

test("a flag reads true or false as written and falls back to its default for anything else", () => {
  assert.equal(parseStoredFlag("true", false), true);
  assert.equal(parseStoredFlag("false", true), false);
  for (const junk of [null, undefined, "", "1", "yes", "TRUE", "{}", "null"]) {
    assert.equal(parseStoredFlag(junk, true), true, `${String(junk)} keeps a default of true`);
    assert.equal(parseStoredFlag(junk, false), false, `${String(junk)} keeps a default of false`);
  }
  assert.equal(serializeFlag(true), "true");
  assert.equal(serializeFlag(false), "false");
  assert.equal(parseStoredFlag(serializeFlag(false), true), false, "an explicit false is not mistaken for unset");
});

test("an id set reads a JSON array of strings and nothing else", () => {
  assert.deepEqual([...parseStoredIdSet('["a","b"]')], ["a", "b"]);
  assert.equal(parseStoredIdSet(null), EMPTY_ID_SET);
  assert.equal(parseStoredIdSet(""), EMPTY_ID_SET);
  assert.equal(parseStoredIdSet("not json"), EMPTY_ID_SET);
  assert.equal(parseStoredIdSet('{"a":true}'), EMPTY_ID_SET);
  assert.equal(parseStoredIdSet('"a"'), EMPTY_ID_SET);
  assert.equal(parseStoredIdSet("[]"), EMPTY_ID_SET);
});

test("bad entries are skipped without losing the good ones, and duplicates collapse", () => {
  assert.deepEqual([...parseStoredIdSet('["a",1,null,"",{"x":1},["b"],"c","a"]')], ["c", "a"]);
  assert.deepEqual([...parseStoredIdSet(JSON.stringify(["ok", "x".repeat(5000)]))], ["ok"], "an absurdly long id is not ours");
});

test("an oversized stored set keeps the newest entries", () => {
  const stored = JSON.stringify(Array.from({ length: MAX_STORED_IDS + 25 }, (_, index) => `id-${index}`));
  const ids = [...parseStoredIdSet(stored)];
  assert.equal(ids.length, MAX_STORED_IDS);
  assert.equal(ids[0], "id-25");
  assert.equal(ids.at(-1), `id-${MAX_STORED_IDS + 24}`);
  assert.deepEqual([...parseStoredIdSet('["a","b","c"]', 2)], ["b", "c"]);
});

test("an id set round-trips, and an empty one serializes to nothing so the key goes away", () => {
  const ids = new Set(["/work/one", "/work/two"]);
  assert.deepEqual([...parseStoredIdSet(serializeIdSet(ids))], ["/work/one", "/work/two"]);
  assert.equal(serializeIdSet(new Set()), null);
  assert.equal(serializeIdSet(EMPTY_ID_SET), null);
});

test("membership changes return the same set when nothing changes, so callers can skip the write", () => {
  const base = new Set(["a", "b"]);
  assert.equal(withIdMembership(base, "a", true), base);
  assert.equal(withIdMembership(base, "z", false), base);
  assert.equal(withIdMembership(base, "", true), base);
  assert.equal(withIdMembership(EMPTY_ID_SET, "z", false), EMPTY_ID_SET);

  const added = withIdMembership(base, "c", true);
  assert.notEqual(added, base);
  assert.deepEqual([...added], ["a", "b", "c"]);
  assert.deepEqual([...base], ["a", "b"], "the input is never mutated");

  const removed = withIdMembership(added, "a", false);
  assert.deepEqual([...removed], ["b", "c"]);
  assert.equal(withIdMembership(new Set(["only"]), "only", false), EMPTY_ID_SET);
});

test("adding past the cap drops the oldest entry", () => {
  let ids = EMPTY_ID_SET;
  for (let index = 0; index < MAX_STORED_IDS + 3; index++) ids = withIdMembership(ids, `id-${index}`, true);
  assert.equal(ids.size, MAX_STORED_IDS);
  assert.equal(ids.has("id-0"), false);
  assert.equal(ids.has("id-2"), false);
  assert.equal(ids.has("id-3"), true);
  assert.equal(ids.has(`id-${MAX_STORED_IDS + 2}`), true);
});

test("a flag is read from storage once and written through when set", () => {
  const storage = fakeStorage({ [STORAGE_KEYS.sidebarRunningOnly]: "true" });
  let reads = 0;
  const counting = { ...storage, getItem: (key) => { reads += 1; return storage.getItem(key); } };
  const store = createPrefStore(() => counting);

  assert.equal(store.getFlag(STORAGE_KEYS.sidebarRunningOnly, false), true, "the stored choice beats the default");
  assert.equal(store.getFlag(STORAGE_KEYS.sidebarRunningOnly, false), true);
  assert.equal(reads, 1, "later reads come from the held value");

  store.setFlag(STORAGE_KEYS.sidebarRunningOnly, false);
  assert.equal(storage.getItem(STORAGE_KEYS.sidebarRunningOnly), "false", "an explicit false is stored, not removed");
  assert.equal(store.getFlag(STORAGE_KEYS.sidebarRunningOnly, true), false);

  const fresh = createPrefStore(() => storage);
  assert.equal(fresh.getFlag(STORAGE_KEYS.sidebarRunningOnly, true), false, "a new page load sees it");
});

test("nothing stored means the default, and a garbled value does too", () => {
  const store = createPrefStore(() => fakeStorage({ [STORAGE_KEYS.sidebarExplorerOpen]: "banana" }));
  assert.equal(store.getFlag(STORAGE_KEYS.sidebarExplorerOpen, true), true);
  assert.equal(store.getFlag(STORAGE_KEYS.sidebarShowAllRecent, false), false);
});

test("subscribers hear about a changed flag, only on their own key, and not about a repeat", () => {
  const store = createPrefStore(() => fakeStorage());
  const heard = [];
  const offRunning = store.subscribe(STORAGE_KEYS.sidebarRunningOnly, () => heard.push("running"));
  store.subscribe(STORAGE_KEYS.sidebarExplorerOpen, () => heard.push("explorer"));

  store.setFlag(STORAGE_KEYS.sidebarRunningOnly, true);
  store.setFlag(STORAGE_KEYS.sidebarRunningOnly, true);
  assert.deepEqual(heard, ["running"]);

  store.setFlag(STORAGE_KEYS.sidebarExplorerOpen, false);
  assert.deepEqual(heard, ["running", "explorer"]);

  offRunning();
  store.setFlag(STORAGE_KEYS.sidebarRunningOnly, false);
  assert.deepEqual(heard, ["running", "explorer"]);
});

test("an id set keeps one identity between reads until it changes", () => {
  const storage = fakeStorage({ [STORAGE_KEYS.sidebarFullProjectLists]: '["/a"]' });
  const store = createPrefStore(() => storage);
  const first = store.getIdSet(STORAGE_KEYS.sidebarFullProjectLists);
  assert.deepEqual([...first], ["/a"]);
  assert.equal(store.getIdSet(STORAGE_KEYS.sidebarFullProjectLists), first, "useSyncExternalStore needs a stable snapshot");

  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", true);
  assert.equal(store.getIdSet(STORAGE_KEYS.sidebarFullProjectLists), first, "re-adding a member is not a change");

  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/b", true);
  const second = store.getIdSet(STORAGE_KEYS.sidebarFullProjectLists);
  assert.notEqual(second, first);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sidebarFullProjectLists)), ["/a", "/b"]);

  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", false);
  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/b", false);
  assert.equal(store.getIdSet(STORAGE_KEYS.sidebarFullProjectLists), EMPTY_ID_SET);
  assert.equal(storage.getItem(STORAGE_KEYS.sidebarFullProjectLists), null, "an emptied set removes its key");
});

test("id set subscribers hear real changes only", () => {
  const store = createPrefStore(() => fakeStorage());
  let heard = 0;
  store.subscribe(STORAGE_KEYS.sidebarFullProjectLists, () => { heard += 1; });
  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", false);
  assert.equal(heard, 0, "removing what was never there changes nothing");
  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", true);
  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", true);
  assert.equal(heard, 1);
  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", false);
  assert.equal(heard, 2);
});

test("a set with no key yet (engine unknown) works for the page and writes nothing", () => {
  const storage = fakeStorage();
  const store = createPrefStore(() => storage);
  const heard = [];
  store.subscribe(null, () => heard.push("memory"));
  store.setIdMember(null, "session-1", true);
  assert.deepEqual([...store.getIdSet(null)], ["session-1"]);
  assert.deepEqual(heard, ["memory"]);
  assert.equal(storage.entries.size, 0, "no key, no stored value");
});

test("the collapsed-fork set is addressed per engine", () => {
  assert.ok(ENGINE_SCOPED_KEYS.includes(STORAGE_KEYS.sidebarCollapsedForks), "session ids are the engine's own");
  const storage = fakeStorage();
  const store = createPrefStore(() => storage);
  const omp = engineScopedKey(STORAGE_KEYS.sidebarCollapsedForks, "omp");
  const pi = engineScopedKey(STORAGE_KEYS.sidebarCollapsedForks, "pi");
  store.setIdMember(omp, "s-1", true);
  assert.deepEqual([...store.getIdSet(omp)], ["s-1"]);
  assert.equal(store.getIdSet(pi), EMPTY_ID_SET, "another engine's world starts clear");
  assert.deepEqual(JSON.parse(storage.getItem("cody:sidebar-collapsed-forks:omp")), ["s-1"]);
  assert.equal(storage.getItem(STORAGE_KEYS.sidebarCollapsedForks), null, "the unscoped key is never written");
});

test("browser storage that throws keeps the preference for the page", () => {
  const blocked = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  const store = createPrefStore(() => blocked);
  assert.equal(store.getFlag(STORAGE_KEYS.sidebarRunningOnly, false), false);
  store.setFlag(STORAGE_KEYS.sidebarRunningOnly, true);
  assert.equal(store.getFlag(STORAGE_KEYS.sidebarRunningOnly, false), true);
  store.setIdMember(STORAGE_KEYS.sidebarFullProjectLists, "/a", true);
  assert.deepEqual([...store.getIdSet(STORAGE_KEYS.sidebarFullProjectLists)], ["/a"]);

  const unavailable = createPrefStore(() => null);
  unavailable.setFlag(STORAGE_KEYS.sidebarExplorerOpen, false);
  assert.equal(unavailable.getFlag(STORAGE_KEYS.sidebarExplorerOpen, true), false);
});

test("every new preference key is a distinct cody: key, and the shared ones are not engine-scoped", () => {
  const keys = [
    STORAGE_KEYS.sidebarOpen,
    STORAGE_KEYS.sidebarRunningOnly,
    STORAGE_KEYS.sidebarShowAllRecent,
    STORAGE_KEYS.sidebarExplorerOpen,
    STORAGE_KEYS.sidebarFullProjectLists,
    STORAGE_KEYS.sidebarCollapsedForks,
    STORAGE_KEYS.sidebarView,
  ];
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^cody:sidebar-/);
  // Project paths and the person's layout choices mean the same on every engine.
  for (const key of keys.filter((candidate) => candidate !== STORAGE_KEYS.sidebarCollapsedForks)) {
    assert.ok(!ENGINE_SCOPED_KEYS.includes(key), `${key} stays global`);
  }
});
