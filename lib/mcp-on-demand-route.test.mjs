import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin } from "./omp/omp-test-package.mjs";

/**
 * `/api/mcp` and "Load on demand": the registry a server is moved to, and the
 * built-in desktop control, through the real handlers against a throwaway agent
 * dir. The rules this pins: moving a server between omp's mcp.json and the
 * registry loses nothing (credentials included), desktop control is one
 * boolean in config.yml, and everything the route writes is an administrator's
 * call while a member sees names and purpose only.
 */
const engineBin = ompTestPackageBin();
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mcp-ondemand-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mcp-ondemand-route-accounts-"));
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
if (engineBin) process.env.CODY_OMP_BIN = engineBin;
// Start on an OPEN instance (no accounts: the viewer is the administrator); the
// last test creates accounts.
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.CODY_PASSWORD;
process.on("exit", () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(process.env.CODY_ACCOUNTS_DIR, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/mcp/route.ts");
const { MCP_SECRET_SENTINEL } = await jiti.import("./mcp-secrets.ts");
const { invalidateOmpCliCache } = await jiti.import("./omp/omp-cli.ts");
const { clearOmpSettingsSchemaCache } = await jiti.import("./omp/settings-schema.ts");

const userPath = path.join(agentDir, "mcp.json");
const registryPath = path.join(agentDir, "cody-on-demand-mcp.json");
const configPath = path.join(agentDir, "config.yml");
const SECRET = "very-secret-token";

const call = (method, body, headers = {}) => route[method](new Request("http://cody.test/api/mcp", {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
}));
const get = async (headers = {}) => (await route.GET(new Request("http://cody.test/api/mcp", { headers }))).json();
const userFile = () => JSON.parse(fs.readFileSync(userPath, "utf8"));
const registryFile = () => JSON.parse(fs.readFileSync(registryPath, "utf8"));
const rea = { type: "stdio", command: "rea", args: ["serve"], env: { TOKEN: SECRET } };

function useEngine(bin) {
  process.env.CODY_OMP_BIN = bin;
  invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
}

test("a fresh agent dir has an empty on-demand block with desktop control on demand", { skip: engineBin === null && "no omp package available" }, async () => {
  const { onDemand, canManageUser } = await get();
  assert.equal(canManageUser, true);
  assert.deepEqual(onDemand, { path: registryPath, servers: [], problems: [], computer: { onDemand: true, supported: true } });
});

test("a user-scope POST with onDemand writes the registry, masks the secret on GET and keeps it through an edit", async () => {
  const created = await call("POST", { scope: "user", onDemand: true, name: "rea", server: rea, purpose: "Take apart apps and programs" });
  assert.equal(created.status, 200);
  const result = await created.json();
  assert.equal(result.path, registryPath, "the answer names the registry, not mcp.json");
  assert.equal(registryFile().servers.rea.config.env.TOKEN, SECRET);
  assert.equal(fs.existsSync(userPath), false, "omp's own mcp.json is untouched, so omp never loads it");

  const body = await get();
  const served = body.onDemand.servers.find((server) => server.name === "rea");
  assert.deepEqual({ name: served.name, type: served.type, valid: served.valid, purpose: served.purpose }, { name: "rea", type: "stdio", valid: true, purpose: "Take apart apps and programs" });
  assert.equal(served.config.env.TOKEN, MCP_SECRET_SENTINEL);
  assert.ok(!JSON.stringify(body).includes(SECRET), "no response field carries the real token");
  assert.equal(body.user.servers.some((server) => server.name === "rea"), false, "it is not listed as a user-level server");

  // Edit through the masked form and rename: the credential and (with no purpose sent) the purpose survive.
  const renamed = await call("POST", { scope: "user", onDemand: true, name: "reverse", previousName: "rea", server: { ...served.config, args: ["serve", "--fast"] } });
  assert.equal(renamed.status, 200);
  const stored = registryFile().servers;
  assert.equal(stored.rea, undefined);
  assert.equal(stored.reverse.config.env.TOKEN, SECRET);
  assert.deepEqual(stored.reverse.config.args, ["serve", "--fast"]);
  assert.equal(stored.reverse.purpose, "Take apart apps and programs");

  const retitled = await call("POST", { scope: "user", onDemand: true, name: "reverse", server: stored.reverse.config, purpose: "Reverse engineering" });
  assert.equal(retitled.status, 200);
  assert.equal(registryFile().servers.reverse.purpose, "Reverse engineering");
});

test("a project-scope POST, a non-boolean flag and a bad purpose are refused with a message", async () => {
  const project = await call("POST", { scope: "project", onDemand: true, cwd: "/tmp", name: "rea", server: rea });
  assert.equal(project.status, 400);
  assert.match((await project.json()).error, /user-level/);

  const flag = await call("POST", { scope: "user", onDemand: "yes", name: "x", server: rea });
  assert.equal(flag.status, 400);
  assert.match((await flag.json()).error, /onDemand must be true or false/);

  const purpose = await call("POST", { scope: "user", onDemand: true, name: "x", server: rea, purpose: 3 });
  assert.equal(purpose.status, 400);
  assert.match((await purpose.json()).error, /purpose must be a string/);

  // A definition the extension cannot start (legacy sse) is refused rather than stored as a dead entry.
  const sse = await call("POST", { scope: "user", onDemand: true, name: "legacy", server: { type: "sse", url: "https://sse.test" } });
  assert.equal(sse.status, 400);
  assert.equal(registryFile().servers.legacy, undefined);
});

test("DELETE with onDemand removes only the registry entry", async () => {
  assert.equal((await call("POST", { scope: "user", name: "keep", server: { type: "http", url: "https://keep.test/mcp" } })).status, 200);
  const removed = await call("DELETE", { scope: "user", onDemand: true, name: "reverse" });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).path, registryPath);
  assert.deepEqual(registryFile().servers, {});
  assert.ok(userFile().mcpServers.keep, "mcp.json is untouched");

  const missing = await call("DELETE", { scope: "user", onDemand: true, name: "reverse" });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /not found/);
  assert.equal((await call("DELETE", { scope: "user", name: "keep" })).status, 200);
});

test("PUT ondemand moves a user-level server to the registry and back without losing its credential", async () => {
  const server = { type: "http", url: "https://docs.test/mcp", headers: { Authorization: `Bearer ${SECRET}` } };
  assert.equal((await call("POST", { scope: "user", name: "docs", server })).status, 200);

  const moved = await call("PUT", { action: "ondemand", scope: "user", name: "docs", onDemand: true, purpose: "Look things up in the docs" });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).path, registryPath);
  assert.equal(userFile().mcpServers.docs, undefined, "gone from mcp.json");
  assert.equal(registryFile().servers.docs.config.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(registryFile().servers.docs.purpose, "Look things up in the docs");
  const afterMove = await get();
  assert.equal(afterMove.user.servers.some((row) => row.name === "docs"), false);
  const listed = afterMove.onDemand.servers.find((row) => row.name === "docs");
  assert.equal(listed.type, "http");
  assert.equal(listed.config.headers.Authorization, MCP_SECRET_SENTINEL);

  const back = await call("PUT", { action: "ondemand", scope: "user", name: "docs", onDemand: false });
  assert.equal(back.status, 200);
  assert.deepEqual(registryFile().servers, {});
  assert.equal(userFile().mcpServers.docs.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal((await get()).user.servers.find((row) => row.name === "docs").config.url, server.url);
});

test("a disabled server cannot be moved on demand, and the refusal says why", async () => {
  assert.equal((await call("PUT", { action: "disable", scope: "user", name: "docs" })).status, 200);
  const refused = await call("PUT", { action: "ondemand", scope: "user", name: "docs", onDemand: true });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Turn the server on/);
  assert.ok(userFile().mcpServers.docs, "still in mcp.json");
  assert.deepEqual(registryFile().servers, {});
  assert.equal((await call("PUT", { action: "enable", scope: "user", name: "docs" })).status, 200);

  const unknown = await call("PUT", { action: "ondemand", scope: "user", name: "nothing", onDemand: true });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /not found/);
  assert.equal((await call("PUT", { action: "ondemand", scope: "project", name: "docs", onDemand: true })).status, 400);
  assert.equal((await call("PUT", { action: "ondemand", scope: "user", name: "docs", onDemand: "yes" })).status, 400);
  assert.equal((await call("PUT", { action: "toggle", scope: "user", name: "docs" })).status, 400);
  assert.equal((await call("DELETE", { scope: "user", name: "docs" })).status, 200);
});

test("PUT computer writes computer.enabled into config.yml and GET reads it back", { skip: engineBin === null && "no omp package available" }, async () => {
  assert.equal((await get()).onDemand.computer.onDemand, true, "off by default means on demand");

  const everyChat = await call("PUT", { action: "computer", onDemand: false });
  assert.equal(everyChat.status, 200);
  assert.deepEqual((await everyChat.json()).computer, { onDemand: false });
  assert.match(fs.readFileSync(configPath, "utf8"), /computer:\s*\n\s+enabled: true/);
  assert.deepEqual((await get()).onDemand.computer, { onDemand: false, supported: true });

  const onDemand = await call("PUT", { action: "computer", onDemand: true });
  assert.equal(onDemand.status, 200);
  assert.match(fs.readFileSync(configPath, "utf8"), /computer:\s*\n\s+enabled: false/);
  assert.deepEqual((await get()).onDemand.computer, { onDemand: true, supported: true });

  const bad = await call("PUT", { action: "computer", onDemand: "yes" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /onDemand must be true or false/);
});

test("an engine without desktop control reports it unsupported and refuses to switch it", async () => {
  useEngine("/nonexistent/omp");
  try {
    assert.equal((await get()).onDemand.computer.supported, false);
    const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
    const refused = await call("PUT", { action: "computer", onDemand: false });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /no desktop control/);
    assert.equal(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null, before, "nothing was written");
  } finally {
    if (engineBin) useEngine(engineBin);
  }
});

test("a member sees on-demand names and purpose, never the config, and cannot change anything", async () => {
  const { createUser } = await jiti.import("./auth/users.ts");
  const { hashPassword } = await jiti.import("./auth/password.ts");
  const { issueSessionToken } = await jiti.import("./auth/session.ts");
  const passwordHash = await hashPassword("correct-horse-battery");
  const owner = createUser({ username: "owner", fullName: "Owner", passwordHash, role: "admin" });
  const member = createUser({ username: "member", fullName: "Member", passwordHash, role: "member" });
  const as = (user) => ({ cookie: `cody_session=${issueSessionToken(user)}` });

  const secretUrl = "https://private.test/webhook/secret-path";
  assert.equal((await call("POST", { scope: "user", onDemand: true, name: "private", server: { type: "http", url: secretUrl, headers: { Authorization: `Bearer ${SECRET}` } }, purpose: "Private lookups" }, as(owner))).status, 200);
  assert.equal((await call("POST", { scope: "user", name: "plain", server: { type: "http", url: "https://plain.test/mcp" } }, as(owner))).status, 200);

  const owned = await get(as(owner));
  assert.equal(owned.canManageUser, true);
  assert.equal(owned.onDemand.servers.find((row) => row.name === "private").config.url, secretUrl);
  assert.equal(owned.onDemand.servers.find((row) => row.name === "private").config.headers.Authorization, MCP_SECRET_SENTINEL);

  for (const headers of [as(member), {}]) {
    const seen = await get(headers);
    assert.equal(seen.canManageUser, false);
    const row = seen.onDemand.servers.find((entry) => entry.name === "private");
    assert.deepEqual({ name: row.name, type: row.type, valid: row.valid, purpose: row.purpose, config: row.config }, { name: "private", type: "http", valid: true, purpose: "Private lookups", config: undefined });
    assert.equal(typeof seen.onDemand.computer.onDemand, "boolean");
    assert.ok(!JSON.stringify(seen).includes("secret-path"), "no field carries the server's URL");
    assert.ok(!JSON.stringify(seen).includes(SECRET));
  }

  const writes = [
    ["POST", { scope: "user", onDemand: true, name: "private", server: { type: "http", url: "https://evil.test/mcp" } }],
    ["PUT", { action: "ondemand", scope: "user", name: "plain", onDemand: true }],
    ["PUT", { action: "ondemand", scope: "user", name: "private", onDemand: false }],
    ["PUT", { action: "computer", onDemand: false }],
    ["DELETE", { scope: "user", onDemand: true, name: "private" }],
  ];
  for (const [method, body] of writes) {
    const refused = await call(method, body, as(member));
    assert.equal(refused.status, 403, `${method} ${JSON.stringify(body)} is refused for a member`);
    assert.equal((await refused.json()).code, "admin_required");
    const anonymous = await call(method, body);
    assert.equal(anonymous.status, 401, `${method} is refused with no credential`);
  }
  assert.equal(registryFile().servers.private.config.url, secretUrl, "nothing was written");
  assert.ok(userFile().mcpServers.plain, "mcp.json is untouched");
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /enabled: true/, "desktop control stays on demand");
});
