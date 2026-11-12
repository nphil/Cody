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

test("Cody's own Claude API credits providers never get a row of their own", () => {
  // One provider per saved key (`anthropic-api`, `anthropic-api-2`, …) serves the plan's models, so the
  // catalog counts them. They belong to the Anthropic row's "API credits (backup)" section; listed as
  // rows they would be extra, deletable providers whose removal silently breaks the credits.
  const rows = ompRows({ counts: { ...COUNTS, "anthropic-api": 24, "anthropic-api-2": 24, "bedrock-mantle": 5 } });
  assert.equal(rows.some((row) => /^anthropic-api/.test(row.id)), false);
  assert.equal(rows.some((row) => row.catalogIds.some((id) => /^anthropic-api/.test(id))), false);
  // Everything else unclaimed is still listed.
  assert.ok(rows.find((row) => row.id === "bedrock-mantle"));
  assert.equal(sortConnectedRows(rows).length, 5);
  // The Anthropic row itself still counts only the plan's models.
  assert.equal(rows.find((row) => row.id === "anthropic").modelCount, 24);
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

// The 2026-11 incident: the provider ended the only login, omp disabled it and
// reports the provider as nothing at all (not authenticated, no models). The
// row must still be where the owner looks, and say what to do.
test("a provider whose only login ended stays listed as signed out and is never offered as new", () => {
  const lost = { id: "7", label: "lost@example.com", position: 0, state: "signed_out", planType: null, resetsAt: null, canRemove: true };
  const rows = ompRows({
    logins: logins.map((login) => login.id === "anthropic" ? { ...login, authenticated: false, canLogout: true, accounts: [lost] } : login),
    keys: keysFor("omp", { env: ENV.filter((name) => name !== "ANTHROPIC_API_KEY") }),
    counts: { ...COUNTS, anthropic: 0 },
  });
  const anthropic = rows.find((row) => row.id === "anthropic");
  assert.equal(anthropic.connected, false);
  assert.equal(anthropic.signedOut, true);
  // First in the Connected list: it is the one that needs the owner.
  assert.equal(sortConnectedRows(rows)[0].id, "anthropic");
  assert.ok(!pickerRowsForGroup(rows, "subscription").some((card) => card.row.id === "anthropic"));
  // Healthy rows do not carry the flag.
  assert.equal(rows.find((row) => row.id === "openai").signedOut, undefined);
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

test("orderIds — the ids reorder/disable write to config.yml — never carry a login id", () => {
  const rows = ompRows();
  // Anthropic's roster carries Claude Code's and its own console login ids
  // (`claude`, `anthropic-console`); OpenAI's carries Codex's (`openai-codex`,
  // `openai-codex-device`, `chatgpt`). None of those belong in omp's own
  // `modelProviderOrder` / `disabledProviders` — only `catalogIds` (the join
  // list) should ever contain them.
  const anthropic = rows.find((row) => row.id === "anthropic");
  assert.deepEqual(anthropic.catalogIds.sort(), ["anthropic", "anthropic-console", "claude"]);
  assert.deepEqual(anthropic.orderIds, ["anthropic"]);

  const openai = rows.find((row) => row.id === "openai");
  assert.ok(openai.catalogIds.includes("chatgpt"), "catalogIds still carries the login ids as a join key");
  assert.deepEqual(openai.orderIds, ["openai"]);

  // A provider with a genuine second catalog id (Bedrock's model-catalog
  // name) keeps it in orderIds — it is a real provider id, not a login id.
  const bedrock = rows.find((row) => row.id === "bedrock");
  assert.deepEqual(bedrock.orderIds.sort(), ["amazon-bedrock", "bedrock"]);

  // A custom endpoint's own name is a real provider id.
  const mock = rows.find((row) => row.id === "mock");
  assert.deepEqual(mock.orderIds, ["mock"]);

  // No row's orderIds ever contains one of the other engines' login ids.
  const loginOnlyIds = ["claude", "anthropic-console", "openai-codex", "openai-codex-device", "chatgpt"];
  for (const row of rows) {
    for (const id of row.orderIds) assert.ok(!loginOnlyIds.includes(id), `${row.id}.orderIds leaked login id ${id}`);
  }

  // A bare sign-in the key catalogue never claimed (no confirmed provider
  // identity) carries no order id at all, and reorder/disable must skip it.
  const bare = buildProviderDirectory({
    logins: [{ id: "some-future-login", name: "Some Future Vendor", authenticated: true, kind: "oauth", canLogout: true }],
    keys: [],
    counts: null,
    directory: DIRECTORY,
    catalog: providersForEngine("omp"),
  }).find((row) => row.id === "some-future-login");
  assert.deepEqual(bare.orderIds, []);
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

/**
 * A models.yml entry that declares no endpoint and no models is an OVERRIDE
 * (a `cost`/`modelOverrides` block against a provider the engine already
 * knows — Cody's own pay-as-you-go price seed writes exactly that shape). It
 * is not a provider anyone configured, and reporting it as a custom endpoint
 * put a "connected" row for a prepaid plan on installs that had never signed
 * into it, observed on a brand-new instance with an empty agent dir.
 */
test("an override-only models.yml entry is not a configured provider", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "cody-provider-overrides-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:",
      "  alibaba-token-plan:",
      "    modelOverrides:",
      "      qwen3.8-max:",
      "        cost:",
      "          input: 2",
      "          output: 6",
      "  real-endpoint:",
      "    baseUrl: http://127.0.0.1:9999/v1",
      "    api: openai-completions",
      "",
    ].join("\n"));
    const { ompHarness } = await jiti.import("./harness/omp.ts");
    const names = ompHarness.providerDirectory().modelsYmlProviders.map((entry) => entry.name);
    assert.deepEqual(names, ["real-endpoint"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// omp 18.16.0 added a `mistral` sign-in; 18.9.2-18.19.0 added eight API-key
// vendors and the `devin-cli` / `devin-windsurf` sign-ins (both stored as
// provider `devin`). Names and ids are those recorded from each engine's
// `get_login_providers` (18.8.3: 81 entries, 18.19.0: 92, none removed).
const roster = (id, name) => ({ id, name, authenticated: false, kind: "oauth", canLogout: false });
const NEW_ROSTER_ENTRIES = [
  roster("devin-cli", "Devin (adopt CLI credentials)"),
  roster("devin-windsurf", "Devin (Windsurf Enterprise)"),
  roster("sambanova", "SambaNova"),
  roster("inception", "Inception"),
  roster("cloudflare-workers-ai", "Cloudflare Workers AI"),
  roster("liquid", "Liquid AI"),
  roster("coralbricks", "CoralBricks"),
  roster("modular", "Modular"),
  roster("mistral", "Mistral"),
  roster("scaleway", "Scaleway"),
  roster("otari", "Otari"),
];
const OLD_ROSTER = logins;
const NEW_ROSTER = [...logins, ...NEW_ROSTER_ENTRIES];

function rowsFor(roster, overrides = {}) {
  return ompRows({ logins: roster, counts: {}, ...overrides });
}

test("one Mistral row on either roster, and every row id is unique", () => {
  for (const roster of [OLD_ROSTER, NEW_ROSTER]) {
    const ids = rowsFor(roster).map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate row ids: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
    assert.equal(ids.filter((id) => id === "mistral").length, 1);
  }
  const mistral = rowsFor(NEW_ROSTER).find((row) => row.id === "mistral");
  assert.deepEqual(mistral.methods.filter((method) => method.loginId).map((method) => method.loginId), ["mistral"]);
  // Nothing in the old roster to sign in to: the row is just the key.
  assert.deepEqual(rowsFor(OLD_ROSTER).find((row) => row.id === "mistral").methods.filter((method) => method.loginId), []);
});

test("a roster id equal to a catalogue row's id merges into that row even when the catalogue does not list it", () => {
  // The state before the Mistral loginIds fix: the catalogue entry names no login.
  const catalog = providersForEngine("omp").map((definition) => (definition.id === "mistral" ? { ...definition, loginIds: undefined } : definition));
  const rows = rowsFor(NEW_ROSTER, { catalog });
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  const mistral = rows.find((row) => row.id === "mistral");
  assert.deepEqual(mistral.methods.filter((method) => method.loginId).map((method) => method.loginId), ["mistral"]);
  assert.ok(mistral.catalogIds.includes("mistral"));
  // The sign-in is placed exactly once.
  assert.equal(rows.flatMap((row) => row.methods).filter((method) => method.loginId === "mistral").length, 1);
});

test("the eight new API-key vendors are curated rows only on an engine whose roster has them", () => {
  const NEW = ["cloudflare-workers-ai", "coralbricks", "inception", "liquid", "modular", "otari", "sambanova", "scaleway"];
  const onOld = rowsFor(OLD_ROSTER).map((row) => row.id);
  for (const id of NEW) assert.ok(!onOld.includes(id), `${id} must not be offered on an engine that lacks it`);
  const onNew = rowsFor(NEW_ROSTER);
  for (const id of NEW) {
    const row = onNew.find((candidate) => candidate.id === id);
    assert.ok(row, `${id} is a row on the new roster`);
    assert.ok(row.methods.some((method) => method.loginId === id), `${id} keeps its sign-in method`);
    assert.ok(["key", "gateway"].includes(row.group), `${id} files under key or gateway, got ${row.group}`);
    assert.notEqual(row.name, id, `${id} has a proper display name`);
  }
  assert.equal(onNew.find((row) => row.id === "otari").group, "gateway");
  // None of them is a bare "Other" row: the catalogue claimed every one.
  assert.ok(!onNew.some((row) => NEW.includes(row.id) && row.group === "other"));
});

test("a key already saved for a newer vendor keeps its row on an engine that lacks it", () => {
  const rows = rowsFor(OLD_ROSTER, { keys: keysFor("omp", { stored: ["SAMBANOVA_API_KEY"] }) });
  const sambanova = rows.find((row) => row.id === "sambanova");
  assert.ok(sambanova);
  assert.equal(sambanova.methods[0].kind, "key");
});

test("Devin's three sign-ins and its key are one row", () => {
  const devin = rowsFor(NEW_ROSTER).find((row) => row.id === "devin");
  assert.deepEqual(devin.methods.filter((method) => method.loginId).map((method) => method.loginId), ["devin", "devin-cli", "devin-windsurf"]);
  assert.equal(devin.group, "subscription");
  const rows = rowsFor(NEW_ROSTER);
  assert.ok(!rows.some((row) => row.id === "devin-cli" || row.id === "devin-windsurf"), "the new ids are methods, not rows");
  // The old roster has only `devin`: the row simply has one sign-in.
  assert.deepEqual(rowsFor(OLD_ROSTER).find((row) => row.id === "devin").methods.filter((method) => method.loginId).map((method) => method.loginId), ["devin"]);
});

test("every roster id lands in exactly one row on the new roster", () => {
  const rows = rowsFor(NEW_ROSTER);
  const placed = new Map();
  for (const row of rows) {
    for (const method of row.methods) {
      if (!method.loginId) continue;
      assert.ok(!placed.has(method.loginId), `${method.loginId} appears on ${placed.get(method.loginId)} and ${row.id}`);
      placed.set(method.loginId, row.id);
    }
  }
  for (const login of NEW_ROSTER) assert.ok(placed.has(login.id), `${login.id} was dropped`);
});

// The two rosters below are the real ones: every sign-in omp 18.8.3 and 18.19.0
// report (81 and 92 entries), recorded as data. Row ids are React keys and the
// route key for a provider, so they must be unique on both.
const REAL_ROSTERS = {
  "18.8.3": JSON.parse(readFileSync(new URL("./harness/fixtures/omp-login-roster-18.8.3.json", import.meta.url), "utf8")).providers,
  "18.19.0": JSON.parse(readFileSync(new URL("./harness/fixtures/omp-login-roster-18.19.0.json", import.meta.url), "utf8")).providers,
};

test("the real 18.8.3 and 18.19.0 rosters give unique row ids and place every sign-in once", () => {
  assert.equal(REAL_ROSTERS["18.8.3"].length, 81);
  assert.equal(REAL_ROSTERS["18.19.0"].length, 92);
  for (const [version, roster] of Object.entries(REAL_ROSTERS)) {
    const rows = rowsFor(roster);
    const ids = rows.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `${version}: duplicate row ids ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
    const placed = rows.flatMap((row) => row.methods.map((method) => method.loginId)).filter(Boolean);
    assert.equal(new Set(placed).size, placed.length, `${version}: a sign-in sits on two rows`);
    for (const login of roster) assert.ok(placed.includes(login.id), `${version}: ${login.id} was dropped`);
  }
  const rows = rowsFor(REAL_ROSTERS["18.19.0"]);
  assert.equal(rows.filter((row) => row.id === "mistral").length, 1);
  // The new roster's vendors are proper rows, not stray ones.
  for (const id of ["cloudflare-workers-ai", "coralbricks", "inception", "liquid", "modular", "otari", "sambanova", "scaleway"]) {
    assert.ok(rows.some((row) => row.id === id && row.name !== id), `${id} is a named row`);
  }
});

test("a sign-in the engine refuses over RPC is a terminal-only method, and only that one", () => {
  const roster = REAL_ROSTERS["18.19.0"].map((login) => (login.id === "google-antigravity" ? { ...login, terminalOnly: true } : login));
  const google = rowsFor(roster).find((row) => row.id === "google");
  const byId = Object.fromEntries(google.methods.filter((method) => method.loginId).map((method) => [method.loginId, method]));
  assert.equal(byId["google-antigravity"].terminalOnly, true);
  assert.equal(byId["google-gemini-cli"].terminalOnly, undefined);
  // Without the flag nothing is marked (an engine that still opens the browser).
  const plain = rowsFor(REAL_ROSTERS["18.8.3"]).find((row) => row.id === "google");
  assert.ok(plain.methods.every((method) => method.terminalOnly === undefined));
});
