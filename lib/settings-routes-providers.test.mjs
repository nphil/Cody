import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The Providers hub's two routes under every engine, with NO engine binary
 * installed. The contract they pin:
 *
 *   - `GET /api/providers` answers 200 under all five engines. An ACP engine
 *     has no sessionless catalog, so its counts are null with the reason; an
 *     rpc-dialect engine whose binary is missing ALSO answers 200, with the
 *     spawn failure on the rows as `reason` — a fact about the engine is
 *     never a 500 for the hub.
 *   - `?cached=1` never starts a child: it answers from what the process
 *     already knows and marks the rest `pending`.
 *   - `POST /api/providers/verify` is admin-only, refuses `unsupported`
 *     under an ACP engine (nothing to read), and under omp with no binary
 *     answers `{ok:false, error}` rather than throwing.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-providers-routes-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-providers-accounts-"));
process.env.CODY_PI_BIN = path.join(agentDir, "no-such-pi");
process.env.CODY_OMP_BIN = path.join(agentDir, "no-such-omp");
// Keys the container may carry must not leak into the assertions below.
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "OPENROUTER_API_KEY"]) delete process.env[name];
process.env.OPENAI_API_KEY = "from-the-container";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const providersRoute = await jiti.import("../app/api/providers/route.ts");
const verifyRoute = await jiti.import("../app/api/providers/verify/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");
const { setProviderKey } = await jiti.import("./harness/provider-keys.ts");

const ENGINES = ["omp", "pi", "hermes", "claude", "codex"];
const ACP_ENGINES = ["hermes", "claude", "codex"];

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}

const admin = createUser({ username: "provadmin", fullName: "Prov Admin", passwordHash: await hashPassword("prov-password-1"), role: "admin" });
const member = createUser({ username: "provmember", fullName: "Prov Member", passwordHash: await hashPassword("prov-password-2"), role: "member" });
const AUTH = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(admin)}` };
const MEMBER_AUTH = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(member)}` };

const json = async (response) => ({ status: response.status, body: await response.json() });
const get = (query = "", headers = AUTH) => providersRoute.GET(new Request(`http://cody.test/api/providers${query}`, { headers }));
const verify = (payload, headers = AUTH) => verifyRoute.POST(new Request("http://cody.test/api/providers/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
}));

test("the hub answers 200 under every engine with no binary installed", async () => {
  for (const id of ENGINES) {
    selectEngine(id);
    const { status, body } = await json(await get());
    assert.equal(status, 200, `${id}: ${JSON.stringify(body).slice(0, 160)}`);
    assert.equal(body.engine?.id, id, `${id}: the answer is stamped with its engine`);
    assert.equal(typeof body.engine?.shortName, "string");
    assert.equal(body.canEdit, true, "the admin may edit");
    assert.equal(body.instanceSource, "writable");
    assert.ok(Array.isArray(body.providers) && body.providers.length > 0, `${id}: the key catalogue alone gives rows`);
    for (const row of body.providers) {
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.name, "string");
      assert.equal(typeof row.group, "string");
      assert.ok(Array.isArray(row.methods));
      assert.equal(typeof row.connected, "boolean");
      assert.ok(row.modelCount === null || typeof row.modelCount === "number");
      for (const method of row.methods) {
        for (const variable of method.variables ?? []) {
          assert.ok(!("value" in variable), `${id}: ${variable.name} must not carry a value`);
        }
      }
    }
    const openai = body.providers.find((row) => row.id === "openai");
    if (openai) {
      const key = openai.methods.find((method) => method.kind === "env" || method.kind === "key");
      assert.ok(key, `${id}: OpenAI has a key method`);
      assert.equal(key.variables[0].fromEnvironment, true, `${id}: the container's OPENAI_API_KEY is reported as such`);
      assert.equal(key.kind, "env");
      assert.equal(openai.connected, true);
    }
  }
});

test("an ACP engine reports null counts with the reason, and no Verify", async () => {
  for (const id of ACP_ENGINES) {
    selectEngine(id);
    const { body } = await json(await get());
    assert.equal(body.canVerify, false, `${id}: nothing to check a key against`);
    for (const row of body.providers) {
      assert.equal(row.modelCount, null, `${id}/${row.id}: models come from the session`);
      assert.match(String(row.reason), /session/i);
      assert.equal(row.pending, undefined, "not pending: this is the answer");
    }
  }
});

test("an rpc-dialect engine with no binary answers 200 with the failure on the rows, never a 500", async () => {
  for (const id of ["omp", "pi"]) {
    selectEngine(id);
    const { status, body } = await json(await get());
    assert.equal(status, 200);
    assert.equal(body.canVerify, true);
    const anthropic = body.providers.find((row) => row.id === "anthropic");
    assert.ok(anthropic);
    assert.equal(anthropic.modelCount, null);
    assert.match(String(anthropic.reason), new RegExp(id, "i"), `${id}: the reason names the engine whose spawn failed`);
    // The roster failed for the same reason, and the key rows are still there.
    assert.ok(body.providers.some((row) => row.id === "openai"));
  }
});

test("the cached read never starts a child and marks the unknown pending", async () => {
  selectEngine("omp");
  const started = Date.now();
  const { status, body } = await json(await get("?cached=1"));
  assert.equal(status, 200);
  assert.equal(body.pending, true);
  assert.ok(Date.now() - started < 1_500, "a cached read is a cache peek, not a spawn");
  const anthropic = body.providers.find((row) => row.id === "anthropic");
  assert.equal(anthropic.modelCount, null);
  assert.equal(anthropic.pending, true);
  assert.equal(anthropic.reason, undefined, "pending is not a failure");
});

test("omp's models.yml endpoints are custom rows, and scoped registry entries make the hub read-only", async () => {
  selectEngine("omp");
  fs.writeFileSync(path.join(agentDir, "models.yml"), [
    "providers:",
    "  mock:",
    "    baseUrl: http://127.0.0.1:30190/v1",
    "    api: openai-completions",
    "    auth: none",
    "    models:",
    "      - id: mock-1",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(agentDir, "config.yml"), "disabledProviders:\n  - anthropic\nmodelProviderOrder:\n  - openai\n  - anthropic\n");
  try {
    const { body } = await json(await get());
    const mock = body.providers.find((row) => row.id === "mock");
    assert.ok(mock, "the models.yml provider is a row");
    assert.equal(mock.group, "custom");
    assert.equal(mock.connected, true);
    assert.equal(mock.modelCount, 1, "the file's own model count, even with no engine to ask");
    assert.equal(mock.endpoint.baseUrl, "http://127.0.0.1:30190/v1");
    assert.equal(body.providers.find((row) => row.id === "anthropic").disabled, true);
    assert.equal(body.providers.find((row) => row.id === "openai").order, 0);
    assert.equal(body.instanceSource, "writable");

    fs.writeFileSync(path.join(agentDir, "config.yml"), "enabledModels:\n  - path: /srv/work\n    models: [\"openai/*\"]\n");
    const scoped = await json(await get());
    assert.equal(scoped.body.instanceSource, "readonly");
    assert.match(String(scoped.body.readonlyReason), /path-scoped/);
  } finally {
    fs.rmSync(path.join(agentDir, "models.yml"), { force: true });
    fs.rmSync(path.join(agentDir, "config.yml"), { force: true });
  }
});

test("a key saved in Cody shows as stored and wins over the container, and a member may only read", async () => {
  selectEngine("hermes");
  setProviderKey("OPENAI_API_KEY", "saved-in-cody");
  try {
    const { body } = await json(await get("", MEMBER_AUTH));
    assert.equal(body.canEdit, false);
    const openai = body.providers.find((row) => row.id === "openai");
    const key = openai.methods.find((method) => method.winning);
    assert.equal(key.kind, "key");
    assert.equal(key.variables[0].stored, true);
    assert.equal(key.variables[0].fromEnvironment, true);
    assert.ok(!JSON.stringify(body).includes("saved-in-cody"), "the value never leaves the server");
  } finally {
    setProviderKey("OPENAI_API_KEY", "");
  }
});

test("the hub is a signed-in surface", async () => {
  selectEngine("omp");
  const { status, body } = await json(await get("", {}));
  assert.equal(status, 401);
  assert.equal(body.code, "auth_required");
});

test("verify refuses under an ACP engine, gates on admin, validates its body, and fails soft under omp", async () => {
  for (const id of ACP_ENGINES) {
    selectEngine(id);
    const { status, body } = await json(await verify({ providerId: "anthropic" }));
    assert.equal(status, 400, `${id}: nothing to verify against`);
    assert.equal(body.code, "unsupported");
  }
  selectEngine("omp");
  const forbidden = await json(await verify({ providerId: "openai" }, MEMBER_AUTH));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "admin_required");
  const missing = await json(await verify({}));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "provider_id_required");
  const malformed = await json(await verify("{ not json"));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_body");

  // No omp binary: the check cannot run, and says so as a result, not a 500.
  const { status, body } = await json(await verify({ providerId: "openai" }));
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.modelCount, 0);
  assert.match(String(body.error), /omp/i);
  assert.equal(typeof body.checkedAt, "string");
});
