import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The sidecar omp leaves next to a session file is untrusted input read on
 * every page load: one bad file must never cost the user the good ones, and a
 * hostile directory must never make the read unbounded.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  readBtwHistoryFromDisk,
  btwHistoryDir,
  BTW_HISTORY_MAX_FILES,
  BTW_HISTORY_MAX_FILE_BYTES,
  BTW_HISTORY_MAX_TOTAL_BYTES,
} = await jiti.import("./btw-history.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-btw-history-"));
let counter = 0;

/** A fresh session file path (never created) and its sidecar dir. */
function freshSession() {
  const sessionFile = path.join(root, `session-${counter++}.jsonl`);
  const dir = path.join(sessionFile.slice(0, -".jsonl".length), "btw-history");
  return { sessionFile, dir };
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function turn(overrides = {}) {
  return { question: "q", answer: "a", status: "complete", createdAt: 1000, updatedAt: 2000, ...overrides };
}

function record(id, overrides = {}) {
  return { id, leafId: null, ...turn(), ...overrides };
}

function write(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}

const ASIS = { recoverRunning: false };
const RECOVER = { recoverRunning: true };

test("the sidecar directory is the session path without .jsonl, plus /btw-history", () => {
  assert.equal(btwHistoryDir("/a/b/c.jsonl"), "/a/b/c/btw-history");
  assert.equal(btwHistoryDir("/a/b/c.json"), null);
  assert.equal(btwHistoryDir(""), null);
  assert.equal(btwHistoryDir(".jsonl"), null);
});

test("a path without .jsonl, a missing session and a missing directory all answer no topics", async () => {
  const { sessionFile } = freshSession();
  assert.deepEqual(await readBtwHistoryFromDisk(sessionFile, ASIS), []);
  assert.deepEqual(await readBtwHistoryFromDisk(sessionFile.slice(0, -".jsonl".length), ASIS), []);
  assert.deepEqual(await readBtwHistoryFromDisk("", RECOVER), []);
});

test("topics come back newest first, with their follow-ups, as omp wrote them", async () => {
  const { sessionFile, dir } = freshSession();
  const old = record("aaaa0001", { createdAt: 10, updatedAt: 11 });
  const mid = record("aaaa0002", {
    createdAt: 20,
    updatedAt: 40,
    leafId: "leaf-1",
    followUps: [turn({ question: "and then?", answer: "this", createdAt: 30, updatedAt: 40 })],
  });
  const newest = record("aaaa0003", { createdAt: 50, updatedAt: 60, status: "error", error: "boom" });
  write(dir, "entry-aaaa0001.json", old);
  write(dir, "entry-aaaa0003.json", newest);
  write(dir, "entry-aaaa0002.json", mid);
  assert.deepEqual(await readBtwHistoryFromDisk(sessionFile, ASIS), [newest, mid, old]);
});

test("a running topic stays running unless the writer is known to be dead", async () => {
  const { sessionFile, dir } = freshSession();
  write(dir, "entry-run1.json", record("run1", { status: "running", answer: "partial" }));
  write(
    dir,
    "entry-run2.json",
    record("run2", {
      createdAt: 5000,
      followUps: [turn({ status: "complete" }), turn({ status: "running", answer: "half", createdAt: 5100 })],
    }),
  );
  write(dir, "entry-done.json", record("done", { createdAt: 10, status: "cancelled" }));

  const asWritten = await readBtwHistoryFromDisk(sessionFile, ASIS);
  assert.deepEqual(
    asWritten.map((r) => [r.id, r.status, r.followUps?.map((t) => t.status)]),
    [["run2", "complete", ["complete", "running"]], ["run1", "running", undefined], ["done", "cancelled", undefined]],
  );

  const recovered = await readBtwHistoryFromDisk(sessionFile, RECOVER);
  assert.deepEqual(
    recovered.map((r) => [r.id, r.status, r.followUps?.map((t) => t.status)]),
    [["run2", "complete", ["complete", "interrupted"]], ["run1", "interrupted", undefined], ["done", "cancelled", undefined]],
  );
  // Recovery changes the status only: the partial answer is kept.
  assert.equal(recovered.find((r) => r.id === "run1").answer, "partial");
  assert.equal(recovered.find((r) => r.id === "run2").followUps[1].answer, "half");
});

test("junk never costs the good topics: bad JSON, wrong shape, other names, subdirectories", async () => {
  const { sessionFile, dir } = freshSession();
  const good = record("good1");
  write(dir, "entry-good1.json", good);
  write(dir, "entry-broken.json", "{ not json");
  write(dir, "entry-empty.json", "");
  write(dir, "entry-array.json", "[]");
  write(dir, "entry-shape.json", { id: "shape", question: "q" });
  write(dir, "entry-status.json", record("status", { status: "thinking" }));
  write(dir, "entry-badturn.json", record("badturn", { followUps: [{ question: 1 }] }));
  write(dir, "notes.txt", "hello");
  write(dir, "entry-good1.json.bak", record("good1"));
  write(dir, "entry-.json", record("x"));
  write(dir, "entry-bad id.json", record("bad id"));
  fs.mkdirSync(path.join(dir, "entry-subdir.json"));
  assert.deepEqual(await readBtwHistoryFromDisk(sessionFile, RECOVER), [good]);
});

test("a file whose name and id disagree is ignored, like omp does", async () => {
  const { sessionFile, dir } = freshSession();
  write(dir, "entry-aaaa.json", record("bbbb"));
  write(dir, "entry-cccc.json", record("cccc"));
  assert.deepEqual(
    (await readBtwHistoryFromDisk(sessionFile, ASIS)).map((r) => r.id),
    ["cccc"],
  );
});

test("a symlink is refused, even one pointing at a valid topic", async () => {
  const { sessionFile, dir } = freshSession();
  const elsewhere = path.join(root, "elsewhere-topic.json");
  fs.writeFileSync(elsewhere, JSON.stringify(record("linked")));
  write(dir, "entry-real.json", record("real"));
  fs.symlinkSync(elsewhere, path.join(dir, "entry-linked.json"));
  assert.deepEqual(
    (await readBtwHistoryFromDisk(sessionFile, ASIS)).map((r) => r.id),
    ["real"],
  );
});

test("a file over the size cap is skipped without hiding the others", async () => {
  const { sessionFile, dir } = freshSession();
  write(dir, "entry-fits.json", record("fits", { answer: "x".repeat(1000) }));
  const huge = JSON.stringify(record("huge", { answer: "y".repeat(BTW_HISTORY_MAX_FILE_BYTES) }));
  assert.ok(huge.length > BTW_HISTORY_MAX_FILE_BYTES);
  write(dir, "entry-huge.json", huge);
  assert.deepEqual(
    (await readBtwHistoryFromDisk(sessionFile, ASIS)).map((r) => r.id),
    ["fits"],
  );
});

test("only the newest files are read when there are more than the cap", async () => {
  const { sessionFile, dir } = freshSession();
  const total = BTW_HISTORY_MAX_FILES + 25;
  for (let i = 0; i < total; i++) {
    const id = `id${String(i).padStart(5, "0")}`;
    write(dir, `entry-${id}.json`, record(id, { createdAt: i }));
  }
  const records = await readBtwHistoryFromDisk(sessionFile, ASIS);
  assert.equal(records.length, BTW_HISTORY_MAX_FILES);
  assert.equal(records[0].id, `id${String(total - 1).padStart(5, "0")}`);
  assert.equal(records.at(-1).id, `id${String(total - BTW_HISTORY_MAX_FILES).padStart(5, "0")}`);
});

test("the total read is bounded: later (older) files are dropped once the budget is spent", async () => {
  const { sessionFile, dir } = freshSession();
  // Each file is just under the per-file cap, so the budget runs out after
  // BTW_HISTORY_MAX_TOTAL_BYTES / size files, long before the 200-file cap.
  const answer = "z".repeat(BTW_HISTORY_MAX_FILE_BYTES - 1000);
  const count = 12;
  for (let i = 0; i < count; i++) {
    const id = `big${String(i).padStart(2, "0")}`;
    write(dir, `entry-${id}.json`, record(id, { createdAt: i, answer }));
  }
  const records = await readBtwHistoryFromDisk(sessionFile, ASIS);
  const perFile = JSON.stringify(record("big00", { answer })).length;
  assert.ok(records.length >= 1 && records.length < count);
  assert.ok(records.length * perFile <= BTW_HISTORY_MAX_TOTAL_BYTES);
  // The newest are the ones kept.
  assert.equal(records[0].id, "big11");
});
