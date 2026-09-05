import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The pure join behind GET /api/providers, run over the state the scratch
 * instance was in when the fixture was captured: omp 18.1.10's 70-entry
 * roster with Anthropic signed in, ANTHROPIC_API_KEY / OPENAI_API_KEY and
 * the AWS pair set on the container (no region), one custom models.yml
 * provider ("mock"), and a catalog of 233 models. That state must read as
 * FOUR connected rows plus Add — not 70 + 17 + 14 rows.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildProviderDirectory, sortConnectedRows, pickerRowsForGroup } = await jiti.import("./provider-directory.ts");
const { providersForEngine } = await jiti.import("./harness/provider-catalog.ts");

const fixture = JSON.parse(readFileSync(new URL("./harness/fixtures/omp-login-providers.json", import.meta.url), "utf8"));
const logins = fixture.providers;

/** describeProviders("omp") as it answered on the scratch instance. */
function keysFor(engineId, present) {
  return providersForEngine(engineId).map((definition) => ({
    id: definition.id,
    name: definition.name,
    variables: definition.variables.map((variable) => ({
      name: variable.name,
      label: variable.label,
      secret: variable.secret,
      ...(variable.hint ? { hint: variable.hint } : {}),
      stored: present.stored?.includes(variable.name) ?? false,
      fromEnvironment: present.env?.includes(variable.name) ?? false,
    })),
  }));
}

const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const COUNTS = { "amazon-bedrock": 149, openai: 54, anthropic: 24, mock: 1 };
const DIRECTORY = {
  modelsYmlProviders: [{ name: "mock", api: "openai-completions", baseUrl: "http://127.0.0.1:30190/v1", modelCount: 1 }],
  disabledProviders: [],
  providerOrder: [],
};

function ompRows(overrides = {}) {
  return buildProviderDirectory({
    logins,
    keys: keysFor("omp", { env: ENV }),
    counts: COUNTS,
    directory: DIRECTORY,
    catalog: providersForEngine("omp"),
    ...overrides,
  });
}

test("the fixture state is four connected rows on omp", () => {
  const rows = ompRows();
  const connected = sortConnectedRows(rows);
  assert.deepEqual(connected.map((row) => row.id), ["anthropic", "openai", "bedrock", "mock"]);

  const anthropic = connected[0];
  assert.equal(anthropic.modelCount, 24);
  // Signed in beats the key from the container: the OAuth method wins.
  const winner = anthropic.methods.find((method) => method.winning);
  assert.equal(winner.kind, "oauth");
  assert.equal(winner.state, "connected");
  assert.equal(winner.loginId, "anthropic");
  assert.equal(winner.canLogout, false);
  assert.equal(anthropic.group, "subscription");

  const openai = connected[1];
  // One row for the platform key AND the two Codex sign-ins.
  assert.deepEqual(openai.methods.map((method) => method.kind), ["oauth", "oauth", "env"]);
  assert.equal(openai.methods.find((method) => method.winning).kind, "env");
  assert.equal(openai.modelCount, 54);

  const bedrock = connected[2];
  // Keys say the region is missing; omp serves 149 models anyway. The row
  // is connected, the count is 149, and the missing variable is a hint.
  assert.equal(bedrock.modelCount, 149);
  const key = bedrock.methods.find((method) => method.kind === "env");
  assert.equal(key.state, "connected");
  assert.deepEqual(key.variables.filter((variable) => variable.optional).map((variable) => variable.name), ["AWS_REGION"]);
  assert.equal(key.variables.find((variable) => variable.name === "AWS_REGION").fromEnvironment, false);

  const mock = connected[3];
  assert.equal(mock.group, "custom");
  assert.equal(mock.methods[0].kind, "custom");
  assert.equal(mock.endpoint.baseUrl, "http://127.0.0.1:30190/v1");
  assert.equal(mock.modelCount, 1);
});

test("every roster id lands in exactly one row and one group, and rows are unique", () => {
  const rows = ompRows();
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "row ids are unique");
  const placed = new Map();
  for (const row of rows) {
    for (const method of row.methods) {
      if (!method.loginId) continue;
      assert.ok(!placed.has(method.loginId), `${method.loginId} appears on ${placed.get(method.loginId)} and ${row.id}`);
      placed.set(method.loginId, row.id);
    }
  }
  for (const login of logins) assert.ok(placed.has(login.id), `${login.id} was dropped from the directory`);
  for (const row of rows) assert.notEqual(row.group, undefined);
  // The join folds 70 logins + 15 keys + 1 custom into far fewer rows.
  assert.ok(rows.length < 70, `expected the join to collapse rows, got ${rows.length}`);
});

test("variants collapse under their card in the picker and stay separate rows", () => {
  const rows = ompRows();
  const xiaomiVariants = rows.filter((row) => row.variantOf === "xiaomi").map((row) => row.id).sort();
  assert.deepEqual(xiaomiVariants, ["xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"]);
  const subscriptions = pickerRowsForGroup(rows, "subscription");
  const xiaomi = subscriptions.find((card) => card.row.id === "xiaomi");
  assert.ok(xiaomi, "xiaomi is one card");
  assert.equal(xiaomi.variants.length, 3);
  assert.ok(!subscriptions.some((card) => card.row.id === "xiaomi-token-plan-cn"), "a variant is not its own card");
  // Connected rows never appear in the picker; popular ids lead their group.
  assert.ok(!subscriptions.some((card) => card.row.id === "anthropic"));
  const keys = pickerRowsForGroup(rows, "key");
  assert.equal(keys[0].row.id, "deepseek", "popular first (DeepSeek is the first unconnected popular key provider)");
  // xAI carries a SuperGrok sign-in beside its key, so it files as a subscription.
  assert.ok(subscriptions.some((card) => card.row.id === "xai"));
  // A joined row with several sign-ins carries them as methods, not variants.
  const google = rows.find((row) => row.id === "google");
  assert.deepEqual(google.methods.filter((method) => method.loginId).map((method) => method.loginId), ["google-gemini-cli", "google-antigravity"]);
});

test("a catalog id no row claims is listed under Other as connected", () => {
  const rows = ompRows({ counts: { ...COUNTS, "bedrock-mantle": 5 } });
  const mantle = rows.find((row) => row.id === "bedrock-mantle");
  assert.ok(mantle);
  assert.equal(mantle.connected, true);
  assert.equal(mantle.modelCount, 5);
  assert.equal(mantle.group, "other");
  assert.equal(sortConnectedRows(rows).length, 5);
});

test("disabled, ordered and read-only registry state lands on the rows", () => {
  const rows = ompRows({
    directory: { ...DIRECTORY, disabledProviders: ["amazon-bedrock"], providerOrder: ["openai", "anthropic"], readOnlyReason: "scoped" },
  });
  assert.equal(rows.find((row) => row.id === "bedrock").disabled, true);
  assert.equal(rows.find((row) => row.id === "openai").order, 0);
  assert.equal(rows.find((row) => row.id === "anthropic").order, 1);
  assert.equal(rows.find((row) => row.id === "bedrock").order, undefined);
  // Ordered rows lead the Connected list in their order.
  assert.deepEqual(sortConnectedRows(rows).map((row) => row.id), ["openai", "anthropic", "bedrock", "mock"]);
});

test("a key saved in Cody wins over the container's, and a partial key set is unset", () => {
  const rows = ompRows({ keys: keysFor("omp", { env: ["ANTHROPIC_API_KEY"], stored: ["ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID"] }), logins: [], counts: {} });
  const anthropic = rows.find((row) => row.id === "anthropic");
  assert.equal(anthropic.methods[0].kind, "key");
  assert.equal(anthropic.methods[0].state, "connected");
  assert.equal(anthropic.connected, true);
  const bedrock = rows.find((row) => row.id === "bedrock");
  assert.equal(bedrock.methods[0].state, "unset", "the secret is missing");
  assert.equal(bedrock.connected, false);
});

test("an ACP engine has null counts with the reason, and rows only from keys and sign-ins", () => {
  const rows = buildProviderDirectory({
    logins: [{ id: "claude", name: "Claude subscription (Pro/Max)", authenticated: true, kind: "oauth", canLogout: true }, { id: "anthropic-console", name: "Anthropic Console (API billing)", authenticated: false, kind: "oauth", canLogout: true }],
    keys: keysFor("claude", {}),
    counts: null,
    countsReason: "Models come from the session",
    directory: null,
    catalog: providersForEngine("claude"),
  });
  assert.equal(rows.length, 1, "Claude Code reaches one vendor");
  const anthropic = rows[0];
  assert.equal(anthropic.modelCount, null);
  assert.equal(anthropic.reason, "Models come from the session");
  assert.equal(anthropic.connected, true);
  assert.deepEqual(anthropic.methods.map((method) => method.loginId ?? method.kind), ["claude", "anthropic-console", "key"]);
  assert.equal(anthropic.methods[0].winning, true);
});

test("a cached read marks what it could not answer as pending, and never as a failure", () => {
  const rows = buildProviderDirectory({
    logins: null,
    keys: keysFor("omp", { env: ENV }),
    counts: null,
    directory: DIRECTORY,
    catalog: providersForEngine("omp"),
    pending: { counts: true, logins: true },
  });
  const openai = rows.find((row) => row.id === "openai");
  assert.equal(openai.pending, true);
  assert.equal(openai.modelCount, null);
  assert.equal(openai.reason, undefined);
  // A custom endpoint's count comes from the file, so it is never pending.
  const mock = rows.find((row) => row.id === "mock");
  assert.equal(mock.modelCount, 1);
  assert.equal(mock.pending, undefined);
});
