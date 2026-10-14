import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * GET/PUT /api/daily-limit and POST /api/daily-limit/beat: who may call them,
 * which zone the day is read in, what a bad body answers, and that one beat can
 * never add more than its cap.
 */
const root = mkdtempSync(join(tmpdir(), "cody-daily-limit-routes-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.TZ = "UTC";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

let counter = 0;
/** A new accounts directory, so a test starts as a fresh open instance. */
function fresh() {
  const dir = join(root, `t${counter++}`, "accounts");
  process.env.CODY_ACCOUNTS_DIR = dir;
  return join(dir, "daily-limit.json");
}
fresh();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const limitRoute = await jiti.import("../../app/api/daily-limit/route.ts");
const beatRoute = await jiti.import("../../app/api/daily-limit/beat/route.ts");
const users = await jiti.import("../auth/users.ts");
const prefs = await jiti.import("../time-zone-prefs.ts");
const { localDayKey } = await jiti.import("./ledger.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");

const URL_BASE = "http://cody.test/api/daily-limit";

function cookieHeader(user) {
  return user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {};
}

function get(user, query = "") {
  return limitRoute.GET(new Request(`${URL_BASE}${query}`, { headers: cookieHeader(user) }));
}

function send(handler, url, user, body, raw = false) {
  return handler(
    new Request(url, {
      method: handler === limitRoute.PUT ? "PUT" : "POST",
      headers: { "Content-Type": "application/json", ...cookieHeader(user) },
      body: raw ? body : JSON.stringify(body),
    }),
  );
}
const put = (user, body, raw) => send(limitRoute.PUT, URL_BASE, user, body, raw);
const beat = (user, body, raw) => send(beatRoute.POST, `${URL_BASE}/beat`, user, body, raw);

async function ok(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

test("an open instance answers without any cookie, off by default, and never caches", async () => {
  fresh();
  const s = await ok(await get(null, "?timeZone=UTC"));
  assert.equal(s.enabled, false);
  assert.equal(s.limitMinutes, 120);
  assert.equal(s.usedSeconds, 0);
  assert.equal(s.zone, "UTC");
  assert.equal(s.day, localDayKey(Date.now(), "UTC"));
});

test("PUT on an open instance saves, and GET reads it back", async () => {
  fresh();
  const saved = await ok(await put(null, { enabled: true, limitMinutes: 90 }));
  assert.equal(saved.enabled, true);
  assert.equal(saved.limitMinutes, 90);
  const read = await ok(await get(null));
  assert.equal(read.enabled, true);
  assert.equal(read.limitMinutes, 90);
});

test("once an account exists, a call with no cookie is a 401 with a JSON body", async () => {
  fresh();
  users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const calls = [get(null), put(null, { enabled: true }), beat(null, { activeSeconds: 10 })];
  for (const response of await Promise.all(calls)) {
    assert.equal(response.status, 401);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("a signed-in user has their own settings and ledger", async () => {
  const file = fresh();
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
  await ok(await put(alice, { enabled: true, limitMinutes: 60 }));
  await ok(await beat(alice, { activeSeconds: 30 }));

  const forAlice = await ok(await get(alice));
  assert.equal(forAlice.enabled, true);
  assert.equal(forAlice.limitMinutes, 60);
  assert.ok(forAlice.usedSeconds <= 30 && forAlice.usedSeconds > 0);

  const forBob = await ok(await get(bob));
  assert.equal(forBob.enabled, false);
  assert.equal(forBob.usedSeconds, 0);
  assert.ok(existsSync(file));
  assert.ok(!(readFileSync(file, "utf8")).includes("password"));
});

test("GET follows ?timeZone= when no zone was chosen", async () => {
  fresh();
  const s = await ok(await get(null, "?timeZone=Asia/Tokyo"));
  assert.equal(s.zone, "Asia/Tokyo");
  assert.equal(s.day, localDayKey(s.serverNow, "Asia/Tokyo"));
  assert.equal(s.dayStartsAt <= s.serverNow && s.serverNow < s.dayEndsAt, true);
});

test("the zone a person chose beats the query and the body zone", async () => {
  fresh();
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  prefs.setExplicitTimeZone(alice, "Europe/Paris");
  assert.equal((await ok(await get(alice, "?timeZone=Asia/Tokyo"))).zone, "Europe/Paris");
  assert.equal((await ok(await put(alice, { enabled: true, timeZone: "Asia/Tokyo" }))).zone, "Europe/Paris");
  assert.equal((await ok(await beat(alice, { activeSeconds: 5, timeZone: "America/New_York" }))).zone, "Europe/Paris");

  const instance = fresh();
  assert.ok(instance);
  prefs.setExplicitTimeZone(null, "Pacific/Auckland");
  assert.equal((await ok(await get(null, "?timeZone=Asia/Tokyo"))).zone, "Pacific/Auckland");
});

test("PUT zone and beat zone are used when nothing was chosen", async () => {
  fresh();
  assert.equal((await ok(await put(null, { enabled: true, timeZone: "Asia/Tokyo" }))).zone, "Asia/Tokyo");
  assert.equal((await ok(await beat(null, { activeSeconds: 5, timeZone: "America/New_York" }))).zone, "America/New_York");
});

test("PUT answers 400 invalid_daily_limit with a message for a bad value", async () => {
  const file = fresh();
  for (const body of [{ limitMinutes: 4 }, { limitMinutes: 1441 }, { limitMinutes: 90.5 }, { limitMinutes: "60" }, { enabled: "yes" }, { addMinutes: 0 }, { addMinutes: 241 }, { dismissNotice: false }, {}, []]) {
    const response = await put(null, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.headers.get("cache-control"), "no-store");
    const json = await response.json();
    assert.equal(json.code, "invalid_daily_limit");
    assert.equal(typeof json.error, "string");
    assert.ok(json.error.length > 0);
  }
  assert.equal(existsSync(file), false, "nothing was written");
});

test("PUT answers 400 invalid_body for a body that is not JSON, or over 1 KB", async () => {
  const file = fresh();
  for (const raw of ["not json", "", "{", `{"enabled":true,"pad":"${"x".repeat(2000)}"}`]) {
    const response = await put(null, raw, true);
    assert.equal(response.status, 400, raw.slice(0, 20));
    assert.equal((await response.json()).code, "invalid_body");
  }
  assert.equal(existsSync(file), false);
});

test("addMinutes and dismissNotice go through PUT", async () => {
  fresh();
  await ok(await put(null, { enabled: true, limitMinutes: 60 }));
  const added = await ok(await put(null, { addMinutes: 15 }));
  assert.equal(added.extraSeconds, 900);
  assert.equal(added.limitSeconds, 4500);
  const dismissed = await ok(await put(null, { dismissNotice: true }));
  assert.equal(dismissed.noticeDue, false);
});

test("a beat returns today's state with the stretch counted", async () => {
  fresh();
  await ok(await put(null, { enabled: true, timeZone: "UTC" }));
  const s = await ok(await beat(null, { activeSeconds: 30, endedSecondsAgo: 0, timeZone: "UTC" }));
  assert.equal(s.enabled, true);
  assert.equal(s.day, localDayKey(s.serverNow, "UTC"));
  assert.ok(s.usedSeconds > 0 && s.usedSeconds <= 30, `used ${s.usedSeconds}`);
  assert.equal(s.limitSeconds, 7200);
  assert.equal(s.remainingSeconds, s.limitSeconds - s.usedSeconds);
});

test("one beat is capped at 90 seconds", async () => {
  fresh();
  await ok(await put(null, { enabled: true, timeZone: "UTC" }));
  const s = await ok(await beat(null, { activeSeconds: 500, timeZone: "UTC" }));
  assert.ok(s.usedSeconds <= 90, `used ${s.usedSeconds}`);
  assert.ok(s.usedSeconds > 0);
});

test("a beat while the limit is off answers enabled:false and records nothing", async () => {
  const file = fresh();
  const s = await ok(await beat(null, { activeSeconds: 30 }));
  assert.equal(s.enabled, false);
  assert.equal(s.usedSeconds, 0);
  assert.equal(existsSync(file), false);
});

test("a malformed beat is a 400 invalid_beat", async () => {
  const file = fresh();
  await ok(await put(null, { enabled: true }));
  const before = readFileSync(file, "utf8");
  const bodies = [
    {},
    { activeSeconds: 0 },
    { activeSeconds: -5 },
    { activeSeconds: "30" },
    { activeSeconds: null },
    { activeSeconds: 30, endedSecondsAgo: -1 },
    { activeSeconds: 30, endedSecondsAgo: "5" },
    "5",
    [],
    null,
  ];
  for (const body of bodies) {
    const response = await beat(null, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).code, "invalid_beat", JSON.stringify(body));
  }
  // NaN and Infinity are not JSON; they arrive as null, which is refused above.
  const nan = await beat(null, '{"activeSeconds": NaN}', true);
  assert.equal(nan.status, 400);
  assert.equal(readFileSync(file, "utf8"), before, "nothing was recorded");
});

test("a beat over 1 KB or not JSON is a 400 invalid_body", async () => {
  fresh();
  for (const raw of ["nope", `{"activeSeconds":5,"pad":"${"y".repeat(2000)}"}`]) {
    const response = await beat(null, raw, true);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_body");
  }
});

test("a beat's content type is not checked (sendBeacon sends text/plain)", async () => {
  fresh();
  await ok(await put(null, { enabled: true }));
  const response = await beatRoute.POST(
    new Request(`${URL_BASE}/beat`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ activeSeconds: 10 }) }),
  );
  const s = await ok(response);
  assert.ok(s.usedSeconds > 0);
});
