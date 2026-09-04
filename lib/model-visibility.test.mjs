import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The visibility store behind Settings › Models and the composer picker:
 * an administrator's instance-wide hide (non-omp engines), and every user's
 * own hidden and pinned lists, per engine, in one file in the instance data
 * dir.
 */
const agentDir = mkdtempSync(join(tmpdir(), "cody-model-visibility-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./model-visibility.ts");

const filePath = join(agentDir, "cody-model-visibility.json");

test("an empty store reads as nothing hidden or pinned, from the instance data dir", () => {
  assert.equal(existsSync(filePath), false);
  assert.deepEqual(store.readInstanceHidden("pi"), []);
  assert.deepEqual(store.readUserVisibility("u1", "pi"), { hidden: [], pinned: [] });
  assert.equal(store.getVisibilityPath(), filePath, "instance data dir via getAgentDir(), never an engine's own dir");
});

test("the on-disk shape is {version, engines, users} and writes are atomic", () => {
  store.writeInstanceHidden("pi", ["acme/beta", "acme/alpha", "acme/beta"]);
  store.writeUserVisibility("u1", "pi", { hidden: ["zeta/gamma"], pinned: ["acme/alpha"] });
  const file = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(file.engines, { pi: { hidden: ["acme/alpha", "acme/beta"] } }, "deduplicated and sorted");
  assert.deepEqual(file.users, { u1: { pi: { hidden: ["zeta/gamma"], pinned: ["acme/alpha"] } } });
  assert.ok(readdirSync(agentDir).every((name) => !name.endsWith(".tmp")), "the temp file of the atomic write is renamed away");
});

test("a user patch replaces only the list it names and keeps the other", () => {
  store.writeUserVisibility("u1", "pi", { hidden: ["zeta/gamma"], pinned: ["acme/alpha"] });
  assert.deepEqual(store.writeUserVisibility("u1", "pi", { pinned: ["acme/beta", "acme/alpha"] }), { hidden: ["zeta/gamma"], pinned: ["acme/alpha", "acme/beta"] });
  assert.deepEqual(store.writeUserVisibility("u1", "pi", { hidden: [] }), { hidden: [], pinned: ["acme/alpha", "acme/beta"] });
});

test("users and engines are independent, and emptied entries leave the file", () => {
  store.writeUserVisibility("u1", "pi", { hidden: ["a/1"], pinned: [] });
  store.writeUserVisibility("u2", "pi", { hidden: [], pinned: ["a/1"] });
  store.writeUserVisibility("u1", "hermes", { hidden: ["h/1"] });
  assert.deepEqual(store.readUserVisibility("u1", "pi"), { hidden: ["a/1"], pinned: [] });
  assert.deepEqual(store.readUserVisibility("u2", "pi"), { hidden: [], pinned: ["a/1"] });
  assert.deepEqual(store.readUserVisibility("u1", "hermes"), { hidden: ["h/1"], pinned: [] });
  assert.deepEqual(store.readUserVisibility("u2", "hermes"), { hidden: [], pinned: [] });

  store.writeUserVisibility("u1", "pi", { hidden: [], pinned: [] });
  store.writeUserVisibility("u1", "hermes", { hidden: [] });
  store.writeInstanceHidden("pi", []);
  const file = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(file.engines, {});
  assert.deepEqual(file.users, { u2: { pi: { hidden: [], pinned: ["a/1"] } } }, "u1 is gone entirely, u2 stays");

  store.deleteUserVisibility("u2");
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).users, {});
});

test("a corrupt or foreign-shaped file reads as empty rather than throwing", () => {
  writeFileSync(filePath, "{ not json");
  assert.deepEqual(store.readInstanceHidden("pi"), []);
  writeFileSync(filePath, JSON.stringify({ version: 1, engines: { pi: { hidden: "x" } }, users: { u1: { pi: { hidden: [1, "ok/1", ""], pinned: null } } } }));
  assert.deepEqual(store.readInstanceHidden("pi"), [], "a malformed engine entry is dropped");
  assert.deepEqual(store.readUserVisibility("u1", "pi"), { hidden: ["ok/1"], pinned: [] }, "only non-empty strings survive");
});

test("an instance hide beats a personal hide, and either beats a pin", () => {
  const lists = { instanceHidden: new Set(["a/1"]), hidden: new Set(["a/2", "a/1"]), pinned: new Set(["a/1", "a/2", "a/3"]) };
  assert.deepEqual(store.resolveModelVisibility("a/1", lists), { state: "instanceHidden", pinned: false });
  assert.deepEqual(store.resolveModelVisibility("a/2", lists), { state: "myHidden", pinned: false });
  assert.deepEqual(store.resolveModelVisibility("a/3", lists), { state: "visible", pinned: true });
  assert.deepEqual(store.resolveModelVisibility("a/4", lists), { state: "visible", pinned: false });
});

test("normalizeModelKeys is the one canonical form", () => {
  assert.deepEqual(store.normalizeModelKeys(["b/2", " a/1 ", "b/2", "", 3, null]), ["a/1", "b/2"]);
});
