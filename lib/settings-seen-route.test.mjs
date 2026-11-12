import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET|POST /api/settings-seen`: the HTTP contract of the "New" badge for
 * engine settings. The engine's schema and version are stubbed on the active
 * harness (no engine package needed); everything else is the real route, the
 * real ledger on a temp instance dir and the real account guard.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-settings-seen-route-"));
process.on("exit", () => fs.rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-settings-seen-accounts-"));
process.on("exit", () => fs.rmSync(accountsDir, { recursive: true, force: true }));
// The open instance (no accounts) is the first half of this file, so nothing in the
// environment may force sign-in.
for (const name of ["CODY_HARNESS", "CODY_REQUIRE_ACCOUNTS", "CODY_PASSWORD"]) delete process.env[name];

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/settings-seen/route.ts");
const { getHarness } = await jiti.import("./harness/index.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");

const ledgerPath = path.join(agentDir, "cody-settings-seen.json");
const ledger = () => JSON.parse(fs.readFileSync(ledgerPath, "utf8"));

const harness = getHarness();
assert.equal(harness.id, "omp", "no engine is selected, so the default engine is the one under test");
let schemaSettings = null;
let schemaVersion = null;
let engineVersion = null;
harness.settings.readSchema = () => ({
  path: "/stub/config.yml",
  schema: schemaSettings
    ? { tabs: [], groups: {}, settings: schemaSettings, source: { packagePath: "/stub", version: schemaVersion } }
    : null,
  values: {},
  ...(schemaSettings ? {} : { reason: "stub: no schema" }),
});
harness.getVersion = async () => engineVersion;

const row = (key, extra = {}) => ({ key, type: "boolean", tab: "general", label: key, ...extra });
const BASE = [row("a.one"), row("a.two"), row("b.three")];
const UPGRADE = [...BASE, row("c.four"), row("d.five"), row("t.terminal", { terminalOnly: true })];
function engineAt(version, settings) {
  engineVersion = version;
  schemaSettings = settings;
  schemaVersion = null;
}

const URL_ = "http://cody.test/api/settings-seen";
const get = (headers = {}) => route.GET(new Request(URL_, { headers }));
const post = (payload, headers = {}) =>
  route.POST(
    new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
  );
const json = async (response) => ({ status: response.status, headers: response.headers, body: await response.json() });

// ── the open instance (no accounts yet) ─────────────────────────────

test("the first look at an engine records its keys and answers with no badge at all", async () => {
  engineAt("18.8.3", BASE);
  const first = await json(await get());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(first.body, {
    engine: { id: "omp", version: "18.8.3" },
    previousVersion: null,
    firstRun: true,
    newKeys: [],
    since: {},
    fadeAfter: 3,
  });
  assert.deepEqual(ledger().engines.omp.keys, ["a.one", "a.two", "b.three"]);
  assert.equal(ledger().engines.omp.engineVersion, "18.8.3");

  const second = await json(await get());
  assert.equal(second.body.firstRun, false, "only the look that created the snapshot is the first run");
  assert.deepEqual(second.body.newKeys, []);
});

test("an engine update badges exactly the added keys, never the terminal-only one, and labels them with the version", async () => {
  engineAt("18.19.0", UPGRADE);
  const { status, body } = await json(await get());
  assert.equal(status, 200);
  assert.equal(body.engine.version, "18.19.0");
  assert.equal(body.previousVersion, "18.8.3");
  assert.equal(body.firstRun, false);
  assert.deepEqual(body.newKeys, ["c.four", "d.five"], "t.terminal does nothing in a browser: no badge");
  assert.deepEqual(body.since, { "c.four": "18.19.0", "d.five": "18.19.0" });
  assert.ok(ledger().engines.omp.keys.includes("t.terminal"), "terminal-only keys are still recorded");
  assert.deepEqual(Object.keys(ledger().engines.omp.introduced).sort(), ["c.four", "d.five", "t.terminal"]);
});

test("a Settings open counts once however often it is reported, and the badge fades on the third open", async () => {
  const first = await json(await post({ openId: "open-1", seen: ["c.four"] }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.newKeys, ["c.four", "d.five"]);
  await post({ openId: "open-1", seen: ["c.four", "c.four"] });
  await post({ openId: "open-1", seen: ["c.four"] });
  assert.equal(ledger().users.__instance.omp["c.four"].seen, 1, "retried and duplicated reports of one open count once");

  await post({ openId: "open-2", seen: ["c.four"] });
  assert.deepEqual((await json(await get())).body.newKeys, ["c.four", "d.five"], "two opens: still badged");
  const third = await json(await post({ openId: "open-3", seen: ["c.four"] }));
  assert.deepEqual(third.body.newKeys, ["d.five"], "the third counted open fades it");
  assert.deepEqual((await json(await get())).body.newKeys, ["d.five"]);
});

test("changing a key fades it at once; unknown, faded and terminal-only keys are ignored, never an error", async () => {
  const changed = await json(await post({ openId: "open-4", changed: ["d.five"] }));
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.newKeys, []);

  const before = fs.readFileSync(ledgerPath, "utf8");
  const ignored = await json(await post({ openId: "open-5", seen: ["no.such.setting", "a.one", "t.terminal"], changed: ["t.terminal", "nope"] }));
  assert.equal(ignored.status, 200);
  assert.deepEqual(ignored.body.newKeys, []);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), before, "nothing was written for keys that cannot badge");
});

test("a report that is not a report is refused, and nothing is counted", async () => {
  const before = fs.readFileSync(ledgerPath, "utf8");
  const cases = [
    ["{ not json", "invalid_body"],
    ["[]", "invalid_report"],
    [{ seen: ["c.four"] }, "invalid_report"],
    [{ openId: "", seen: ["c.four"] }, "invalid_report"],
    [{ openId: "x".repeat(129), seen: ["c.four"] }, "invalid_report"],
    [{ openId: "o", seen: "c.four" }, "invalid_report"],
    [{ openId: "o", changed: [1] }, "invalid_report"],
    [{ openId: "o", seen: Array.from({ length: 1001 }, (_, i) => `k${i}`) }, "invalid_report"],
  ];
  for (const [payload, code] of cases) {
    const refused = await json(await post(payload));
    assert.equal(refused.status, 400, JSON.stringify(payload).slice(0, 60));
    assert.equal(refused.body.code, code);
  }
  const oversized = await json(
    await route.POST(
      new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "9999999" }, body: JSON.stringify({ openId: "o" }) }),
    ),
  );
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.code, "invalid_body");
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), before);
});

test("an engine with no settings surface, or whose schema cannot be read, answers no badges and writes nothing", async () => {
  const before = fs.readFileSync(ledgerPath, "utf8");
  const settings = harness.settings;

  schemaSettings = null;
  const unreadable = await json(await get());
  assert.equal(unreadable.status, 200);
  assert.deepEqual(unreadable.body, { engine: { id: "omp", version: null }, previousVersion: null, firstRun: false, newKeys: [], since: {}, fadeAfter: 3 });

  schemaSettings = [];
  assert.deepEqual((await json(await get())).body.newKeys, [], "an empty schema is not an engine that lost every setting");

  harness.settings = undefined;
  try {
    assert.deepEqual((await json(await get())).body.newKeys, []);
    assert.deepEqual((await json(await post({ openId: "o", seen: ["c.four"] }))).body.newKeys, []);
  } finally {
    harness.settings = settings;
  }
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), before, "the snapshot survives a look at an unreadable schema");
});

test("an engine version that cannot be read still diffs by key set and is reported as null", async () => {
  fs.rmSync(ledgerPath, { force: true });
  engineAt(null, BASE);
  const first = await json(await get());
  assert.equal(first.body.firstRun, true);
  assert.equal(first.body.engine.version, null);

  engineAt(null, UPGRADE);
  const upgraded = await json(await get());
  assert.deepEqual(upgraded.body.newKeys, ["c.four", "d.five"]);
  assert.deepEqual(upgraded.body.since, { "c.four": null, "d.five": null }, "an unreadable version is null, not a placeholder string");
  assert.equal(upgraded.body.previousVersion, null);

  // The schema's own version stands in when the engine's cannot be read.
  engineVersion = null;
  schemaVersion = "18.20.0";
  schemaSettings = [...UPGRADE, row("e.six")];
  const fromSchema = await json(await get());
  assert.equal(fromSchema.body.engine.version, "18.20.0");
  assert.equal(fromSchema.body.since["e.six"], "18.20.0");
});

// ── accounts ────────────────────────────────────────────────────────

test("with accounts, each person's views and changes are their own", async () => {
  fs.rmSync(ledgerPath, { force: true });
  engineAt("18.8.3", BASE);
  await get();
  engineAt("18.19.0", UPGRADE);
  await get();

  const ana = createUser({ username: "ana", fullName: "Ana", passwordHash: await hashPassword("ana-password-1"), role: "admin" });
  const ben = createUser({ username: "ben", fullName: "Ben", passwordHash: await hashPassword("ben-password-1"), role: "member" });
  const ANA = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(ana)}` };
  const BEN = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(ben)}` };

  const anonymous = await json(await get());
  assert.equal(anonymous.status, 401, "once accounts exist the badge answer is per person");
  assert.equal(anonymous.body.code, "auth_required");
  assert.equal((await json(await post({ openId: "o", seen: ["c.four"] }))).status, 401);

  assert.deepEqual((await json(await get(ANA))).body.newKeys, ["c.four", "d.five"], "the instance record's earlier counts do not carry over to accounts");
  for (const open of ["open-1", "open-2", "open-3"]) await post({ openId: open, seen: ["c.four"] }, ANA);
  await post({ openId: "open-4", changed: ["d.five"] }, ANA);
  assert.deepEqual((await json(await get(ANA))).body.newKeys, []);

  const benView = await json(await get(BEN));
  assert.equal(benView.status, 200, "a member may read and report their own badges");
  assert.deepEqual(benView.body.newKeys, ["c.four", "d.five"], "Ana's views never fade Ben's chips");
  await post({ openId: "open-1", seen: ["c.four"] }, BEN);
  assert.equal(ledger().users[ben.id].omp["c.four"].seen, 1, "Ben counts from his own zero, though the openId is the same string");
  assert.equal(ledger().users[ana.id].omp["c.four"].seen, 3);
  assert.deepEqual(Object.keys(ledger().users).sort(), [ana.id, ben.id].sort());
});
