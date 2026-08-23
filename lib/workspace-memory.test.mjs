import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearLastOpenSession,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} = await jiti.import("./workspace-memory.ts");

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); },
    entries,
  };
}

test("remembers the last session for each project independently", () => {
  const storage = createStorage();
  setLastOpenSession("omp", "project-a", "session-a", storage);
  setLastOpenSession("omp", "project-b", "session-b", storage);

  assert.equal(getLastOpenSession("omp", "project-a", storage), "session-a");
  assert.equal(getLastOpenSession("omp", "project-b", storage), "session-b");
  clearLastOpenSession("omp", "project-a", storage);
  assert.equal(getLastOpenSession("omp", "project-a", storage), null);
  assert.equal(getLastOpenSession("omp", "project-b", storage), "session-b");
});

test("one engine's memory is invisible to another", () => {
  // Session ids belong to the engine that minted them: after a switch, the
  // stored id names a session the new engine has never heard of, and
  // restoring it silently did nothing. Each engine keeps its own map.
  const storage = createStorage();
  setLastOpenSession("omp", "project-a", "omp-session", storage);
  setLastOpenSession("pi", "project-a", "pi-session", storage);

  assert.equal(getLastOpenSession("omp", "project-a", storage), "omp-session");
  assert.equal(getLastOpenSession("pi", "project-a", storage), "pi-session");
  clearLastOpenSession("pi", "project-a", storage);
  assert.equal(getLastOpenSession("omp", "project-a", storage), "omp-session");
});

test("an unknown engine reads and writes nothing", () => {
  // Before /api/info answers there is no honest key to address, and the
  // unscoped predecessor is another engine's data by definition.
  const storage = createStorage();
  setLastOpenSession(null, "project-a", "session-a", storage);
  assert.equal(storage.entries.size, 0);
  assert.equal(getLastOpenSession(null, "project-a", storage), null);
  assert.doesNotThrow(() => clearLastOpenSession(null, "project-a", storage));
});

test("uses the shared project root so worktrees restore the same workspace", () => {
  assert.equal(workspaceKeyOf({ cwd: "D:/repo-worktrees/feature", projectRoot: "D:/repo" }), "D:/repo");
  assert.equal(workspaceKeyOf({ cwd: "D:/scratch" }), "D:/scratch");
});
