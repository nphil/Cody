import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { hermesMemoryDir, readHermesMemory } = await jiti.import("./hermes-memory.ts");

function home(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cody-hermes-memory-"));
  const memories = join(dir, "memories");
  mkdirSync(memories, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(memories, name), body);
  return dir;
}

test("memory lives beside the rest of the engine's home", () => {
  assert.equal(hermesMemoryDir("/data/hermes"), join("/data/hermes", "memories"));
});

test("both files Hermes maintains are read, in reading order", (t) => {
  const dir = home({
    "MEMORY.md": "# Notes\nThe repo builds with npm.\n",
    "USER.md": "# User\nPrefers short answers.\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const docs = readHermesMemory(dir);
  assert.deepEqual(docs.map((d) => d.id), ["memory", "user"]);
  assert.match(docs[0].content, /builds with npm/);
  assert.match(docs[1].content, /short answers/);
  // The path is shown so the user can open the file themselves — Cody only
  // reads it.
  assert.equal(docs[0].path, join(dir, "memories", "MEMORY.md"));
  assert.ok(docs.every((d) => d.exists));
  assert.ok(docs.every((d) => d.description.length > 0));
});

test("a fresh install has no memory yet, which is not an error", (t) => {
  const dir = home();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const docs = readHermesMemory(dir);
  assert.equal(docs.length, 2);
  // Empty-but-present, so the panel can say "nothing written yet" instead of
  // reporting a broken engine.
  assert.ok(docs.every((d) => d.exists === false && d.content === ""));
  assert.ok(docs.every((d) => d.path.endsWith(".md")));
});

test("a memory that outgrew the panel keeps its NEWEST entries", (t) => {
  // Memory accretes across sessions, so the entries a user came looking for
  // are the ones at the end.
  const oldest = "OLDEST-ENTRY\n";
  const newest = "NEWEST-ENTRY\n";
  const dir = home({ "MEMORY.md": oldest + "x".repeat(400 * 1024) + newest });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const [memory] = readHermesMemory(dir);
  assert.ok(memory.exists);
  assert.match(memory.content, /NEWEST-ENTRY/);
  assert.ok(!memory.content.includes("OLDEST-ENTRY"), "the head is what gets dropped");
  // ...and it says so, with the path, rather than silently showing a fragment.
  assert.match(memory.content, /truncated/i);
  assert.ok(memory.content.includes(memory.path));
});

test("a missing memories directory reads as empty, never throws", () => {
  const docs = readHermesMemory(join(tmpdir(), "cody-hermes-does-not-exist"));
  assert.deepEqual(docs.map((d) => d.exists), [false, false]);
});
