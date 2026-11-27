import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getCachedSessionData,
  setCachedSessionData,
  clearCachedSessionData,
  __resetSessionTranscriptCacheForTests,
} = await jiti.import("./session-transcript-cache.ts");

function fixture(sessionId, overrides = {}) {
  return {
    sessionId,
    filePath: `/tmp/${sessionId}.jsonl`,
    tree: [],
    leafId: null,
    context: { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] },
    ...overrides,
  };
}

test("returns undefined for a session that was never cached", () => {
  __resetSessionTranscriptCacheForTests();
  assert.equal(getCachedSessionData("never-seen"), undefined);
});

test("returns exactly what was set, immediately after set", () => {
  __resetSessionTranscriptCacheForTests();
  const data = fixture("s1");
  setCachedSessionData("s1", data, 1_000);
  assert.equal(getCachedSessionData("s1", 1_000), data);
});

test("an entry older than the max age reads as a miss, without deleting it", () => {
  __resetSessionTranscriptCacheForTests();
  const data = fixture("s1");
  setCachedSessionData("s1", data, 0);
  const maxAgeMs = 15 * 60 * 1000;
  assert.equal(getCachedSessionData("s1", maxAgeMs), data, "still fresh exactly at the boundary");
  assert.equal(getCachedSessionData("s1", maxAgeMs + 1), undefined, "stale one millisecond past the boundary");
  // A stale read must not evict — a fresh write for the same id right after
  // must not behave any differently than writing a brand-new key.
  setCachedSessionData("s1", data, maxAgeMs + 1);
  assert.equal(getCachedSessionData("s1", maxAgeMs + 1), data);
});

test("writing beyond the capacity evicts the least-recently-written entry first", () => {
  __resetSessionTranscriptCacheForTests();
  for (let i = 0; i < 12; i++) setCachedSessionData(`s${i}`, fixture(`s${i}`), 1_000);
  // Capacity is exactly 12 — all 12 must still be present.
  for (let i = 0; i < 12; i++) assert.notEqual(getCachedSessionData(`s${i}`, 1_000), undefined, `s${i} should still be cached`);
  // A 13th write must evict s0 (the oldest by insertion), not any other entry.
  setCachedSessionData("s12", fixture("s12"), 1_000);
  assert.equal(getCachedSessionData("s0", 1_000), undefined, "oldest entry was evicted");
  for (let i = 1; i < 13; i++) assert.notEqual(getCachedSessionData(`s${i}`, 1_000), undefined, `s${i} should survive the eviction`);
});

test("re-writing an existing id refreshes its recency instead of duplicating it", () => {
  __resetSessionTranscriptCacheForTests();
  for (let i = 0; i < 12; i++) setCachedSessionData(`s${i}`, fixture(`s${i}`), 1_000);
  // Re-write the oldest entry: it should now be the MOST recent, so the next
  // eviction drops s1 (now the oldest) instead of s0.
  setCachedSessionData("s0", fixture("s0", { filePath: "/tmp/s0-v2.jsonl" }), 2_000);
  setCachedSessionData("s12", fixture("s12"), 2_000);
  assert.equal(getCachedSessionData("s1", 2_000), undefined, "s1 is now the oldest and gets evicted");
  const refreshed = getCachedSessionData("s0", 2_000);
  assert.notEqual(refreshed, undefined, "s0 survived because the re-write refreshed its recency");
  assert.equal(refreshed.filePath, "/tmp/s0-v2.jsonl", "the re-write's content replaced the original");
});

test("clearCachedSessionData removes exactly one entry, leaving the rest untouched", () => {
  __resetSessionTranscriptCacheForTests();
  setCachedSessionData("a", fixture("a"), 1_000);
  setCachedSessionData("b", fixture("b"), 1_000);
  clearCachedSessionData("a");
  assert.equal(getCachedSessionData("a", 1_000), undefined);
  assert.notEqual(getCachedSessionData("b", 1_000), undefined);
});

test("switching between large transcripts respects one shared budget, including tool bodies", () => {
  __resetSessionTranscriptCacheForTests();
  const transcript = (id, n) => fixture(id, { context: { messages: [{ role: "toolResult", content: "x".repeat(n) }] } });
  for (const id of ["a", "b", "c"]) setCachedSessionData(id, transcript(id, 800_000));
  assert.equal(getCachedSessionData("a"), undefined);
  assert.ok(getCachedSessionData("b"));
  assert.ok(getCachedSessionData("c"));
  setCachedSessionData("b", transcript("b", 3_000_000));
  assert.equal(getCachedSessionData("b"), undefined, "an oversized refresh must not leave the stale entry");
  assert.ok(getCachedSessionData("c"), "a single oversized entry cannot flush other chats");
});
