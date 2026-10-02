import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Where a person's time zone lives and which one wins. Accounts keep their own
 * (a chosen zone, and the last browser seen); an instance with no accounts
 * keeps one instance-level record the same way.
 */
const accountsDir = mkdtempSync(join(tmpdir(), "cody-time-zone-prefs-"));
process.env.CODY_ACCOUNTS_DIR = accountsDir;
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
process.env.TZ = "Australia/Sydney";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const users = await jiti.import("./auth/users.ts");
const owners = await jiti.import("./auth/session-owners.ts");
const prefs = await jiti.import("./time-zone-prefs.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");
const route = await jiti.import("../app/api/time-zone/route.ts");

const call = (method, body, cookie) => route[method](new Request("http://cody.test/api/time-zone", {
  method,
  headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

// ---------------------------------------------------------------------------
// An open instance runs first: creating the first account locks it.
// ---------------------------------------------------------------------------

test("an instance with no accounts keeps one instance-level zone, exactly as an account keeps its own", async () => {
  assert.equal(users.hasAnyUser(), false);
  const fresh = await (await call("GET")).json();
  assert.deepEqual(fresh, { zone: "Australia/Sydney", source: "server", explicit: null, deviceZone: null, serverZone: "Australia/Sydney" }, "nothing saved: the server's zone");

  const seen = await (await call("PUT", { deviceTimeZone: "Asia/Tokyo" })).json();
  assert.deepEqual([seen.zone, seen.source, seen.deviceZone], ["Asia/Tokyo", "last-seen", "Asia/Tokyo"]);

  const chosen = await call("PUT", { timeZone: "Europe/Paris" });
  assert.equal(chosen.status, 200);
  assert.deepEqual([(await chosen.json()).zone], ["Europe/Paris"], "a chosen zone beats the last device seen");
  assert.equal(existsSync(join(accountsDir, "time-zone.json")), true, "persisted in the accounts directory");
  assert.deepEqual(JSON.parse(readFileSync(join(accountsDir, "time-zone.json"), "utf8")), { version: 1, explicit: "Europe/Paris", deviceZone: "Asia/Tokyo" });

  const back = await (await call("PUT", { timeZone: null })).json();
  assert.deepEqual([back.zone, back.explicit], ["Asia/Tokyo", null], "Automatic again: the device last seen");
});

test("a zone this server does not know is refused, and the previous choice survives", async () => {
  await call("PUT", { timeZone: "Europe/Paris" });
  for (const bad of ["Nowhere/Land", "+05:00", "../../etc/localtime", "", 42]) {
    const response = await call("PUT", { timeZone: bad });
    assert.equal(response.status, 400, `${JSON.stringify(bad)}`);
    assert.equal((await response.json()).code, "invalid_time_zone");
  }
  assert.equal(prefs.readTimeZonePrefs(null).explicit, "Europe/Paris");

  // A device zone is a hint the page reports unasked: a bad one is ignored, not an error.
  const hint = await call("PUT", { deviceTimeZone: "garbage" });
  assert.equal(hint.status, 200);
  assert.equal((await hint.json()).deviceZone, "Asia/Tokyo");
  assert.equal((await call("PUT", {})).status, 400, "an empty save is a client bug");
  await call("PUT", { timeZone: null });
});

test("a message's zone: chosen beats this device beats last seen beats the server beats UTC", () => {
  const user = users.createUser({ username: "precedence", fullName: "Precedence", passwordHash: "x", role: "member" });
  const zone = (device) => prefs.effectiveTimeZone(users.findUserById(user.id), device);

  assert.deepEqual(zone(undefined), { zone: "Australia/Sydney", source: "server" }, "no choice, no device, never seen: the server's zone");
  prefs.noteDeviceTimeZone(users.findUserById(user.id), "Pacific/Auckland");
  assert.deepEqual(zone(undefined), { zone: "Pacific/Auckland", source: "last-seen" }, "a message with no browser zone follows where they were last seen");
  assert.deepEqual(zone("Asia/Tokyo"), { zone: "Asia/Tokyo", source: "device" }, "the browser sending THIS message beats where they were last seen");
  prefs.setExplicitTimeZone(users.findUserById(user.id), "Europe/Paris");
  assert.deepEqual(zone("Asia/Tokyo"), { zone: "Europe/Paris", source: "explicit" }, "a chosen zone beats the device");
  assert.deepEqual(zone("not a zone"), { zone: "Europe/Paris", source: "explicit" });
  prefs.setExplicitTimeZone(users.findUserById(user.id), null);
  assert.deepEqual(zone("not a zone"), { zone: "Pacific/Auckland", source: "last-seen" }, "a bad browser value is skipped, never trusted");
});

test("a message saves the browser's zone for next time, but only when it changed", () => {
  const user = users.createUser({ username: "writer", fullName: "Writer", passwordHash: "x", role: "member" });
  const reread = () => users.findUserById(user.id);

  assert.equal(prefs.zoneForMessage(reread(), "asia/tokyo"), "Asia/Tokyo");
  assert.equal(reread().preferences.deviceTimeZone, "Asia/Tokyo", "saved in canonical form");

  // Nothing new to remember: the account file is not rewritten for every message.
  const accountsFile = join(accountsDir, "accounts.json");
  const before = readFileSync(accountsFile, "utf8");
  assert.equal(prefs.zoneForMessage(reread(), "Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(readFileSync(accountsFile, "utf8"), before);

  assert.equal(prefs.zoneForMessage(reread(), "nonsense"), "Asia/Tokyo", "a bad value neither fails the message nor replaces what is known");
  assert.equal(reread().preferences.deviceTimeZone, "Asia/Tokyo");
  assert.equal(prefs.zoneForMessage(reread(), "America/New_York"), "America/New_York", "a trip changes it");
  assert.equal(reread().preferences.deviceTimeZone, "America/New_York");
});

// ---------------------------------------------------------------------------
// Accounts.
// ---------------------------------------------------------------------------

// Created on first use, not at import: the first account closes the instance.
let created;
const accounts = () => (created ??= {
  alice: users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" }),
  bob: users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" }),
});
const cookieFor = (user) => `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}`;

test("each account has its own zone, saved by the route and read back", async () => {
  const { alice, bob } = accounts();
  const aliceCookie = cookieFor(alice);
  const bobCookie = cookieFor(bob);

  assert.deepEqual(await (await call("PUT", { timeZone: "Europe/Paris", deviceTimeZone: "asia/tokyo" }, aliceCookie)).json(), {
    zone: "Europe/Paris", source: "explicit", explicit: "Europe/Paris", deviceZone: "Asia/Tokyo", serverZone: "Australia/Sydney",
  });
  const bobsView = await (await call("GET", undefined, bobCookie)).json();
  assert.deepEqual([bobsView.explicit, bobsView.deviceZone], [null, null], "another account's choice is not shared");
  assert.equal(users.findUserById(alice.id).preferences.timeZone, "Europe/Paris", "persisted on the account, not merely echoed");

  assert.equal((await call("PUT", { timeZone: "Nowhere/Land" }, aliceCookie)).status, 400);
  assert.equal(users.findUserById(alice.id).preferences.timeZone, "Europe/Paris", "a refused save changes nothing");
  assert.equal((await call("PUT", { timeZone: null }, aliceCookie)).status, 200);
  assert.equal(users.findUserById(alice.id).preferences.timeZone, undefined, "Automatic is the absence of a choice");
  assert.equal(users.findUserById(alice.id).preferences.deviceTimeZone, "Asia/Tokyo", "and clearing it keeps the last device seen");
});

test("signed out, once accounts exist, nothing is read or written", async () => {
  assert.equal((await call("GET")).status, 401);
  assert.equal((await call("PUT", { timeZone: "Europe/Paris" })).status, 401);
});

test("theme and zone share an account record without clobbering each other", () => {
  const user = users.createUser({ username: "both", fullName: "Both", passwordHash: "x", role: "member" });
  users.updateUser(user.id, (record) => { record.preferences = { ...record.preferences, theme: "nord-dark" }; });
  prefs.setExplicitTimeZone(users.findUserById(user.id), "Europe/Paris");
  prefs.noteDeviceTimeZone(users.findUserById(user.id), "Asia/Tokyo");
  assert.deepEqual(users.findUserById(user.id).preferences, { theme: "nord-dark", timeZone: "Europe/Paris", deviceTimeZone: "Asia/Tokyo" });
  prefs.setExplicitTimeZone(users.findUserById(user.id), null);
  assert.deepEqual(users.findUserById(user.id).preferences, { theme: "nord-dark", deviceTimeZone: "Asia/Tokyo" });
});

test("a hand-edited or stale stored zone is dropped when read, not handed to an engine", () => {
  const user = users.createUser({ username: "stale", fullName: "Stale", passwordHash: "x", role: "member" });
  users.updateUser(user.id, (record) => { record.preferences = { timeZone: "Gone/Forever", deviceTimeZone: "$(reboot)" }; });
  assert.equal(users.findUserById(user.id).preferences, undefined);
  assert.equal(prefs.effectiveTimeZone(users.findUserById(user.id)).zone, "Australia/Sydney");
});

test("work nobody is typing for follows the session's owner, and an unowned session the instance-level zone", () => {
  const { bob } = accounts();
  owners.setSessionOwner("owned-by-bob", bob.id);
  prefs.noteDeviceTimeZone(users.findUserById(bob.id), "America/Chicago");
  assert.equal(prefs.ownerTimeZone("owned-by-bob"), "America/Chicago");
  prefs.setExplicitTimeZone(users.findUserById(bob.id), "Europe/Berlin");
  assert.equal(prefs.ownerTimeZone("owned-by-bob"), "Europe/Berlin", "their own choice beats where they were last seen");

  // The open-instance record (last device seen: Tokyo, nothing chosen) is what an unowned session uses.
  assert.equal(prefs.ownerTimeZone("nobody-owns-this"), "Asia/Tokyo");
  assert.equal(prefs.ownerTimeZone(undefined), "Asia/Tokyo");
});
