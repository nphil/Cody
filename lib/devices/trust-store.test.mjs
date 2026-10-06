import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What GET / PUT / DELETE /api/devices/trust do to the per-account file, driven
 * through the route handlers as lib/notifications/routes.test.mjs drives its
 * routes. The point of the PUT tests: only a page (cookie session) can write trust.
 */
const root = mkdtempSync(join(tmpdir(), "cody-trust-store-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
process.env.CODY_INTERNAL_DISPLAY_SECRET = Buffer.from("trust-store-test-secret").toString("base64url");
delete process.env.CODY_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../../app/api/devices/trust/route.ts");
const store = await jiti.import("./trust-store.ts");
const { MAX_TRUSTED_DEVICES } = await jiti.import("./trust.ts");
const { getDeviceTrustPath } = await jiti.import("../auth/paths.ts");
const users = await jiti.import("../auth/users.ts");
const { issueAccessToken } = await jiti.import("../auth/tokens.ts");
const { issueDisplayCapability } = await jiti.import("../display/capability.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");

const file = getDeviceTrustPath();
const request = (method, body, headers = {}, query = "") =>
  new Request(`http://cody.test/api/devices/trust${query}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const as = (user) => ({ Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` });
const get = async (headers) => answer(await route.GET(request("GET", undefined, headers)));
const put = async (body, headers) => answer(await route.PUT(request("PUT", body, headers)));
const del = async (key, headers) =>
  answer(await route.DELETE(request("DELETE", undefined, headers, key === undefined ? "" : `?key=${encodeURIComponent(key)}`)));
const answer = async (response) => ({ status: response.status, response, body: await response.clone().json() });
const diskText = () => readFileSync(file, "utf8");
const keysOf = (result) => result.body.devices.map((device) => device.key);

const pixel = { label: "Pixel 8", vendorId: 0x18d1, productId: 0x4ee7, serialNumber: "PIX123" };
const esp = { label: "ESP32-S3", vendorId: 0x303a, serialNumber: "ESP001" };
const pixelKey = "usb:18d1:PIX123";
const espKey = "usb:303a:ESP001";

// ---------------------------------------------------------------------------
// An open instance (no accounts)
// ---------------------------------------------------------------------------

test("an open instance starts empty and answers uncached", async () => {
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { devices: [] });
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(existsSync(file), false, "reading creates nothing");
});

test("PUT remembers a device: key derived server-side, 0600, written atomically", async () => {
  const result = await put(pixel);
  assert.equal(result.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.body.devices.length, 1);
  assert.equal(result.body.devices[0].key, pixelKey);
  assert.equal(result.body.devices[0].label, "Pixel 8");
  assert.equal(result.body.devices[0].productId, 0x4ee7);
  assert.ok(Math.abs(result.body.devices[0].grantedAt - Date.now()) < 10_000);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
  assert.equal(JSON.parse(diskText()).instance.devices[0].key, pixelKey, "the open instance has its own record");
  assert.deepEqual(keysOf(await get()), [pixelKey]);
});

test("a body that names a different key, or no usable identity, is a 400 invalid_trusted_device and writes nothing", async () => {
  const before = diskText();
  for (const bad of [
    { ...pixel, key: "usb:303a:ESP001" },
    { ...pixel, serialNumber: "" },
    { ...pixel, serialNumber: undefined },
    { ...pixel, label: "   " },
    { ...pixel, label: "x".repeat(500) },
    { ...pixel, vendorId: 0x1_0000 },
    { ...pixel, productId: -1 },
    [pixel],
    JSON.stringify("just text"),
  ]) {
    const result = await put(bad);
    assert.equal(result.status, 400, JSON.stringify(bad));
    assert.equal(result.body.code, "invalid_trusted_device", JSON.stringify(bad));
  }
  assert.equal(diskText(), before);
  // The same key is accepted when it is the one the server would derive.
  assert.equal((await put({ ...pixel, key: pixelKey })).status, 200);
});

test("a body that is not JSON, or is larger than 4 KB, is invalid_body", async () => {
  const before = diskText();
  const notJson = await route.PUT(request("PUT", "{nope"));
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).code, "invalid_body");
  const huge = await put({ ...pixel, label: "x".repeat(5000) });
  assert.equal(huge.status, 400);
  assert.equal(huge.body.code, "invalid_body");
  assert.equal(diskText(), before);
});

test("on an open instance a request with an Authorization header of any scheme cannot write trust, valid or not: 403 page_required, file unchanged", async () => {
  const before = diskText();
  const capability = issueDisplayCapability("some-session");
  for (const authorization of ["Bearer garbage", `Bearer ${capability}`, "bearer lower-case-scheme", "Bearer", "Basic Y29keTpodW50ZXIyMg==", "Token abc"]) {
    const result = await put(esp, { Authorization: authorization });
    assert.equal(result.status, 403, authorization);
    assert.equal(result.body.code, "page_required", authorization);
  }
  assert.equal(diskText(), before, "nothing was written");
  assert.deepEqual(keysOf(await get()), [pixelKey]);
});

test("DELETE is idempotent and a missing key is a 400", async () => {
  assert.equal((await del(undefined)).status, 400);
  assert.equal((await del("")).status, 400);
  const before = diskText();
  const unknown = await del("usb:dead:nobody");
  assert.equal(unknown.status, 200);
  assert.deepEqual(keysOf(unknown), [pixelKey]);
  assert.equal(diskText(), before, "forgetting what is not remembered writes nothing");

  assert.deepEqual((await del(pixelKey)).body, { devices: [] });
  assert.deepEqual((await del(pixelKey)).body, { devices: [] }, "a second forget is the same answer");
  assert.deepEqual(JSON.parse(diskText()).instance, undefined, "an empty record is not kept");
});

// ---------------------------------------------------------------------------
// The store: order, upsert, cap, hand edits
// ---------------------------------------------------------------------------

test("remembering an already-remembered device refreshes it and moves it to the front", () => {
  store.rememberTrustedDevice("order", pixel, 1_000);
  store.rememberTrustedDevice("order", esp, 2_000);
  assert.deepEqual(store.listTrustedDevices("order").map((device) => device.key), [espKey, pixelKey]);

  const refreshed = store.rememberTrustedDevice("order", { ...pixel, label: "Pixel 8 Pro" }, 3_000);
  assert.deepEqual(refreshed.map((device) => device.key), [pixelKey, espKey], "the refreshed device is the newest");
  assert.equal(refreshed[0].grantedAt, 3_000);
  assert.equal(refreshed[0].label, "Pixel 8 Pro");
  assert.equal(store.listTrustedDevices("order").length, 2, "an upsert never duplicates");
});

test("past the cap the device with the oldest grantedAt is dropped", () => {
  const owner = "capped";
  for (let index = 0; index < MAX_TRUSTED_DEVICES + 1; index += 1) {
    store.rememberTrustedDevice(owner, { label: `Board ${index}`, vendorId: 0x1234, serialNumber: `S${index}` }, 10_000 + index);
  }
  const list = store.listTrustedDevices(owner);
  assert.equal(list.length, MAX_TRUSTED_DEVICES);
  assert.equal(list[0].serialNumber, `S${MAX_TRUSTED_DEVICES}`, "newest first");
  assert.equal(list.some((device) => device.serialNumber === "S0"), false, "the oldest went");
  assert.equal(list.at(-1).serialNumber, "S1");

  // Refreshing the oldest survivor makes the next one the oldest.
  store.rememberTrustedDevice(owner, { label: "Board 1", vendorId: 0x1234, serialNumber: "S1" }, 99_999);
  store.rememberTrustedDevice(owner, { label: "Extra", vendorId: 0x1234, serialNumber: "EXTRA" }, 100_000);
  const after = store.listTrustedDevices(owner);
  assert.equal(after.some((device) => device.serialNumber === "S1"), true);
  assert.equal(after.some((device) => device.serialNumber === "S2"), false);
});

test("reading re-checks what is on disk: hand-edited, forged or repeated entries are dropped", () => {
  const good = { key: pixelKey, label: "Pixel 8", vendorId: 0x18d1, serialNumber: "PIX123", grantedAt: 5_000 };
  writeFileSync(file, JSON.stringify({
    version: 1,
    accounts: {
      edited: {
        devices: [
          good,
          { ...good, grantedAt: 4_000, label: "older duplicate" },
          { ...good, key: "usb:303a:ESP001", label: "key does not match the identity" },
          { key: "usb:18d1:", label: "no serial", vendorId: 0x18d1, serialNumber: "", grantedAt: 1 },
          { ...good, serialNumber: "NOTIME", key: "usb:18d1:NOTIME", grantedAt: "yesterday" },
          "text",
          null,
        ],
      },
      broken: "not a record",
    },
  }));
  const list = store.listTrustedDevices("edited");
  assert.deepEqual(list, [{ key: pixelKey, label: "Pixel 8", vendorId: 0x18d1, serialNumber: "PIX123", grantedAt: 5_000 }]);
  assert.deepEqual(store.listTrustedDevices("broken"), []);
  writeFileSync(file, "{ not json");
  assert.deepEqual(store.listTrustedDevices("edited"), [], "an unreadable file reads as empty");
});

// ---------------------------------------------------------------------------
// With accounts: per account, cookie-only writes
// ---------------------------------------------------------------------------

test("with accounts, signed-out requests are 401 on every method", async () => {
  writeFileSync(file, JSON.stringify({ version: 1, accounts: {}, instance: { devices: [{ key: espKey, ...esp, grantedAt: 7 }] } }));
  users.createUser({ username: "root", fullName: "Root", passwordHash: "x", role: "admin" });
  assert.equal((await get()).status, 401);
  assert.equal((await put(pixel)).status, 401);
  assert.equal((await del(pixelKey)).status, 401);
  assert.equal((await get()).body.code, "auth_required");
});

test("each account sees only its own devices, and the open-instance record is never served to an account", async () => {
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });

  assert.deepEqual(keysOf(await get(as(alice))), [], "the old open-instance record is not Alice's");
  assert.equal((await put(pixel, as(alice))).status, 200);
  assert.equal((await put(esp, as(bob))).status, 200);

  assert.deepEqual(keysOf(await get(as(alice))), [pixelKey]);
  assert.deepEqual(keysOf(await get(as(bob))), [espKey]);
  assert.deepEqual(store.listTrustedDevices("__instance").map((device) => device.key), [espKey], "the instance record is separate");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("DELETE only reaches the caller's own record", async () => {
  const alice = users.findUserByUsername("alice");
  const bob = users.findUserByUsername("bob");
  const attempt = await del(espKey, as(alice));
  assert.equal(attempt.status, 200);
  assert.deepEqual(keysOf(attempt), [pixelKey], "Alice's list is unchanged and says nothing about Bob's");
  assert.deepEqual(keysOf(await get(as(bob))), [espKey], "Bob's device is still remembered");
  assert.deepEqual(store.listTrustedDevices("__instance").map((device) => device.key), [espKey]);

  assert.deepEqual((await del(espKey, as(bob))).body, { devices: [] });
});

test("an access token, a capability token and the instance password can read and forget but never remember; a cookie session can", async () => {
  const alice = users.findUserByUsername("alice");
  const { secret } = issueAccessToken(alice, "script");
  const bearer = { Authorization: `Bearer ${secret}` };
  const before = diskText();

  const refused = await put(esp, bearer);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "page_required");
  // A valid session cookie does not rescue a request that also carries an Authorization header.
  assert.equal((await put(esp, { ...as(alice), ...bearer })).status, 403);
  assert.equal((await put(esp, { Authorization: `Bearer ${issueDisplayCapability("chat-1")}` })).status, 403);
  assert.equal(diskText(), before, "nothing was written");

  // The instance password (HTTP Basic) is what a script, or an agent's shell that inherited the server's environment, holds.
  process.env.CODY_PASSWORD = "hunter22";
  try {
    const basic = { Authorization: `Basic ${Buffer.from("cody:hunter22").toString("base64")}` };
    assert.equal((await get(basic)).status, 200, "the password is a real credential: it can read");
    const basicWrite = await put(esp, basic);
    assert.equal(basicWrite.status, 403);
    assert.equal(basicWrite.body.code, "page_required");
    assert.equal(diskText(), before, "the instance password cannot write trust");
  } finally {
    delete process.env.CODY_PASSWORD;
  }

  assert.deepEqual(keysOf(await get(bearer)), [pixelKey], "a token can read");
  assert.equal((await put(esp, as(alice))).status, 200, "the page can write");
  assert.deepEqual((await del(espKey, bearer)).body.devices.map((device) => device.key), [pixelKey], "a token can withdraw trust");
});

test("a deleted account's devices go with it the next time anyone writes", async () => {
  const bob = users.findUserByUsername("bob");
  const alice = users.findUserByUsername("alice");
  assert.equal((await put(esp, as(bob))).status, 200);
  assert.ok(JSON.parse(diskText()).accounts[bob.id]);

  users.deleteUser(bob.id);
  assert.ok(JSON.parse(diskText()).accounts[bob.id], "deleting the account alone does not touch the file");
  assert.equal((await put(esp, as(alice))).status, 200);
  assert.equal(JSON.parse(diskText()).accounts[bob.id], undefined);
  assert.ok(JSON.parse(diskText()).accounts[alice.id]);
});
