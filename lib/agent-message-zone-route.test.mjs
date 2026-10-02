import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A message carries the zone of the browser that sent it. The route settles
 * which zone the AGENT gets — the person's own choice, else that browser, else
 * where they were last seen — and hands the session only that, never the raw
 * value the client sent.
 */
const root = mkdtempSync(join(tmpdir(), "cody-message-zone-route-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
process.env.TZ = "Australia/Sydney";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/agent/[id]/route.ts");
const users = await jiti.import("./auth/users.ts");
const prefs = await jiti.import("./time-zone-prefs.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");

const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
prefs.setExplicitTimeZone(alice, "Europe/Paris");

/** A live session the route finds in the registry; it records what it was sent. */
function liveSession(id) {
  const sent = [];
  const session = { sessionId: id, cwd: root, isAlive: () => true, isRunning: () => true, send: async (command) => { sent.push(command); return null; } };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return sent;
}

async function post(user, id, body) {
  const response = await route.POST(
    new Request(`http://cody.test/api/agent/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200, await response.clone().text());
}

test("the agent gets the zone of the browser that sent the message, canonicalised", async () => {
  const sent = liveSession("s-bob");
  await post(bob, "s-bob", { type: "steer", message: "where am I", timeZone: "asia/tokyo" });
  assert.equal(sent[0].timeZone, "Asia/Tokyo");
  assert.equal(users.findUserById(bob.id).preferences.deviceTimeZone, "Asia/Tokyo", "and the account remembers where it was last seen");
});

test("a chosen zone beats the browser's, but the browser is still remembered", async () => {
  const sent = liveSession("s-alice");
  await post(alice, "s-alice", { type: "steer", message: "hi", timeZone: "Asia/Tokyo" });
  assert.equal(sent[0].timeZone, "Europe/Paris");
  assert.equal(users.findUserById(alice.id).preferences.deviceTimeZone, "Asia/Tokyo");
});

test("a message with no usable browser zone follows where the account was last seen, and still goes", async () => {
  const sent = liveSession("s-bob-2");
  for (const timeZone of [undefined, "Mars/Phobos", "$(reboot)", 12]) {
    await post(bob, "s-bob-2", { type: "steer", message: "no hint", ...(timeZone === undefined ? {} : { timeZone }) });
  }
  assert.deepEqual(sent.map((command) => command.timeZone), ["Asia/Tokyo", "Asia/Tokyo", "Asia/Tokyo", "Asia/Tokyo"]);
  assert.equal(users.findUserById(bob.id).preferences.deviceTimeZone, "Asia/Tokyo", "garbage never replaces what is known");
});

test("a trip is picked up from the next message", async () => {
  const sent = liveSession("s-bob-3");
  await post(bob, "s-bob-3", { type: "steer", message: "landed", timeZone: "America/New_York" });
  await post(bob, "s-bob-3", { type: "steer", message: "no hint now" });
  assert.deepEqual(sent.map((command) => command.timeZone), ["America/New_York", "America/New_York"]);
});

test("commands that carry no words say nothing about where the user is", async () => {
  const sent = liveSession("s-bob-4");
  const command = { type: "set_thinking_level", level: "high", timeZone: "Pacific/Auckland" };
  await post(bob, "s-bob-4", command);
  assert.deepEqual(sent, [command], "forwarded as sent: the route does not interpret the zone");
  assert.equal(users.findUserById(bob.id).preferences.deviceTimeZone, "America/New_York", "and does not count it as a sighting");
});
