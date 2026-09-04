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
// "No engine binaries installed" is the premise of this whole file, and pi's
// schema route now READS its installed package — so a stray `pi` on the
// runner's PATH would change what these routes answer. Pinned to a path that
// does not exist, which is exactly the state being tested.
process.env.CODY_PI_BIN = path.join(agentDir, "no-such-pi");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const modelsRoute = await jiti.import("../app/api/models/route.ts");
const modelRolesRoute = await jiti.import("../app/api/model-roles/route.ts");
const modelsConfigRoute = await jiti.import("../app/api/models-config/route.ts");
const ompSettingsRoute = await jiti.import("../app/api/omp-settings/route.ts");
const ompSettingsSchemaRoute = await jiti.import("../app/api/omp-settings/schema/route.ts");
const authProvidersRoute = await jiti.import("../app/api/auth/providers/route.ts");
const allProvidersRoute = await jiti.import("../app/api/auth/all-providers/route.ts");
const usageRoute = await jiti.import("../app/api/usage/route.ts");
const newModelsRoute = await jiti.import("../app/api/models/new/route.ts");
const seenModelsRoute = await jiti.import("../app/api/models/seen/route.ts");
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
const member = createUser({
  username: "guardmember",
  fullName: "Guard Member",
  passwordHash: await hashPassword("guard-password-2"),
  role: "member",
});
const MEMBER_AUTH = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(member)}` };

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

test("provider sign-in lists through the adapter under every engine, never through omp", async () => {
  // Sign-in used to be omp's alone (an omp child behind /api/auth/*). It is
  // now each engine's OWN login behind HarnessAdapter.providerLogins: under
  // Hermes the roster is Hermes' OAuth providers, read through `hermes auth`,
  // and an engine whose CLI is absent answers an empty list with its reason —
  // an answer, not a refusal, and never omp's roster.
  for (const id of ["hermes", "claude", "codex", "pi"]) {
    selectEngine(id);
    const { status, body } = await json(await authProvidersRoute.GET());
    assert.equal(status, 200, `${id}: sign-in is served, not refused (got ${JSON.stringify(body).slice(0, 120)})`);
    assert.equal(body.engine?.id, id, `${id}: the roster is stamped with the engine it belongs to`);
    assert.ok(Array.isArray(body.providers), `${id}: providers is a list`);
    for (const provider of body.providers) {
      assert.equal(typeof provider.id, "string");
      assert.equal(typeof provider.authenticated, "boolean");
      assert.ok(provider.kind === "oauth" || provider.kind === "device", `${id}: ${provider.id} declares how it signs in`);
    }
    if (body.providers.length === 0) assert.equal(typeof body.reason, "string", `${id}: an empty roster says why`);
  }
});

test("the two settings routes are gated by the two different flags they answer to", async () => {
  // These look like one surface and are two, which is exactly how they got
  // confused. `/api/omp-settings` serves omp's config.yml through Cody's
  // HAND-BUILT editors and refuses for anyone else — `configEditor`.
  // `/api/omp-settings/schema` is engine-GENERIC: it renders whatever the
  // active engine declares (omp's TypeScript schema, Hermes' DEFAULT_CONFIG,
  // pi's own docs/settings.md) through the same panel — `nativeSettings`.
  //
  // Guard the schema route on configEditor and Hermes keeps a settings tab
  // whose contents nothing can search; guard the values route on
  // nativeSettings and Hermes gets a red banner over the whole dialog. Both
  // have happened. The flags are asserted against the ROUTES here so the two
  // cannot drift apart again in either direction.
  const { getHarnessById } = await jiti.import("./harness/index.ts");

  // pi joined this list when it grew a settings surface of its own: its
  // settings are the tables in the INSTALLED pi package's docs/settings.md,
  // written back to `<pi agent dir>/settings.json`. It is also the engine
  // that proves the two flags are still different — nativeSettings true,
  // configEditor false, so it answers the schema route and still refuses
  // omp's config.yml editors below.
  for (const id of ["omp", "hermes", "pi"]) {
    selectEngine(id);
    const { capabilities } = getHarnessById(id);
    assert.equal(capabilities.nativeSettings, true, `${id} is expected to declare nativeSettings=true here`);

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
    assert.equal(schema.body.schema, null, `${id} has no binary here, so there is no schema to read`);
    assert.equal(typeof schema.body.reason, "string", `${id} must say WHY the schema is unavailable`);
    assert.equal(typeof schema.body.path, "string", "the file the user would edit by hand is still named");
  }

  // pi refuses omp's hand-built config.yml editors specifically — the check
  // above only says the status tracks the flag, and pi is the engine where
  // the two flags disagree.
  selectEngine("pi");
  const piValues = await json(await ompSettingsRoute.GET());
  assert.equal(piValues.status, 400, "pi has no omp config.yml for the hand-built editors");
  assert.equal(piValues.body.code, "unsupported");

  // …and an engine with NEITHER flag gets neither surface. This half is the
  // one that was missing: the schema route had no gate at all, so pi, Claude
  // Code and Codex — none of which declared nativeSettings then — got omp's
  // ~550-key schema and omp's config.yml values back, stamped with their own
  // shortName. The PUT was the real damage: it fell through to omp's writer
  // and saved into omp's config.yml while another engine was active,
  // reporting success.
  for (const id of ["claude", "codex"]) {
    selectEngine(id);
    const { capabilities } = getHarnessById(id);
    assert.equal(capabilities.nativeSettings, false, `${id} is expected to declare nativeSettings=false here`);

    for (const [label, call] of [
      ["GET /api/omp-settings", () => ompSettingsRoute.GET()],
      ["GET /api/omp-settings/schema", () => ompSettingsSchemaRoute.GET()],
      ["PUT /api/omp-settings/schema", () => ompSettingsSchemaRoute.PUT(new Request("http://cody.test/api/omp-settings/schema", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { "mcp.enableProjectConfig": true } }),
      }))],
    ]) {
      const { status, body } = await json(await call());
      assert.equal(status, 400, `${label} answered ${status} under ${id}`);
      assert.equal(body.code, "unsupported", `${label} must refuse with the code the UI hides on`);
    }
  }
});

test("a PUT never falls through to another engine's config file", async () => {
  // The failure this pins is silent by construction: the old route's PUT had
  // an `if (hermes) … else ompWriter(patch)` shape, so every engine without a
  // branch wrote omp's config.yml and reported success. Each engine's writer
  // now hangs off its own adapter, so a patch either reaches THAT engine or
  // fails saying why — it can never land in someone else's file.
  const put = (patch) => ompSettingsSchemaRoute.PUT(new Request("http://cody.test/api/omp-settings/schema", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch }),
  }));

  // pi, with no pi installed: the write refuses with pi's own words, and
  // writes nothing anywhere.
  selectEngine("pi");
  const pi = await json(await put({ "compaction.enabled": false }));
  assert.equal(pi.status, 400);
  assert.match(String(pi.body.error), /pi/i, "the refusal must name the engine that could not take the write");
  assert.equal(fs.existsSync(path.join(agentDir, "settings.json")), false, "pi's settings file must not be created by a failed write");

  // Hermes, with no hermes installed: same shape, its own words.
  selectEngine("hermes");
  const hermes = await json(await put({ "display.show_reasoning": true }));
  assert.equal(hermes.status, 400);
  assert.match(String(hermes.body.error), /hermes/i);
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

test("the new-models diff has nothing to diff for an ACP engine, and says so without spawning anything", async () => {
  // Same premise as the models route: an ACP engine's models are session
  // state, so there is no catalog to compare against the ledger. Empty and
  // "session" is the ANSWER; an error here would put a red status line under
  // a Models entry that is simply not this engine's surface.
  for (const id of ACP_ENGINES) {
    selectEngine(id);
    const { status, body } = await json(await newModelsRoute.GET());
    assert.equal(status, 200, `${id}: the new-models route must still answer`);
    assert.deepEqual(body.newModels, [], `${id} was told about models it never published`);
    assert.equal(body.total, 0);
    assert.equal(body.catalogSource, "session", `${id} must say where its models actually live`);
    assert.equal(body.firstRun, false);
    assert.equal(body.seenAt, null);
    assert.equal(body.modelError, undefined, `${id}: an absent catalog is not an error`);

    const seen = await json(await seenModelsRoute.GET());
    assert.equal(seen.status, 200, `${id}: the seen ledger is readable under every engine`);
    assert.equal(seen.body.engine?.id, id, `${id}: the ledger is stamped with the engine it belongs to`);
    assert.deepEqual(seen.body.seenKeys, []);
    assert.equal(seen.body.seenAt, null);
  }
});

test("under omp the new-models diff takes omp's unrestricted catalog path and fails soft without a binary", async () => {
  selectEngine("omp");
  const { status, body } = await json(await newModelsRoute.GET());
  assert.equal(status, 200, "a loader failure is a 200 with modelError, exactly like /api/models");
  // No omp binary is installed here, so the unrestricted read fails — and
  // that failure IS the proof the route dispatched to omp's catalog rather
  // than short-circuiting every engine to empty.
  assert.match(String(body.modelError), /omp/i);
  assert.deepEqual(body.newModels, []);
  assert.equal(body.total, 0);
  assert.equal(body.catalogSource, "global", "omp's catalog IS the sessionless one");
});

test("marking the catalog seen is an administrator's act, and the ledger is per engine", async () => {
  const post = (headers, payload) => seenModelsRoute.POST(new Request("http://cody.test/api/models/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  }));

  selectEngine("hermes");
  // A member may read the ledger but not write it: one member marking the
  // catalog seen would silence the "new models" notice for everyone.
  const forbidden = await json(await post(MEMBER_AUTH, { keys: ["acme/alpha"] }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "admin_required");
  assert.deepEqual((await json(await seenModelsRoute.GET())).body.seenKeys, [], "a refused write leaves the ledger untouched");

  // The body is `{keys: string[]}` and nothing else is accepted.
  for (const payload of [{}, { keys: "acme/alpha" }, { keys: [1, 2] }, { keys: [{ id: "x" }] }]) {
    const bad = await json(await post(AUTH, payload));
    assert.equal(bad.status, 400, `${JSON.stringify(payload)} must be refused`);
    assert.equal(bad.body.code, "keys_required");
  }
  const malformed = await json(await post(AUTH, "{ not json"));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_body");

  // An admin's write persists — deduplicated and sorted — and the next read
  // answers it, stamped with the engine it was recorded for.
  const written = await json(await post(AUTH, { keys: ["acme/beta", "acme/alpha", "acme/beta"] }));
  assert.equal(written.status, 200);
  assert.equal(written.body.engine?.id, "hermes");
  assert.deepEqual(written.body.seenKeys, ["acme/alpha", "acme/beta"]);
  assert.equal(typeof written.body.seenAt, "string");
  const read = await json(await seenModelsRoute.GET());
  assert.deepEqual(read.body, written.body, "GET answers exactly what the POST recorded");

  // A second write REPLACES the list: the ledger records what was shown, it
  // is not a union of every display there has ever been.
  const replaced = await json(await post(AUTH, { keys: ["zeta/gamma"] }));
  assert.deepEqual(replaced.body.seenKeys, ["zeta/gamma"]);

  // Another engine's ledger is untouched by all of the above.
  selectEngine("codex");
  const other = await json(await seenModelsRoute.GET());
  assert.equal(other.body.engine?.id, "codex");
  assert.deepEqual(other.body.seenKeys, []);
  assert.equal(other.body.seenAt, null);
});
