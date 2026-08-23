import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * No route answers for an engine that is not the active one.
 *
 * The defect this pins was reported by the owner as "the composer shows omp's
 * models on other engines", and the models route was only the visible half.
 * Underneath, every omp-shaped surface answered 200 whichever engine was
 * selected: `/api/models` served omp's 150-model catalog as Claude Code's,
 * `/api/model-roles` served omp's roles, `/api/omp-settings` served omp's
 * config.yml with a Save that wrote to a file the active engine never reads,
 * `/api/auth/*` served omp's credential store. The UI hid most of those
 * panels behind capability flags — which is why it took a direct probe to
 * see them — but a client-side flag is a convenience, not a boundary.
 *
 * Everything here runs with NO engine binaries installed. That matters: if a
 * route did fall back to omp it would fail with "omp binary not found", and
 * these assertions would see an error where they demand an honest, empty,
 * successful answer.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-route-guards-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-route-guard-accounts-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const modelsRoute = await jiti.import("../app/api/models/route.ts");
const modelRolesRoute = await jiti.import("../app/api/model-roles/route.ts");
const modelsConfigRoute = await jiti.import("../app/api/models-config/route.ts");
const ompSettingsRoute = await jiti.import("../app/api/omp-settings/route.ts");
const ompSettingsSchemaRoute = await jiti.import("../app/api/omp-settings/schema/route.ts");
const authProvidersRoute = await jiti.import("../app/api/auth/providers/route.ts");
const allProvidersRoute = await jiti.import("../app/api/auth/all-providers/route.ts");
const usageRoute = await jiti.import("../app/api/usage/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");

/** Every engine that does NOT speak omp's rpc dialect. These are the ones the
 * bug hit: `utilityRpcLaunchFor` answered `undefined` for each, and
 * `undefined` is rpc-utility's "spawn the installed omp" signal. */
const ACP_ENGINES = ["claude", "codex", "hermes"];

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}

const admin = createUser({
  username: "guardadmin",
  fullName: "Guard Admin",
  passwordHash: await hashPassword("guard-password-1"),
  role: "admin",
});
// A real signed-in session: /api/usage is auth-gated, and the point of the
// test is what it answers AFTER that gate, not the gate itself.
const AUTH = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(admin)}` };

const json = async (response) => ({ status: response.status, body: await response.json() });

test("an ACP engine is never handed another engine's model catalog", async () => {
  for (const id of ACP_ENGINES) {
    selectEngine(id);
    const { status, body } = await json(await modelsRoute.GET(new Request("http://cody.test/api/models")));
    assert.equal(status, 200, `${id}: the models route must still answer`);
    assert.deepEqual(body.modelList, [], `${id} was served a model list it never published`);
    assert.deepEqual(body.models, {}, `${id} was served model names it never published`);
    assert.equal(body.defaultModel, null);
    // "session", not "global": ACP publishes models per session, so the
    // composer must read them from the session's get_state rather than
    // conclude the engine has none.
    assert.equal(body.catalogSource, "session", `${id} must say where its models actually live`);
    // Empty is the ANSWER here, not a failure. A modelError would tell the
    // composer something broke and make it render an error chip over a
    // surface that is simply not this engine's.
    assert.equal(body.modelError, undefined, `${id}: an absent catalog is not an error`);
  }
});

test("omp still gets its own catalog path (the fix is a dispatch, not a disablement)", async () => {
  selectEngine("omp");
  const { status, body } = await json(await modelsRoute.GET(new Request("http://cody.test/api/models")));
  assert.equal(status, 200);
  // No omp binary is installed here, so the real read fails — and that
  // failure IS the proof the route took omp's path instead of short-circuiting
  // every engine to empty.
  assert.match(String(body.modelError), /omp/i);
  assert.equal(body.catalogSource, "global", "omp's catalog IS the sessionless one");
});

test("the unrestricted catalog refuses rather than spawning omp behind another engine", async () => {
  for (const id of ACP_ENGINES) {
    selectEngine(id);
    const { status, body } = await json(
      await modelsRoute.GET(new Request("http://cody.test/api/models?catalog=full")),
    );
    assert.equal(status, 400, `${id}: curation is omp's models.yml surface`);
    assert.equal(body.code, "unsupported");
  }
});

test("omp-only surfaces refuse under another engine instead of serving omp's files", async () => {
  const surfaces = [
    ["GET /api/model-roles", () => modelRolesRoute.GET()],
    ["DELETE /api/model-roles", () => modelRolesRoute.DELETE()],
    ["GET /api/models-config", () => modelsConfigRoute.GET()],
    ["GET /api/omp-settings", () => ompSettingsRoute.GET()],
    ["GET /api/auth/providers", () => authProvidersRoute.GET()],
    ["GET /api/auth/all-providers", () => allProvidersRoute.GET()],
  ];
  selectEngine("hermes");
  for (const [label, call] of surfaces) {
    const { status, body } = await json(await call());
    assert.equal(status, 400, `${label} answered ${status} for a non-omp engine`);
    assert.equal(body.code, "unsupported", `${label} must refuse with the code the UI hides on`);
    // The message has to name the mismatch, or a user reads it as a bug in
    // the engine they actually chose.
    assert.match(body.error, /omp/i, `${label} must say whose surface it is`);
  }
});

test("the two settings routes are gated by the two different flags they answer to", async () => {
  // These look like one surface and are two, which is exactly how they got
  // confused. `/api/omp-settings` serves omp's config.yml through Cody's
  // HAND-BUILT editors and refuses for anyone else — `configEditor`.
  // `/api/omp-settings/schema` is engine-GENERIC: it renders omp's TypeScript
  // schema or Hermes' DEFAULT_CONFIG-derived one through the same panel —
  // `nativeSettings`.
  //
  // Guard the schema route on configEditor and Hermes keeps a settings tab
  // whose contents nothing can search; guard the values route on
  // nativeSettings and Hermes gets a red banner over the whole dialog. Both
  // have happened. The flags are asserted against the ROUTES here so the two
  // cannot drift apart again in either direction.
  const { getHarnessById } = await jiti.import("./harness/index.ts");

  for (const id of ["omp", "hermes"]) {
    selectEngine(id);
    const { capabilities } = getHarnessById(id);

    const values = await json(await ompSettingsRoute.GET());
    assert.equal(
      values.status === 200, capabilities.configEditor,
      `/api/omp-settings answered ${values.status} for ${id}, which declares configEditor=${capabilities.configEditor}`,
    );

    // The schema route reads the engine's installed package, so with no
    // binary present it answers 200 with `schema: null` and a reason rather
    // than refusing. What is asserted is that it does not REFUSE, which is
    // the half the capability flag decides.
    const schema = await json(await ompSettingsSchemaRoute.GET());
    assert.equal(
      schema.status, 200,
      `/api/omp-settings/schema must answer for ${id}, which declares nativeSettings=${capabilities.nativeSettings}`,
    );
    assert.equal(schema.body.harness.id, id, "the schema route must name the engine it answered for");
  }

  // …and an engine with neither flag gets neither surface.
  selectEngine("claude");
  assert.equal((await json(await ompSettingsRoute.GET())).status, 400);
});

test("plan quota is one engine's account, and an engine that reports none says so", async () => {
  selectEngine("hermes");
  const response = await usageRoute.GET(new Request("http://cody.test/api/usage", { headers: AUTH }));
  const body = await response.json();
  assert.equal(response.status, 200, "the quota meter is never an error surface");
  assert.equal(body.available, false, "Hermes must not report an OMP account's quota");
  assert.deepEqual(body.accounts, []);
  assert.match(body.reason, /Hermes/);
});

test("an engine switch drops the previous engine's quota snapshot", async () => {
  // resetUsageCache exists for exactly this and, until the switch route
  // called it, had no caller at all: a 60s TTL served stale-while-revalidate
  // meant the composer's quota ring kept showing the old engine's numbers.
  const selectSource = fs.readFileSync(
    new URL("../app/api/engines/select/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(selectSource, /resetUsageCache\(\)/);
});
