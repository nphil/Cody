import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The store is the one thing a crash, a cancel and a claim all meet at, so its
 * guarantees are pinned on the real file: limits, atomic 0600 writes, what a
 * damaged file may never turn into, and pruning.
 */
const root = mkdtempSync(join(tmpdir(), "cody-scheduled-store-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./store.ts");
const { SCHEDULED_LIMITS } = await jiti.import("./types.ts");

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-05T12:00:00Z");

const draft = (overrides = {}) => ({
  sessionId: "chat-1",
  accountKey: "alice",
  message: "run the tests",
  mode: "at",
  dueAt: NOW + HOUR,
  source: "user",
  ...overrides,
});

function reset() {
  writeFileSync(store.scheduledStorePath(), "", { mode: 0o600 });
}

test("an item is stored in the instance data dir, owner-readable only, and read back whole", () => {
  const { item } = store.insertItem(draft(), NOW);
  assert.match(item.id, /^sch_[A-Za-z0-9_-]{6,}$/);
  assert.equal(item.status, "pending");
  assert.equal(item.rev, 0);
  assert.equal(item.attempts, 0);
  assert.equal(store.scheduledStorePath(), join(root, "agent", "cody-scheduled.json"));
  assert.equal(statSync(store.scheduledStorePath()).mode & 0o777, 0o600, "a message may be private");
  assert.deepEqual(store.findItem(item.id, NOW), item);
  assert.deepEqual(store.listItemsForSession("chat-1", NOW).map((entry) => entry.id), [item.id]);
  assert.equal(store.listItemsForSession("chat-2", NOW).length, 0);
  reset();
});

test("a chat holds 20 and an account 100: the 21st and the 101st are refused, and nothing is written", () => {
  reset();
  for (let index = 0; index < SCHEDULED_LIMITS.perChat; index += 1) {
    assert.equal(store.insertItem(draft({ message: `m${index}` }), NOW).ok, true);
  }
  const refusedChat = store.insertItem(draft(), NOW);
  assert.deepEqual(refusedChat, { ok: false, code: "too_many_for_chat" });
  assert.equal(store.listItems(NOW).length, SCHEDULED_LIMITS.perChat);

  // Other chats of the SAME account fill up the account's 100; another account is unaffected.
  for (let chat = 2; chat <= 5; chat += 1) {
    for (let index = 0; index < SCHEDULED_LIMITS.perChat; index += 1) {
      assert.equal(store.insertItem(draft({ sessionId: `chat-${chat}` }), NOW).ok, true);
    }
  }
  assert.equal(store.listItems(NOW).length, SCHEDULED_LIMITS.perAccount);
  assert.deepEqual(store.insertItem(draft({ sessionId: "chat-6" }), NOW), { ok: false, code: "too_many_for_account" });
  assert.equal(store.insertItem(draft({ sessionId: "chat-6", accountKey: "bob" }), NOW).ok, true, "another account has its own 100");
  reset();
});

test("a change is stamped with a new revision, and a deletion removes the item", () => {
  const { item } = store.insertItem(draft(), NOW);
  const changed = store.mutateItem(item.id, (current) => ({ ...current, message: "edited" }), NOW + 5);
  assert.equal(changed.message, "edited");
  assert.equal(changed.rev, 1);
  assert.equal(changed.updatedAt, NOW + 5);
  assert.equal(store.mutateItem(item.id, () => undefined, NOW + 9).rev, 1, "undefined leaves it alone");
  assert.equal(store.mutateItem(item.id, () => null, NOW + 10), null);
  assert.equal(store.findItem(item.id, NOW), null);
  assert.equal(store.mutateItem("sch_missing", (current) => current, NOW), null, "a missing item is just absent");
  reset();
});

test("a failed message is dropped a week after it failed; a pending one never ages out", () => {
  const failed = store.insertItem(draft({ message: "will fail" }), NOW).item;
  const waiting = store.insertItem(draft({ message: "waits" }), NOW).item;
  store.mutateItem(failed.id, (current) => ({ ...current, status: "failed", error: "boom" }), NOW);
  assert.equal(store.findItem(failed.id, NOW + store.FAILED_RETENTION_MS - 1)?.status, "failed");
  const later = NOW + store.FAILED_RETENTION_MS + 1;
  assert.equal(store.findItem(failed.id, later), null, "expired on read");
  assert.equal(store.findItem(waiting.id, later)?.status, "pending");
  store.insertItem(draft({ message: "any write prunes" }), later);
  assert.ok(!readFileSync(store.scheduledStorePath(), "utf8").includes('"will fail"'), "and it is gone from the file, not just hidden");
  reset();
});

test("a damaged or hand-edited file degrades entry by entry and never throws or invents a message", () => {
  const good = {
    id: "sch_good1",
    sessionId: "chat-1",
    accountKey: "alice",
    message: "keep me",
    mode: "at",
    dueAt: NOW,
    source: "agent",
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
    rev: 3,
    deliveryNo: 1,
    attempts: 2,
    firstAttemptAt: NOW - 5,
    notBefore: NOW + 1,
    error: "earlier",
  };
  writeFileSync(store.scheduledStorePath(), JSON.stringify({
    version: 1,
    items: [
      good,
      { ...good, id: "sch_good1" }, // a duplicate id is dropped
      { ...good, id: "bad id!" },
      { ...good, id: "sch_nosession", sessionId: "" },
      { ...good, id: "sch_nomsg", message: 7 },
      { ...good, id: "sch_badmode", mode: "later" },
      { ...good, id: "sch_badstatus", status: "done" },
      { ...good, id: "sch_noquota", mode: "quota" }, // quota mode without its quota
      { ...good, id: "sch_notime", dueAt: "soon" },
      "garbage",
      null,
    ],
  }));
  assert.deepEqual(store.listItems(NOW).map((item) => item.id), ["sch_good1"]);
  assert.deepEqual(store.findItem("sch_good1", NOW), good);

  for (const content of ["", "not json", "[]", '{"items":"nope"}', "{}"]) {
    writeFileSync(store.scheduledStorePath(), content);
    assert.deepEqual(store.listItems(NOW), [], JSON.stringify(content));
  }
  reset();
});

test("a quota message round-trips its quota; the stored form has everything the scheduler needs", () => {
  const quota = { provider: "anthropic", modelId: "claude-opus-4-5", label: "Claude · Secondary", giveUpAt: NOW + 25 * HOUR };
  const { item } = store.insertItem(draft({ mode: "quota", quota, dueAt: NOW + HOUR }), NOW);
  assert.deepEqual(store.findItem(item.id, NOW).quota, quota);
  reset();
});

test("a chat that is deleted takes its messages with it, and one that moves to a new id keeps them", () => {
  const a = store.insertItem(draft({ sessionId: "old-id" }), NOW).item;
  const b = store.insertItem(draft({ sessionId: "other" }), NOW).item;
  assert.equal(store.moveSessionItems("old-id", "new-id"), 1);
  assert.equal(store.findItem(a.id, NOW).sessionId, "new-id");
  assert.equal(store.findItem(b.id, NOW).sessionId, "other");
  assert.equal(store.moveSessionItems("old-id", "old-id"), 0, "moving onto itself is nothing");
  assert.equal(store.moveSessionItems("nobody", "someone"), 0);
  assert.equal(store.removeSessionItems("new-id"), 1);
  assert.equal(store.findItem(a.id, NOW), null);
  assert.equal(store.removeSessionItems("new-id"), 0);
  assert.ok(store.findItem(b.id, NOW), "another chat's message is untouched");
  reset();
});

test("the id a send goes out under is stable per delivery and moves only when the delivery does", () => {
  assert.equal(store.clientMessageIdFor({ id: "sch_x", deliveryNo: 0 }), "sched-sch_x");
  assert.equal(store.clientMessageIdFor({ id: "sch_x", deliveryNo: 0 }), store.clientMessageIdFor({ id: "sch_x", deliveryNo: 0 }));
  assert.equal(store.clientMessageIdFor({ id: "sch_x", deliveryNo: 2 }), "sched-sch_x-2");
  assert.notEqual(store.clientMessageIdFor({ id: "sch_x", deliveryNo: 1 }), store.clientMessageIdFor({ id: "sch_y", deliveryNo: 1 }));
});
