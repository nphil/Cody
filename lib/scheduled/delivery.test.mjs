import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Handing one message to its chat, with the real delivery module and a stand-in
 * for the chat's session: what a delivery says to the session, in whose time
 * zone, when a retry must look for its own earlier copy instead of sending
 * again, and which failures are worth another try.
 */
const root = mkdtempSync(path.join(tmpdir(), "cody-scheduled-delivery-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.TZ = "America/New_York";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deliverScheduledMessage } = await jiti.import("./delivery.ts");
const { clientMessageIdFor } = await jiti.import("./store.ts");
const { EngineCommandError } = await jiti.import("../harness/errors.ts");
const { WebRpcError } = await jiti.import("../rpc-manager.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");
const prefs = await jiti.import("../time-zone-prefs.ts");

const NOW = Date.now();

const item = (overrides = {}) => ({
  id: "sch_one",
  sessionId: "chat-1",
  accountKey: "",
  message: "carry on with the migration",
  mode: "at",
  dueAt: NOW,
  source: "user",
  status: "sending",
  createdAt: NOW - 1000,
  updatedAt: NOW,
  rev: 1,
  deliveryNo: 0,
  attempts: 0,
  ...overrides,
});

/** A live chat in the registry; `send` is what the chat does with a command. */
function liveChat(id, send) {
  const sent = [];
  (globalThis.__ompSessions ??= new Map()).set(id, {
    sessionId: id,
    cwd: path.join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => true,
    send: async (command) => {
      sent.push(command);
      return send ? send(command) : null;
    },
  });
  return sent;
}

function writeTranscript(id, entries, base = path.join("sessions", "-project")) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, base);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id, cwd: "/proj", title: "t", created: "2026-01-01", modified: "2026-01-01" })];
  let parentId = null;
  for (const [index, entry] of entries.entries()) {
    const entryId = `${id}-${index}`;
    lines.push(JSON.stringify({ id: entryId, parentId, ...entry }));
    parentId = entryId;
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  invalidateSessionListCache();
}

const userEntry = (text, at) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: text } });

const failure = (promise) => promise.then(() => assert.fail("expected the delivery to fail"), (error) => error);

test("a delivery is one prompt held as a follow-up, under the item's own id, in the owner's zone", async () => {
  const owner = users.createUser({ username: "owner", fullName: "Owner", passwordHash: "x", role: "member" });
  owners.setSessionOwner("chat-owned", owner.id);
  prefs.setExplicitTimeZone(owner, "Asia/Tokyo");
  const sent = liveChat("chat-owned");

  await deliverScheduledMessage(item({ sessionId: "chat-owned", id: "sch_zone" }));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "prompt",
    message: "carry on with the migration",
    streamingBehavior: "followUp",
    clientMessageId: "sched-sch_zone",
    timeZone: "Asia/Tokyo",
  });

  const open = liveChat("chat-open");
  await deliverScheduledMessage(item({ sessionId: "chat-open" }));
  assert.equal(open[0].timeZone, "America/New_York", "a chat nobody owns uses the server's own zone, never UTC");
});

test("the id a delivery goes out under is the item's, and moves only with the delivery", async () => {
  const sent = liveChat("chat-ids");
  await deliverScheduledMessage(item({ sessionId: "chat-ids", deliveryNo: 0 }));
  await deliverScheduledMessage(item({ sessionId: "chat-ids", deliveryNo: 0, attempts: 1 }));
  await deliverScheduledMessage(item({ sessionId: "chat-ids", deliveryNo: 2 }));
  assert.deepEqual(sent.map((command) => command.clientMessageId), ["sched-sch_one", "sched-sch_one", "sched-sch_one-2"]);
  assert.equal(sent[0].clientMessageId, clientMessageIdFor(item()));
});

test("a retry looks for its own earlier copy in the chat first; a first attempt never does", async () => {
  const firstAttemptAt = NOW - 60_000;
  writeTranscript("chat-copy", [
    userEntry("an older, unrelated message", NOW - 3_600_000),
    userEntry("carry on with the migration", NOW - 30_000),
  ]);
  const sent = liveChat("chat-copy");

  await deliverScheduledMessage(item({ sessionId: "chat-copy", attempts: 1, firstAttemptAt }));
  assert.equal(sent.length, 0, "the interrupted attempt did reach the chat: nothing is sent again");

  await deliverScheduledMessage(item({ sessionId: "chat-copy", attempts: 0 }));
  assert.equal(sent.length, 1, "an item on its first attempt is simply sent, even if the same words appear in the chat");
});

test("a copy from before the first attempt is somebody else's message, not this one's", async () => {
  writeTranscript("chat-old-copy", [userEntry("carry on with the migration", NOW - 7_200_000)]);
  const sent = liveChat("chat-old-copy");
  await deliverScheduledMessage(item({ sessionId: "chat-old-copy", attempts: 2, firstAttemptAt: NOW - 60_000 }));
  assert.equal(sent.length, 1, "the identical earlier message does not stand in for the scheduled one");
});

test("a retry whose chat cannot be read just sends: the chat's own ledger dedupes by id", async () => {
  const sent = liveChat("chat-no-file");
  await deliverScheduledMessage(item({ sessionId: "chat-no-file", attempts: 1, firstAttemptAt: NOW - 1000 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].clientMessageId, "sched-sch_one");
});

test("an engine's refusal is final; a restart, a dead child or an unknown failure is worth another try", async () => {
  const cases = [
    [Object.assign(new Error("not accepting messages"), { name: "RpcCommandError" }), false, "omp's own refusal"],
    [new EngineCommandError("prompt", "unsupported here", "unsupported"), false, "an engine that lacks the command"],
    [new EngineCommandError("prompt", "busy", "session_busy"), true, "an engine turn in progress"],
    [new EngineCommandError("prompt", "dead", "session_dead"), true, "a child that died"],
    [new EngineCommandError("prompt", "restarting", "session_restarting"), true, "a chat mid-restart"],
    [new WebRpcError("The wrapper is restarting", "session_restarting", 409), true, "the wrapper's own failure"],
    [new Error("socket hang up"), true, "anything else"],
  ];
  for (const [error, retryable, what] of cases) {
    liveChat("chat-fails", async () => { throw error; });
    const raised = await failure(deliverScheduledMessage(item({ sessionId: "chat-fails" })));
    assert.equal(raised.name, "ScheduledDeliveryError", what);
    assert.equal(raised.retryable, retryable, what);
    assert.equal(raised.message, error.message, `${what}: the reason is kept for the person to read`);
  }
});

test("a chat that no longer exists is a final failure, and a sidebar chat can never receive one", async () => {
  globalThis.__ompSessions?.delete("chat-vanished");
  const gone = await failure(deliverScheduledMessage(item({ sessionId: "chat-vanished" })));
  assert.equal(gone.retryable, false);
  assert.match(gone.message, /no longer exists/);

  writeTranscript("chat-sidebar", [userEntry("hello", NOW)], path.join("cody-sidebar-chats", "-project"));
  globalThis.__ompSessions?.delete("chat-sidebar");
  const sidebar = await failure(deliverScheduledMessage(item({ sessionId: "chat-sidebar" })));
  assert.equal(sidebar.retryable, false);
  assert.match(sidebar.message, /sidebar chat cannot receive scheduled messages/);
});
