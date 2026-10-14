import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { parse } from "yaml";
import { createFakeOmpPackage, FAKE_PLAN_MODELS } from "./fixtures/claude-credits/fake-omp-package.mjs";
import {
  addFakeRows,
  FAKE_CREDENTIALS_HELPER,
  FAKE_KEYS_HELPER,
  fakeCreditsKeys,
  openGate,
  planAccount,
  readOperations,
  setFault,
  updateFakeStore,
  waitUntilHeld,
  watchFiles,
} from "./fixtures/claude-credits/fake-omp-store.mjs";

/**
 * The server side of the Claude API credits, against a THROWAWAY agent dir and fake bridges.
 *
 * The bridges are two small node scripts that print the same JSON frames the real Bun helpers
 * print (fixtures/claude-credits/), over one JSON file standing in for omp's credential store;
 * the model list comes from a fake omp package. Nothing here touches the instance's own agent
 * dir or omp. The real helpers, against the real AuthStorage and a real omp, are
 * claude-credits-omp.test.mjs.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "cody-claude-credits-"));
const fakeOmp = createFakeOmpPackage(scratch);
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CODY_PACKAGE_DIR", "PI_CONFIG_FILES", "CODY_OMP_BIN", "HOME", "OMP_PROFILE", "PI_PROFILE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent-initial");
process.env.CODY_PACKAGE_DIR = repoRoot;
process.env.PI_CONFIG_FILES = "";
process.env.CODY_OMP_BIN = fakeOmp.bin;
process.env.HOME = scratch;
// A named omp profile outranks PI_CODING_AGENT_DIR: never let one point these tests at a real agent dir.
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const credits = await jiti.import("./claude-credits.ts");
const overlay = await jiti.import("./claude-credits-overlay.ts");
const creditsStore = await jiti.import("./claude-credits-store.ts");
const { invalidateOmpCliCache } = await jiti.import("./omp-cli.ts");

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  invalidateOmpCliCache();
  rmSync(scratch, { recursive: true, force: true });
});

// Obviously fake: these never leave the machine, and each ends in four distinguishable characters.
const KEY_1 = "sk-ant-api03-FAKE-first-0001";
const KEY_2 = "sk-ant-api03-FAKE-second-0002";
const KEY_3 = "sk-ant-api03-FAKE-third-0003";
const BASE_URL = "http://127.0.0.1:9"; // nothing listens: these tests never send a request
// The ids omp and models.yml know the credits by: spelled out here on purpose, they are the contract.
const FAMILY = ["anthropic-api", "anthropic-api-2", "anthropic-api-3", "anthropic-api-4", "anthropic-api-5", "anthropic-api-6", "anthropic-api-7", "anthropic-api-8"];

/** A fresh agent dir with two Claude plan accounts in the fake omp store. */
let counter = 0;
function freshAgent({ plans = [planAccount("nitin@example.test"), planAccount("nathan@example.test")] } = {}) {
  const dir = path.join(scratch, `agent-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dir;
  const planIds = addFakeRows(dir, plans);
  const bridge = (helperPath) => ({ helperPath, bunBin: process.execPath, packageRoot: () => fakeOmp.root, agentDir: () => dir });
  const ctx = {
    dir,
    planIds,
    modelsYml: path.join(dir, "models.yml"),
    config: path.join(dir, "config.yml"),
    codyStore: creditsStore.getClaudeCreditsStorePath(),
    deps: { credentials: bridge(FAKE_CREDENTIALS_HELPER), keys: bridge(FAKE_KEYS_HELPER), baseUrl: BASE_URL },
  };
  // Every operation omp is asked to do records what Cody's own store looked like at that moment.
  watchFiles(dir, [ctx.codyStore]);
  return ctx;
}

const text = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const savedKeys = (ctx) => fakeCreditsKeys(ctx.dir).map((row) => row.key);
const savedProviders = (ctx) => parse(text(ctx.modelsYml) ?? "")?.providers ?? {};

async function rejectsWith(action, code, status) {
  const error = await action().then(() => null, (reason) => reason);
  assert.ok(error, `expected a rejection with ${code}`);
  assert.equal(error.name, "ClaudeCreditsError", error.stack);
  assert.equal(error.code, code, error.message);
  if (status !== undefined) assert.equal(error.status, status);
  return error;
}

/** Nothing the browser can see, and nothing Cody writes down, may hold a key. */
function assertNoKey(label, value, ...keys) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of keys) {
    assert.ok(!body.includes(key), `${label} holds a full key`);
    assert.ok(!body.includes(key.slice("sk-ant-api03-".length)), `${label} holds most of a key`);
  }
}

// ── The models.yml block ─────────────────────────────────────────────────────

test("the credits' provider block is added once, mirrors omp's Claude models, and a second sync writes nothing", () => {
  const { modelsYml } = freshAgent();
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: BASE_URL }), { changed: true });
  const written = text(modelsYml);
  assert.deepEqual(parse(written), {
    providers: {
      "anthropic-api": {
        baseUrl: BASE_URL,
        api: "anthropic-messages",
        // The key is in omp's credential store, never here: `none` demands no apiKey and forces no OAuth shaping.
        auth: "none",
        models: [
          { id: "claude-haiku-5-5", name: "claude-haiku-5-5 (API credits)" },
          { id: "claude-opus-5-5", name: "Claude Opus 5.5 (API credits)" },
          { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (API credits)" },
        ],
      },
    },
  });
  assert.doesNotMatch(written, /apiKey|sk-ant/);
  assert.doesNotMatch(written, /gpt-6-astra/, "only Claude models belong to the credits");

  const before = statSync(modelsYml).mtimeMs;
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: BASE_URL }), { changed: false });
  assert.equal(text(modelsYml), written);
  assert.equal(statSync(modelsYml).mtimeMs, before, "an unchanged block is not rewritten");
});

test("every key's provider has a block of its own, named for its slot, and each goes when its own key does", () => {
  const { modelsYml } = freshAgent();
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL }), { changed: true });
  let providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers), ["anthropic-api", "anthropic-api-2"]);
  for (const name of Object.keys(providers)) {
    assert.deepEqual(Object.keys(providers[name]).sort(), ["api", "auth", "baseUrl", "models"]);
    assert.deepEqual([providers[name].api, providers[name].auth, providers[name].baseUrl], ["anthropic-messages", "none", BASE_URL]);
    assert.deepEqual(providers[name].models.map((model) => model.id), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  }
  // The model names say which key's credits serve them: that is all the model picker shows of the difference.
  assert.deepEqual(providers["anthropic-api"].models.map((model) => model.name), ["claude-haiku-5-5 (API credits)", "Claude Opus 5.5 (API credits)", "Claude Sonnet 5.5 (API credits)"]);
  assert.deepEqual(providers["anthropic-api-2"].models.map((model) => model.name), ["claude-haiku-5-5 (API credits 2)", "Claude Opus 5.5 (API credits 2)", "Claude Sonnet 5.5 (API credits 2)"]);
  assert.doesNotMatch(text(modelsYml), /apiKey|sk-ant/);
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL }), { changed: false });
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api-2", "anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL }), { changed: false }, "the order and repeats of the list do not matter");

  // The first key goes; the second keeps its block, untouched.
  const second = providers["anthropic-api-2"];
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api-2"]), { changed: true });
  providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers), ["anthropic-api-2"]);
  assert.deepEqual(providers["anthropic-api-2"], second);

  // The first slot is free again: a key that comes next lands there, and its block is named for the first slot.
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"]), { changed: true });
  providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers).sort(), ["anthropic-api", "anthropic-api-2"]);
  assert.equal(providers["anthropic-api"].models[1].name, "Claude Opus 5.5 (API credits)");
  assert.equal(providers["anthropic-api"].baseUrl, BASE_URL, "inherited from the block that was already there");

  assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: true });
  assert.deepEqual(savedProviders({ modelsYml }), {});
  assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: false }, "removing what is not there changes nothing");
});

test("all eight slots can hold a block, each named for its own number, and what is not one of them is never written", () => {
  const { modelsYml } = freshAgent();
  const family = FAMILY;
  assert.deepEqual(credits.syncClaudeCreditsProviders(family, { baseUrl: BASE_URL }), { changed: true });
  const providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers), family);
  family.forEach((name, slot) => {
    assert.equal(providers[name].models[1].name, `Claude Opus 5.5 (API credits${slot === 0 ? "" : ` ${slot + 1}`})`, name);
  });
  assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: true });

  // A name outside the family — the plans' own pool above all — is never turned into a block.
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic", "anthropic-api-9", "anthropic-api-1", "openai-codex"], { baseUrl: BASE_URL }), { changed: false });
  assert.equal(existsSync(modelsYml), true);
  assert.deepEqual(savedProviders({ modelsYml }), {});
});

test("the block follows a changed address or model list, and goes when the last key does", () => {
  const { modelsYml } = freshAgent();
  credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: BASE_URL });
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: "http://127.0.0.1:10" }), { changed: true });
  assert.equal(parse(text(modelsYml)).providers["anthropic-api"].baseUrl, "http://127.0.0.1:10");
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: "http://127.0.0.1:10", models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] }), { changed: true });
  assert.deepEqual(parse(text(modelsYml)).providers["anthropic-api"].models, [{ id: "claude-opus-5-5", name: "Claude Opus 5.5 (API credits)" }]);
  assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: true });
  assert.deepEqual(savedProviders({ modelsYml }), {});
  assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: false }, "removing what is not there changes nothing");
});

test("a new block points at Anthropic's API; an existing block keeps the address it has unless a sync names another", () => {
  const { modelsYml } = freshAgent();
  credits.syncClaudeCreditsProviders(["anthropic-api"]);
  assert.equal(savedProviders({ modelsYml })["anthropic-api"].baseUrl, "https://api.anthropic.com", "no block yet and no address given: the real API");

  // Someone pointed the block at a gateway: a sync that names no address leaves it there…
  credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: "http://127.0.0.1:10" });
  const settled = text(modelsYml);
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api"]), { changed: false });
  assert.equal(text(modelsYml), settled);
  // …even when it is the model list that changed.
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api"], { models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] }), { changed: true });
  const block = savedProviders({ modelsYml })["anthropic-api"];
  assert.equal(block.baseUrl, "http://127.0.0.1:10");
  assert.deepEqual(block.models, [{ id: "claude-opus-5-5", name: "Claude Opus 5.5 (API credits)" }]);

  // A sync that does name one wins, for every block it writes.
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL, models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] }), { changed: true });
  assert.deepEqual(Object.values(savedProviders({ modelsYml })).map((provider) => provider.baseUrl), [BASE_URL, BASE_URL]);
});

test("a block that appears later inherits the first block's address, and the blocks already there keep their own", () => {
  const { modelsYml } = freshAgent();
  // The first key's block was pointed at a gateway (that is the address new blocks follow)…
  credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: "http://127.0.0.1:10" });
  credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"]);
  assert.deepEqual(Object.values(savedProviders({ modelsYml })).map((provider) => provider.baseUrl), ["http://127.0.0.1:10", "http://127.0.0.1:10"]);

  // …and when it is the SECOND block that someone repointed, the first still sets the example and the second keeps its own.
  writeFileSync(modelsYml, text(modelsYml).replace(/(anthropic-api-2:\n\s+baseUrl: )\S+/, "$1http://127.0.0.1:11"));
  assert.equal(savedProviders({ modelsYml })["anthropic-api-2"].baseUrl, "http://127.0.0.1:11");
  assert.deepEqual(credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2", "anthropic-api-3"]), { changed: true });
  const providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers), ["anthropic-api", "anthropic-api-2", "anthropic-api-3"]);
  assert.deepEqual(Object.values(providers).map((provider) => provider.baseUrl), ["http://127.0.0.1:10", "http://127.0.0.1:11", "http://127.0.0.1:10"]);

  // With the first block gone the next block in slot order sets the example.
  credits.syncClaudeCreditsProviders(["anthropic-api-2", "anthropic-api-3"]);
  credits.syncClaudeCreditsProviders(["anthropic-api-2", "anthropic-api-3", "anthropic-api-4"]);
  assert.equal(savedProviders({ modelsYml })["anthropic-api-4"].baseUrl, "http://127.0.0.1:11");
});

test("syncing keeps the user's comments and every other provider, in and out", () => {
  const { modelsYml } = freshAgent();
  writeFileSync(modelsYml, [
    "# my hand-written models",
    "providers:",
    "  llama-swap: # the local server",
    "    baseUrl: http://127.0.0.1:8080/v1",
    "    api: openai-completions",
    "    auth: none",
    "    models:",
    "      - id: qwen3.8-27b",
    "        contextWindow: 24576",
    "",
  ].join("\n"));
  const llama = parse(text(modelsYml)).providers["llama-swap"];

  credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL });
  let providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers).sort(), ["anthropic-api", "anthropic-api-2", "llama-swap"]);
  assert.deepEqual(providers["llama-swap"], llama);
  assert.match(text(modelsYml), /# my hand-written models/);
  assert.match(text(modelsYml), /# the local server/);

  credits.syncClaudeCreditsProviders(["anthropic-api-2"]);
  assert.deepEqual(Object.keys(savedProviders({ modelsYml })).sort(), ["anthropic-api-2", "llama-swap"]);

  credits.syncClaudeCreditsProviders([]);
  providers = savedProviders({ modelsYml });
  assert.deepEqual(Object.keys(providers), ["llama-swap"]);
  assert.deepEqual(providers["llama-swap"], llama);
  assert.match(text(modelsYml), /# my hand-written models/);
  assert.match(text(modelsYml), /# the local server/);
});

test("a hand-written provider under one of the credits' names is never overwritten and never removed, in any slot", () => {
  for (const { lines, validForOmp } of [
    // A key of its own: the user's provider.
    { lines: ["    baseUrl: https://my-proxy.example.test", "    api: anthropic-messages", "    apiKey: MY_OWN_ENV_VAR", "    models:", "      - id: claude-opus-5-5"], validForOmp: true },
    // Another wire protocol.
    { lines: ["    baseUrl: https://my-proxy.example.test/v1", "    api: openai-completions", "    auth: none", "    models:", "      - id: claude-opus-5-5"], validForOmp: true },
    // The plan's protocol, but still asking omp for a key. (omp itself would refuse this file: custom models need an apiKey or `auth: none`.)
    { lines: ["    baseUrl: https://my-proxy.example.test", "    api: anthropic-messages", "    models:", "      - id: claude-opus-5-5"], validForOmp: false },
  ]) {
    for (const name of ["anthropic-api", "anthropic-api-2", "anthropic-api-8"]) {
      const ctx = freshAgent();
      writeFileSync(ctx.modelsYml, ["providers:", `  ${name}:`, ...lines, ""].join("\n"));
      const before = text(ctx.modelsYml);
      const mine = parse(before).providers[name];
      assert.deepEqual(credits.readClaudeCreditsProvider(name), { present: true, owned: false, modelIds: ["claude-opus-5-5"] }, name);

      // Asked to serve it — alone or among the others — the whole sync is refused and not a byte is written.
      for (const wanted of [[name], FAMILY]) {
        assert.throws(
          () => credits.syncClaudeCreditsProviders(wanted, { baseUrl: BASE_URL }),
          (error) => error.name === "ClaudeCreditsError" && error.code === "claude_credits_unavailable" && error.status === 409 && error.message.includes(`"${name}"`),
          `${name} wanted with ${wanted.length}`,
        );
        assert.equal(text(ctx.modelsYml), before, "models.yml is byte-for-byte what the user wrote");
      }
      // Removing the credits must not remove the user's own provider.
      assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: false });
      assert.equal(text(ctx.modelsYml), before);

      // The other keys' providers are still served beside it, and still removed again, leaving it alone.
      if (validForOmp) {
        const others = ["anthropic-api", "anthropic-api-2"].filter((other) => other !== name);
        assert.deepEqual(credits.syncClaudeCreditsProviders(others, { baseUrl: BASE_URL }), { changed: true });
        assert.deepEqual(Object.keys(savedProviders(ctx)).sort(), [...others, name].sort());
        assert.deepEqual(savedProviders(ctx)[name], mine);
        credits.syncClaudeCreditsProviders([]);
        assert.deepEqual(Object.keys(savedProviders(ctx)), [name]);
        assert.deepEqual(savedProviders(ctx)[name], mine);
      }

      // …and it never counts as the credits being on.
      creditsStore.writeClaudeCreditsStore([{ keyId: 3, provider: name, account: "nitin@example.test", addedAt: "2026-10-01T00:00:00.000Z" }]);
      assert.equal(credits.readClaudeCreditsRouting().active, false, name);
    }
  }
});

test("an unreadable models.yml is refused, not repaired: the user's providers are not ours to overwrite", () => {
  const { modelsYml } = freshAgent();
  const broken = "providers:\n  llama-swap: {baseUrl: [unclosed\n";
  writeFileSync(modelsYml, broken);
  for (const wanted of [["anthropic-api"], ["anthropic-api", "anthropic-api-2"], []]) {
    assert.throws(() => credits.syncClaudeCreditsProviders(wanted, { baseUrl: BASE_URL }), (error) => error.name === "ClaudeCreditsError" && error.code === "claude_credits_unavailable" && error.status === 409);
  }
  assert.equal(text(modelsYml), broken);
  assert.deepEqual(credits.readClaudeCreditsProvider(), { present: false, owned: false, modelIds: [] });
  assert.deepEqual(credits.readClaudeCreditsProvider("anthropic-api-2"), { present: false, owned: false, modelIds: [] });
});

test("without a readable list of omp's Claude models a block is refused and nothing is written, but taking blocks away needs no list", () => {
  const { modelsYml } = freshAgent();
  credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL });
  const withBoth = text(modelsYml);
  rmSync(modelsYml);
  process.env.CODY_OMP_BIN = path.join(scratch, "no-omp-installed-here");
  invalidateOmpCliCache();
  try {
    assert.equal(credits.readClaudePlanModels(), null);
    for (const wanted of [["anthropic-api"], ["anthropic-api", "anthropic-api-2"]]) {
      assert.throws(() => credits.syncClaudeCreditsProviders(wanted, { baseUrl: BASE_URL }), (error) => error.name === "ClaudeCreditsError" && error.code === "claude_credits_unavailable" && error.status === 503);
    }
    assert.equal(existsSync(modelsYml), false);
    assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: false }, "nothing wanted needs no catalog");

    // The last key's removal must not depend on the catalog either: its blocks go without a list of models.
    writeFileSync(modelsYml, withBoth);
    assert.deepEqual(credits.syncClaudeCreditsProviders([]), { changed: true });
    assert.deepEqual(savedProviders({ modelsYml }), {});
  } finally {
    process.env.CODY_OMP_BIN = fakeOmp.bin;
    invalidateOmpCliCache();
  }
});

test("omp's Claude models come from its own catalog: id-sorted, display name or id, and re-read when the catalog changes", () => {
  assert.deepEqual(credits.readClaudePlanModels(fakeOmp.root), [
    { id: "claude-haiku-5-5", name: "claude-haiku-5-5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ]);
  assert.deepEqual(credits.readClaudePlanModels().map((model) => model.id), FAKE_PLAN_MODELS.map((model) => model.id).sort(), "the default root is the omp that CODY_OMP_BIN names");

  const other = createFakeOmpPackage(path.join(scratch, "other-catalog"), { anthropic: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
  assert.deepEqual(credits.readClaudePlanModels(other.root), [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
  // Rewritten with a later mtime: the cache is keyed on it.
  const catalog = JSON.parse(readFileSync(other.models, "utf8"));
  catalog.anthropic["claude-sonnet-5-5"] = { name: "Claude Sonnet 5.5" };
  writeFileSync(other.models, JSON.stringify(catalog));
  const later = new Date(Date.now() + 10_000);
  utimesSync(other.models, later, later);
  assert.deepEqual(credits.readClaudePlanModels(other.root).map((model) => model.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);

  // Nothing to mirror, an unreadable catalog and no package at all are all "unknown", never an empty block.
  const empty = createFakeOmpPackage(path.join(scratch, "empty-catalog"), { anthropic: [] });
  assert.equal(credits.readClaudePlanModels(empty.root), null);
  const broken = createFakeOmpPackage(path.join(scratch, "broken-catalog"));
  writeFileSync(broken.models, "{ not json");
  assert.equal(credits.readClaudePlanModels(broken.root), null);
  assert.equal(credits.readClaudePlanModels(null), null);
});

test("the credits are 'on' only while a key is saved AND models.yml serves it, and the routing says how many keys there are and where they live", () => {
  const { modelsYml } = freshAgent();
  const key = { keyId: 3, provider: "anthropic-api", account: "nitin@example.test", addedAt: "2026-10-01T00:00:00.000Z" };
  const secondKey = { keyId: 4, provider: "anthropic-api-2", account: "nathan@example.test", addedAt: "2026-10-02T00:00:00.000Z" };
  const nothing = { active: false, modelIds: new Set(), keyCount: 0, providers: [] };
  assert.deepEqual(credits.readClaudeCreditsRouting(), nothing);

  creditsStore.writeClaudeCreditsStore([key]);
  assert.equal(credits.readClaudeCreditsRouting().active, false, "a key with nothing serving it");

  credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: BASE_URL });
  const routing = credits.readClaudeCreditsRouting();
  assert.equal(routing.active, true);
  assert.equal(routing.keyCount, 1);
  assert.deepEqual(routing.providers, ["anthropic-api"]);
  assert.deepEqual([...routing.modelIds].sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.deepEqual(credits.readClaudeCreditsProvider(), { present: true, owned: true, modelIds: ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"] });

  // A second key whose provider has no block yet is not served: it is not counted.
  creditsStore.writeClaudeCreditsStore([key, secondKey]);
  assert.equal(credits.readClaudeCreditsRouting().keyCount, 1);
  assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api"]);

  // Routing judges "the credits are spent" against this count: every key a block serves must be blocked.
  credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: BASE_URL });
  const both = credits.readClaudeCreditsRouting();
  assert.equal(both.keyCount, 2);
  assert.deepEqual(both.providers, ["anthropic-api", "anthropic-api-2"], "in slot order: the order the chain tries them in");
  assert.deepEqual([...both.modelIds].sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"], "the union of what the blocks serve");

  // The order of the store does not decide the order of the chain.
  creditsStore.writeClaudeCreditsStore([secondKey, key]);
  assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api", "anthropic-api-2"]);

  // A block with no key behind it is not served either: only the second key is saved, so only its provider counts.
  creditsStore.writeClaudeCreditsStore([secondKey]);
  assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api-2"]);
  assert.equal(credits.readClaudeCreditsRouting().keyCount, 1);

  creditsStore.writeClaudeCreditsStore([]);
  assert.deepEqual(credits.readClaudeCreditsRouting(), nothing, "blocks with no key behind them");

  // A block that serves no model cannot answer for any.
  creditsStore.writeClaudeCreditsStore([key]);
  credits.syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: BASE_URL, models: [] });
  assert.equal(credits.readClaudeCreditsRouting().active, false);
  assert.ok(text(modelsYml).includes("anthropic-api"));
});

// ── What an Anthropic API key looks like ─────────────────────────────────────

test("an Anthropic API key is accepted; a sign-in token, an admin key and anything malformed are named for what they are", () => {
  for (const good of ["sk-ant-api03-FAKE-first-0001", `sk-ant-api03-${"A".repeat(93)}AA`, "sk-ant-api01-FAKE-an-older-key-0001"]) {
    assert.doesNotThrow(() => credits.checkClaudeApiKeyShape(good), good);
  }
  const cases = [
    // The sign-in token of a plan: the very thing the plans already use, and omp would send it as OAuth.
    ["sk-ant-oat01-FAKE-login-token-0001", "claude_credits_login_token"],
    ["sk-ant-oat02-FAKE-login-token-0002", "claude_credits_login_token"],
    // Other Anthropic credentials that cannot call the Messages API.
    ["sk-ant-admin01-FAKE-admin-key-0001", "claude_credits_invalid_key"],
    ["sk-ant-sid01-FAKE-session-key-0001", "claude_credits_invalid_key"],
    // Not Anthropic's at all.
    ["sk-proj-FAKE-someone-elses-key-0001", "claude_credits_invalid_key"],
    ["FAKE-no-prefix-at-all-0001", "claude_credits_invalid_key"],
    // Too short, too long, empty.
    ["sk-ant-api03-short", "claude_credits_invalid_key"],
    [`sk-ant-api03-${"A".repeat(600)}`, "claude_credits_invalid_key"],
    ["", "claude_credits_invalid_key"],
    // Whitespace and control characters, inside or around the key.
    ["sk-ant-api03-FAKE with a space-0001", "claude_credits_invalid_key"],
    ["sk-ant-api03-FAKE\nnewline-0001", "claude_credits_invalid_key"],
    ["sk-ant-api03-FAKE\ttab-0001-xxxx", "claude_credits_invalid_key"],
    [" sk-ant-api03-FAKE-leading-0001", "claude_credits_invalid_key"],
    ["sk-ant-api03-FAKE-trailing-0001 ", "claude_credits_invalid_key"],
    ["sk-ant-api03-FAKE\u0000nul-0001-xxx", "claude_credits_invalid_key"],
    ["sk-ant-api03-FAKE\u007fdel-0001-xxx", "claude_credits_invalid_key"],
  ];
  for (const [key, code] of cases) {
    let error;
    try {
      credits.checkClaudeApiKeyShape(key);
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, `${JSON.stringify(key.slice(0, 40))} should be refused`);
    assert.equal(error.name, "ClaudeCreditsError");
    assert.equal(error.code, code, JSON.stringify(key.slice(0, 40)));
    assert.equal(error.status, 400);
    assert.ok(!error.message.includes(key.trim()) || key.trim() === "", "the refusal never echoes what was typed");
  }
});

test("the route's error shape keeps a code for what Cody raised and says nothing of anything else", () => {
  const known = new credits.ClaudeCreditsError("claude_credits_duplicate_key", "That key is already saved for another account.", 409);
  assert.deepEqual(credits.describeClaudeCreditsError(known), { message: "That key is already saved for another account.", code: "claude_credits_duplicate_key", status: 409 });
  // An unexpected failure may carry a key in its text: none of it is passed on.
  const unexpected = credits.describeClaudeCreditsError(new Error(`spawn failed for ${KEY_1}`));
  assert.deepEqual(unexpected, { message: "The Claude API key could not be saved.", status: 500 });
  assertNoKey("an unexpected failure's description", unexpected, KEY_1);
  assert.deepEqual(credits.describeClaudeCreditsError("nope"), { message: "The Claude API key could not be saved.", status: 500 });
});

// ── The overlay ──────────────────────────────────────────────────────────────

/** The credits are on: a key is recorded for each of `providers` and models.yml serves them. */
function turnCreditsOn(providers = ["anthropic-api"]) {
  const accounts = ["nitin@example.test", "nathan@example.test", "third@example.test"];
  creditsStore.writeClaudeCreditsStore(providers.map((provider, index) => ({ keyId: 3 + index, provider, account: accounts[index], addedAt: "2026-10-01T00:00:00.000Z" })));
  credits.syncClaudeCreditsProviders(providers, { baseUrl: BASE_URL });
}
const overlayDirectory = (dir) => path.join(dir, "cody-claude-credits");
const overlayFiles = (dir) => (existsSync(overlayDirectory(dir)) ? readdirSync(overlayDirectory(dir)).sort() : []);
const chainsOf = (file) => parse(text(file)).retry.fallbackChains;

test("with no credits saved there is no overlay, and nothing is created for one", () => {
  const { dir } = freshAgent();
  writeFileSync(path.join(dir, "config.yml"), "retry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-astra]\n");
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), null);
  creditsStore.writeClaudeCreditsStore([{ keyId: 3, provider: "anthropic-api", account: "nitin@example.test", addedAt: "2026-10-01T00:00:00.000Z" }]);
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), null, "a key that models.yml does not serve");
  assert.equal(existsSync(overlayDirectory(dir)), false);
});

test("the overlay puts the credits first in the chains the chat will actually have: config.yml, then each layer", () => {
  const { dir } = freshAgent();
  writeFileSync(path.join(dir, "config.yml"), [
    "retry:",
    "  fallbackChains:",
    "    default: [openai-codex/gpt-6-astra, anthropic/claude-opus-5-5]",
    "    slow: [anthropic/claude-opus-5-5:high, local/qwen]",
    "    smol: [llama-swap/small]",
    "    commit: []",
    "    openai-codex/gpt-6-astra: [openai-codex/gpt-5.6-terra]",
    "",
  ].join("\n"));
  const preset = path.join(dir, "preset.yml");
  writeFileSync(preset, [
    "modelRoles:",
    "  slow: anthropic/claude-sonnet-5-5",
    "retry:",
    "  fallbackChains:",
    "    slow: [anthropic/claude-sonnet-5-5, local/other]", // replaces the key's array
    "    smol: null", // retires the inherited chain
    "    extra: [openrouter/free]", // a key only the preset has
    "    bad: [1, 2]", // not a chain of selectors: ignored
    "",
  ].join("\n"));
  turnCreditsOn();

  // omp merges key by key: an array replaces, null is a tombstone, and layers outside `retry.fallbackChains` do not matter here.
  assert.deepEqual(overlay.effectiveFallbackChains([]), {
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"],
    slow: ["anthropic/claude-opus-5-5:high", "local/qwen"],
    smol: ["llama-swap/small"],
    commit: [],
    "openai-codex/gpt-6-astra": ["openai-codex/gpt-5.6-terra"],
  });
  assert.deepEqual(overlay.effectiveFallbackChains([preset]), {
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"],
    slow: ["anthropic/claude-sonnet-5-5", "local/other"],
    commit: [],
    "openai-codex/gpt-6-astra": ["openai-codex/gpt-5.6-terra"],
    extra: ["openrouter/free"],
  });

  const withoutPreset = overlay.materializeClaudeCreditsOverlay([]);
  assert.deepEqual(chainsOf(withoutPreset), {
    default: ["anthropic-api/*", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5"],
    slow: ["anthropic-api/*", "anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5:high", "local/qwen"],
    smol: ["anthropic-api/*", "llama-swap/small"],
  }, "an empty chain and another provider's model chain are left to the user's own value");

  const withPreset = overlay.materializeClaudeCreditsOverlay([preset]);
  assert.deepEqual(chainsOf(withPreset), {
    default: ["anthropic-api/*", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5"],
    slow: ["anthropic-api/*", "anthropic/claude-sonnet-5-5", "anthropic-api/claude-sonnet-5-5", "local/other"],
    extra: ["anthropic-api/*", "openrouter/free"],
  }, "the preset's chain is the one that gets the credits, and its retired chain is not revived");
  assert.notEqual(withPreset, withoutPreset);
  assert.ok(!("smol" in chainsOf(withPreset)));
});

test("with two keys the overlay lists both wildcards in slot order and both twins after every exact plan entry, and the second key's arrival is a new file", () => {
  const { dir } = freshAgent();
  writeFileSync(path.join(dir, "config.yml"), [
    "retry:",
    "  fallbackChains:",
    "    default: [openai-codex/gpt-6-astra, anthropic/claude-opus-5-5]",
    "    slow: [anthropic/claude-opus-5-5:high, local/qwen]",
    "    smol: [llama-swap/small]",
    "",
  ].join("\n"));
  turnCreditsOn(["anthropic-api"]);
  const one = overlay.materializeClaudeCreditsOverlay([]);
  assert.deepEqual(chainsOf(one), {
    default: ["anthropic-api/*", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5"],
    slow: ["anthropic-api/*", "anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5:high", "local/qwen"],
    smol: ["anthropic-api/*", "llama-swap/small"],
  });

  turnCreditsOn(["anthropic-api", "anthropic-api-2"]);
  const two = overlay.materializeClaudeCreditsOverlay([]);
  assert.notEqual(two, one, "a second key changes the chains, so a relaunch notices");
  assert.deepEqual(chainsOf(two), {
    default: ["anthropic-api/*", "anthropic-api-2/*", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5"],
    slow: ["anthropic-api/*", "anthropic-api-2/*", "anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5:high", "anthropic-api-2/claude-opus-5-5:high", "local/qwen"],
    smol: ["anthropic-api/*", "anthropic-api-2/*", "llama-swap/small"],
  });
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), two, "the same keys give the same file");

  // Only the SECOND slot holds a key (the first was removed): the chain names that provider alone, never the empty one.
  turnCreditsOn(["anthropic-api-2"]);
  const second = overlay.materializeClaudeCreditsOverlay([]);
  assert.deepEqual(chainsOf(second), {
    default: ["anthropic-api-2/*", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5"],
    slow: ["anthropic-api-2/*", "anthropic/claude-opus-5-5:high", "anthropic-api-2/claude-opus-5-5:high", "local/qwen"],
    smol: ["anthropic-api-2/*", "llama-swap/small"],
  });

  // The last key goes: no overlay at all, and the files already written stay for engines that still name them.
  creditsStore.writeClaudeCreditsStore([]);
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), null);
  assert.deepEqual(overlayFiles(dir), [path.basename(one), path.basename(two), path.basename(second)].sort());
});

test("a tombstoned default is created again, and a layer that cannot be read is skipped rather than failing the chat", () => {
  const { dir } = freshAgent();
  writeFileSync(path.join(dir, "config.yml"), "retry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-astra]\n");
  const retired = path.join(dir, "retired.yml");
  writeFileSync(retired, "retry:\n  fallbackChains:\n    default: null\n");
  const broken = path.join(dir, "broken.yml");
  writeFileSync(broken, "retry: [unclosed\n");
  turnCreditsOn();
  assert.deepEqual(overlay.effectiveFallbackChains([retired]), {});
  assert.deepEqual(chainsOf(overlay.materializeClaudeCreditsOverlay([retired])), { default: ["anthropic-api/*"] }, "every role without a chain inherits the default, so it must exist");
  turnCreditsOn(["anthropic-api", "anthropic-api-2"]);
  assert.deepEqual(chainsOf(overlay.materializeClaudeCreditsOverlay([retired])), { default: ["anthropic-api/*", "anthropic-api-2/*"] }, "…and it names every key's provider");
  assert.deepEqual(overlay.effectiveFallbackChains([broken, path.join(dir, "not-there.yml")]), { default: ["openai-codex/gpt-6-astra"] });
});

test("the overlay is content-addressed: the same chains give the same file, new chains a new one", () => {
  const { dir, config } = freshAgent();
  const write = (chain) => writeFileSync(config, `retry:\n  fallbackChains:\n    default: [${chain}]\n`);
  write("openai-codex/gpt-6-astra");
  turnCreditsOn();
  const first = overlay.materializeClaudeCreditsOverlay([]);
  assert.equal(path.dirname(first), overlayDirectory(dir));
  assert.match(path.basename(first), /^[0-9a-f]{64}\.yml$/);

  // Reused, and refreshed so a file a running engine still names never looks old.
  const aged = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  utimesSync(first, aged, aged);
  const content = text(first);
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), first);
  assert.equal(text(first), content);
  assert.ok(Date.now() - statSync(first).mtimeMs < 60_000, "a reused overlay's mtime is refreshed");
  assert.deepEqual(overlayFiles(dir), [path.basename(first)]);

  // Other chains: another file, the first left in place for whoever still runs on it.
  write("llama-swap/qwen3.8-27b");
  const second = overlay.materializeClaudeCreditsOverlay([]);
  assert.notEqual(second, first);
  assert.deepEqual(overlayFiles(dir), [path.basename(first), path.basename(second)].sort());

  // The address is the EFFECTIVE chains, not how they were reached: a layer that sets what config.yml now says is the same file.
  write("openai-codex/gpt-6-astra");
  const layer = path.join(dir, "layer.yml");
  writeFileSync(layer, "retry:\n  fallbackChains:\n    default: [llama-swap/qwen3.8-27b]\n");
  assert.equal(overlay.materializeClaudeCreditsOverlay([layer]), second);
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), first);
});

test("the overlay is written private, atomically, and says whose it is", { skip: process.platform === "win32" && "POSIX permissions" }, () => {
  const { dir, config } = freshAgent();
  writeFileSync(config, "retry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-astra]\n");
  turnCreditsOn();
  const file = overlay.materializeClaudeCreditsOverlay([]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(overlayDirectory(dir)).mode & 0o777, 0o700);
  assert.match(text(file), /^# Cody: Claude API credits come first in every fallback chain/);
  assert.deepEqual(readdirSync(overlayDirectory(dir)).filter((name) => !name.endsWith(".yml")), [], "no half-written temp file is left behind");
  // The user's own config.yml is never touched by any of this.
  assert.equal(text(config), "retry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-astra]\n");
});

test("old overlays are pruned: never one under a week old, and the twelve newest are always kept", () => {
  const { dir, config } = freshAgent();
  turnCreditsOn();
  const day = 24 * 3600 * 1000;
  const make = (name) => {
    writeFileSync(config, `retry:\n  fallbackChains:\n    default: [local/${name}]\n`);
    return overlay.materializeClaudeCreditsOverlay([]);
  };
  const touch = (file, ageMs) => utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));

  // Fourteen overlays, all fresh: more than twelve, but none is a week old, and an engine started earlier may still name any.
  const files = Array.from({ length: 14 }, (_, index) => make(`m${index}`));
  assert.equal(new Set(files).size, 14);
  assert.equal(overlayFiles(dir).length, 14);

  // Three of them age past a week; the rest are minutes old, newest last.
  files.forEach((file, index) => touch(file, index < 3 ? 8 * day + index * 1000 : (14 - index) * 60_000));
  const newest = make("newest");
  const expected = [...files.slice(3), newest].map((file) => path.basename(file)).sort();
  assert.deepEqual(overlayFiles(dir), expected, "exactly the old ones beyond the twelve newest went");
  assert.equal(overlayFiles(dir).length, 12);

  // Old, but among the twelve newest: kept.
  for (const file of [...files.slice(3), newest]) touch(file, 10 * day);
  const another = make("another");
  assert.equal(overlayFiles(dir).length, 13 - 1, "twelve newest kept: the oldest one beyond them went, the new one stays");
  assert.ok(existsSync(another));
});

test("an overlay that cannot be written leaves the chat to start without it", () => {
  const { dir, config } = freshAgent();
  writeFileSync(config, "retry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-astra]\n");
  turnCreditsOn();
  // Something that is not a directory sits where the overlays go.
  writeFileSync(overlayDirectory(dir), "in the way");
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), null);
  rmSync(overlayDirectory(dir));
  assert.equal(typeof overlay.materializeClaudeCreditsOverlay([]), "string", "and it works again once the way is clear");

  // A config.yml omp itself could not load.
  writeFileSync(config, "retry: [unclosed\n");
  assert.equal(overlay.materializeClaudeCreditsOverlay([]), null);
});

test("every chat start levels each key's block with omp's catalog; a catalog it cannot read leaves the blocks exactly as they were", () => {
  const ctx = freshAgent();
  writeFileSync(ctx.modelsYml, [
    "# my hand-written models",
    "providers:",
    "  llama-swap: # the local server",
    "    baseUrl: http://127.0.0.1:8080/v1",
    "    api: openai-completions",
    "    auth: none",
    "    models:",
    "      - id: qwen3.8-27b",
    "        contextWindow: 24576",
    "",
  ].join("\n"));
  writeFileSync(ctx.config, "retry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-astra]\n");
  const llama = savedProviders(ctx)["llama-swap"];
  // The blocks as an older omp left them: ONE Claude model each, at an address someone chose; and a saved key behind each.
  const GATEWAY = "http://127.0.0.1:12345";
  credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: GATEWAY, models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
  creditsStore.writeClaudeCreditsStore([
    { keyId: 3, provider: "anthropic-api", account: "nitin@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 4, provider: "anthropic-api-2", account: "nathan@example.test", addedAt: "2026-10-02T00:00:00.000Z" },
  ]);
  assert.deepEqual(credits.readClaudeCreditsProvider().modelIds, ["claude-opus-5-5"]);
  assert.deepEqual(credits.readClaudeCreditsProvider("anthropic-api-2").modelIds, ["claude-opus-5-5"]);

  // omp was upgraded since, and now knows a second Claude model.
  const upgraded = createFakeOmpPackage(path.join(scratch, `upgraded-${path.basename(ctx.dir)}`), { anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ] });
  const useCatalogOf = (bin) => {
    process.env.CODY_OMP_BIN = bin;
    invalidateOmpCliCache();
  };
  try {
    useCatalogOf(upgraded.bin);
    const started = overlay.materializeClaudeCreditsOverlay([]);
    assert.equal(typeof started, "string", "the chat gets its overlay");
    assert.ok(existsSync(started));
    for (const [name, suffix] of [["anthropic-api", "API credits"], ["anthropic-api-2", "API credits 2"]]) {
      const block = savedProviders(ctx)[name];
      assert.deepEqual(block.models, [
        { id: "claude-opus-5-5", name: `Claude Opus 5.5 (${suffix})` },
        { id: "claude-sonnet-5-5", name: `Claude Sonnet 5.5 (${suffix})` },
      ], `${name}: the new model has its credits twin from this chat on`);
      assert.equal(block.baseUrl, GATEWAY, `${name}: the address someone chose survives the sync`);
    }
    assert.deepEqual(savedProviders(ctx)["llama-swap"], llama, "another provider is not touched");
    assert.match(text(ctx.modelsYml), /# my hand-written models/);
    assert.match(text(ctx.modelsYml), /# the local server/);
    assert.deepEqual(credits.readClaudeCreditsRouting().modelIds, new Set(["claude-opus-5-5", "claude-sonnet-5-5"]), "routing sees the new model as covered");
    assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api", "anthropic-api-2"]);

    // Already level: the next chat to start writes nothing.
    const level = text(ctx.modelsYml);
    const levelTime = statSync(ctx.modelsYml).mtimeMs;
    assert.equal(overlay.materializeClaudeCreditsOverlay([]), started);
    assert.equal(text(ctx.modelsYml), level);
    assert.equal(statSync(ctx.modelsYml).mtimeMs, levelTime, "models.yml is rewritten only when the model list changed");

    // A catalog Cody cannot read: the chat still gets its overlay, and the blocks stay byte for byte.
    useCatalogOf(path.join(scratch, "no-omp-installed-here"));
    assert.equal(credits.readClaudePlanModels(), null);
    assert.equal(overlay.materializeClaudeCreditsOverlay([]), started);
    assert.equal(text(ctx.modelsYml), level);
    assert.equal(statSync(ctx.modelsYml).mtimeMs, levelTime);
  } finally {
    useCatalogOf(fakeOmp.bin);
  }
});

// ── Cody's record of which key belongs to which account ──────────────────────

test("the record of key pairings reads defensively: damage means 'no keys', and one bad entry costs only itself", () => {
  const { codyStore } = freshAgent();
  assert.deepEqual(creditsStore.readClaudeCreditsStore(), [], "no file yet");
  for (const damaged of ["", "not json", "[]", "null", "{}", "{\"keys\": \"nope\"}", "{\"version\": 1, \"keys\": {\"a\": 1}}"]) {
    writeFileSync(codyStore, damaged);
    assert.deepEqual(creditsStore.readClaudeCreditsStore(), [], JSON.stringify(damaged));
  }
  writeFileSync(codyStore, JSON.stringify({ version: 1, keys: [
    { keyId: 3, provider: "anthropic-api", account: "a@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 3, provider: "anthropic-api", account: "again@example.test", addedAt: "2026-10-02T00:00:00.000Z" }, // a repeated key id: the first stands
    { keyId: "4", provider: "anthropic-api", account: "string-id@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 5.5, provider: "anthropic-api", account: "fraction@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 6, provider: "anthropic-api", account: "", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 7, provider: "anthropic-api", account: "no-date@example.test" },
    null,
    "junk",
    12,
    { keyId: 8, provider: "anthropic-api-2", account: "b@example.test", addedAt: "2026-10-03T00:00:00.000Z", extra: "ignored" },
  ] }));
  assert.deepEqual(creditsStore.readClaudeCreditsStore(), [
    { keyId: 3, provider: "anthropic-api", account: "a@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 8, provider: "anthropic-api-2", account: "b@example.test", addedAt: "2026-10-03T00:00:00.000Z" },
  ]);
});

test("a pairing that names no credits provider is dropped on read, whatever else it holds", () => {
  const { codyStore } = freshAgent();
  const entry = (keyId, provider) => ({ keyId, ...(provider === undefined ? {} : { provider }), account: `key-${keyId}@example.test`, addedAt: "2026-10-01T00:00:00.000Z" });
  writeFileSync(codyStore, JSON.stringify({ version: 1, keys: [
    entry(1, undefined), // a pairing written before every key had a provider of its own
    entry(2, null),
    entry(3, 2),
    entry(4, ""),
    entry(5, "anthropic"), // the plans' own pool
    entry(6, "anthropic-api-1"), // the first slot is spelled without a number
    entry(7, "anthropic-api-9"), // one past the ceiling
    entry(8, "anthropic-api-10"),
    entry(9, "Anthropic-API"),
    entry(10, " anthropic-api "),
    entry(11, "openai-codex"),
    entry(20, "anthropic-api"),
    entry(21, "anthropic-api-2"),
    entry(22, "anthropic-api-8"),
  ] }));
  assert.deepEqual(creditsStore.readClaudeCreditsStore().map((stored) => [stored.keyId, stored.provider]), [[20, "anthropic-api"], [21, "anthropic-api-2"], [22, "anthropic-api-8"]]);
  // A dropped pairing never counts as the credits being on.
  credits.syncClaudeCreditsProviders(FAMILY, { baseUrl: BASE_URL });
  assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api", "anthropic-api-2", "anthropic-api-8"]);
  writeFileSync(codyStore, JSON.stringify({ version: 1, keys: [entry(1, undefined), entry(5, "anthropic"), entry(7, "anthropic-api-9")] }));
  assert.deepEqual(credits.readClaudeCreditsRouting(), { active: false, modelIds: new Set(), keyCount: 0, providers: [] });
});

test("the record is written whole and private, creates the agent dir if need be, and holds an id, a provider, an account and a date — never a key", { skip: process.platform === "win32" && "POSIX permissions" }, () => {
  const ctx = freshAgent();
  const entries = [
    { keyId: 3, provider: "anthropic-api", account: "nitin@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: 4, provider: "anthropic-api-2", account: "nathan@example.test", addedAt: "2026-10-02T00:00:00.000Z" },
  ];
  creditsStore.writeClaudeCreditsStore(entries);
  assert.deepEqual(JSON.parse(text(ctx.codyStore)), { version: 1, keys: entries });
  assert.equal(statSync(ctx.codyStore).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(ctx.dir).filter((name) => name.endsWith(".tmp")), [], "no half-written temp file is left behind");

  creditsStore.writeClaudeCreditsStore([]);
  assert.deepEqual(JSON.parse(text(ctx.codyStore)), { version: 1, keys: [] }, "a rewrite replaces the whole record");

  // An instance whose data directory does not exist yet.
  const fresh = path.join(scratch, "not-yet-there", "agent");
  process.env.PI_CODING_AGENT_DIR = fresh;
  creditsStore.writeClaudeCreditsStore(entries);
  assert.deepEqual(creditsStore.readClaudeCreditsStore(), entries);
  assert.equal(statSync(fresh).mode & 0o777, 0o700, "a directory made for it is private");
});

// ── The keys, the status and the pairing, over fake bridges ──────────────────

test("saving a key pairs it with its plan account, turns the provider block on and the status shows only the last four", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), `  ${KEY_1}\n`, ctx.deps);

  assert.deepEqual(savedKeys(ctx), [KEY_1], "surrounding whitespace is trimmed before the key is stored");
  const [entry] = creditsStore.readClaudeCreditsStore();
  assert.deepEqual({ ...entry, addedAt: undefined }, { keyId: fakeCreditsKeys(ctx.dir)[0].id, provider: "anthropic-api", account: "nitin@example.test", addedAt: undefined });
  assert.equal(fakeCreditsKeys(ctx.dir)[0].provider, "anthropic-api", "omp holds it under the first credits provider, never under the plans' own `anthropic`");
  assert.ok(Math.abs(Date.parse(entry.addedAt) - Date.now()) < 60_000);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"]);
  assert.equal(credits.readClaudeCreditsRouting().active, true);

  const status = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(status, {
    available: true,
    canEdit: true,
    accounts: [
      { accountId: String(ctx.planIds[0]), label: "nitin@example.test", position: 0, key: { keyId: String(entry.keyId), last4: "0001", addedAt: entry.addedAt } },
      { accountId: String(ctx.planIds[1]), label: "nathan@example.test", position: 1, key: null },
    ],
    strayKeys: [],
    fallbackEnabled: true,
    returnsToPlan: true,
  });
  assertNoKey("the status", status, KEY_1);
  assertNoKey("Cody's record of the pairing", text(ctx.codyStore), KEY_1);
  assertNoKey("models.yml", text(ctx.modelsYml), KEY_1);
});

test("each account has its own key in a provider of its own, and the status pairs them by who the account is", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const [nitinKey, nathanKey] = [fakeCreditsKeys(ctx.dir).find((row) => row.key === KEY_1).id, fakeCreditsKeys(ctx.dir).find((row) => row.key === KEY_2).id];

  // The key saved first takes the first provider, whichever account it belongs to: that is the order omp's chain tries them in.
  assert.deepEqual(fakeCreditsKeys(ctx.dir).map((row) => [row.key, row.provider]), [[KEY_2, "anthropic-api"], [KEY_1, "anthropic-api-2"]]);
  assert.deepEqual(creditsStore.readClaudeCreditsStore().map((entry) => [entry.account, entry.provider, entry.keyId]), [
    ["nathan@example.test", "anthropic-api", nathanKey],
    ["nitin@example.test", "anthropic-api-2", nitinKey],
  ]);
  const providers = savedProviders(ctx);
  assert.deepEqual(Object.keys(providers), ["anthropic-api", "anthropic-api-2"], "one block per key");
  assert.equal(providers["anthropic-api-2"].models[1].name, "Claude Opus 5.5 (API credits 2)");
  const routing = credits.readClaudeCreditsRouting();
  assert.deepEqual([routing.keyCount, routing.providers], [2, ["anthropic-api", "anthropic-api-2"]]);

  let status = await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.deepEqual(status.accounts.map((account) => [account.label, account.key?.keyId, account.key?.last4]), [
    ["nitin@example.test", String(nitinKey), "0001"],
    ["nathan@example.test", String(nathanKey), "0002"],
  ]);
  assert.deepEqual(status.strayKeys, []);
  assert.ok(!JSON.stringify(status).includes("anthropic-api"), "which provider holds a key is not the browser's business");

  // Signing out and back in gives the account a new row id: the key stays with the PERSON, not the row.
  updateFakeStore(ctx.dir, (store) => { store.rows = store.rows.filter((row) => row.id !== ctx.planIds[0]); });
  const [returned] = addFakeRows(ctx.dir, [planAccount("nitin@example.test")]);
  status = await credits.readClaudeCreditsStatus(false, ctx.deps);
  const nitin = status.accounts.find((account) => account.label === "nitin@example.test");
  assert.equal(nitin.accountId, String(returned));
  assert.equal(nitin.key?.keyId, String(nitinKey), "the new row inherits the key");
  assert.deepEqual(status.strayKeys, []);
  assertNoKey("the status", status, KEY_1, KEY_2);
});

test("an account the plan list numbers 'Secondary' is numbered the same here, disabled and non-OAuth rows included", async () => {
  const ctx = freshAgent({ plans: [
    planAccount("first@example.test"),
    planAccount("expired@example.test", { disabledCause: "oauth refresh failed: invalid_grant" }),
    { provider: "anthropic", type: "api_key", identity: null }, // the user's own key beside the plans
    planAccount("second@example.test"),
    { provider: "openai-codex", type: "oauth", identity: "codex@example.test" },
  ] });
  const status = await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.deepEqual(status.accounts.map((account) => [account.label, account.position]), [
    ["first@example.test", 0],
    ["second@example.test", 3],
  ], "a skipped row keeps its slot so nobody is renumbered; Codex is not a plan account");

  // The plan card (Settings › Providers › Anthropic) numbers the same rows with its own code: they must agree.
  const { createOmpProviderLogins } = await jiti.import("./provider-login.ts");
  const { listOmpCredentials } = await jiti.import("../harness/omp-credentials.ts");
  const card = createOmpProviderLogins({
    listProviders: async () => [{ id: "anthropic", name: "Anthropic", available: true, authenticated: true }],
    listCredentials: () => listOmpCredentials(ctx.deps.credentials),
    listUsage: async () => ({ accounts: [] }),
  });
  const onTheCard = (await card.list()).providers.find((provider) => provider.id === "anthropic").accounts;
  for (const account of status.accounts) {
    assert.equal(onTheCard.find((entry) => entry.id === account.accountId)?.position, account.position, `${account.label} is the same number on the plan card`);
  }

  // Only an active OAuth plan account can be given a key.
  for (const id of [ctx.planIds[1], ctx.planIds[2], ctx.planIds[4], 999]) {
    await rejectsWith(() => credits.saveClaudeApiKey(String(id), KEY_1, ctx.deps), "claude_credits_unknown_account", 404);
  }
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "add"), [], "omp was never asked to store a key for them");
  assert.equal(existsSync(ctx.modelsYml), false);
});

test("an account without an email is paired by its row, and shown as plain Claude", async () => {
  const ctx = freshAgent({ plans: [planAccount(null)] });
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  assert.equal(creditsStore.readClaudeCreditsStore()[0].account, `account-${ctx.planIds[0]}`);
  const status = await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.deepEqual(status.accounts.map((account) => [account.label, account.key?.last4]), [["Claude", "0001"]]);
});

test("a replaced key is in before the old one goes, and the account keeps exactly one", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const oldId = fakeCreditsKeys(ctx.dir)[0].id;
  const addedAt = creditsStore.readClaudeCreditsStore()[0].addedAt;

  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_2, ctx.deps);
  assert.deepEqual(savedKeys(ctx), [KEY_2], "the old key is gone from omp's store");
  const [entry, ...rest] = creditsStore.readClaudeCreditsStore();
  assert.deepEqual(rest, []);
  assert.equal(entry.keyId, fakeCreditsKeys(ctx.dir)[0].id);
  assert.notEqual(entry.keyId, oldId);
  assert.equal(entry.account, "nitin@example.test");
  assert.equal(entry.provider, "anthropic-api", "the new key lives where the old one did");
  assert.ok(Date.parse(entry.addedAt) >= Date.parse(addedAt), "a new key is dated now");

  // The order of what omp was asked, and what Cody's record said when it was asked.
  const [firstAdd, secondAdd, removal, ...more] = readOperations(ctx.dir);
  assert.deepEqual(more, []);
  assert.deepEqual([firstAdd.op, secondAdd.op, removal.op], ["add", "add", "remove"]);
  assert.deepEqual([secondAdd.provider, secondAdd.asked], ["anthropic-api", "anthropic-api"]);
  assert.deepEqual({ provider: removal.provider, id: removal.id }, { provider: "anthropic-api", id: oldId }, "only the credits' old key is removed, never anything of the plan's");
  assert.ok(removal.held.includes(secondAdd.id) && removal.held.includes(oldId), "both keys existed at the moment the old one was removed");
  const recordAtRemoval = JSON.parse(removal.watched[ctx.codyStore]);
  assert.deepEqual(recordAtRemoval.keys.map((key) => key.keyId), [secondAdd.id], "the new key was already paired when the old one went");
});

test("a replacement goes into the provider of the key it replaces, and the other keys and their providers are left alone", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  const byProvider = () => Object.fromEntries(fakeCreditsKeys(ctx.dir).map((row) => [row.provider, row.key]));
  assert.deepEqual(byProvider(), { "anthropic-api": KEY_1, "anthropic-api-2": KEY_2 });
  const blocks = savedProviders(ctx);
  const secondEntry = creditsStore.readClaudeCreditsStore().find((entry) => entry.account === "nathan@example.test");

  // The first account's key is replaced: it stays in the first provider, and the second key is not touched.
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_3, ctx.deps);
  assert.deepEqual(byProvider(), { "anthropic-api": KEY_3, "anthropic-api-2": KEY_2 });
  assert.deepEqual(savedProviders(ctx), blocks, "no block came or went");
  assert.deepEqual(creditsStore.readClaudeCreditsStore().find((entry) => entry.account === "nathan@example.test"), secondEntry, "the other account's pairing is exactly as it was");

  // The second account's key is replaced: it stays in the second provider — never moved into the first, never a third.
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_1, ctx.deps);
  assert.deepEqual(byProvider(), { "anthropic-api": KEY_3, "anthropic-api-2": KEY_1 });
  assert.deepEqual(creditsStore.readClaudeCreditsStore().map((entry) => [entry.account, entry.provider]).sort(), [["nathan@example.test", "anthropic-api-2"], ["nitin@example.test", "anthropic-api"]]);
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove").map((operation) => operation.provider), ["anthropic-api", "anthropic-api-2"], "each old key was removed under its own provider");
  assert.deepEqual(Object.keys(savedProviders(ctx)).sort(), ["anthropic-api", "anthropic-api-2"]);
});

test("a pairing whose key omp has lost does not keep its slot: the replacement takes the first provider that holds no key", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  // omp loses the FIRST key behind Cody's back (the record still pairs it with the first account).
  updateFakeStore(ctx.dir, (store) => { store.rows = store.rows.filter((row) => row.key !== KEY_1); });
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_3, ctx.deps);
  assert.deepEqual(fakeCreditsKeys(ctx.dir).map((row) => [row.key, row.provider]), [[KEY_2, "anthropic-api-2"], [KEY_3, "anthropic-api"]]);
  const entries = creditsStore.readClaudeCreditsStore();
  assert.deepEqual(entries.map((entry) => [entry.account, entry.provider]).sort(), [["nathan@example.test", "anthropic-api-2"], ["nitin@example.test", "anthropic-api"]]);
  assert.equal(entries.length, 2, "the account's lost key left no second record behind");
});

test("saving the same key for the same account again changes nothing, not even its date", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  const before = creditsStore.readClaudeCreditsStore();
  const modelsBefore = text(ctx.modelsYml);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  assert.deepEqual(creditsStore.readClaudeCreditsStore(), before);
  assert.deepEqual(savedKeys(ctx), [KEY_1, KEY_2]);
  assert.equal(text(ctx.modelsYml), modelsBefore);
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove"), [], "nothing was removed");
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "add").map((operation) => [operation.reused, operation.provider]), [[false, "anthropic-api"], [false, "anthropic-api-2"], [true, "anthropic-api"], [true, "anthropic-api-2"]], "omp answered with the rows it already held");
});

test("the same key for a second account is refused and changes nothing anywhere — the first provider's key is found even though the second is where it would go", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const snapshot = () => ({ cody: text(ctx.codyStore), models: text(ctx.modelsYml), omp: JSON.stringify(fakeCreditsKeys(ctx.dir)) });
  const before = snapshot();

  // omp keeps an identical key once, so the "new" key comes back as the first account's row — from the first provider,
  // although the second account's key would have gone into the second.
  const error = await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_1, ctx.deps), "claude_credits_duplicate_key", 409);
  assert.doesNotMatch(error.message, /sk-ant/);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"], "the second provider's block, written before the key was asked for, is taken away again");
  assert.equal(creditsStore.readClaudeCreditsStore()[0].account, "nitin@example.test");
  const adds = readOperations(ctx.dir).filter((operation) => operation.op === "add");
  assert.deepEqual(adds.map((operation) => [operation.asked, operation.provider, operation.reused]), [["anthropic-api", "anthropic-api", false], ["anthropic-api-2", "anthropic-api", true]]);

  // A different key for that second account is fine, and goes into the second provider.
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  assert.deepEqual(fakeCreditsKeys(ctx.dir).map((row) => [row.key, row.provider]), [[KEY_1, "anthropic-api"], [KEY_2, "anthropic-api-2"]]);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api", "anthropic-api-2"]);

  // The duplicate is found whichever provider holds the key: the SECOND account's key offered for the first account.
  const secondBefore = snapshot();
  await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_2, ctx.deps), "claude_credits_duplicate_key", 409);
  assert.deepEqual(snapshot(), secondBefore);
});

test("with all eight providers holding a key a ninth account is refused before omp is asked, while an account that already has one can still replace it", async () => {
  const ctx = freshAgent({ plans: [planAccount("a@example.test"), planAccount("b@example.test"), planAccount("c@example.test")] });
  const seeded = FAMILY.map((_, slot) => `sk-ant-api03-FAKE-seeded-${String(slot + 1).padStart(4, "0")}`);
  const rows = addFakeRows(ctx.dir, FAMILY.map((provider, slot) => ({ provider, type: "api_key", key: seeded[slot] })));
  // The first account's key is the third provider's; the rest of the eight are strays, which take a slot just the same.
  creditsStore.writeClaudeCreditsStore([{ keyId: rows[2], provider: "anthropic-api-3", account: "a@example.test", addedAt: "2026-10-01T00:00:00.000Z" }]);
  credits.syncClaudeCreditsProviders(FAMILY, { baseUrl: BASE_URL });
  const modelsBefore = text(ctx.modelsYml);
  const recordBefore = text(ctx.codyStore);

  const error = await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_1, ctx.deps), "claude_credits_unavailable", 409);
  assert.equal(error.message, "Too many API keys are saved.");
  assert.deepEqual(readOperations(ctx.dir), [], "omp was not asked to store a ninth key");
  assert.equal(text(ctx.modelsYml), modelsBefore);
  assert.equal(text(ctx.codyStore), recordBefore);
  assert.equal(fakeCreditsKeys(ctx.dir).length, 8);

  // Replacing the key an account already has needs no free slot: it goes into the slot the old key held.
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_2, ctx.deps);
  assert.deepEqual(fakeCreditsKeys(ctx.dir).map((row) => [row.provider, row.key]).sort(), FAMILY.map((provider, slot) => [provider, provider === "anthropic-api-3" ? KEY_2 : seeded[slot]]).sort());
  assert.equal(creditsStore.readClaudeCreditsStore()[0].provider, "anthropic-api-3");
  assert.equal(creditsStore.readClaudeCreditsStore().length, 1);
});

test("a malformed key is refused before omp, models.yml or the record are asked anything", async () => {
  const ctx = freshAgent();
  const login = await rejectsWith(async () => credits.saveClaudeApiKey(String(ctx.planIds[0]), "sk-ant-oat01-FAKE-login-token-0001", ctx.deps), "claude_credits_login_token", 400);
  assert.doesNotMatch(login.message, /sk-ant/);
  await rejectsWith(async () => credits.saveClaudeApiKey(String(ctx.planIds[0]), "   ", ctx.deps), "claude_credits_invalid_key", 400);
  await rejectsWith(async () => credits.saveClaudeApiKey(String(ctx.planIds[0]), "sk-ant-sid01-FAKE-session-0001", ctx.deps), "claude_credits_invalid_key", 400);
  assert.deepEqual(readOperations(ctx.dir), []);
  assert.equal(existsSync(ctx.modelsYml), false);
  assert.equal(existsSync(ctx.codyStore), false);
});

test("a models.yml Cody cannot take over stops the save before any key is stored", async () => {
  for (const content of ["providers:\n  llama-swap: {baseUrl: [unclosed\n", "providers:\n  anthropic-api:\n    baseUrl: https://mine.example.test\n    api: anthropic-messages\n    apiKey: MINE\n    models:\n      - id: x\n"]) {
    const ctx = freshAgent();
    writeFileSync(ctx.modelsYml, content);
    await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps), "claude_credits_unavailable", 409);
    assert.deepEqual(savedKeys(ctx), [], "a key saved while omp cannot serve it would look done and do nothing");
    assert.deepEqual(readOperations(ctx.dir), []);
    assert.equal(text(ctx.modelsYml), content);
    assert.equal(existsSync(ctx.codyStore), false);
  }
});

test("a hand-written provider in the slot a key would go into stops that save and no other, and is left exactly as the user wrote it", async () => {
  const ctx = freshAgent();
  const mine = ["providers:", "  anthropic-api-2:", "    baseUrl: https://mine.example.test", "    api: anthropic-messages", "    apiKey: MINE", "    models:", "      - id: x", ""].join("\n");
  writeFileSync(ctx.modelsYml, mine);

  // The first key goes into the first slot, which is free: saved, and the user's provider beside it is not touched.
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.deepEqual(savedProviders(ctx)["anthropic-api-2"], parse(mine).providers["anthropic-api-2"]);
  assert.match(text(ctx.modelsYml), /apiKey: MINE/);

  // The second account's key would go into that slot: refused, before omp is asked to store anything.
  const modelsBefore = text(ctx.modelsYml);
  const recordBefore = text(ctx.codyStore);
  const addsBefore = readOperations(ctx.dir).filter((operation) => operation.op === "add").length;
  const error = await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps), "claude_credits_unavailable", 409);
  assert.match(error.message, /"anthropic-api-2"/, "the message says whose provider is in the way");
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.equal(readOperations(ctx.dir).filter((operation) => operation.op === "add").length, addsBefore);
  assert.equal(text(ctx.modelsYml), modelsBefore);
  assert.equal(text(ctx.codyStore), recordBefore);
});

test("when omp will not take the key the block it just added is taken away again, unless another key needs it", async () => {
  const ctx = freshAgent();
  setFault(ctx.dir, "keys.add", "fail");
  const refused = await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps), "claude_credits_unavailable", 503);
  assert.match(refused.message, /refused|fake/i, "omp's own reason is passed on");
  assert.deepEqual(savedProviders(ctx), {}, "no key, so no block");
  assert.equal(existsSync(ctx.codyStore), false);

  // With a key already saved the block stays, and that key's pairing is untouched.
  setFault(ctx.dir, "keys.add", null);
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const before = text(ctx.codyStore);
  setFault(ctx.dir, "keys.add", "fail");
  await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_2, ctx.deps), "claude_credits_unavailable", 503);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"]);
  assert.equal(text(ctx.codyStore), before);
  assert.deepEqual(savedKeys(ctx), [KEY_1], "the old key is not removed when the new one did not go in");

  // A SECOND account's key that omp will not take: the block of the provider it was going into goes away again, the first key's stays.
  await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps), "claude_credits_unavailable", 503);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"]);
  assert.equal(text(ctx.codyStore), before);
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api"]);
});

test("a helper that does not answer is an honest 'unavailable', and nothing is changed", async () => {
  // Either bridge being down stops the save before anything is written: the list of keys decides which provider a key goes into.
  for (const operation of ["credentials.list", "keys.list"]) {
    for (const fault of ["garbage", "exit", "fail"]) {
      const ctx = freshAgent();
      setFault(ctx.dir, operation, fault);
      await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps), "claude_credits_unavailable", 503);
      assert.equal(existsSync(ctx.modelsYml), false, `${operation} ${fault}`);
      assert.equal(existsSync(ctx.codyStore), false, `${operation} ${fault}`);
      assert.deepEqual(readOperations(ctx.dir), [], `${operation} ${fault}`);
    }
  }
  const ctx = freshAgent();
  setFault(ctx.dir, "keys.add", "garbage");
  const error = await rejectsWith(() => credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps), "claude_credits_unavailable", 503);
  assert.match(error.message, /did not answer/);
  assert.deepEqual(savedProviders(ctx), {});
});

test("if omp will not drop the old key the new one is still saved, and the old one shows up to be removed", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const oldId = fakeCreditsKeys(ctx.dir)[0].id;
  setFault(ctx.dir, "credentials.remove", "fail");
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_2, ctx.deps);

  const status = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.equal(status.accounts[0].key.last4, "0002", "the new key is the account's");
  assert.deepEqual(status.strayKeys, [{ keyId: String(oldId), last4: "0001", addedAt: null, label: null }]);
  assertNoKey("the status", status, KEY_1, KEY_2);

  // …and the person can remove it from there.
  setFault(ctx.dir, "credentials.remove", null);
  await credits.removeClaudeApiKey(String(oldId), ctx.deps);
  assert.deepEqual(savedKeys(ctx), [KEY_2]);
  assert.deepEqual((await credits.readClaudeCreditsStatus(true, ctx.deps)).strayKeys, []);
});

test("removing a key forgets its pairing, and each provider's block goes with its own key — the last key takes the last block", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  const [first, second] = fakeCreditsKeys(ctx.dir);
  assert.deepEqual([first.provider, second.provider], ["anthropic-api", "anthropic-api-2"]);

  // The FIRST key goes: its provider's block goes with it, and the second key's block stays.
  await credits.removeClaudeApiKey(String(first.id), ctx.deps);
  assert.deepEqual(savedKeys(ctx), [KEY_2]);
  assert.deepEqual(creditsStore.readClaudeCreditsStore().map((entry) => entry.keyId), [second.id]);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api-2"], "one key is still saved: its provider stays served, the emptied one does not");
  const routing = credits.readClaudeCreditsRouting();
  assert.deepEqual([routing.active, routing.keyCount, routing.providers], [true, 1, ["anthropic-api-2"]]);

  // The freed first provider is the next key's, so the credits of whoever signs in next are tried first.
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_3, ctx.deps);
  assert.deepEqual(fakeCreditsKeys(ctx.dir).map((row) => [row.key, row.provider]), [[KEY_2, "anthropic-api-2"], [KEY_3, "anthropic-api"]]);
  assert.deepEqual(Object.keys(savedProviders(ctx)).sort(), ["anthropic-api", "anthropic-api-2"]);
  const third = fakeCreditsKeys(ctx.dir).find((row) => row.key === KEY_3);

  await credits.removeClaudeApiKey(String(second.id), ctx.deps);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"]);
  await credits.removeClaudeApiKey(String(third.id), ctx.deps);
  assert.deepEqual(savedKeys(ctx), []);
  assert.deepEqual(creditsStore.readClaudeCreditsStore(), []);
  assert.deepEqual(savedProviders(ctx), {}, "no key, no block");
  assert.equal(credits.readClaudeCreditsRouting().active, false);
  // Each removal names the provider the key lives under — never the plans' own `anthropic`.
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove").map((operation) => [operation.provider, operation.id]), [
    ["anthropic-api", first.id],
    ["anthropic-api-2", second.id],
    ["anthropic-api", third.id],
  ]);

  // The plan accounts themselves are untouched.
  const status = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(status.accounts.map((account) => [account.label, account.key]), [["nitin@example.test", null], ["nathan@example.test", null]]);
});

test("removing is strict about what is not a key id, and quiet about a key omp no longer holds", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const [{ id }] = fakeCreditsKeys(ctx.dir);
  const before = text(ctx.codyStore);
  const modelsBefore = text(ctx.modelsYml);

  for (const bad of ["abc", "1.5", "NaN", "9007199254740993", "3; DROP TABLE auth_credentials"]) {
    const error = await rejectsWith(() => credits.removeClaudeApiKey(bad, ctx.deps), "claude_credits_unknown_account", 404);
    assert.equal(error.message, "That key is no longer saved.", bad);
  }
  // A well-formed id omp does not hold is a key that is already gone (a second tab, a double click): not an error.
  for (const gone of ["999", "0"]) await credits.removeClaudeApiKey(gone, ctx.deps);
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove"), [], "omp was not asked to remove anything");
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.equal(text(ctx.codyStore), before);
  assert.equal(text(ctx.modelsYml), modelsBefore);

  // omp refusing is reported, and neither the key's pairing nor the block is dropped.
  setFault(ctx.dir, "credentials.remove", "fail");
  await rejectsWith(() => credits.removeClaudeApiKey(String(id), ctx.deps), "claude_credits_unavailable", 503);
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.equal(text(ctx.codyStore), before);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"]);

  // Without a list of the keys omp holds nothing is removed either: the id could be anyone's.
  setFault(ctx.dir, "credentials.remove", null);
  for (const fault of ["garbage", "exit", "fail"]) {
    setFault(ctx.dir, "keys.list", fault);
    await rejectsWith(() => credits.removeClaudeApiKey(String(id), ctx.deps), "claude_credits_unavailable", 503);
  }
  setFault(ctx.dir, "keys.list", null);
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove"), [], "omp was never asked to remove the key");
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.equal(text(ctx.codyStore), before);

  // …and with everything answering again, the same id is removed under its own provider.
  await credits.removeClaudeApiKey(String(id), ctx.deps);
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove").map((operation) => [operation.provider, operation.id, operation.found]), [["anthropic-api", id, true]]);
  assert.deepEqual(savedKeys(ctx), []);
  assert.deepEqual(savedProviders(ctx), {});
});

test("a plan account's own credentials, and the user's own `anthropic` API key, are never reachable through the key calls", async () => {
  const ownKey = "sk-ant-api03-FAKE-the-users-own-0009";
  const ctx = freshAgent({ plans: [planAccount("nitin@example.test"), planAccount("nathan@example.test"), { provider: "anthropic", type: "api_key", identity: null, key: ownKey }] });
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  // The id of a PLAN row, or of an API key the user keeps beside the plans: removing "a key" with it must change nothing —
  // it is not one of the credits' keys, so it reads as a key that is already gone, and omp is never asked to remove it.
  for (const id of [ctx.planIds[0], ctx.planIds[1], ctx.planIds[2]]) {
    await credits.removeClaudeApiKey(String(id), ctx.deps);
  }
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove"), [], "omp was not asked to remove anything");
  const status = await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.deepEqual(status.accounts.map((account) => account.label), ["nitin@example.test", "nathan@example.test"]);
  assert.deepEqual(status.strayKeys, [], "and the user's own key is not listed among the credits' keys");
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.equal(text(ctx.modelsYml).includes(ownKey), false);
});

test("keys that no active account owns are listed as strays: the signed-out account's, and one Cody has no record of", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await credits.saveClaudeApiKey(String(ctx.planIds[1]), KEY_2, ctx.deps);
  const keyOf = (key) => fakeCreditsKeys(ctx.dir).find((row) => row.key === key).id;
  const recorded = creditsStore.readClaudeCreditsStore().find((entry) => entry.keyId === keyOf(KEY_2));
  // One account signs out; and a key arrives by other means (omp's own login under another credits provider, say).
  updateFakeStore(ctx.dir, (store) => { store.rows = store.rows.filter((row) => row.id !== ctx.planIds[1]); });
  const [other] = addFakeRows(ctx.dir, [{ provider: "anthropic-api-3", type: "api_key", key: KEY_3 }]);

  const status = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(status.accounts.map((account) => [account.label, account.key?.last4 ?? null]), [["nitin@example.test", "0001"]]);
  assert.deepEqual(status.strayKeys, [
    { keyId: String(keyOf(KEY_2)), last4: "0002", addedAt: recorded.addedAt, label: "nathan@example.test" },
    { keyId: String(other), last4: "0003", addedAt: null, label: null },
  ]);
  assertNoKey("the status", status, KEY_1, KEY_2, KEY_3);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api", "anthropic-api-2", "anthropic-api-3"], "a key that exists is served, strays included");

  // Strays stay removable: they cost money when used, so the person must be able to get rid of them.
  await credits.removeClaudeApiKey(String(keyOf(KEY_2)), ctx.deps);
  await credits.removeClaudeApiKey(String(other), ctx.deps);
  assert.deepEqual((await credits.readClaudeCreditsStatus(true, ctx.deps)).strayKeys, []);
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"], "each provider's block went with its key");
  assert.deepEqual(readOperations(ctx.dir).filter((operation) => operation.op === "remove").map((operation) => operation.provider), ["anthropic-api-2", "anthropic-api-3"], "each removal named the provider the key lives under");
});

test("an administrator's status read heals the books; anyone else's writes nothing at all", async () => {
  const ctx = freshAgent();
  // omp holds two keys Cody recorded — one of them filed under the wrong provider — and Cody recorded a third that omp no longer holds; models.yml says nothing.
  const [kept, moved] = addFakeRows(ctx.dir, [
    { provider: "anthropic-api", type: "api_key", key: KEY_1 },
    { provider: "anthropic-api-2", type: "api_key", key: KEY_2 },
  ]);
  creditsStore.writeClaudeCreditsStore([
    { keyId: kept, provider: "anthropic-api", account: "nitin@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
    { keyId: moved, provider: "anthropic-api", account: "nathan@example.test", addedAt: "2026-10-02T00:00:00.000Z" },
    { keyId: 999, provider: "anthropic-api-3", account: "ghost@example.test", addedAt: "2026-10-03T00:00:00.000Z" },
  ]);
  const files = () => ({ cody: text(ctx.codyStore), models: text(ctx.modelsYml), codyTime: statSync(ctx.codyStore).mtimeMs });
  const before = files();

  const plain = await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.equal(plain.canEdit, false);
  assert.deepEqual(plain.accounts.map((account) => account.key?.keyId ?? null), [String(kept), String(moved)], "the pairing is read from what omp still holds");
  assert.deepEqual(files(), before, "no write to the record");
  assert.equal(existsSync(ctx.modelsYml), false, "no models.yml created for a reader");

  const healed = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(healed.accounts, plain.accounts);
  assert.deepEqual(
    creditsStore.readClaudeCreditsStore().map((entry) => [entry.keyId, entry.provider]),
    [[kept, "anthropic-api"], [moved, "anthropic-api-2"]],
    "the record of a key omp lost is dropped, and a pairing follows its key to the provider that holds it",
  );
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api", "anthropic-api-2"], "the blocks follow the keys: each provider that holds a key is served");
  assert.deepEqual(credits.readClaudeCreditsRouting().providers, ["anthropic-api", "anthropic-api-2"]);

  // One provider's key goes in omp, behind Cody's back: only ITS block goes, and only on an administrator's read.
  updateFakeStore(ctx.dir, (store) => { store.rows = store.rows.filter((row) => row.id !== moved); });
  let modelsBefore = text(ctx.modelsYml);
  let codyBefore = text(ctx.codyStore);
  await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.equal(text(ctx.modelsYml), modelsBefore, "a reader leaves the blocks");
  assert.equal(text(ctx.codyStore), codyBefore);
  await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"]);
  assert.deepEqual(creditsStore.readClaudeCreditsStore().map((entry) => entry.keyId), [kept]);

  // The other way round: no key left in omp, a block still in models.yml.
  updateFakeStore(ctx.dir, (store) => { store.rows = store.rows.filter((row) => !FAMILY.includes(row.provider)); });
  modelsBefore = text(ctx.modelsYml);
  codyBefore = text(ctx.codyStore);
  await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.equal(text(ctx.modelsYml), modelsBefore, "a reader leaves the block");
  assert.equal(text(ctx.codyStore), codyBefore);
  await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(savedProviders(ctx), {}, "an administrator's read removes a block with no key behind it");
  assert.deepEqual(creditsStore.readClaudeCreditsStore(), []);
});

test("an administrator's status read that comes while a key is being saved waits its turn, and the save stands", async () => {
  const ctx = freshAgent();
  // The first key's `add` is held back: the save is in flight (the provider block is already written, the key not yet).
  setFault(ctx.dir, "keys.add", "gate");
  const saving = credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  await waitUntilHeld(ctx.dir);
  setFault(ctx.dir, "keys.add", null);

  // A status read arrives now. It must not judge omp's keys, nor heal Cody's books, half-way through the save:
  // taken now it would see no key, drop the pairing the save is about to record and take the block away.
  let answered = false;
  const reading = credits.readClaudeCreditsStatus(true, ctx.deps).then((status) => {
    answered = true;
    return status;
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(answered, false, "the read waits behind the save");

  openGate(ctx.dir);
  await saving;
  const status = await reading;
  // …and what it reports is the finished save.
  assert.equal(status.available, true);
  assert.deepEqual(status.accounts.map((account) => account.key?.last4 ?? null), ["0001", null]);
  assert.deepEqual(status.strayKeys, []);
  assert.deepEqual(savedKeys(ctx), [KEY_1]);
  assert.deepEqual(creditsStore.readClaudeCreditsStore().map((entry) => entry.account), ["nitin@example.test"], "the pairing is recorded");
  assert.deepEqual(Object.keys(savedProviders(ctx)), ["anthropic-api"], "and the block still serves the key");
  assert.equal(credits.readClaudeCreditsRouting().active, true, "so the credits are on");
});

test("a bridge that is down makes the status unavailable, with the reason, and never an empty claim of 'no keys'", async () => {
  const ctx = freshAgent();
  await credits.saveClaudeApiKey(String(ctx.planIds[0]), KEY_1, ctx.deps);
  const codyBefore = text(ctx.codyStore);
  const modelsBefore = text(ctx.modelsYml);

  setFault(ctx.dir, "keys.list", "garbage");
  let status = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.deepEqual(status, { available: false, reason: "The key helper did not answer.", canEdit: true, accounts: [], strayKeys: [], fallbackEnabled: true, returnsToPlan: true });

  setFault(ctx.dir, "keys.list", null);
  setFault(ctx.dir, "credentials.list", "fail");
  status = await credits.readClaudeCreditsStatus(false, ctx.deps);
  assert.equal(status.available, false);
  assert.equal(status.canEdit, false);
  assert.match(status.reason, /refused|fake/i);
  assert.deepEqual([status.accounts, status.strayKeys], [[], []]);

  setFault(ctx.dir, "credentials.list", "exit");
  status = await credits.readClaudeCreditsStatus(true, ctx.deps);
  assert.equal(status.available, false);
  // A bridge that cannot answer is not evidence that the keys are gone: nothing is healed away.
  assert.equal(text(ctx.codyStore), codyBefore);
  assert.equal(text(ctx.modelsYml), modelsBefore);
});

test("the status reports whether omp will actually switch, and whether it comes back, from config.yml", async () => {
  const ctx = freshAgent();
  const flags = async (config) => {
    if (config === null) rmSync(ctx.config, { force: true }); else writeFileSync(ctx.config, config);
    const { fallbackEnabled, returnsToPlan } = await credits.readClaudeCreditsStatus(false, ctx.deps);
    return { fallbackEnabled, returnsToPlan };
  };
  assert.deepEqual(await flags(null), { fallbackEnabled: true, returnsToPlan: true });
  assert.deepEqual(await flags("retry:\n  enabled: false\n"), { fallbackEnabled: false, returnsToPlan: true });
  assert.deepEqual(await flags("retry:\n  modelFallback: false\n"), { fallbackEnabled: false, returnsToPlan: true });
  assert.deepEqual(await flags("retry:\n  enabled: true\n  modelFallback: true\n  fallbackRevertPolicy: never\n"), { fallbackEnabled: true, returnsToPlan: false });
  assert.deepEqual(await flags("retry:\n  fallbackRevertPolicy: cooldown-expiry\n"), { fallbackEnabled: true, returnsToPlan: true });
  assert.deepEqual(await flags("retry: [unclosed\n"), { fallbackEnabled: true, returnsToPlan: true }, "a config omp cannot read says nothing");
});
