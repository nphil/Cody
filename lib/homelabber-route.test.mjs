import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/homelabber`: where the approval card's "Use backup code" link points.
 *
 * The rule this pins is the one `/api/mcp` lives by: nothing from a user-level
 * MCP server's config except what the answer needs. A HomeLabber entry carries
 * a bearer token in its headers, and its URL may carry more; the route says an
 * ORIGIN, and only when the URL is a name a person can sign in at.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-homelabber-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-homelabber-route-accounts-"));
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.CODY_PASSWORD;
delete process.env.CODY_HARNESS;
process.on("exit", () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(process.env.CODY_ACCOUNTS_DIR, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/homelabber/route.ts");

const userPath = path.join(agentDir, "mcp.json");
const TOKEN = "Bearer hl-super-secret-token";
const DEFAULT = { base: "https://homelabber.nateshome.net", source: "default" };

function configure(servers) {
  fs.writeFileSync(userPath, JSON.stringify({ mcpServers: servers }));
}
const ask = async (init) => {
  const response = route.GET(new Request("http://cody.test/api/homelabber", init));
  return { status: response.status, headers: response.headers, body: await response.json() };
};

test("with no MCP config the answer is the built-in default", async () => {
  const { status, body, headers } = await ask();
  assert.equal(status, 200);
  assert.deepEqual(body, DEFAULT);
  assert.equal(headers.get("cache-control"), "no-store");
});

test("the configured homelabber server's origin is the base, and nothing else of its config is said", async () => {
  configure({
    "ha-mcp": { type: "http", url: "https://ha.example.test/private_webhook_abc/mcp" },
    HomeLabber: { type: "http", url: "https://hl.example.test:8443/mcp?key=url-secret", headers: { Authorization: TOKEN } },
  });
  const { body } = await ask();
  assert.deepEqual(body, { base: "https://hl.example.test:8443", source: "mcp" });
  const wire = JSON.stringify(body);
  for (const secret of ["hl-super-secret-token", "url-secret", "/mcp", "private_webhook_abc", "ha.example.test"]) {
    assert.ok(!wire.includes(secret), `the answer must not carry ${secret}`);
  }
});

test("an address that is not a name falls back: Nitin's own config points at the NAS by IP", async () => {
  configure({ homelabber: { type: "http", url: "http://192.168.1.69:3009/mcp", headers: { Authorization: TOKEN } } });
  assert.deepEqual((await ask()).body, DEFAULT);
  configure({ homelabber: { type: "http", url: "http://localhost:3009/mcp" } });
  assert.deepEqual((await ask()).body, DEFAULT);
});

test("a server of another name, a stdio server and a broken file all fall back", async () => {
  configure({ other: { type: "http", url: "https://other.example.test/mcp" } });
  assert.deepEqual((await ask()).body, DEFAULT);
  configure({ homelabber: { command: "npx", args: ["homelabber-mcp"] } });
  assert.deepEqual((await ask()).body, DEFAULT);
  fs.writeFileSync(userPath, "{ not json");
  assert.deepEqual((await ask()).body, DEFAULT);
});

test("another engine's chat never reads omp's mcp.json", async () => {
  configure({ homelabber: { type: "http", url: "https://hl.example.test/mcp" } });
  assert.equal((await ask()).body.source, "mcp");
  process.env.CODY_HARNESS = "claude";
  try {
    assert.deepEqual((await ask()).body, DEFAULT);
  } finally {
    delete process.env.CODY_HARNESS;
  }
});

test("CODY_HOMELABBER_URL outranks the MCP config, as an origin, and a bad value is ignored", async () => {
  configure({ homelabber: { type: "http", url: "https://from-mcp.example.test/mcp" } });
  try {
    process.env.CODY_HOMELABBER_URL = "https://hl.example.test:9443/anything?x=1";
    assert.deepEqual((await ask()).body, { base: "https://hl.example.test:9443", source: "env" });
    // Another engine has no mcp.json to read, but the operator's own word still holds.
    process.env.CODY_HARNESS = "claude";
    assert.deepEqual((await ask()).body, { base: "https://hl.example.test:9443", source: "env" });
    delete process.env.CODY_HARNESS;
    for (const unusable of ["http://10.0.0.5:3009", "not a url", "javascript:alert(1)", ""]) {
      process.env.CODY_HOMELABBER_URL = unusable;
      assert.deepEqual((await ask()).body, { base: "https://from-mcp.example.test", source: "mcp" }, unusable);
    }
  } finally {
    delete process.env.CODY_HOMELABBER_URL;
    delete process.env.CODY_HARNESS;
  }
});

test("once accounts exist it needs a signed-in user, and a member may ask", async () => {
  configure({ homelabber: { type: "http", url: "https://hl.example.test/mcp" } });
  const { createUser } = await jiti.import("./auth/users.ts");
  const { hashPassword } = await jiti.import("./auth/password.ts");
  const { issueSessionToken } = await jiti.import("./auth/session.ts");
  const member = createUser({ username: "member", fullName: "Member", passwordHash: await hashPassword("correct-horse-battery"), role: "member" });

  assert.equal((await ask()).status, 401);
  const answered = await ask({ headers: { cookie: `cody_session=${issueSessionToken(member)}` } });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body, { base: "https://hl.example.test", source: "mcp" });
});
