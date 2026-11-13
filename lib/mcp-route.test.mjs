import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/mcp` in the scope the browser can reach without a workspace.
 *
 * The rule this pins: a user-level server's credentials never leave the
 * server. The GET answer carries the config so the form can edit it, but every
 * `headers`/`env` value is the sentinel, and saving that sentinel back merges
 * the real value from disk instead of blanking it.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mcp-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mcp-route-accounts-"));
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
// The container sets CODY_REQUIRE_ACCOUNTS=1, which makes auth mandatory even
// with an empty store. The tests below start on an OPEN instance (no accounts,
// the viewer is the administrator) and the last one creates accounts, so this
// fixture states the mode instead of inheriting it.
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.CODY_PASSWORD;
process.on("exit", () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(process.env.CODY_ACCOUNTS_DIR, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/mcp/route.ts");
const { MCP_SECRET_SENTINEL } = await jiti.import("./mcp-secrets.ts");

const userPath = path.join(agentDir, "mcp.json");
const TOKEN = "Bearer super-secret-token";

const call = (method, body) => route[method](new Request("http://cody.test/api/mcp", {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const get = async () => (await route.GET(new Request("http://cody.test/api/mcp"))).json();
const onDisk = () => JSON.parse(fs.readFileSync(userPath, "utf8"));

test("a user-scope POST writes the agent dir's mcp.json with no workspace at all", async () => {
  const response = await call("POST", {
    scope: "user",
    name: "docs",
    server: { type: "http", url: "https://docs.test/mcp", headers: { Authorization: TOKEN } },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scope, "user");
  assert.equal(result.path, userPath, "the answer names the file the save landed in");
  assert.equal(onDisk().mcpServers.docs.headers.Authorization, TOKEN);
});

test("GET masks the credential it just stored", async () => {
  const body = await get();
  const served = body.user.servers.find((server) => server.name === "docs");
  assert.equal(served.type, "http");
  assert.equal(served.enabled, true);
  assert.equal(served.config.url, "https://docs.test/mcp", "the rest of the config is editable");
  assert.equal(served.config.headers.Authorization, MCP_SECRET_SENTINEL);
  assert.ok(!JSON.stringify(body).includes("super-secret-token"), "no response field carries the real token");
});

test("saving the masked config back keeps the credential", async () => {
  const { user } = await get();
  const masked = user.servers.find((server) => server.name === "docs").config;
  const response = await call("POST", { scope: "user", name: "docs", server: { ...masked, url: "https://docs.test/mcp/v2" } });
  assert.equal(response.status, 200);
  assert.equal(onDisk().mcpServers.docs.url, "https://docs.test/mcp/v2");
  assert.equal(onDisk().mcpServers.docs.headers.Authorization, TOKEN);

  // A sentinel with nothing behind it is a 400, never a blanked secret.
  const invented = await call("POST", { scope: "user", name: "docs", server: { type: "http", url: "https://docs.test/mcp", headers: { "X-Api-Key": MCP_SECRET_SENTINEL } } });
  assert.equal(invented.status, 400);
  assert.match((await invented.json()).error, /No saved value for headers\.X-Api-Key/);
  assert.equal(onDisk().mcpServers.docs.headers.Authorization, TOKEN);
});

test("PUT toggles the user denylist and still validates when no action is given", async () => {
  const disabled = await call("PUT", { action: "disable", scope: "user", name: "docs" });
  assert.equal(disabled.status, 200);
  assert.deepEqual((await disabled.json()).disabledServers, ["docs"]);
  const afterDisable = await get();
  assert.equal(afterDisable.user.servers[0].enabled, false);
  assert.equal(afterDisable.user.servers[0].disabled, true);
  // The denied server keeps its own row; it is not doubled as a bare
  // "Disabled" entry in the inventory.
  assert.equal(afterDisable.inventory.filter((server) => server.name === "docs").length, 1);

  assert.equal((await call("PUT", { action: "enable", scope: "user", name: "docs" })).status, 200);
  assert.equal("disabledServers" in onDisk(), false);

  const validated = await call("PUT", { name: "docs", server: { type: "http", url: "https://docs.test/mcp" } });
  assert.equal(validated.status, 200);
  assert.match((await validated.json()).message, /valid/);
});

test("a malformed scope or action is refused with a message", async () => {
  const scope = await call("POST", { scope: "global", name: "docs", server: { command: "npx" } });
  assert.equal(scope.status, 400);
  assert.match((await scope.json()).error, /scope must be "user" or "project"/);

  const action = await call("PUT", { action: "toggle", scope: "user", name: "docs" });
  assert.equal(action.status, 400);
  assert.match((await action.json()).error, /action must be "enable", "disable"/);

  const projectScope = await call("PUT", { action: "disable", scope: "project", name: "docs" });
  assert.equal(projectScope.status, 400);
  assert.match((await projectScope.json()).error, /user-level/);
});

test("a user-scope DELETE removes it from the same file", async () => {
  const response = await call("DELETE", { scope: "user", name: "docs" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, userPath);
  assert.deepEqual(onDisk().mcpServers, {});
  assert.deepEqual((await get()).user.servers, []);
});

test("a signed-in member can list user-level servers but neither read nor change them", async () => {
  // Everything above ran on an open instance (no accounts), where the viewer
  // IS the administrator. Once accounts exist, user-level servers are
  // instance state: a member sees which are configured and nothing more.
  const { createUser } = await jiti.import("./auth/users.ts");
  const { hashPassword } = await jiti.import("./auth/password.ts");
  const { issueSessionToken } = await jiti.import("./auth/session.ts");
  const passwordHash = await hashPassword("correct-horse-battery");
  const owner = createUser({ username: "owner", fullName: "Owner", passwordHash, role: "admin" });
  const member = createUser({ username: "member", fullName: "Member", passwordHash, role: "member" });
  const as = (user, method, body) => route[method](new Request("http://cody.test/api/mcp", {
    method,
    headers: { "Content-Type": "application/json", cookie: `cody_session=${issueSessionToken(user)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const server = { type: "http", url: "https://private.test/webhook/secret-path", headers: { Authorization: TOKEN } };
  assert.equal((await as(owner, "POST", { scope: "user", name: "shared", server })).status, 200);

  const seen = await (await route.GET(new Request("http://cody.test/api/mcp", { headers: { cookie: `cody_session=${issueSessionToken(member)}` } }))).json();
  assert.equal(seen.canManageUser, false);
  assert.equal(seen.user.servers.find((row) => row.name === "shared").type, "http", "the row is still listed");
  assert.equal(seen.user.servers.find((row) => row.name === "shared").config, undefined, "with no config to edit");
  // The URL can BE the credential (an ha-mcp webhook), and it is not maskable.
  assert.ok(!JSON.stringify(seen).includes("secret-path"), "no field carries the server's URL");

  for (const [method, body] of [
    ["POST", { scope: "user", name: "shared", server }],
    ["PUT", { action: "disable", scope: "user", name: "shared" }],
    ["DELETE", { scope: "user", name: "shared" }],
  ]) {
    const refused = await as(member, method, body);
    assert.equal(refused.status, 403, `${method} is refused`);
    assert.equal((await refused.json()).code, "admin_required");
  }
  assert.equal(onDisk().mcpServers.shared.headers.Authorization, TOKEN, "nothing was written");

  const owned = await (await route.GET(new Request("http://cody.test/api/mcp", { headers: { cookie: `cody_session=${issueSessionToken(owner)}` } }))).json();
  assert.equal(owned.canManageUser, true);
  assert.equal(owned.user.servers.find((row) => row.name === "shared").config.url, server.url);
});
