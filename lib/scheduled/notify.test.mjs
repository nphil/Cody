import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * "A scheduled message was sent / could not be" reaches the owner through the
 * same dispatch as every other kind: its own switch, its own priority, the chat
 * link, and silence while they are looking at that chat. Only the network is
 * stubbed.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-scheduled-notify-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.TZ = "UTC";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const notify = await jiti.import("./notify.ts");
const catalog = await jiti.import("../notifications/catalog.ts");
const compose = await jiti.import("../notifications/compose.ts");
const settings = await jiti.import("../notifications/store.ts");
const presence = await jiti.import("../notifications/presence.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const timeZones = await jiti.import("../time-zone-prefs.ts");

const NOW = Date.parse("2026-10-06T03:40:00Z");
const item = (overrides = {}) => ({
  id: "sch_abc123",
  sessionId: "chat-1",
  accountKey: "",
  message: "Continue with the migration, then run the tests and tell me what failed.",
  mode: "at",
  dueAt: NOW,
  source: "user",
  status: "sending",
  createdAt: NOW - 3_600_000,
  updatedAt: NOW,
  rev: 1,
  deliveryNo: 0,
  attempts: 0,
  ...overrides,
});

function stubNetwork() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function until(calls, count, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (calls.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return calls;
}

const configure = (patch = {}) =>
  settings.updateNotificationPrefs("__instance", { enabled: true, server: "https://ntfy.test", topic: "mytopic", codyUrl: "https://cody.test", ...patch });

function writeChat(id, title, cwd) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, cwd, title, created: "2026-01-01", modified: "2026-01-01" })}\n`);
  invalidateSessionListCache();
}

test("the kind exists, is on by default under Progress at the default priority, and every kind still has a title and a tag", () => {
  const spec = catalog.NOTIFICATION_EVENTS.find((entry) => entry.id === "scheduled");
  assert.ok(spec, "in the catalog");
  assert.equal(spec.group, "progress");
  assert.equal(spec.defaultEnabled, true);
  assert.equal(spec.defaultPriority, 3);
  assert.equal(spec.scope, "session", "suppressed while you look at that very chat");
  assert.deepEqual(catalog.defaultNotificationPrefs().events.scheduled, { enabled: true, priority: 3 });
  assert.equal(compose.EVENT_TITLES.scheduled, "Scheduled message");
  assert.ok(compose.EVENT_TAGS.scheduled);
  assert.ok(catalog.NOTIFICATION_EVENT_IDS.includes("scheduled"));
});

test("what a sent and a failed notification say, in the owner's zone, with the message clipped to a line", () => {
  const chat = { title: "Fix login" };
  const sent = notify.composeScheduledNotification({ kind: "sent", item: item() }, chat, "America/New_York", NOW);
  assert.equal(sent.title, "Scheduled message · Fix login");
  assert.equal(sent.body, "Sent 2026-10-05 23:40 EDT: Continue with the migration, then run the tests and tell me what failed.");

  const failed = notify.composeScheduledNotification({ kind: "failed", item: item(), reason: "The chat this message was scheduled for no longer exists." }, chat, "UTC", NOW);
  assert.equal(failed.title, "Scheduled message · Fix login");
  assert.equal(failed.body, "Could not send: The chat this message was scheduled for no longer exists.\nContinue with the migration, then run the tests and tell me what failed.\nOpen the chat to retry or cancel it.");

  const long = notify.composeScheduledNotification({ kind: "sent", item: item({ message: `line one\n\n${"x".repeat(400)}` }) }, chat, "UTC", NOW);
  assert.ok(!long.body.includes("\n"), "one line");
  assert.ok(long.body.length < 200, "a preview, not the whole message");
});

test("the notification goes out through dispatch: its own kind, tags, priority and a link to the chat", async () => {
  configure();
  writeChat("chat-1", "Fix login", "/work/my-project");
  timeZones.setExplicitTimeZone(null, "Asia/Tokyo");
  const net = stubNetwork();
  try {
    await notify.notifyScheduledOutcome({ kind: "sent", item: item() }, { now: () => NOW });
    await until(net.calls, 1);
    assert.equal(net.calls.length, 1);
    const [{ body }] = net.calls;
    assert.equal(body.title, "Scheduled message · Fix login");
    assert.match(body.message, /^Sent 2026-10-06 12:40 JST?|^Sent 2026-10-06 12:40 UTC\+09:00: Continue with the migration/, "the owner's zone, not the server's");
    assert.equal(body.priority, 3);
    assert.deepEqual(body.tags, ["alarm_clock", "my-project"]);
    assert.equal(body.click, "https://cody.test/?session=chat-1");
  } finally {
    net.restore();
    timeZones.setExplicitTimeZone(null, null);
  }
});

test("a failure is announced the same way, once, with the reason", async () => {
  configure();
  const net = stubNetwork();
  try {
    await notify.notifyScheduledOutcome({ kind: "failed", item: item(), reason: "The session stopped responding." }, { now: () => NOW });
    await until(net.calls, 1);
    assert.equal(net.calls.length, 1);
    assert.match(net.calls[0].body.message, /^Could not send: The session stopped responding\./);
  } finally {
    net.restore();
  }
});

test("the owner can switch the kind off, and then nothing is published", async () => {
  configure({ events: { scheduled: { enabled: false } } });
  const net = stubNetwork();
  try {
    await notify.notifyScheduledOutcome({ kind: "sent", item: item() });
    await until(net.calls, 1, 150);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
  configure({ events: { scheduled: { enabled: true } } });
});

test("someone looking at that very chat is not told: they watched it arrive", async () => {
  configure({ skipWhenViewing: true });
  presence.recordPresence("__instance", "chat-1", Date.now());
  const net = stubNetwork();
  try {
    await notify.notifyScheduledOutcome({ kind: "sent", item: item() });
    await until(net.calls, 1, 150);
    assert.equal(net.calls.length, 0, "viewing this chat");
    await notify.notifyScheduledOutcome({ kind: "sent", item: item({ sessionId: "chat-elsewhere" }) });
    await until(net.calls, 1);
    assert.equal(net.calls.length, 1, "but a chat they are not looking at is announced");
  } finally {
    net.restore();
  }
});

test("a chat nobody has named yet is described by its message, never as nothing", async () => {
  const chat = await jiti.import("./notify.ts").then(() => null);
  assert.equal(chat, null);
  configure();
  const net = stubNetwork();
  try {
    await notify.notifyScheduledOutcome({ kind: "sent", item: item({ sessionId: "unnamed-chat", message: "Deploy the staging build and smoke test it" }) });
    await until(net.calls, 1);
    assert.equal(net.calls[0].body.title, "Scheduled message · Deploy the staging build and smoke test it");
  } finally {
    net.restore();
  }
});

test("a failure to notify never reaches the caller", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await notify.notifyScheduledOutcome({ kind: "sent", item: item() }, { describeChat: async () => { throw new Error("disk on fire"); } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not send a notification: disk on fire/);
  } finally {
    console.warn = original;
  }
});
