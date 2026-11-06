import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * A scheduled message is a turn like any other: while a disk is almost full it
 * is not handed to its chat, and no engine is started for it. It is not lost
 * either. The refusal is a delivery that can be tried again, so it goes through
 * the scheduler's own back-off with the gate's plain words recorded on the
 * message, and it is sent when there is room. The real delivery module and the
 * real scheduler run here; the chat is a stand-in and the disk is made up.
 */
const root = mkdtempSync(path.join(tmpdir(), "cody-scheduled-delivery-disk-"));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.TZ = "America/New_York";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { checkHandedOver, deliverScheduledMessage } = await jiti.import("./delivery.ts");
const { findItem, insertItem } = await jiti.import("./store.ts");
const scheduler = await jiti.import("./scheduler.ts");
const gate = await jiti.import("../disk/gate.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");

after(() => gate.configureDiskGateForTests(null));

const NOW = Date.now();
const GiB = 1024 ** 3;

/** The disk: nearly full (3% free) or roomy (half free). Setting it drops the gate's cached reading. */
function disk(state) {
  const availableBytes = state === "full" ? 6 * GiB : 100 * GiB;
  gate.configureDiskGateForTests({ probe: () => ({ totalBytes: 200 * GiB, availableBytes }) });
}

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

/** A live chat in the registry that records what it is sent. */
function liveChat(id) {
  const sent = [];
  (globalThis.__ompSessions ??= new Map()).set(id, {
    sessionId: id,
    cwd: path.join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => false,
    send: async (command) => {
      sent.push(command);
      return { delivery: "started", clientMessageId: command.clientMessageId };
    },
  });
  return sent;
}

const failure = (promise) => promise.then(() => assert.fail("expected the delivery to fail"), (error) => error);

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
  return { clock, notes, deps, run: () => scheduler.runDue(deps) };
}

const scheduleFor = (sessionId, message) => insertItem({ sessionId, accountKey: "", message, mode: "at", dueAt: NOW - 1000, source: "agent" }, NOW).item;

test("a nearly full disk refuses the delivery as one worth trying again, in the gate's words, and starts nothing", async () => {
  const sent = liveChat("chat-live");
  disk("full");

  const raised = await failure(deliverScheduledMessage(item({ sessionId: "chat-live" })));
  assert.equal(raised.name, "ScheduledDeliveryError");
  assert.equal(raised.retryable, true, "room can be made: the janitor runs every hour and a person may clean up");
  assert.match(raised.message, /^The server's temporary disk space is almost full \(3% free: 6\.0 GB of 200 GB\)/);
  assert.match(raised.message, /Settings → System → Disk space/);
  assert.deepEqual(sent, [], "the chat was not handed anything");

  // No engine is started for it either: a chat that does not exist would otherwise be a final failure, found by trying to start one.
  const unknown = await failure(deliverScheduledMessage(item({ sessionId: "chat-not-started" })));
  assert.equal(unknown.retryable, true);
  assert.match(unknown.message, /almost full/, "the disk is asked before anything is acquired");
  assert.equal(globalThis.__ompSessions.has("chat-not-started"), false);

  disk("roomy");
  await deliverScheduledMessage(item({ sessionId: "chat-live" }));
  assert.equal(sent.length, 1, "with room it goes as it always did");
  assert.equal(sent[0].streamingBehavior, "followUp");
});

test("the scheduler waits on its usual back-off with the words on the message, and sends it once there is room", async () => {
  const sent = liveChat("chat-waits");
  const created = scheduleFor("chat-waits", "check in on the run");
  const { clock, notes, run } = realRound();

  disk("full");
  await run();
  const waiting = findItem(created.id, NOW);
  assert.equal(waiting.status, "pending", "not failed, not lost");
  assert.equal(waiting.attempts, 1);
  assert.equal(waiting.notBefore, NOW + scheduler.RETRY_DELAYS_MS[0], "the same back-off as any other delivery that could not be handed over");
  assert.match(waiting.error, /^The server's temporary disk space is almost full/, "the reason is recorded in full, not cut at the scheduler's 300 characters");
  assert.ok(waiting.error.endsWith("then send again."));
  assert.deepEqual(notes, [], "a wait is not announced");

  await run();
  assert.deepEqual(sent, [], "not before the back-off has passed");

  disk("roomy");
  clock.now += scheduler.RETRY_DELAYS_MS[0];
  await run();
  assert.deepEqual(sent.map((command) => command.message), ["check in on the run"]);
  assert.equal(findItem(created.id, NOW), null, "sent, and gone from the schedule");
  assert.deepEqual(notes, ["sent"]);
});

test("a disk that stays full uses up the back-off like any other failure, and the person is told once, with the reason", async () => {
  const sent = liveChat("chat-stays-full");
  const created = scheduleFor("chat-stays-full", "run the nightly report");
  const { clock, notes, run } = realRound();
  disk("full");

  for (let attempt = 1; attempt <= scheduler.MAX_ATTEMPTS; attempt += 1) {
    await run();
    clock.now += scheduler.RETRY_DELAYS_MS[attempt - 1] ?? 0;
  }
  const failed = findItem(created.id, NOW);
  assert.equal(failed.status, "failed", "after the last try it is the person's: Retry, Edit or Cancel");
  assert.equal(failed.attempts, scheduler.MAX_ATTEMPTS);
  assert.match(failed.error, /almost full/);
  assert.deepEqual(sent, [], "not one attempt reached the chat");
  assert.deepEqual(notes, ["failed"], "told once");
});

test("Send now on a full disk fails at once with the reason, for the person who pressed it to read", async () => {
  const sent = liveChat("chat-send-now");
  const created = scheduleFor("chat-send-now", "go now");
  const { deps, notes } = realRound();
  disk("full");

  assert.equal(await scheduler.fireItem(created.id, null, deps, { manual: true }), "failed", "nobody is retrying in the background for a person who is looking");
  const failed = findItem(created.id, NOW);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /almost full/);
  assert.deepEqual(sent, []);
  assert.deepEqual(notes, [], "and no notification: they are looking");
});

test("a copy that already reached the chat is still found on a full disk: finding it writes nothing", async () => {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(NOW - 30_000).toISOString();
  fs.writeFileSync(path.join(dir, "chat-copy.jsonl"), [
    JSON.stringify({ type: "session", version: 3, id: "chat-copy", cwd: "/proj", title: "t", created: "2026-01-01", modified: "2026-01-01" }),
    JSON.stringify({ id: "e0", parentId: null, type: "message", timestamp: at, message: { role: "user", content: "carry on with the migration" } }),
  ].join("\n") + "\n");
  invalidateSessionListCache();
  const sent = liveChat("chat-copy");
  disk("full");

  const result = await deliverScheduledMessage(item({ sessionId: "chat-copy", attempts: 1, firstAttemptAt: NOW - 60_000 }));
  assert.equal(result, "delivered");
  assert.deepEqual(sent, [], "and nothing is sent a second time");
});
