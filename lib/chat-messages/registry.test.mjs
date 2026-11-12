import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * What the server remembers of the messages chats have sent each other: the
 * delivery ids, the per-sender allowance that stops two agents answering each
 * other forever, and which sends the target has answered.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const registry = await jiti.import("./registry.ts");
const { CHAT_MESSAGE_LIMITS, clientMessageIdForChatMessage } = await jiti.import("./types.ts");

beforeEach(() => registry.resetChatMessages());

const fields = (overrides = {}) => ({ fromSessionId: "chat-a", fromTitle: "Chat A", toSessionId: "chat-b", urgency: "next_step", preview: "hello", ...overrides });
const MINUTE = 60_000;

test("a send gets its own msg_ id, starts out `sending`, and is found again by that id", () => {
  const first = registry.createChatMessage(fields(), 1_000);
  const second = registry.createChatMessage(fields(), 1_000);
  assert.match(first.id, /^msg_[A-Za-z0-9_-]{7}$/);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(
    [first.state, first.createdAt, first.fromSessionId, first.toSessionId, first.urgency, first.preview],
    ["sending", 1_000, "chat-a", "chat-b", "next_step", "hello"],
  );
  assert.equal(registry.findChatMessage(first.id, 2_000), first, "the same record, so what delivery settles is what status reads");
  assert.equal(registry.findChatMessage("msg_nope", 2_000), undefined);
  assert.equal(clientMessageIdForChatMessage(first.id), `chat-${first.id}`, "the id the target's delivery ledger knows it under");
});

test("a chat may send twenty messages per ten minutes; the twenty-first waits for the oldest to age out", () => {
  assert.equal(CHAT_MESSAGE_LIMITS.perSender, 20);
  assert.equal(CHAT_MESSAGE_LIMITS.windowMs, 10 * MINUTE);
  const t0 = 1_000_000;
  for (let sent = 0; sent < CHAT_MESSAGE_LIMITS.perSender; sent += 1) {
    assert.deepEqual(registry.sendAllowance("chat-a", t0 + sent * 1_000), { allowed: true }, `send ${sent + 1}`);
    registry.createChatMessage(fields(), t0 + sent * 1_000);
  }
  const blocked = registry.sendAllowance("chat-a", t0 + 30_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryInMs, 10 * MINUTE - 30_000, "until the first of the twenty is ten minutes old");

  assert.equal(registry.sendAllowance("chat-a", t0 + 10 * MINUTE - 1).allowed, false, "one millisecond short of the window");
  assert.deepEqual(registry.sendAllowance("chat-a", t0 + 10 * MINUTE + 1), { allowed: true }, "the first has aged out, so one more may go");
});

test("the allowance is per sender: one chatty chat never blocks another", () => {
  for (let sent = 0; sent < CHAT_MESSAGE_LIMITS.perSender; sent += 1) registry.createChatMessage(fields(), 5_000);
  assert.equal(registry.sendAllowance("chat-a", 5_001).allowed, false);
  assert.deepEqual(registry.sendAllowance("chat-b", 5_001), { allowed: true });
  assert.deepEqual(registry.sendAllowance("chat-never-sent", 5_001), { allowed: true });
});

test("an id keeps answering for a day, then is forgotten", () => {
  const record = registry.createChatMessage(fields(), 0);
  assert.equal(registry.findChatMessage(record.id, CHAT_MESSAGE_LIMITS.keepMs - 1), record);
  assert.equal(registry.findChatMessage(record.id, CHAT_MESSAGE_LIMITS.keepMs), undefined);
});

test("no more than the cap are remembered: the oldest go first", () => {
  const records = [];
  for (let index = 0; index < CHAT_MESSAGE_LIMITS.cap + 3; index += 1) {
    // Each one from its own chat, so the allowance never gets in the way.
    records.push(registry.createChatMessage(fields({ fromSessionId: `chat-${index}` }), 1_000 + index));
  }
  const now = 1_000 + records.length;
  assert.equal(registry.findChatMessage(records[0].id, now), undefined);
  assert.equal(registry.findChatMessage(records[2].id, now), undefined);
  assert.equal(registry.findChatMessage(records[3].id, now), records[3]);
  assert.equal(registry.findChatMessage(records.at(-1).id, now), records.at(-1));
});

test("what a chat sent another and the other has not answered: accepted sends only, oldest first", () => {
  const sending = registry.createChatMessage(fields({ preview: "still sending" }), 1_000);
  const accepted = registry.createChatMessage(fields({ preview: "accepted" }), 2_000);
  accepted.state = "accepted";
  const failed = registry.createChatMessage(fields({ preview: "failed" }), 3_000);
  failed.state = "failed";
  const answered = registry.createChatMessage(fields({ preview: "answered" }), 4_000);
  answered.state = "accepted";
  answered.repliedAt = 5_000;
  const later = registry.createChatMessage(fields({ preview: "later" }), 6_000);
  later.state = "accepted";
  registry.createChatMessage(fields({ fromSessionId: "chat-b", toSessionId: "chat-a", preview: "the other way" }), 7_000).state = "accepted";
  registry.createChatMessage(fields({ toSessionId: "chat-c", preview: "to someone else" }), 8_000).state = "accepted";

  assert.deepEqual(registry.unansweredChatMessages("chat-a", "chat-b").map((record) => record.preview), ["accepted", "later"]);
  assert.ok(!registry.unansweredChatMessages("chat-a", "chat-b").includes(sending), "one the chat has not even taken cannot have been answered");
  assert.deepEqual(registry.unansweredChatMessages("chat-b", "chat-a").map((record) => record.preview), ["the other way"]);
});

test("a send made through one copy of the module is found through another: the server loads its modules more than once", async () => {
  const otherCopy = await createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, fsCache: false }).import("./registry.ts");
  assert.notEqual(otherCopy.createChatMessage, registry.createChatMessage, "a genuinely separate copy");
  const record = otherCopy.createChatMessage(fields(), 10_000);
  assert.equal(registry.findChatMessage(record.id, 10_001), record);
  for (let sent = 1; sent < CHAT_MESSAGE_LIMITS.perSender; sent += 1) otherCopy.createChatMessage(fields(), 10_000);
  assert.equal(registry.sendAllowance("chat-a", 10_001).allowed, false, "and the allowance is shared the same way");
});

test("resetChatMessages is a clean slate", () => {
  const record = registry.createChatMessage(fields(), 1_000);
  registry.resetChatMessages();
  assert.equal(registry.findChatMessage(record.id, 1_001), undefined);
  assert.deepEqual(registry.sendAllowance("chat-a", 1_001), { allowed: true });
});
