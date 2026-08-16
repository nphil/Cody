import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getPreferredToolPreset, setPreferredToolPreset } = await jiti.import("./tool-preset-preference.ts");
const { STORAGE_KEYS } = await jiti.import("./storage-keys.ts");

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

test("persists only known tool preset values", () => {
  const storage = createStorage({ [STORAGE_KEYS.toolPreset]: "unknown" });
  assert.equal(getPreferredToolPreset(storage), "default");

  setPreferredToolPreset("full", storage);
  assert.equal(getPreferredToolPreset(storage), "full");
});
