import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The HTTP surface Settings talks to — read, write, test, report presence — and
 * the one public hole in the perimeter. The routes are driven directly, as
 * lib/agent-message-zone-route.test.mjs drives its route.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-routes-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const settings = await jiti.import("../../app/api/notifications/route.ts");
const testRoute = await jiti.import("../../app/api/notifications/test/route.ts");
const presenceRoute = await jiti.import("../../app/api/notifications/presence/route.ts");
const catalog = await jiti.import("./catalog.ts");
const store = await jiti.import("./store.ts");
const presence = await jiti.import("./presence.ts");
const users = await jiti.import("../auth/users.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");
const { NextRequest } = await jiti.import("next/server");
const { proxy } = await jiti.import("../../proxy.ts");

const request = (path, method, body, headers = {}) =>
  new Request(`http://cody.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const as = (user) => ({ Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` });
const get = async (headers) => {
  const response = await settings.GET(request("/api/notifications", "GET", undefined, headers));
  return { status: response.status, response, body: await response.clone().json() };
};
const put = async (body, headers) => {
  const response = await settings.PUT(request("/api/notifications", "PUT", body, headers));
  return { status: response.status, body: await response.json() };
};

// ---------------------------------------------------------------------------
// An open instance (no accounts): whoever is looking is the administrator
// ---------------------------------------------------------------------------

test("GET answers the actor's prefs and the defaults, and never the token", async () => {
  const { status, response, body } = await get();
  assert.equal(status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(body).sort(), ["defaults", "prefs"]);
  assert.equal(body.prefs.hasToken, false);
  assert.equal("token" in body.prefs, false);
  assert.equal("token" in body.defaults, false);
  const expectedDefaults = { ...catalog.defaultNotificationPrefs(), hasToken: false };
  delete expectedDefaults.token;
  assert.deepEqual(body.defaults, expectedDefaults);
  assert.deepEqual(body.prefs, body.defaults, "nothing saved yet");
});

test("PUT saves, answers the saved record, and the token goes in but never comes back out", async () => {
  const secret = "tk_this_must_never_be_echoed";
  const saved = await put({ enabled: true, server: "https://ntfy.example.com/", topic: "alerts", token: secret, codyUrl: "https://cody.example.net" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.prefs.server, "https://ntfy.example.com", "normalized");
  assert.equal(saved.body.prefs.hasToken, true);
  assert.equal(JSON.stringify(saved.body).includes(secret), false);

  const read = await get();
  assert.equal(JSON.stringify(read.body).includes(secret), false, "not in GET either");
  assert.equal(read.body.prefs.topic, "alerts");
  assert.equal(read.body.prefs.hasToken, true);
  assert.equal(store.readNotificationPrefs("__instance").token, secret, "but it IS stored, for the server's own use");
});

test("PUT is a patch: unmentioned settings keep their value, events merge, the token keeps or clears", async () => {
  await put({ events: { approval: { priority: 5 } }, finishedMinSeconds: 120 });
  const kept = await get();
  assert.equal(kept.body.prefs.topic, "alerts");
  assert.equal(kept.body.prefs.finishedMinSeconds, 120);
  assert.equal(kept.body.prefs.events.approval.priority, 5);
  assert.equal(kept.body.prefs.events.approval.enabled, true);
  assert.equal(kept.body.prefs.hasToken, true, "absent token: kept");
  assert.equal((await put({ token: null })).body.prefs.hasToken, false, "null clears");
  assert.equal((await put({})).body.prefs.topic, "alerts", "an empty patch is a harmless read");
});

test("PUT refuses anything invalid with a 400 and the invalid_notification_settings code, saving nothing", async () => {
  const before = (await get()).body.prefs;
  for (const patch of [
    { server: "ftp://nope" },
    { server: "https://user:pw@ntfy.example.com" },
    { topic: "has space" },
    { finishedMinSeconds: -5 },
    { quotaLowPercent: 100 },
    { events: { approval: { priority: 9 } } },
    { events: { nonsense: {} } },
    { token: "x".repeat(600) },
    { enabled: "yes" },
    { mystery: true },
    [],
    '"just text"',
  ]) {
    const result = await put(patch);
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.equal(result.body.code, "invalid_notification_settings");
    assert.equal(typeof result.body.error, "string");
    assert.ok(result.body.error.length > 0);
  }
  assert.deepEqual((await get()).body.prefs, before);
});

test("PUT with a body that is not JSON, or is too large, is invalid_body", async () => {
  for (const body of ["{ not json", JSON.stringify({ topic: "x", filler: "y".repeat(9_000) })]) {
    const result = await put(body);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_body");
  }
});

// ---------------------------------------------------------------------------
// Test notification
// ---------------------------------------------------------------------------

async function fakeNtfy(respond) {
  const requests = [];
  const server = http.createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push({ method: incoming.method, path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") });
      respond(outgoing);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const accept = (outgoing) => { outgoing.writeHead(200, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ id: "t1" })); };
const postTest = async (headers, body) => {
  const response = await testRoute.POST(request("/api/notifications/test", "POST", body, headers));
  return { status: response.status, body: await response.json() };
};

test("the test needs a saved server and topic, and says so", async () => {
  store.updateNotificationPrefs("__instance", { server: "", topic: "" });
  const result = await postTest();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: false, error: "Save an ntfy server and a topic first." });
});

test("the test publishes 'Test from Cody' with an Open Cody button, from the SAVED settings, even with notifications switched off", async () => {
  const ntfy = await fakeNtfy(accept);
  try {
    store.updateNotificationPrefs("__instance", { enabled: false, server: ntfy.url, topic: "alerts", token: "tk_test", codyUrl: "https://cody.example.net" });
    const result = await postTest({}, { server: "http://elsewhere.invalid", topic: "ignored" });
    assert.deepEqual(result, { status: 200, body: { ok: true } });
    assert.equal(ntfy.requests.length, 1);
    const [seen] = ntfy.requests;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/");
    assert.equal(seen.headers.authorization, "Bearer tk_test");
    const body = JSON.parse(seen.body);
    assert.equal(body.topic, "alerts", "the saved topic, not the one in the request body");
    assert.equal(body.title, "Test from Cody");
    assert.equal(body.priority, 3);
    assert.equal(body.click, "https://cody.example.net");
    assert.deepEqual(body.actions, [{ action: "view", label: "Open Cody", url: "https://cody.example.net" }]);
  } finally {
    await ntfy.close();
  }
});

test("without Cody's address the test has no link or button", async () => {
  const ntfy = await fakeNtfy(accept);
  try {
    store.updateNotificationPrefs("__instance", { server: ntfy.url, topic: "alerts", codyUrl: "", token: null });
    assert.equal((await postTest()).body.ok, true);
    const body = JSON.parse(ntfy.requests[0].body);
    assert.equal("click" in body, false);
    assert.equal("actions" in body, false);
    assert.equal(ntfy.requests[0].headers.authorization, undefined);
  } finally {
    await ntfy.close();
  }
});

test("a refusal comes back in ntfy's own words with its status; an unreachable server with the reason", async () => {
  const ntfy = await fakeNtfy((outgoing) => {
    outgoing.writeHead(403, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ code: 40301, http: 403, error: "forbidden" }));
  });
  store.updateNotificationPrefs("__instance", { server: ntfy.url, topic: "locked" });
  try {
    assert.deepEqual(await postTest(), { status: 200, body: { ok: false, error: "forbidden", status: 403 } });
  } finally {
    await ntfy.close();
  }
  const refused = await postTest();
  assert.equal(refused.status, 200);
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /Could not reach the ntfy server/);
  assert.equal("status" in refused.body, false);
});

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

const postPresence = async (body, headers) => {
  const response = await presenceRoute.POST(request("/api/notifications/presence", "POST", body, headers));
  return { status: response.status, body: await response.json() };
};

test("presence records the chat on screen for the actor, and null clears it", async () => {
  assert.deepEqual(await postPresence({ sessionId: "chat-1" }), { status: 200, body: { ok: true } });
  assert.equal(presence.isViewing("__instance", "chat-1"), true);
  assert.equal(presence.isViewing("__instance", "chat-2"), false);
  assert.deepEqual(await postPresence({ sessionId: null }), { status: 200, body: { ok: true } });
  assert.equal(presence.isViewing("__instance", "chat-1"), false);
});

test("presence takes a beacon: whatever content type the page's sendBeacon sent", async () => {
  const response = await presenceRoute.POST(request("/api/notifications/presence", "POST", JSON.stringify({ sessionId: "chat-3" }), { "Content-Type": "text/plain;charset=UTF-8" }));
  assert.equal(response.status, 200);
  assert.equal(presence.isViewing("__instance", "chat-3"), true);
  presence.recordPresence("__instance", null);
});

test("presence refuses a body that is not a chat id or null", async () => {
  for (const body of [{}, { sessionId: 5 }, { sessionId: "" }, { sessionId: "x".repeat(201) }, { sessionId: ["a"] }, [], "nope", JSON.stringify({ sessionId: "x", pad: "y".repeat(2_000) })]) {
    const result = await postPresence(body);
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(typeof result.body.code, "string");
  }
  assert.equal((await postPresence({ sessionId: "x".repeat(200) })).status, 200, "200 characters is fine");
  presence.recordPresence("__instance", null);
});

// ---------------------------------------------------------------------------
// With accounts: each person has their own, and signed-out is refused
// ---------------------------------------------------------------------------

test("with accounts, every route needs a signed-in account, and each account sees only its own settings and presence", async () => {
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });

  // Signed out.
  assert.equal((await get()).status, 401);
  assert.equal((await put({ topic: "x" })).status, 401);
  assert.equal((await postTest()).status, 401);
  assert.equal((await postPresence({ sessionId: "c" })).status, 401);
  assert.equal((await get()).body.code, "auth_required");

  // Each account has its own record.
  assert.equal((await put({ topic: "alice_topic", token: "tk_alice", enabled: true }, as(alice))).status, 200);
  assert.equal((await put({ topic: "bob_topic" }, as(bob))).status, 200, "a member configures their own");
  const aliceView = (await get(as(alice))).body.prefs;
  const bobView = (await get(as(bob))).body.prefs;
  assert.equal(aliceView.topic, "alice_topic");
  assert.equal(aliceView.hasToken, true);
  assert.equal(bobView.topic, "bob_topic");
  assert.equal(bobView.hasToken, false, "Bob cannot see, or inherit, Alice's token");
  assert.equal(bobView.enabled, false);
  assert.equal(store.readNotificationPrefs(alice.id).topic, "alice_topic");

  // Presence is per account.
  assert.equal((await postPresence({ sessionId: "shared-chat" }, as(alice))).status, 200);
  assert.equal(presence.isViewing(alice.id, "shared-chat"), true);
  assert.equal(presence.isViewing(bob.id, "shared-chat"), false);
  assert.equal(presence.isViewing("__instance", "shared-chat"), false);
});

// ---------------------------------------------------------------------------
// The perimeter
// ---------------------------------------------------------------------------

test("the answer-button route is public, every other notifications route is not", () => {
  // Accounts exist now (the previous test), so the perimeter is armed.
  const send = (path, init) => proxy(new NextRequest(`http://localhost:3000${path}`, init));
  assert.equal(send("/api/notifications/action", { method: "POST" }).status, 200, "the ntfy app has no cookie");
  assert.equal(send("/api/notifications/action", { method: "OPTIONS" }).status, 200, "nor does a preflight");
  for (const path of ["/api/notifications", "/api/notifications/test", "/api/notifications/presence", "/api/notifications/action/extra"]) {
    assert.equal(send(path, { method: "POST" }).status, 401, path);
  }
});

test("a cross-site browser call to the answer route is let through, because it carries nothing to forge", () => {
  // ntfy's web app calls from its own origin, with no cookie.
  const response = proxy(new NextRequest("http://localhost:3000/api/notifications/action", {
    method: "POST",
    headers: { Origin: "https://ntfy.example.com", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
  }));
  assert.equal(response.status, 200);
  // The same call WITH a session cookie is still the cross-site request the guard exists to stop.
  const alice = users.findUserByUsername("alice");
  const forged = proxy(new NextRequest("http://localhost:3000/api/notifications/action", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", Cookie: as(alice).Cookie },
  }));
  assert.equal(forged.status, 403);
});
