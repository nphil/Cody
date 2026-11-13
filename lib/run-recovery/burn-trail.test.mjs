import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Reading requests and compactions out of omp's transcripts, on real files.
 * The lines are omp 18.20.0's own shapes (a `message` entry with the
 * assistant's `usage`, a `compaction` entry with `tokensBefore` /
 * `tokensAfter` and the `warning` omp stamps on one that freed too little).
 * What matters: megabyte tool results are never parsed, a file omp rewrote is
 * simply read again, only the end of a large file is read, and helper
 * transcripts are found where omp puts them.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-burn-trail-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseTrailLine, parseTrail, readTrail, statTrail, listHelperTrails } = await jiti.import("./burn-trail.ts");

const AT = "2026-11-12T17:05:39.000Z";
const assistant = (usage, at = AT) => JSON.stringify({
  type: "message", id: "a1", parentId: "p1", timestamp: at,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { ...usage, totalTokens: 1, cost: { total: 0.1 } }, stopReason: "toolUse" },
});
const compaction = (fields, at = AT) => JSON.stringify({ type: "compaction", id: "c1", parentId: "p1", timestamp: at, summary: "…", firstKeptEntryId: "k1", ...fields });

test("an assistant message is a request: what it paid in full, and whether the cache served any of it", () => {
  assert.deepEqual(
    parseTrailLine(assistant({ input: 152_070, output: 300, cacheRead: 43_100, cacheWrite: 14_201 })),
    { kind: "request", at: Date.parse(AT), fresh: 166_271, cached: true },
  );
  assert.deepEqual(
    parseTrailLine(assistant({ input: 2, output: 900, cacheRead: 0, cacheWrite: 3_500 })),
    { kind: "request", at: Date.parse(AT), fresh: 3_502, cached: false },
  );
});

test("a request that was aborted before the provider answered cost nothing and is not one", () => {
  assert.equal(parseTrailLine(assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })), null);
});

test("a compaction carries what omp recorded, whichever method ran", () => {
  assert.deepEqual(
    parseTrailLine(compaction({ tokensBefore: 208_780, tokensAfter: 189_735, details: { kind: "experimental-context-rollover" }, warning: "Compaction freed too little context" })),
    { kind: "compaction", at: Date.parse(AT), before: 208_780, after: 189_735, warned: true },
  );
  assert.deepEqual(
    parseTrailLine(compaction({ tokensBefore: 81_812, tokensAfter: 29_904, method: "handoff" })),
    { kind: "compaction", at: Date.parse(AT), before: 81_812, after: 29_904, warned: false },
  );
  // Written before omp knows what is left: stamped later, by rewriting the file.
  assert.deepEqual(
    parseTrailLine(compaction({ tokensBefore: 81_812 })),
    { kind: "compaction", at: Date.parse(AT), before: 81_812, after: null, warned: false },
  );
});

test("everything else is skipped, and a megabyte tool result is never parsed", () => {
  const huge = `{"type":"message","id":"t1","timestamp":"${AT}","message":{"role":"toolResult","content":[{"type":"text","text":"${"x".repeat(2_000_000)}"}],"usage":{"input":999999}}`;
  // Deliberately not valid JSON at its far end: it must be turned away on its first characters.
  assert.equal(parseTrailLine(huge), null);
  for (const line of [
    JSON.stringify({ type: "message", id: "u1", timestamp: AT, message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "session_init", id: "s1", timestamp: AT, compactionThreshold: { thresholdPercent: 20 } }),
    JSON.stringify({ type: "custom", customType: "note", data: { type: "compaction", tokensBefore: 5 } }),
    assistant({ input: 5, cacheRead: 0, cacheWrite: 0 }).slice(0, 80),
    "",
    "not json",
    "[1,2,3]",
  ]) assert.equal(parseTrailLine(line), null, line.slice(0, 60));
  // No timestamp, no event: the rules are all about when.
  assert.equal(parseTrailLine(JSON.stringify({ type: "compaction", tokensBefore: 5, tokensAfter: 4 })), null);
});

test("a transcript reads in file order", () => {
  const text = [
    JSON.stringify({ type: "session_init", id: "s", timestamp: AT }),
    assistant({ input: 2, cacheRead: 100_000, cacheWrite: 4_000 }, "2026-11-12T17:05:40.000Z"),
    compaction({ tokensBefore: 200_357, tokensAfter: 58_403 }, "2026-11-12T17:05:41.000Z"),
    assistant({ input: 2, cacheRead: 41_515, cacheWrite: 27_000 }, "2026-11-12T17:05:48.000Z"),
    '{"type":"message","id":"half',
  ].join("\n");
  assert.deepEqual(parseTrail(text).map((event) => event.kind), ["request", "compaction", "request"]);
});

test("only the end of a large file is read, starting at a whole line", async () => {
  const file = path.join(root, "big.jsonl");
  const filler = JSON.stringify({ type: "message", id: "u", timestamp: AT, message: { role: "user", content: "y".repeat(4_000) } });
  const lines = [assistant({ input: 111_111, cacheRead: 1, cacheWrite: 0 }, "2026-11-12T16:00:00.000Z")];
  for (let i = 0; i < 50; i += 1) lines.push(filler);
  lines.push(assistant({ input: 222_222, cacheRead: 1, cacheWrite: 0 }, "2026-11-12T17:00:00.000Z"));
  lines.push(compaction({ tokensBefore: 10, tokensAfter: 9 }, "2026-11-12T17:00:01.000Z"));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const whole = await readTrail(file, 8 * 1024 * 1024);
  assert.deepEqual(whole.map((event) => event.kind === "request" ? event.fresh : "c"), [111_111, 222_222, "c"]);
  const tail = await readTrail(file, 6_000);
  assert.deepEqual(tail.map((event) => event.kind === "request" ? event.fresh : "c"), [222_222, "c"], "the first line of the tail is a fragment and is dropped");
  assert.deepEqual(await readTrail(path.join(root, "gone.jsonl"), 1_000), []);
});

test("a file omp rewrote is a different file to the guard", async () => {
  const file = path.join(root, "rewritten.jsonl");
  fs.writeFileSync(file, `${compaction({ tokensBefore: 208_780 })}\n`);
  const before = await statTrail(file);
  assert.deepEqual((await readTrail(file, 1_000_000))[0], { kind: "compaction", at: Date.parse(AT), before: 208_780, after: null, warned: false });
  // omp's atomic rewrite: a new file moved over the old one, now carrying what the compaction left and its warning.
  const next = `${file}.tmp`;
  fs.writeFileSync(next, `${compaction({ tokensBefore: 208_780, tokensAfter: 189_735, warning: "freed too little" })}\n`);
  fs.renameSync(next, file);
  const afterStamp = await statTrail(file);
  assert.notEqual(afterStamp.ino, before.ino);
  assert.deepEqual((await readTrail(file, 1_000_000))[0], { kind: "compaction", at: Date.parse(AT), before: 208_780, after: 189_735, warned: true });
  assert.equal(await statTrail(path.join(root, "gone.jsonl")), null);
  assert.equal(await statTrail(root), null, "a directory is not a transcript");
});

test("helper transcripts are found where omp puts them, and nothing else is", async () => {
  const sessionFile = path.join(root, "2026-11-03T23-51-06-575Z_01a1a3d2.jsonl");
  const dir = sessionFile.slice(0, -".jsonl".length);
  fs.mkdirSync(path.join(dir, "AgentsSlim", "AgentsSlim.CheckUi"), { recursive: true });
  fs.mkdirSync(path.join(dir, "local", "pnf-harness"), { recursive: true });
  fs.writeFileSync(sessionFile, "");
  for (const name of [
    "DbHealth.jsonl", "AgentsSlim.jsonl",
    "AgentsSlim/AgentsSlim.CheckUi.jsonl", "AgentsSlim/AgentsSlim.CheckUi/AgentsSlim.CheckUi.Deep.jsonl",
    // Not helpers: the advisor, tool output, the chat's shared files.
    "__advisor.jsonl", "10001.bash.log", "AgentsSlim/200.eval.log", "local/notes.jsonl", "local/pnf-harness/out.jsonl",
  ]) fs.writeFileSync(path.join(dir, name), "{}\n");
  const found = (await listHelperTrails(sessionFile)).map((trail) => `${trail.id} < ${trail.root} @ ${path.relative(dir, trail.file)}`).sort();
  assert.deepEqual(found, [
    "AgentsSlim < AgentsSlim @ AgentsSlim.jsonl",
    "AgentsSlim.CheckUi < AgentsSlim @ AgentsSlim/AgentsSlim.CheckUi.jsonl",
    "AgentsSlim.CheckUi.Deep < AgentsSlim @ AgentsSlim/AgentsSlim.CheckUi/AgentsSlim.CheckUi.Deep.jsonl",
    "DbHealth < DbHealth @ DbHealth.jsonl",
  ]);
  const one = (await listHelperTrails(sessionFile)).find((trail) => trail.id === "DbHealth");
  assert.deepEqual(one.stamp, await statTrail(one.file));
  // A chat that never had a helper has no such directory; an engine with no transcript has no file at all.
  assert.deepEqual(await listHelperTrails(path.join(root, "no-helpers.jsonl")), []);
  assert.deepEqual(await listHelperTrails(""), []);
});
