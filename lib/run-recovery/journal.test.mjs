import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The run journal is what a restart reads to learn which chats were cut off,
 * so what matters is what it says after each thing that can happen to a run:
 * it began, it stayed alive, it ended, its chat moved, it was restarted, and a
 * day went by.
 */
const root = mkdtempSync(join(tmpdir(), "cody-run-journal-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
after(() => rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const journal = await jiti.import("./journal.ts");

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-09T06:00:00Z");
const reset = () => rmSync(journal.runJournalPath(), { force: true });

test("a run's entry exists while it is in flight and is gone when it ends", () => {
  reset();
  assert.deepEqual(journal.listRuns(), []);

  const entry = journal.beginRun("chat-1", T0);
  assert.deepEqual(entry, { sessionId: "chat-1", startedAt: T0, updatedAt: T0, recoveries: [] });
  assert.deepEqual(journal.findRun("chat-1"), entry);

  assert.equal(journal.endRun("chat-1", T0 + 5_000), true);
  assert.equal(journal.findRun("chat-1"), null);
  assert.equal(journal.endRun("chat-1", T0 + 6_000), false, "ending a run twice is harmless");
});

test("the journal is a private file written atomically in the instance data dir", () => {
  reset();
  journal.beginRun("chat-1", T0);
  const file = journal.runJournalPath();
  assert.equal(file, join(process.env.PI_CODING_AGENT_DIR, "cody-run-journal.json"));
  assert.equal(statSync(file).mode & 0o777, 0o600, "nobody but Cody reads it");
  assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp")), [], "no half-written copy is left behind");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).runs.map((run) => run.sessionId), ["chat-1"]);
});

test("a heartbeat moves the last-activity time and keeps everything else", () => {
  reset();
  journal.beginRun("chat-1", T0);
  journal.addRecovery("chat-1", { at: T0 + 1_000, reason: "stuck" }, T0 + 1_000);
  journal.touchRun("chat-1", T0 + 60_000);
  const entry = journal.findRun("chat-1");
  assert.equal(entry.updatedAt, T0 + 60_000);
  assert.equal(entry.startedAt, T0);
  assert.deepEqual(entry.recoveries, [{ at: T0 + 1_000, reason: "stuck" }]);
});

test("a recovered run that starts again keeps its start and its recoveries", () => {
  reset();
  journal.beginRun("chat-1", T0);
  journal.addRecovery("chat-1", { at: T0 + 10, reason: "first" }, T0 + 10);
  journal.beginRun("chat-1", T0 + 20_000);
  const entry = journal.findRun("chat-1");
  assert.equal(entry.startedAt, T0);
  assert.equal(entry.recoveries.length, 1, "the cap on recoveries must survive the run starting over");
});

test("a session id that changes under a run takes the entry with it", () => {
  reset();
  journal.beginRun("old-id", T0);
  journal.addRecovery("old-id", { at: T0, reason: "stuck" }, T0);
  journal.rekeyRun("old-id", "new-id", T0 + 1_000);
  assert.equal(journal.findRun("old-id"), null);
  const moved = journal.findRun("new-id");
  assert.equal(moved.startedAt, T0);
  assert.equal(moved.recoveries.length, 1);

  journal.rekeyRun("never-ran", "somewhere", T0);
  assert.equal(journal.findRun("somewhere"), null, "re-keying a chat with no run invents none");
});

test("recoveries are remembered, bounded, and counted only inside the window", () => {
  reset();
  for (let n = 0; n < 14; n += 1) journal.addRecovery("chat-1", { at: T0 + n * HOUR, reason: `try ${n}` }, T0 + n * HOUR);
  const entry = journal.findRun("chat-1");
  assert.equal(entry.recoveries.length, 10, "an entry remembers only its latest few");
  assert.equal(entry.recoveries.at(-1).reason, "try 13");
  const now = T0 + 13 * HOUR;
  assert.deepEqual(journal.recentRecoveries(entry, now, 5 * HOUR).map((recovery) => recovery.reason), ["try 9", "try 10", "try 11", "try 12", "try 13"], "only the last five hours count");
  assert.equal(journal.recentRecoveries(null, now, 12 * HOUR).length, 0);
});

test("a chat's recoveries outlive the run they belonged to, so the next run is counted against the same cap", () => {
  reset();
  journal.beginRun("chat-1", T0);
  journal.addRecovery("chat-1", { at: T0 + HOUR, reason: "edit hung" }, T0 + HOUR);
  journal.addRecovery("chat-1", { at: T0 + 2 * HOUR, reason: "edit hung again" }, T0 + 2 * HOUR);
  // The recovered run answers and ends; a scheduled check-in starts the next one.
  assert.equal(journal.endRun("chat-1", T0 + 3 * HOUR), true);
  assert.equal(journal.findRun("chat-1"), null, "no run is in flight, so a boot finds nothing to resume");
  assert.deepEqual(journal.listRuns(), []);

  const next = journal.beginRun("chat-1", T0 + 4 * HOUR);
  assert.deepEqual(next.recoveries.map((recovery) => recovery.reason), ["edit hung", "edit hung again"]);
  assert.equal(journal.recentRecoveries(next, T0 + 4 * HOUR, 12 * HOUR).length, 2, "the cap still sees both");

  // Another chat's history is its own, and a day later it is gone.
  assert.deepEqual(journal.beginRun("chat-2", T0 + 4 * HOUR).recoveries, []);
  journal.endRun("chat-1", T0 + 5 * HOUR);
  assert.deepEqual(journal.beginRun("chat-1", T0 + 30 * HOUR).recoveries, [], "history older than a day is dropped");
});

test("entries nobody touched for a day are dropped by the next write, never kept for ever", () => {
  reset();
  journal.beginRun("stale", T0);
  journal.beginRun("fresh", T0 + 23 * HOUR);
  assert.deepEqual(journal.listRuns().map((run) => run.sessionId).sort(), ["fresh", "stale"], "a read never prunes");

  journal.touchRun("fresh", T0 + 25 * HOUR);
  assert.deepEqual(journal.listRuns().map((run) => run.sessionId), ["fresh"]);
});

test("at most 200 entries are kept, the most recently alive ones", () => {
  reset();
  for (let n = 0; n < 205; n += 1) journal.beginRun(`chat-${n}`, T0 + n * 1_000);
  const kept = journal.listRuns();
  assert.equal(kept.length, 200);
  assert.equal(kept[0].sessionId, "chat-204", "newest first");
  assert.equal(kept.some((run) => run.sessionId === "chat-0"), false, "the oldest went");
});

test("a damaged or hand-edited file reads as no runs, and one bad entry never costs the good ones", () => {
  reset();
  writeFileSync(journal.runJournalPath(), "{ not json");
  assert.deepEqual(journal.listRuns(), []);
  journal.beginRun("chat-1", T0);
  assert.deepEqual(journal.listRuns().map((run) => run.sessionId), ["chat-1"], "the next write replaces the junk");

  writeFileSync(journal.runJournalPath(), JSON.stringify({
    version: 1,
    runs: [
      { sessionId: "good", startedAt: T0, updatedAt: T0, recoveries: [{ at: T0, reason: "x" }, { at: "no", reason: 1 }] },
      { sessionId: "", startedAt: T0, updatedAt: T0, recoveries: [] },
      { sessionId: "no-times", recoveries: [] },
      "nonsense",
      { sessionId: "good", startedAt: T0, updatedAt: T0 + 1, recoveries: [] },
    ],
  }));
  const runs = journal.listRuns();
  assert.deepEqual(runs.map((run) => run.sessionId), ["good"], "a repeated id keeps its first entry");
  assert.deepEqual(runs[0].recoveries, [{ at: T0, reason: "x" }], "a malformed recovery is dropped, not trusted");
});

test("the file is created on first write even when the data dir does not exist yet", () => {
  rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
  assert.equal(existsSync(journal.runJournalPath()), false);
  journal.beginRun("chat-1", T0);
  assert.equal(existsSync(journal.runJournalPath()), true);
});
