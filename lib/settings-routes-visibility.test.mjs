import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET|PUT /api/models/visibility` under every engine, with no engine
 * binaries installed: who may hide what, where the instance-wide hide lives
 * per engine, and that the answer is the same shape everywhere so the
 * Models hub and the composer can code against one contract.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-visibility-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-visibility-accounts-"));
process.env.CODY_PI_BIN = path.join(agentDir, "no-such-pi");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const visibilityRoute = await jiti.import("../app/api/models/visibility/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");

const ENGINES = ["omp", "pi", "hermes", "claude", "codex"];

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}

const admin = createUser({ username: "visadmin", fullName: "Vis Admin", passwordHash: await hashPassword("vis-password-1"), role: "admin" });
const member = createUser({ username: "vismember", fullName: "Vis Member", passwordHash: await hashPassword("vis-password-2"), role: "member" });
const ADMIN = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(admin)}` };
const MEMBER = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(member)}` };

const json = async (response) => ({ status: response.status, body: await response.json() });
const get = (headers) => visibilityRoute.GET(new Request("http://cody.test/api/models/visibility", { headers }));
const put = (headers, payload) => visibilityRoute.PUT(new Request("http://cody.test/api/models/visibility", {
  method: "PUT",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
}));

test("every engine answers the same shape, stamped with its id and where its instance hide lives", async () => {
  for (const id of ENGINES) {
    selectEngine(id);
    const { status, body } = await json(await get(ADMIN));
    assert.equal(status, 200, `${id}: visibility is readable under every engine`);
    assert.equal(body.engine?.id, id);
    assert.deepEqual(body.instanceHidden, []);
    assert.deepEqual(body.hidden, []);
    assert.deepEqual(body.pinned, []);
    // omp's instance hide IS enabledModels in its own config.yml; every
    // other engine's lives in Cody's file.
    assert.equal(body.instanceSource, id === "omp" ? "enabledModels" : "cody", `${id}: instanceSource`);
  }
});

test("reading requires a signed-in user", async () => {
  selectEngine("pi");
  const { status, body } = await json(await get({}));
  assert.equal(status, 401);
  assert.equal(body.code, "auth_required");
});

test("a member may hide for themselves and pin, never for the instance", async () => {
  selectEngine("pi");
  const own = await json(await put(MEMBER, { hidden: ["acme/beta", "acme/alpha"], pinned: ["zeta/one"] }));
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.hidden, ["acme/alpha", "acme/beta"], "stored sorted and deduplicated");
  assert.deepEqual(own.body.pinned, ["zeta/one"]);
  assert.deepEqual(own.body.instanceHidden, []);

  const forbidden = await json(await put(MEMBER, { instanceHidden: ["acme/alpha"] }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "admin_required");
  assert.deepEqual((await json(await get(ADMIN))).body.instanceHidden, [], "a refused write changes nothing");

  // Lists are per user: the admin's own lists are untouched by the member's.
  const adminView = await json(await get(ADMIN));
  assert.deepEqual(adminView.body.hidden, []);
  assert.deepEqual(adminView.body.pinned, []);
});

test("an administrator's instance hide lands in Cody's file on a non-omp engine and is refused on omp", async () => {
  selectEngine("hermes");
  const written = await json(await put(ADMIN, { instanceHidden: ["hermes-model/two", "hermes-model/one"] }));
  assert.equal(written.status, 200);
  assert.deepEqual(written.body.instanceHidden, ["hermes-model/one", "hermes-model/two"]);
  assert.equal(written.body.instanceSource, "cody");
  // Every user sees the instance hide; only its author sees their own lists.
  const memberView = await json(await get(MEMBER));
  assert.deepEqual(memberView.body.instanceHidden, ["hermes-model/one", "hermes-model/two"]);
  const file = JSON.parse(fs.readFileSync(path.join(agentDir, "cody-model-visibility.json"), "utf8"));
  assert.deepEqual(file.engines.hermes, { hidden: ["hermes-model/one", "hermes-model/two"] });

  selectEngine("omp");
  const refused = await json(await put(ADMIN, { instanceHidden: ["acme/alpha"] }));
  assert.equal(refused.status, 400, "omp's instance hide is enabledModels, written through /api/omp-settings");
  assert.equal(refused.body.code, "unsupported");
  assert.deepEqual((await json(await get(ADMIN))).body.instanceHidden, [], "omp never reports a Cody-file instance hide");
  // A mixed body is refused as a whole under omp: nothing is written.
  const mixed = await json(await put(ADMIN, { instanceHidden: ["acme/alpha"], pinned: ["acme/beta"] }));
  assert.equal(mixed.status, 400);
  assert.deepEqual((await json(await get(ADMIN))).body.pinned, []);
});

test("lists are per engine", async () => {
  selectEngine("pi");
  const pi = await json(await get(MEMBER));
  assert.deepEqual(pi.body.hidden, ["acme/alpha", "acme/beta"], "the member's pi hides from earlier");
  selectEngine("codex");
  const codex = await json(await get(MEMBER));
  assert.deepEqual(codex.body.hidden, [], "nothing hidden under codex");
  assert.deepEqual(codex.body.instanceHidden, []);
});

test("the body is validated: string arrays only, at least one list, parseable JSON", async () => {
  selectEngine("pi");
  for (const payload of [{ hidden: "acme/alpha" }, { pinned: [1] }, { hidden: [{ id: "x" }] }, {}]) {
    const bad = await json(await put(ADMIN, payload));
    assert.equal(bad.status, 400, `${JSON.stringify(payload)} must be refused`);
    assert.equal(bad.body.code, "keys_required");
  }
  const malformed = await json(await put(ADMIN, "{ not json"));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_body");
  const list = await json(await put(ADMIN, "[]"));
  assert.equal(list.status, 400);
  assert.equal(list.body.code, "invalid_body");
});
