import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
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

const { __resetSessionParseCacheForTests, __sessionParseCacheStatsForTests, hasPersistedMessage, readPersistedMessage } = await jiti.import("../session-reader.ts");
const { getBlobsDir } = await jiti.import("./paths.ts");

const bigEntry = (id, chars) => entry(id, "x".repeat(chars));

test("parse caches share one byte budget across chats and caches, oldest use first", () => {
  __resetSessionParseCacheForTests(3_000);
  const paths = ["a", "b", "c"].map((name) => sessionFile([header(), bigEntry(name, 1_000)]));
  for (const path of paths) getSessionEntries(path);
  const { weight, size } = __sessionParseCacheStatsForTests();
  assert.ok(weight <= 3_000, `weight ${weight}`);
  assert.equal(size, 2, "the oldest parse made room");
  // The other cache draws on the same budget.
  loadSessionFileCached(paths[2], { resolveBlobs: true });
  assert.ok(__sessionParseCacheStatsForTests().weight <= 3_000);
  // Evicted parses are simply parsed again.
  assert.deepEqual(getSessionEntries(paths[0]).map((e) => e.id), ["a"]);
});

test("a session bigger than the budget is never kept, and does not evict the others", () => {
  __resetSessionParseCacheForTests(3_000);
  const small = sessionFile([header(), bigEntry("s", 100)]);
  const huge = sessionFile([header(), bigEntry("h", 5_000)]);
  getSessionEntries(small);
  assert.deepEqual(getSessionEntries(huge).map((e) => e.id), ["h"]);
  assert.equal(__sessionParseCacheStatsForTests().size, 1);
  assert.deepEqual(getSessionEntries(huge).map((e) => e.id), ["h"]);
  assert.equal(__sessionParseCacheStatsForTests().size, 1);
});

test("a growing session that outgrows the budget drops its stale parse instead of holding both", () => {
  __resetSessionParseCacheForTests(2_000);
  const path = sessionFile([header(), bigEntry("a", 500)]);
  getSessionEntries(path);
  assert.equal(__sessionParseCacheStatsForTests().size, 1);
  appendFileSync(path, `${bigEntry("b", 3_000)}\n`);
  assert.deepEqual(getSessionEntries(path).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(__sessionParseCacheStatsForTests(), { weight: 0, size: 0 });
});

test("media that blob resolution inlines is charged to the budget", () => {
  const blob = Buffer.alloc(9_000, 7);
  const hash = "ab".repeat(32);
  mkdirSync(getBlobsDir(), { recursive: true });
  writeFileSync(join(getBlobsDir(), hash), blob);
  const imageEntry = JSON.stringify({
    type: "message", id: "img", parentId: null, timestamp: "2026-11-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] },
  });
  const path = sessionFile([header(), imageEntry]);
  __resetSessionParseCacheForTests(100_000);
  loadSessionFileCached(path, { resolveBlobs: true });
  const inflated = __sessionParseCacheStatsForTests().weight;
  assert.ok(inflated >= Buffer.from(blob).toString("base64").length, `weight ${inflated}`);
  __resetSessionParseCacheForTests(100_000);
  loadSessionFileCached(path, {});
  assert.ok(__sessionParseCacheStatsForTests().weight < 1_000, "an unresolved parse costs about its file");
  // A budget below the inflated size keeps the inline parse out of memory.
  __resetSessionParseCacheForTests(5_000);
  loadSessionFileCached(path, { resolveBlobs: true });
  assert.equal(__sessionParseCacheStatsForTests().size, 0);
});

test("short rows are charged per entry, so many tiny entries cannot slip under the budget", () => {
  const rows = Array.from({ length: 2_000 }, (_, i) => entry(`e${i}`, "x"));
  const path = sessionFile([header(), ...rows]);
  const fileBytes = readFileSync(path).length;
  __resetSessionParseCacheForTests(100_000_000);
  getSessionEntries(path);
  assert.ok(__sessionParseCacheStatsForTests().weight >= fileBytes - 2_100 + 2_000 * 256);
  // The same file against a budget that its bytes alone would fit.
  __resetSessionParseCacheForTests(fileBytes + 1_000);
  getSessionEntries(path);
  assert.equal(__sessionParseCacheStatsForTests().size, 0);
});

const message = (id, body) => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-11-01T00:00:01.000Z", message: body });

test("persisted messages are found by role, timestamp and tool call, and read back with media resolved", () => {
  const blob = Buffer.from("png-bytes");
  const hash = "cd".repeat(32);
  mkdirSync(getBlobsDir(), { recursive: true });
  writeFileSync(join(getBlobsDir(), hash), blob);
  const path = sessionFile([
    header(),
    message("u", { role: "user", timestamp: 100, content: "hi" }),
    message("r1", { role: "toolResult", timestamp: 200, toolCallId: "call-1", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] }),
    message("r2", { role: "toolResult", timestamp: 200, toolCallId: "call-2", content: [{ type: "text", text: "two" }] }),
  ]);
  __resetSessionParseCacheForTests();
  assert.equal(hasPersistedMessage(path, { role: "user", timestamp: 100 }, 0), true);
  assert.equal(hasPersistedMessage(path, { role: "assistant", timestamp: 100 }, 0), false);
  assert.equal(hasPersistedMessage(path, { role: "toolResult", timestamp: 200, toolCallId: "call-2" }, 0), true);
  assert.equal(hasPersistedMessage(path, { role: "toolResult", timestamp: 200, toolCallId: "call-3" }, 0), false);
  assert.equal(hasPersistedMessage("", { role: "user", timestamp: 100 }, 0), false);
  assert.equal(hasPersistedMessage(join(root, "missing.jsonl"), { role: "user", timestamp: 100 }, 0), false);

  const read = readPersistedMessage(path, { role: "toolResult", timestamp: 200, toolCallId: "call-1" }, 0);
  assert.equal(read.content[0].data, blob.toString("base64"));
  assert.equal(read.toolCallId, "call-1");
  // Nothing was parsed into the cache, and the cache's own entries still hold the reference.
  assert.equal(__sessionParseCacheStatsForTests().size, 0);
  assert.equal(getSessionEntries(path)[1].message.content[0].data, `blob:sha256:${hash}`);

  // A message written after the first look is found at once: the search starts at the end.
  assert.equal(hasPersistedMessage(path, { role: "assistant", timestamp: 300 }, 0), false);
  appendFileSync(path, `${message("a", { role: "assistant", timestamp: 300, content: [] })}\n`);
  assert.equal(hasPersistedMessage(path, { role: "assistant", timestamp: 300 }, 0), true);
  assert.equal(readPersistedMessage(path, { role: "assistant", timestamp: 999 }, 0), null);
});

test("the tail search crosses chunk boundaries, skips a torn last line, and stops at its reach", () => {
  const big = "y".repeat(3 * 1024 * 1024);
  const lines = [
    header(),
    message("old", { role: "assistant", timestamp: 111, content: "old" }),
    message("big", { role: "toolResult", timestamp: 222, toolCallId: "c-big", content: [{ type: "text", text: big }] }),
    ...Array.from({ length: 50 }, (_, i) => message(`t${i}`, { role: "user", timestamp: 1_000 + i, content: "x" })),
  ];
  const path = sessionFile(lines, `\n{"type":"message","id":"torn","message":{"role":"user","timest`);
  const ref = { role: "toolResult", timestamp: 222, toolCallId: "c-big" };
  __resetSessionParseCacheForTests();
  // Reach scales with the frame: a 3 MiB frame finds its 3 MiB line, a tiny one does not look that far.
  assert.equal(hasPersistedMessage(path, ref, 3 * 1024 * 1024), true);
  assert.equal(readPersistedMessage(path, ref, 3 * 1024 * 1024).content[0].text.length, big.length);
  assert.equal(hasPersistedMessage(path, ref, 0), false, "beyond its reach it reads as absent");
  // A short message near the start is within reach only when the file is small enough.
  assert.equal(hasPersistedMessage(path, { role: "assistant", timestamp: 111 }, 0), false);
  assert.equal(hasPersistedMessage(path, { role: "user", timestamp: 1_049 }, 0), true);
  assert.equal(__sessionParseCacheStatsForTests().size, 0, "no parse of the file was made");
});

const { loadSessionForHistoryPage, buildSessionContext, entryToUiMessage } = await jiti.import("../session-reader.ts");
const { lazyDetailText } = await jiti.import("../lazy-blocks.ts");

const HIDDEN = "h".repeat(20_000);
const ENGINE_ONLY = ["providerPayload", "inputTransformations", "requestControls"];
const at = "2026-11-01T00:00:01.000Z";
const row = (id, parentId, fields) => JSON.stringify({ id, parentId, timestamp: at, ...fields });
const assistantRow = (i, parentId) => row(`a${i}`, parentId, {
  type: "message",
  message: {
    role: "assistant", timestamp: 1_000 + i, content: [{ type: "text", text: `reply ${i}` }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    contextSnapshot: { promptTokens: 42 },
    providerPayload: { replay: HIDDEN }, inputTransformations: [HIDDEN], requestControls: { raw: HIDDEN },
  },
});
const resultRow = (i, parentId, toolName, details, text = "ok") => row(`r${i}`, parentId, {
  type: "message",
  message: { role: "toolResult", timestamp: 2_000 + i, toolCallId: `call-${i}`, toolName, isError: false, content: [{ type: "text", text }], details },
});

// A transcript that is mostly engine-only data, like a real long chat.
function heavyTranscript(turns) {
  const lines = [header()];
  let parent = null;
  const add = (line, id) => { lines.push(line); parent = id; };
  for (let i = 0; i < turns; i += 1) {
    add(assistantRow(i, parent), `a${i}`);
    const kind = i === 1 ? "todo" : i === 2 ? "task" : i === 3 ? "ask" : "edit";
    const details = {
      todo: { phases: [{ name: "Work", tasks: [{ content: "step", status: "in_progress" }] }], raw: HIDDEN },
      task: { results: [{ index: 0, id: "sub", agent: "explore", status: "completed", task: "look", usage: { cost: { total: 0.25 } }, output: HIDDEN }], progress: [], raw: HIDDEN },
      ask: { question: "Which?", selectedOptions: ["A"], id: "q", raw: HIDDEN },
      edit: { patch: "@@ -1 +1 @@", diff: "+x", fullOutput: HIDDEN },
    }[kind];
    add(resultRow(i, parent, kind, details, i === 0 ? "y".repeat(20_000) : "ok"), `r${i}`);
  }
  add(row("c", parent, { type: "compaction", summary: "s", firstKeptEntryId: "a0", tokensBefore: 1, preserveData: { archive: HIDDEN } }), "c");
  return lines;
}

test("a transcript of hidden engine data stays cached and append-aware inside a small budget", () => {
  const path = sessionFile(heavyTranscript(30));
  const fileBytes = readFileSync(path).length;
  const budget = 200_000;
  assert.ok(fileBytes > 5 * budget, `fixture is ${fileBytes} bytes`);
  __resetSessionParseCacheForTests(budget);

  // Raw consumers still get every field, and a session this size is too big for the budget.
  const raw = getSessionEntries(path);
  assert.ok(raw.some((e) => e.type === "message" && e.message.providerPayload));
  assert.equal(__sessionParseCacheStatsForTests().size, 0);

  const first = loadSessionForHistoryPage(path);
  const held = __sessionParseCacheStatsForTests();
  assert.equal(held.size, 1, "the pruned parse fits and is kept");
  assert.ok(held.weight <= budget && held.weight < fileBytes / 5, `weight ${held.weight} of ${fileBytes}`);
  assert.equal(loadSessionForHistoryPage(path).entries, first.entries, "an unchanged file is a cache hit");

  // An append parses its own lines: every earlier entry is the very object from before.
  appendFileSync(path, `${assistantRow(99, "c")}\n`);
  const next = loadSessionForHistoryPage(path);
  assert.equal(next.entries.length, first.entries.length + 1);
  assert.equal(next.entries[5], first.entries[5]);
  assert.equal(next.entries.at(-1).message.providerPayload, undefined);
  assert.equal(__sessionParseCacheStatsForTests().size, 1);
  assert.ok(__sessionParseCacheStatsForTests().weight <= budget);
});

test("the pruned parse carries no engine-only field, and a page built from it matches the raw one", () => {
  const path = sessionFile(heavyTranscript(30));
  __resetSessionParseCacheForTests(200_000);
  const pruned = loadSessionForHistoryPage(path).entries;
  const json = JSON.stringify(pruned);
  for (const field of [...ENGINE_ONLY, "preserveData", "fullOutput", HIDDEN]) assert.ok(!json.includes(field), `${field} leaked`);
  assert.ok(json.includes('"contextSnapshot":{"promptTokens":42}'), "what the context meter reads stays");

  const options = { deferOversizedBlocks: true, deferToolResultImages: true };
  const fromRaw = buildSessionContext(getSessionEntries(path), undefined, options);
  const fromPruned = buildSessionContext(pruned, undefined, options);
  // The raw response would still carry an assistant message's engine-only fields; the pruned one does not.
  fromRaw.messages = fromRaw.messages.map((m) => {
    if (m.role !== "assistant") return m;
    const copy = { ...m };
    for (const key of ENGINE_ONLY) delete copy[key];
    return copy;
  });
  assert.deepEqual(fromPruned, fromRaw);
  assert.deepEqual(fromPruned.todoPhases.map((p) => p.name), ["Work"], "the branch's todo state is read from the pruned entries");
  assert.ok(fromPruned.messages.some((m) => m.role === "toolResult" && m.details?.patch === "@@ -1 +1 @@"));
  const task = fromPruned.messages.find((m) => m.role === "toolResult" && m.toolName === "task");
  assert.deepEqual(task, fromRaw.messages.find((m) => m.role === "toolResult" && m.toolName === "task"), "a task result is projected once, not twice");
  assert.equal(task.details.raw, undefined);
});

test("an oversized block is read in full from the pruned parse when its detail is requested", () => {
  const path = sessionFile(heavyTranscript(5));
  __resetSessionParseCacheForTests(200_000);
  const entry = loadSessionForHistoryPage(path).entries.find((e) => e.id === "r0");
  const text = lazyDetailText(entryToUiMessage(entry, {}), "result", 0);
  assert.equal(text, "y".repeat(20_000));
  assert.equal(text, lazyDetailText(entryToUiMessage(getSessionEntries(path).find((e) => e.id === "r0"), {}), "result", 0));
});
