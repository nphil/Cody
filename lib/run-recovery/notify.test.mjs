import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Telling the owner that Cody restarted a chat's engine, gave up, or did not
 * resume a run. The words are pinned in text.test.mjs; what matters here is
 * that it goes out through the same dispatch as every other kind (the `error`
 * kind: its own switch, priority and tags, silent while the owner is looking at
 * the chat), carries the chat's own name, and can never break a recovery.
 * Only the network is stubbed.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-run-recovery-notify-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
after(() => fs.rmSync(root, { recursive: true, force: true }));
process.env.TZ = "UTC";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const notify = await jiti.import("./notify.ts");
const dispatch = await jiti.import("../notifications/dispatch.ts");
const settings = await jiti.import("../notifications/store.ts");
const presence = await jiti.import("../notifications/presence.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const timeZones = await jiti.import("../time-zone-prefs.ts");

const AT = Date.parse("2026-10-09T06:51:00Z");
const STARTED = Date.parse("2026-10-09T06:31:00Z");
const outcome = { kind: "recovered", cause: { kind: "tool", tool: "edit", startedAt: STARTED, quietSince: STARTED, sinceMs: 20 * 60_000 }, at: AT };

function stubNetwork() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
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

const deps = (send, overrides = {}) => ({ zoneFor: () => "America/New_York", describeChat: notify.describeChat, send, ...overrides });

test("the notification is an error kind with the chat's name in the title and the project as a tag", () => {
  const draft = notify.composeRecoveryNotification("chat-1", outcome, { title: "Fix login", project: "my-project" }, "America/New_York");
  assert.equal(draft.event, "error");
  assert.equal(draft.sessionId, "chat-1");
  assert.equal(draft.title, "Error · Fix login");
  assert.equal(draft.body, "Stuck since 2026-10-09 02:31 EDT: `edit` never answered. Cody restarted the engine at 2026-10-09 02:51 EDT and asked the agent to carry on.");
  assert.deepEqual(draft.tags, ["my-project"]);
  assert.deepEqual(notify.composeRecoveryNotification("chat-1", outcome, { title: "Fix login", project: null }, "UTC").tags, []);
});

test("a chat is named by its own file, a chat nobody has named is not nothing, and a missing one is not an error", async () => {
  writeChat("named-chat", "Fix login", "/work/my-project");
  assert.deepEqual(await notify.describeChat("named-chat"), { title: "Fix login", project: "my-project" });
  assert.deepEqual(
    await notify.describeChat("named-chat", { sessionFile: path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project", "named-chat.jsonl") }),
    { title: "Fix login", project: "my-project" },
    "a live session offers its file, so nothing is searched for",
  );
  assert.deepEqual(await notify.describeChat("never-existed"), { title: "Untitled chat", project: null });
});

test("it goes out through dispatch: the error kind's priority and tags, in the owner's zone, with a link to the chat", async () => {
  configure();
  writeChat("chat-1", "Fix login", "/work/my-project");
  timeZones.setExplicitTimeZone(null, "Asia/Tokyo");
  const net = stubNetwork();
  try {
    await notify.notifyRecovery("chat-1", outcome, undefined, deps((draft) => dispatch.sendNotification(draft), { zoneFor: timeZones.ownerTimeZone }));
    await until(net.calls, 1);
    assert.equal(net.calls.length, 1);
    const [{ body }] = net.calls;
    assert.equal(body.title, "Error · Fix login");
    assert.match(body.message, /^Stuck since 2026-10-09 15:31 (JST|UTC\+09:00): `edit` never answered\./, "the owner's zone, not the server's");
    assert.equal(body.priority, 4);
    assert.deepEqual(body.tags, ["x", "my-project"]);
    assert.equal(body.click, "https://cody.test/?session=chat-1");
  } finally {
    net.restore();
    timeZones.setExplicitTimeZone(null, null);
  }
});

test("giving up and not resuming are announced the same way", async () => {
  configure();
  const net = stubNetwork();
  try {
    await notify.notifyRecovery("chat-1", { kind: "gave_up", count: 3 }, undefined, deps((draft) => dispatch.sendNotification(draft)));
    await notify.notifyRecovery("chat-1", { kind: "not_resumed", lastActivityAt: STARTED, at: STARTED + 7 * 3_600_000 }, undefined, deps((draft) => dispatch.sendNotification(draft)));
    await until(net.calls, 2);
    assert.deepEqual(net.calls.map((call) => call.body.message), [
      "Cody restarted this chat's engine 3 times in 12 hours and stopped trying. Open the chat to continue.",
      "Not resumed: Cody restarted 7 hours after this chat last did anything (2026-10-09 02:31 EDT).",
    ]);
  } finally {
    net.restore();
  }
});

test("the owner can switch the kind off, and someone looking at that very chat is not told", async () => {
  configure({ events: { error: { enabled: false } } });
  const net = stubNetwork();
  try {
    await notify.notifyRecovery("chat-1", outcome, undefined, deps((draft) => dispatch.sendNotification(draft)));
    await until(net.calls, 1, 150);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }

  configure({ events: { error: { enabled: true } }, skipWhenViewing: true });
  presence.recordPresence("__instance", "chat-1", Date.now());
  const watching = stubNetwork();
  try {
    await notify.notifyRecovery("chat-1", outcome, undefined, deps((draft) => dispatch.sendNotification(draft)));
    await until(watching.calls, 1, 150);
    assert.equal(watching.calls.length, 0, "they are looking at it");
    await notify.notifyRecovery("chat-elsewhere", outcome, undefined, deps((draft) => dispatch.sendNotification(draft)));
    await until(watching.calls, 1);
    assert.equal(watching.calls.length, 1, "but a chat they are not looking at is announced");
  } finally {
    watching.restore();
  }
});

test("a notification that cannot be sent never breaks the recovery that asked for it", async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => { warned.push(args.join(" ")); };
  try {
    await notify.notifyRecovery("chat-1", outcome, undefined, deps(() => { throw new Error("ntfy is down"); }));
    await notify.notifyRecovery("chat-1", outcome, undefined, deps(() => undefined, { describeChat: async () => { throw new Error("no such chat"); } }));
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 2);
  assert.match(warned[0], /could not send a notification: ntfy is down/);
});
