import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/** The keys route: readable by anyone signed in, writable by admins only,
 * and never a source of the values it stores. */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-keys-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-keys-route-accounts-"));
delete process.env.CODY_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/provider-keys/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");
const { readProviderKeys } = await jiti.import("./harness/provider-keys.ts");

const admin = createUser({ username: "admin", fullName: "Admin", passwordHash: await hashPassword("long enough"), role: "admin" });
const member = createUser({ username: "member", fullName: "Member", passwordHash: await hashPassword("long enough"), role: "member" });
const cookieFor = (user) => `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}`;
const put = (user, body) => route.PUT(new Request("http://cody.test/api/provider-keys", {
  method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookieFor(user) }, body: JSON.stringify(body),
}));

test("an admin saves a key; the answer says it is configured without repeating it", async () => {
  const response = await put(admin, { name: "OPENROUTER_API_KEY", value: "sk-or-secret" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes("sk-or-secret"));
  assert.equal(body.providers.find((p) => p.id === "openrouter").configured, true);
  assert.equal(readProviderKeys().OPENROUTER_API_KEY, "sk-or-secret");
});

test("a member can see what is configured but cannot change it", async () => {
  const get = await route.GET(new Request("http://cody.test/api/provider-keys", { headers: { Cookie: cookieFor(member) } }));
  assert.equal(get.status, 200);
  assert.equal((await get.json()).providers.find((p) => p.id === "openrouter").configured, true);
  const response = await put(member, { name: "OPENROUTER_API_KEY", value: "attacker" });
  assert.equal(response.status, 403);
  assert.equal(readProviderKeys().OPENROUTER_API_KEY, "sk-or-secret");
});

test("only variables an engine reads can be set, and a value cannot smuggle control characters", async () => {
  assert.equal((await put(admin, { name: "PATH", value: "/evil" })).status, 400);
  assert.equal((await put(admin, { name: "ANTHROPIC_API_KEY", value: "bad\nkey" })).status, 400);
  assert.equal((await put(admin, { name: "ANTHROPIC_API_KEY", value: "x".repeat(5000) })).status, 400);
  assert.equal(readProviderKeys().ANTHROPIC_API_KEY, undefined);
});

test("an empty value clears the key", async () => {
  assert.equal((await put(admin, { name: "OPENROUTER_API_KEY", value: "" })).status, 200);
  assert.equal(readProviderKeys().OPENROUTER_API_KEY, undefined);
});

test("signed out, the route is closed", async () => {
  const response = await route.GET(new Request("http://cody.test/api/provider-keys"));
  assert.equal(response.status, 401);
});
