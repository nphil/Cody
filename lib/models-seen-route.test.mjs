import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET|POST /api/models/seen`: who may record a display, and — the two
 * fixes this file pins — that an OPEN instance (no accounts at all) can
 * still write the ledger the same way `useModelCatalog`'s `openInstance`
 * already treats it (the "new models" feature must not go silently inert
 * just because nobody has created an account yet), and that `merge: true`
 * unions into the ledger's current keys instead of replacing them (a
 * curation dialog that displayed one provider's models must not erase what
 * was recorded for every other provider).
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-seen-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-seen-route-accounts-"));
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/models/seen/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");

const json = async (response) => ({ status: response.status, body: await response.json() });
const get = () => route.GET();
const post = (headers, payload) => route.POST(new Request("http://cody.test/api/models/seen", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
}));

// --- No accounts exist yet: the open-instance case ------------------------
// Declared FIRST — creating a user later in this file makes `hasAnyUser()`
// true for the rest of the process, so the open-instance behavior can only
// be observed before that happens.

test("GET needs no credential at all — the proxy is the gate, as for /api/models", async () => {
  const { status, body } = await json(await get());
  assert.equal(status, 200);
  assert.deepEqual(body.seenKeys, []);
  assert.equal(body.seenAt, null);
});

test("POST succeeds with no credential when no accounts exist yet (open instance)", async () => {
  const { status, body } = await json(await post({}, { keys: ["acme/alpha", "acme/beta"] }));
  assert.equal(status, 200, "an open instance is administered by whoever is looking, same as useModelCatalog's openInstance");
  assert.deepEqual(body.seenKeys, ["acme/alpha", "acme/beta"]);

  const read = await json(await get());
  assert.deepEqual(read.body.seenKeys, ["acme/alpha", "acme/beta"], "the write actually landed, not just answered 200");
});

// --- Once accounts exist, it is admin-only ---------------------------------

const admin = createUser({ username: "seenadmin", fullName: "Seen Admin", passwordHash: await hashPassword("long enough 1"), role: "admin" });
const member = createUser({ username: "seenmember", fullName: "Seen Member", passwordHash: await hashPassword("long enough 2"), role: "member" });
const cookieFor = (user) => ({ Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` });

test("once an account exists, POST with no credential is 401, not the open-instance case", async () => {
  const { status, body } = await json(await post({}, { keys: ["acme/gamma"] }));
  assert.equal(status, 401);
  assert.equal(body.code, "auth_required");
});

test("a member cannot record a display", async () => {
  const { status, body } = await json(await post(cookieFor(member), { keys: ["acme/gamma"] }));
  assert.equal(status, 403);
  assert.equal(body.code, "admin_required");
});

test("an admin's POST replaces the ledger by default", async () => {
  const { status, body } = await json(await post(cookieFor(admin), { keys: ["acme/gamma", "acme/alpha"] }));
  assert.equal(status, 200);
  assert.deepEqual(body.seenKeys, ["acme/alpha", "acme/gamma"], "acme/beta from the earlier open-instance write is gone: a replace, not a union");
});

test("merge: true unions into the ledger instead of replacing it", async () => {
  // The curation-Save scenario: only what one provider's dialog displayed is
  // new information; every other provider's already-seen keys must survive.
  const first = await json(await post(cookieFor(admin), { keys: ["anthropic/opus", "anthropic/sonnet"] }));
  assert.deepEqual(first.body.seenKeys, ["anthropic/opus", "anthropic/sonnet"]);

  const merged = await json(await post(cookieFor(admin), { keys: ["openrouter/x"], merge: true }));
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body.seenKeys, ["anthropic/opus", "anthropic/sonnet", "openrouter/x"], "the earlier anthropic keys survive a merged write");

  // A plain (non-merge) POST after that still replaces the whole list.
  const replaced = await json(await post(cookieFor(admin), { keys: ["openrouter/x"] }));
  assert.deepEqual(replaced.body.seenKeys, ["openrouter/x"]);
});

test("the body is validated: keys must be an array of strings", async () => {
  for (const payload of [{ keys: "acme/alpha" }, { keys: [1, 2] }, {}]) {
    const bad = await json(await post(cookieFor(admin), payload));
    assert.equal(bad.status, 400, `${JSON.stringify(payload)} must be refused`);
    assert.equal(bad.body.code, "keys_required");
  }
  const malformed = await json(await post(cookieFor(admin), "{ not json"));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_body");
});
