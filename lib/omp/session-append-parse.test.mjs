import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "cody-append-parse-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { extendLoadedSession, loadSessionFile, loadSessionFileWithCursor, serializeTitleSlot } = await jiti.import("./session-files.ts");
const { getSessionEntries, loadSessionFileCached } = await jiti.import("../session-reader.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

const header = (version = 3) => JSON.stringify({ type: "session", version, id: "s1", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/w" });
const entry = (id, text) => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: text } });
const ids = (loaded) => loaded.entries.map((e) => e.id);
let count = 0;
function sessionFile(lines, end = "\n") {
  const path = join(root, `s${count++}.jsonl`);
  writeFileSync(path, lines.join("\n") + end);
  return path;
}
function replaceByRename(path, lines) {
  writeFileSync(`${path}.tmp`, lines.join("\n") + "\n");
  renameSync(`${path}.tmp`, path);
}
function writeAt(path, text, position) {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, text, position);
  } finally {
    closeSync(fd);
  }
}

test("an append is parsed on its own and matches a full parse", () => {
  const path = sessionFile([header(), entry("a", "one")]);
  const first = loadSessionFileWithCursor(path);
  appendFileSync(path, `${entry("b", "two")}\n${entry("c", "three")}\n`);
  const next = extendLoadedSession(path, first);
  assert.ok(next);
  assert.deepEqual(ids(next.loaded), ["a", "b", "c"]);
  assert.deepEqual(next.loaded, loadSessionFile(path));
  // The earlier result may still be in use: it is left as it was.
  assert.deepEqual(ids(first.loaded), ["a"]);
});

test("a last line without its newline is read again once it is finished", () => {
  const path = sessionFile([header(), entry("a", "one"), entry("b", "two")], "");
  const first = loadSessionFileWithCursor(path);
  assert.deepEqual(ids(first.loaded), ["a", "b"]);
  assert.equal(first.cursor.tailEntries, 1);
  appendFileSync(path, `\n${entry("c", "three")}\n`);
  assert.deepEqual(ids(extendLoadedSession(path, first).loaded), ["a", "b", "c"]);
});

test("a torn last line is skipped, then read once the write completes", () => {
  const torn = entry("b", "two");
  const path = sessionFile([header(), entry("a", "one"), torn.slice(0, 20)], "");
  const first = loadSessionFileWithCursor(path);
  assert.deepEqual(ids(first.loaded), ["a"]);
  appendFileSync(path, `${torn.slice(20)}\n`);
  assert.deepEqual(ids(extendLoadedSession(path, first).loaded), ["a", "b"]);
});

test("a file changed before the cursor, shrunk or replaced needs a full parse", () => {
  const path = sessionFile([header(), entry("a", "one"), entry("b", "two")]);
  const first = loadSessionFileWithCursor(path);
  writeAt(path, readFileSync(path, "utf8").replace('"one"', '"ONE"'), 0);
  assert.equal(extendLoadedSession(path, first), null);

  writeFileSync(path, `${header()}\n${entry("a", "one")}\n`);
  assert.equal(extendLoadedSession(path, first), null);

  const again = loadSessionFileWithCursor(path);
  replaceByRename(path, [header(), entry("x", "other"), entry("y", "more")]);
  assert.equal(extendLoadedSession(path, again), null);
});

test("a title renamed in place is picked up without a full parse", () => {
  const slot = (title) => serializeTitleSlot({ title, updatedAt: "2026-11-01T00:00:00.000Z" });
  const path = join(root, `slot${count++}.jsonl`);
  writeFileSync(path, `${slot("Old")}${header()}\n${entry("a", "one")}\n`);
  const first = loadSessionFileWithCursor(path);
  assert.equal(first.loaded.header.title, "Old");
  writeAt(path, slot("New"), 0);
  appendFileSync(path, `${entry("b", "two")}\n`);
  const next = extendLoadedSession(path, first);
  assert.equal(next.loaded.header.title, "New");
  assert.deepEqual(ids(next.loaded), ["a", "b"]);
  assert.equal(first.loaded.header.title, "Old");
});

test("a legacy file is migrated as a whole, never extended", () => {
  const path = sessionFile([header(2), entry("a", "one")]);
  assert.equal(loadSessionFileWithCursor(path).cursor, null);
});

test("both parse caches follow appends and replacements", () => {
  const path = sessionFile([header(), entry("a", "one")]);
  const options = { resolveBlobs: true, skipToolResultImages: true };
  const first = loadSessionFileCached(path, options);
  assert.equal(loadSessionFileCached(path, options), first);

  appendFileSync(path, `${entry("b", "two")}\n`);
  const second = loadSessionFileCached(path, options);
  assert.deepEqual(ids(second), ["a", "b"]);
  // Extended, not parsed again: the earlier entry objects carry over.
  assert.equal(second.entries[0], first.entries[0]);
  assert.deepEqual(getSessionEntries(path).map((e) => e.id), ["a", "b"]);

  appendFileSync(path, `${entry("c", "three")}\n`);
  assert.deepEqual(getSessionEntries(path).map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(ids(loadSessionFileCached(path, options)), ["a", "b", "c"]);

  replaceByRename(path, [header(), entry("z", "new")]);
  assert.deepEqual(ids(loadSessionFileCached(path, options)), ["z"]);
  assert.deepEqual(getSessionEntries(path).map((e) => e.id), ["z"]);
});
