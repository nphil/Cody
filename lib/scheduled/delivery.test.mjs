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
 *
 * The hand-over half: a chat that is mid-turn only QUEUES a follow-up, so the
 * delivery says "queued" rather than "delivered", and the chat's own ledger is
 * what later says whether it started, was lost with an engine, or was taken
 * back — read here against stand-in sessions, and end to end through the real
 * scheduler.
 */
const root = mkdtempSync(path.join(tmpdir(), "cody-scheduled-delivery-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.TZ = "America/New_York";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { checkHandedOver, deliverScheduledMessage } = await jiti.import("./delivery.ts");
const { clientMessageIdFor, findItem, insertItem } = await jiti.import("./store.ts");
const scheduler = await jiti.import("./scheduler.ts");
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

/** A live chat in the registry; `send` is what the chat does with a command, `ledger` (when given) is its delivery ledger — a chat without one is an engine that keeps none (ACP). */
function liveChat(id, send, ledger) {
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
    ...(ledger ? { getDeliveryLedger: ledger } : {}),
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

test("a chat whose saved model is gone fails for good, in words the person can act on", async () => {
  const gone = new WebRpcError("This chat used acme/old-1, which is no longer available.", "model_unrestorable", { provider: "acme", modelId: "old-1" });
  liveChat("chat-model-gone", async () => { throw gone; });
  const raised = await failure(deliverScheduledMessage(item({ sessionId: "chat-model-gone" })));
  assert.equal(raised.retryable, false, "a timer cannot pick another model, so retrying would only repeat this");
  assert.match(raised.message, /acme\/old-1/);
  assert.match(raised.message, /pick another model/);
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

// ---------------------------------------------------------------------------
// Queued behind a running reply
// ---------------------------------------------------------------------------

/** The ledger of a chat whose rows are whatever `rows(id)` says (undefined: nothing remembered). */
const ledgerOf = (rows) => (ids) => ids.map((clientMessageId) => ({ clientMessageId, status: "unknown", ...rows(clientMessageId) }));

test("a chat that only queues the message behind a running reply has not delivered it; one that starts it has", async () => {
  const queued = { delivery: "queued", clientMessageId: "sched-sch_one", held: true };
  liveChat("chat-held", () => queued, ledgerOf(() => ({ status: "queued", held: true })));
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-held" })), "queued", "held in the wrapper");

  liveChat("chat-omp-queue", () => queued, ledgerOf(() => ({ status: "queued", held: false })));
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-omp-queue" })), "queued", "in omp's own queue");

  liveChat("chat-idle", () => ({ delivery: "started", clientMessageId: "sched-sch_one" }), ledgerOf(() => ({ status: "started" })));
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-idle" })), "delivered", "the chat was idle, so it began at once");

  liveChat("chat-echoed", () => queued, ledgerOf(() => ({ status: "delivered" })));
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-echoed" })), "delivered", "the ack was older than the ledger: the engine had already echoed the message");

  liveChat("chat-ack-says", () => ({ ...queued, status: "delivered" }), ledgerOf(() => ({})));
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-ack-says" })), "delivered");
});

test("a chat whose engine keeps no ledger (ACP) cannot say queued: a send it took is delivered, as it always was", async () => {
  liveChat("chat-acp", () => ({ delivery: "queued", clientMessageId: "sched-sch_one" }));
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-acp" })), "delivered");
  liveChat("chat-acp-null", () => null);
  assert.equal(await deliverScheduledMessage(item({ sessionId: "chat-acp-null" })), "delivered");
});

test("a send the chat's own ledger already calls failed is a retryable failure, not a message that waits", async () => {
  liveChat("chat-failed-at-once", () => ({ delivery: "queued", clientMessageId: "sched-sch_one" }), ledgerOf(() => ({ status: "failed", error: "The session restarted before this message was read." })));
  const raised = await failure(deliverScheduledMessage(item({ sessionId: "chat-failed-at-once" })));
  assert.equal(raised.retryable, true);
  assert.equal(raised.message, "The session restarted before this message was read.");
});

test("what the chat's ledger says about a queued message: started and delivered are done, queued waits, withdrawn is taken back, and anything else is lost", async () => {
  const handed = item({ sessionId: "chat-ledger", status: "sending", handedAt: NOW, handedClientMessageId: "sched-sch_one-7" });
  const asked = [];
  const answer = (status, extra = {}) => liveChat("chat-ledger", undefined, (ids) => {
    asked.push(...ids);
    return ids.map((clientMessageId) => ({ clientMessageId, status, ...extra }));
  });
  for (const status of ["started", "delivered"]) {
    answer(status);
    assert.deepEqual(await checkHandedOver(handed), { state: "done" }, status);
  }
  for (const status of ["queued", "sending"]) {
    answer(status);
    assert.deepEqual(await checkHandedOver(handed), { state: "waiting" }, status);
  }
  answer("withdrawn");
  assert.deepEqual(await checkHandedOver(handed), { state: "withdrawn" });

  answer("failed", { error: "The session restarted before this message was read." });
  assert.deepEqual(await checkHandedOver(handed), { state: "lost", reason: "The session restarted before this message was read.", freshId: true }, "this wrapper still remembers that id, so only a new one can reach the engine");

  answer("unknown");
  const unknown = await checkHandedOver(handed);
  assert.equal(unknown.state, "lost");
  assert.equal(unknown.freshId, false, "a replacement wrapper has never seen the id");
  assert.deepEqual([...new Set(asked)], ["sched-sch_one-7"], "it asks about the id that was actually sent");
  asked.length = 0;
  await checkHandedOver(item({ sessionId: "chat-ledger", status: "sending", handedAt: NOW }));
  assert.deepEqual(asked, ["sched-sch_one"], "an item with no recorded id asks about the id it would send under");
});

test("a chat with no live engine, a dead one, or one that keeps no ledger has lost a queued message, and checking never starts a session", async () => {
  globalThis.__ompSessions?.delete("chat-no-engine");
  const handed = (sessionId) => item({ sessionId, status: "sending", handedAt: NOW, handedClientMessageId: "sched-sch_one" });
  assert.equal((await checkHandedOver(handed("chat-no-engine"))).state, "lost");
  assert.equal(globalThis.__ompSessions.has("chat-no-engine"), false);

  (globalThis.__ompSessions ??= new Map()).set("chat-dead", { sessionId: "chat-dead", isAlive: () => false, getDeliveryLedger: ledgerOf(() => ({ status: "queued" })) });
  assert.equal((await checkHandedOver(handed("chat-dead"))).state, "lost");

  liveChat("chat-no-ledger");
  assert.equal((await checkHandedOver(handed("chat-no-ledger"))).state, "lost");
});

/** A scheduler wired to the real delivery module, a settable clock and a notification log. */
function realRound() {
  const clock = { now: NOW };
  const notes = [];
  const deps = {
    now: () => clock.now,
    deliver: deliverScheduledMessage,
    checkHandedOver,
    readUsage: async () => { throw new Error("no quota message here"); },
    notify: async (outcome) => { notes.push(outcome.kind); },
  };
  return { clock, notes, run: () => scheduler.runDue(deps) };
}

const scheduleFor = (sessionId, message) => insertItem({ sessionId, accountKey: "", message, mode: "at", dueAt: NOW - 1000, source: "agent" }, NOW).item;

test("a check-in held behind a running turn survives the engine being replaced: it is retried on the new child and arrives once", async () => {
  const sessionId = "chat-loss-new-child";
  const original = liveChat(sessionId, () => ({ delivery: "queued", clientMessageId: "x", held: true }), ledgerOf(() => ({ status: "queued", held: true })));
  const created = scheduleFor(sessionId, "check in on the run");
  const { clock, notes, run } = realRound();

  await run();
  await run();
  assert.equal(original.length, 1, "handed over once, however many rounds look at it");
  assert.equal(findItem(created.id, NOW).status, "sending", "still ours until it starts");
  assert.deepEqual(notes, [], "held is not sent");

  // The watchdog recycled the engine: a new wrapper that has never heard of the old id.
  const seen = new Set();
  const replacement = liveChat(sessionId, (command) => { seen.add(command.clientMessageId); return { delivery: "started", clientMessageId: command.clientMessageId }; },
    ledgerOf((id) => (seen.has(id) ? { status: "started" } : {})));
  await run();
  const waiting = findItem(created.id, NOW);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.attempts, 1);
  await run();
  assert.equal(replacement.length, 0, "the back-off has not passed");

  clock.now += scheduler.RETRY_DELAYS_MS[0];
  await run();
  await run();
  assert.deepEqual(replacement.map((command) => [command.message, command.clientMessageId]), [["check in on the run", `sched-${created.id}`]]);
  assert.equal(original.length, 1, "the lost child is never written to again");
  assert.equal(findItem(created.id, NOW), null);
  assert.deepEqual(notes, ["sent"]);
});

test("a check-in whose wrapper was restarted in place (its ledger says failed) is retried under a new id the engine has never seen", async () => {
  const sessionId = "chat-loss-same-wrapper";
  let failed = false;
  const seen = new Set();
  const sent = liveChat(sessionId, (command) => {
    seen.add(command.clientMessageId);
    return failed && !command.clientMessageId.endsWith("-1") ? { delivery: "queued", clientMessageId: command.clientMessageId } : { delivery: seen.size > 1 ? "started" : "queued", clientMessageId: command.clientMessageId };
  }, ledgerOf((id) => {
    if (id.endsWith("-1")) return { status: "started" };
    return seen.has(id) ? { status: failed ? "failed" : "queued", error: "The session restarted before this message was read." } : {};
  }));
  const created = scheduleFor(sessionId, "report back when the build is done");
  const { clock, notes, run } = realRound();

  await run();
  await run();
  assert.equal(findItem(created.id, NOW).status, "sending");
  failed = true;
  await run();
  assert.equal(findItem(created.id, NOW).deliveryNo, 1);
  clock.now += scheduler.RETRY_DELAYS_MS[0];
  await run();
  await run();
  assert.deepEqual(sent.map((command) => command.clientMessageId), [`sched-${created.id}`, `sched-${created.id}-1`]);
  assert.equal(findItem(created.id, NOW), null);
  assert.deepEqual(notes, ["sent"]);
});

test("a check-in the person took back out of the queue disappears quietly", async () => {
  let status = "queued";
  liveChat("chat-taken-back", () => ({ delivery: "queued", clientMessageId: "x" }), ledgerOf(() => ({ status })));
  const takenBack = scheduleFor("chat-taken-back", "never mind");
  const { notes, run } = realRound();
  await run();
  status = "withdrawn";
  await run();
  assert.equal(findItem(takenBack.id, NOW), null);
  assert.deepEqual(notes, [], "taking a message back is not a delivery");
});
