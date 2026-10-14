import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { parse } from "yaml";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";
import { findBun, packageRootOf } from "./omp-test-store.mjs";
import { buildScenario, CREDITS_KEYS } from "./fixtures/claude-credits/credits-scenario.mjs";
import { ANTHROPIC_CREDIT_BALANCE_FAILURE, creditsText, planText, STAND_IN_TEXT } from "./fixtures/claude-credits/fake-anthropic.mjs";
import { assistantMessages, childEnv, describeTurn, killAll, runCommand, runOmpPrint, startNetworkTrap, startOmpRpc } from "./fixtures/claude-credits/omp-driver.mjs";

/**
 * The Claude API credits, proven against a REAL omp, omp's REAL credential store and Cody's REAL
 * modules, with every assertion about what a FAKE server observed.
 *
 *  - omp never reaches an API key stored beside the plan accounts of the same provider, even with
 *    every plan blocked: the reason the keys live under providers of their own — `anthropic-api` for
 *    the first key, `anthropic-api-2` for the second, and so on;
 *  - each credits provider is shaped as an API key against the official URL;
 *  - the overlay Cody writes is merged by omp the way Cody predicts;
 *  - the scenarios: plans first (omp's own account rotation), the credits only after every plan
 *    account's limit error came back, never while a plan has headroom, no other provider before
 *    the credits, the first key before the second, the second key when the first is dead (Anthropic's
 *    credit-balance 400, which omp does not rotate keys on, is the reason for one provider per key),
 *    the next provider once every key is spent, and back to the plan by itself after omp's cooldown;
 *  - Cody's key handling against omp's real SQLite store: what is stored where, that a replaced or
 *    removed key leaves no row behind, and that the key helper's look across every credits provider
 *    is what Cody's "that key is already saved for another account" rests on.
 *
 * Everything runs in throwaway directories with credentials that are plainly fake. Each omp child
 * gets an environment built from scratch (no inherited keys, proxies or agent dir) and a proxy
 * that refuses anything but 127.0.0.1: omp does try to reach other hosts at startup (model
 * catalogs), and none of that may leave the machine. Needs omp and Bun; skipped without them.
 */

// Before the environment below changes: where omp is installed depends on PI_CODING_AGENT_DIR.
const ompBin = ompTestPackageBin();
const packageRoot = ompBin ? packageRootOf(ompBin) : null;
const bun = findBun();
const skip = ompTestPackageSkip() || (!bun && "bun is not installed") || (!packageRoot && "the omp package root could not be found");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixtures = path.join(here, "fixtures", "claude-credits");
const scratch = mkdtempSync(path.join(os.tmpdir(), "cody-credits-omp-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CODY_PACKAGE_DIR", "PI_CONFIG_FILES", "CODY_OMP_BIN", "HOME", "OMP_PROFILE", "PI_PROFILE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent-initial");
process.env.CODY_PACKAGE_DIR = repoRoot;
process.env.PI_CONFIG_FILES = "";
if (ompBin) process.env.CODY_OMP_BIN = ompBin;
process.env.HOME = scratch;
// A named omp profile outranks PI_CODING_AGENT_DIR: never let one point these tests at a real agent dir.
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const credits = await jiti.import("./claude-credits.ts");
const overlay = await jiti.import("./claude-credits-overlay.ts");
const creditsStore = await jiti.import("./claude-credits-store.ts");
const pure = await jiti.import("../claude-credits.ts");

// The Claude model every scenario runs is one omp's own catalog lists, so an omp upgrade that renames models cannot break it.
const catalogModels = skip ? null : credits.readClaudePlanModels();
const MODEL_ID = catalogModels?.find((model) => /opus/.test(model.id))?.id ?? catalogModels?.[0]?.id ?? "claude-opus-5-5";
const MODEL = `anthropic/${MODEL_ID}`;

// The proxy every child's outside traffic is sent to — and refused by. Started on first use, closed at the end.
let trapStarting = null;
const outsideTrap = () => (trapStarting ??= startNetworkTrap());

test.after(async () => {
  killAll();
  if (trapStarting) await (await trapStarting).close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** Run `action` with Cody pointed at `dir` as its agent dir, then put the environment back. */
function inAgentDir(dir, action) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return action();
  } finally {
    process.env.PI_CODING_AGENT_DIR = previous;
  }
}

/** The `RESULT:{json}` line a Bun probe prints. */
function resultOf(run, what) {
  assert.equal(run.timedOut, false, `${what} timed out`);
  assert.equal(run.code, 0, `${what} failed (${run.code}): ${run.stderr || run.stdout}`);
  const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("RESULT:"));
  assert.ok(line, `${what} printed no result: ${run.stdout}${run.stderr}`);
  return JSON.parse(line.slice("RESULT:".length));
}

// ── 1. The cascade: why the keys cannot live beside the plans ────────────────

test("omp never reaches an API key stored beside the plan accounts, even with every plan blocked", { skip, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(path.join(scratch, "cascade-"));
  const trap = await outsideTrap();
  const result = resultOf(await runCommand(bun, [path.join(fixtures, "probe-cascade.mjs"), packageRoot, dir], { env: childEnv({ root: scratch, agentDir: dir, trap }) }), "the cascade probe");
  const step = Object.fromEntries(result.steps.map((entry) => [entry.step, entry]));
  const allOAuth = (entry) => entry.picks.every((pick) => /^oauth:[AB]$/.test(pick));

  assert.ok(allOAuth(step["two plan accounts"]), JSON.stringify(step["two plan accounts"]));
  assert.ok(allOAuth(step["plus ANTHROPIC_API_KEY in the environment"]), `an API key in the environment does not outrank the plans: ${JSON.stringify(step["plus ANTHROPIC_API_KEY in the environment"])}`);
  const stored = step["plus an api_key row stored under anthropic"];
  assert.deepEqual(stored.rows, ["oauth", "oauth", "api_key"], "the key really is stored beside the plans");
  assert.ok(allOAuth(stored), `a stored API key beside the plans is not handed out: ${JSON.stringify(stored)}`);

  // Both plans hit their limit. omp's own rotation moves from the first to the second, and has nowhere to go from the second…
  const blocked = step["both plans marked limited"];
  assert.deepEqual(blocked.marks, [{ switched: true }, { switched: false }], "the first plan's limit rotates to its sibling plan; the second finds no usable sibling");
  assert.ok(allOAuth(blocked), `…and the key stored beside them is STILL not chosen, though both plans are blocked: ${JSON.stringify(blocked)}`);
  const rotation = step["rotate after a plan's 429"];
  assert.equal(rotation.switched, false, "a plan's limit error never rotates onto the key stored beside it");
  assert.ok(allOAuth(rotation), JSON.stringify(rotation));

  // …it only wins once the plans are gone, which is what a fallback to the credits must not require.
  assert.deepEqual(step["plans removed"].picks, ["api-key:stored", "api-key:stored", "api-key:stored"]);
});

// ── 2. How the credits provider's requests are shaped ────────────────────────

test("every credits provider is sent as an API key to the official URL, never as the plan's OAuth", { skip, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(path.join(scratch, "shape-"));
  // Cody's own models.yml blocks for two keys, built from omp's real catalog and aimed at the official API.
  const changed = inAgentDir(dir, () => credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"]));
  assert.deepEqual(changed, { changed: true });
  const blocks = parse(readFileSync(path.join(dir, "models.yml"), "utf8")).providers;
  assert.deepEqual(Object.keys(blocks), ["anthropic-api", "anthropic-api-2"]);
  for (const name of Object.keys(blocks)) {
    assert.equal(blocks[name].baseUrl, "https://api.anthropic.com", name);
    assert.deepEqual(blocks[name].models.map((model) => model.id), catalogModels.map((model) => model.id), `${name} mirrors every Claude model omp lists`);
  }

  const trap = await outsideTrap();
  const result = resultOf(await runCommand(bun, [path.join(fixtures, "probe-shape.mjs"), packageRoot, dir, MODEL_ID], { env: childEnv({ root: scratch, agentDir: dir, trap }) }), "the shape probe");
  const expected = { "anthropic-api": { last4: "7777", suffix: "(API credits)" }, "anthropic-api-2": { last4: "8888", suffix: "(API credits 2)" } };
  for (const [provider, { last4, suffix }] of Object.entries(expected)) {
    const entry = result.providers[provider];
    const model = entry.model;
    assert.ok(model, `omp's own registry resolves Cody's ${provider} block into a model`);
    assert.deepEqual({ provider: model.provider, api: model.api, baseUrl: model.baseUrl, officialEndpoint: model.officialEndpoint }, { provider, api: "anthropic-messages", baseUrl: "https://api.anthropic.com", officialEndpoint: true });
    assert.ok(model.name.endsWith(suffix), `the model picker tells the keys apart: ${model.name}`);
    assert.equal(entry.resolvedKeyPrefix, "sk-ant-api03-", `${provider}: the stored key is what omp hands the client`);
    assert.equal(entry.resolvedKeyLast4, last4, `${provider} resolves ITS OWN key, not another provider's`);

    const shaped = entry.shape;
    assert.equal(shaped.isOAuthToken, false, `${provider}: an API key is never treated as the plan's OAuth token`);
    assert.equal(shaped.apiKeySet, true);
    assert.equal(shaped.authTokenSet, false);
    assert.ok(shaped.headerNames.includes("x-api-key"), `X-Api-Key is how Anthropic's API wants a key: ${shaped.headerNames}`);
    assert.equal(shaped.xApiKey, "sk-ant-api03-");
    assert.equal(shaped.authorization, null, "and no Authorization header goes with it");
    assert.ok(!shaped.headerNames.includes("authorization"));
    assert.ok(shaped.beta === null || !/oauth/i.test(shaped.beta), `no OAuth beta flag rides along with an API key: ${shaped.beta}`);
  }

  // The contrast that is the reason Cody refuses a sign-in token as a "key": omp sniffs the prefix. (The probe masks the token after twelve characters.)
  assert.equal(result.loginTokenAsKey.isOAuthToken, true, "a sign-in token saved as a credits key would be sent as the plan's OAuth");
  assert.match(result.loginTokenAsKey.authorization ?? "", /^Bearer sk-ant-oat01/);
  assert.equal(result.planToken.isOAuthToken, true);
  assert.equal(result.planToken.authTokenSet, true);
  assert.match(result.planToken.authorization ?? "", /^Bearer sk-ant-oat01/);
});

// ── 3. The overlay, as omp merges it ─────────────────────────────────────────

test("omp merges the overlay after the chat's other layers exactly as Cody predicts", { skip, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(path.join(scratch, "chains-"));
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
  const layer = path.join(dir, "preset.yml");
  writeFileSync(layer, "retry:\n  fallbackChains:\n    slow: [anthropic/claude-sonnet-5-5, local/other]\n    smol: null\n    extra: [openrouter/free]\n");
  const overlayFile = inAgentDir(dir, () => {
    creditsStore.writeClaudeCreditsStore([
      { keyId: 3, provider: "anthropic-api", account: "plan-a@example.test", addedAt: "2026-10-01T00:00:00.000Z" },
      { keyId: 4, provider: "anthropic-api-2", account: "plan-b@example.test", addedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    credits.syncClaudeCreditsProviders(["anthropic-api", "anthropic-api-2"], { baseUrl: "http://127.0.0.1:9", models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
    return overlay.materializeClaudeCreditsOverlay([layer]);
  });
  assert.ok(overlayFile, "the credits are on, so there is an overlay");

  // The chat's own layers come first and the overlay last, as rpc-manager's launch composes PI_CONFIG_FILES.
  const trap = await outsideTrap();
  const run = await runCommand(ompBin, ["config", "get", "retry.fallbackChains", "--json"], { env: childEnv({ root: scratch, agentDir: dir, configFiles: [layer, overlayFile].join(path.delimiter), trap }) });
  assert.equal(run.timedOut, false);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).value, {
    default: ["anthropic-api/*", "anthropic-api-2/*", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5"],
    slow: ["anthropic-api/*", "anthropic-api-2/*", "anthropic/claude-sonnet-5-5", "anthropic-api/claude-sonnet-5-5", "anthropic-api-2/claude-sonnet-5-5", "local/other"],
    smol: null, // the preset retired it and the overlay did not bring it back
    commit: [], // an empty chain is the user's "no fallback here" and is left alone
    "openai-codex/gpt-6-astra": ["openai-codex/gpt-5.6-terra"],
    extra: ["anthropic-api/*", "anthropic-api-2/*", "openrouter/free"],
  });

  // Without the overlay the same layers say what the user wrote.
  const plain = await runCommand(ompBin, ["config", "get", "retry.fallbackChains", "--json"], { env: childEnv({ root: scratch, agentDir: dir, configFiles: layer, trap }) });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout).value.default, ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"]);
});

// ── 4. The scenarios ─────────────────────────────────────────────────────────

const requestKinds = (requests) => requests.map((request) => request.kind + (request.who ? `:${request.who}` : ""));
const ofKind = (requests, kind) => requests.filter((request) => request.kind === kind);
/** `who/status` of every request of one kind, in the order the fake saw them. */
const outcomes = (requests, kind) => ofKind(requests, kind).map((request) => `${request.who}/${request.status}`);
const textOf = (message) => message?.content?.find((block) => block.type === "text")?.text ?? message?.errorMessage ?? "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

test("a real omp walks the plans, then each key in turn, then the next provider, and returns to the plan by itself", { skip, timeout: 900_000 }, async (t) => {
  const trap = await outsideTrap();
  const scenarios = [];
  t.after(async () => {
    killAll();
    for (const scenario of scenarios) await scenario.cleanup();
  });
  const build = async (options) => {
    const scenario = await buildScenario({ repoRoot, ompBin, packageRoot, bun, trap, model: MODEL, ...options });
    scenarios.push(scenario);
    return scenario;
  };

  /** Build a scenario, run one `omp -p` turn in it, and keep what the fake saw. */
  const printRun = async (fake) => {
    const scenario = await build({ fake });
    const run = await runOmpPrint({ ompBin, env: scenario.env(), model: MODEL, timeoutMs: 120_000 });
    return { scenario, run, requests: scenario.fake.requests().map((request) => ({ ...request })), seen: scenario.fake.describe() };
  };
  const evidence = ({ run, seen }) => `\n--- what the fake saw, in order ---\n${seen}\n--- omp exit ${run.code}${run.timedOut ? " (TIMED OUT)" : ""}, stdout ---\n${run.stdout.trim()}\n--- stderr (tail) ---\n${run.stderr.trim().slice(-700)}`;
  const lastPlanRefusal = (fake) => Math.max(...fake.requests().filter((request) => request.status === 429).map((request) => request.at));

  const plansLimited = { A: "limited", B: "limited" };
  const staleUsage = { A: 12, B: 12 };
  const bothSpent = { "0001": "exhausted", "0002": "exhausted" };
  const firstSpent = { "0001": "exhausted" };
  // The wording omp classifies as a limit it can rotate away from: an HTTP 402 about available credits.
  const WOULD_EXCEED = { status: 402, type: "billing_error", message: "This request would exceed your available credits given your current in-flight requests." };
  const runs = {
    // Both plans over their limit while the usage report still says "plenty": omp has to learn it from each 429.
    staleUsage: printRun({ plans: plansLimited, usage: staleUsage }),
    // The usage report tells the truth: omp already knows both are out, and needs only the first 429.
    truthfulUsage: printRun({ plans: plansLimited }),
    headroom: printRun({ plans: { A: "ok", B: "ok" } }),
    // The usage report ranks A first, so A is dialled first, answers 429, and B serves.
    secondPlan: printRun({ plans: { A: "limited", B: "ok" }, usage: { A: 5, B: 30 } }),
    // Every key is spent: Anthropic's own wording, an HTTP 400.
    creditsSpent: printRun({ plans: plansLimited, usage: staleUsage, credits: bothSpent, creditsFailure: ANTHROPIC_CREDIT_BALANCE_FAILURE }),
    // …and in the wording omp classifies as a limit it can rotate away from (an HTTP 402 about available credits).
    creditsSpentRotating: printRun({ plans: plansLimited, usage: staleUsage, credits: bothSpent, creditsFailure: WOULD_EXCEED }),
    // Only the FIRST key is spent: the second one has to serve, whichever wording the refusal comes in.
    deadFirstKey: printRun({ plans: plansLimited, usage: staleUsage, credits: firstSpent, creditsFailure: ANTHROPIC_CREDIT_BALANCE_FAILURE }),
    deadFirstKeyRotating: printRun({ plans: plansLimited, usage: staleUsage, credits: firstSpent, creditsFailure: WOULD_EXCEED }),
    revert: (async () => {
      // The plan's 429 says to retry after 3 s: that is omp's cooldown for the account.
      const scenario = await build({ fake: { plans: plansLimited, retryAfter: 3 } });
      const rpc = startOmpRpc({ ompBin, env: scenario.env(), model: MODEL });
      try {
        const ready = await rpc.ready(120_000);
        const one = await rpc.prompt("turn 1 (the plan is over its limit)", 120_000);
        const afterOne = scenario.fake.requests().length;
        // The plan recovers. Wait until well past the cooldown, measured from the fake's own clock of the 429.
        scenario.fake.state.plans = { A: "ok", B: "ok" };
        await sleep(lastPlanRefusal(scenario.fake) + 6000 - Date.now());
        const two = await rpc.prompt("turn 2 (the plan has recovered)", 120_000);
        return { ready, one, two, afterOne, requests: scenario.fake.requests().map((request) => ({ ...request })), seen: scenario.fake.describe(), stderr: rpc.stderr() };
      } finally {
        rpc.kill();
      }
    })(),
    // One chat, the plans over their limit and the FIRST key dead, over four turns: the walk, the next turn at once,
    // the next one after the plans' cooldown with the plans still out, and the one after the plans recovered.
    deadKeyChat: (async () => {
      const scenario = await build({ fake: { plans: plansLimited, retryAfter: 3, credits: firstSpent } });
      const rpc = startOmpRpc({ ompBin, env: scenario.env(), model: MODEL });
      try {
        const ready = await rpc.ready(120_000);
        const turns = [];
        const turn = async (label) => {
          const from = scenario.fake.requests().length;
          const result = await rpc.prompt(label, 120_000);
          turns.push({ label, ...result, requests: scenario.fake.requests().slice(from).map((request) => ({ ...request })) });
        };
        await turn("turn 1 (the plans are out, the first key is dead)");
        await turn("turn 2 (straight afterwards)");
        await sleep(lastPlanRefusal(scenario.fake) + 6000 - Date.now());
        await turn("turn 3 (after the plans' cooldown, the plans still out)");
        scenario.fake.state.plans = { A: "ok", B: "ok" };
        await sleep(lastPlanRefusal(scenario.fake) + 6000 - Date.now());
        await turn("turn 4 (the plans have recovered)");
        return { ready, turns, seen: scenario.fake.describe(), stderr: rpc.stderr() };
      } finally {
        rpc.kill();
      }
    })(),
    // Cody's key handling against omp's real SQLite store, in a process of its own.
    roundtrip: (async () => {
      const root = mkdtempSync(path.join(scratch, "roundtrip-"));
      const agentDir = path.join(root, "agent");
      mkdirSync(agentDir, { recursive: true });
      const env = childEnv({ root, agentDir, trap });
      const seeded = await runCommand(bun, [path.join(fixtures, "seed-plans.mjs"), packageRoot, agentDir, JSON.stringify({ plans: ["A", "B"] })], { env });
      assert.equal(seeded.code, 0, `seeding failed: ${seeded.stderr}`);
      const ran = await runCommand(process.execPath, [path.join(fixtures, "cody-roundtrip.mjs"), JSON.stringify({ repoRoot, agentDir, root, baseUrl: "http://127.0.0.1:9", keys: CREDITS_KEYS.concat("sk-ant-api03-FAKE-credits-key-0003") })], { env: { ...env, CODY_OMP_BIN: ompBin }, timeoutMs: 300_000 });
      assert.equal(ran.code, 0, `the roundtrip failed (${ran.code}): ${ran.stderr || ran.stdout}`);
      return JSON.parse(ran.stdout);
    })(),
  };
  // A failed scenario is reported by the subtest that reads it, not as an unhandled rejection.
  for (const pending of Object.values(runs)) pending.catch(() => undefined);
  await Promise.allSettled(Object.values(runs));
  const timing = (label, run) => t.diagnostic(`${label}: omp ran ${run.ms} ms`);

  await t.test("with both plans over their limit, omp tries every plan account before the credits, the first key before the second, and no other provider is dialled", async () => {
    const result = await runs.staleUsage;
    const { run, requests } = result;
    timing("both plans limited", run);
    const here = evidence(result);
    assert.equal(run.timedOut, false, `omp did not finish${here}`);
    assert.equal(run.code, 0, `omp failed${here}`);
    assert.ok(run.stdout.includes("HELLO FROM THE API CREDITS"), `the reply is the credits'${here}`);

    const firstCredits = requests.findIndex((request) => request.kind === "credits");
    assert.ok(firstCredits > 0, `the credits were used${here}`);
    const before = requests.slice(0, firstCredits);
    assert.deepEqual(before.map((request) => request.kind), before.map(() => "plan"), `only plan requests came before the credits${here}`);
    assert.deepEqual([...new Set(before.map((request) => request.who))].sort(), ["A", "B"], `each plan account answered with its own limit error before the credits were touched${here}`);
    assert.ok(before.every((request) => request.status === 429), `and every one of them was refused${here}`);
    assert.ok(requests.slice(firstCredits).every((request) => request.kind === "credits"), `nothing else after them${here}`);
    assert.equal(ofKind(requests, "standin").length, 0, `no other provider was dialled${here}`);
    // The first key is next in the chain, so the first key answers — and the second is never asked while it can.
    assert.deepEqual(outcomes(requests, "credits"), ["0001/200"], `the first key answered and the second was not touched${here}`);
    assert.ok(run.stdout.includes(creditsText("0001")), `the reply is the first key's${here}`);

    // Cody's own record, from the same real run: both keys saved and paired, never shown in full, each in a provider of its own.
    const status = result.scenario.status;
    assert.deepEqual(status.accounts.map((account) => [account.label, account.key?.last4]), [["plan-a@example.test", "0001"], ["plan-b@example.test", "0002"]]);
    assert.deepEqual(status.strayKeys, []);
    for (const key of CREDITS_KEYS) assert.ok(!JSON.stringify(status).includes(key.slice("sk-ant-api03-".length)), "the status holds no key");
    assert.deepEqual(result.scenario.providers.filter((name) => name.startsWith("anthropic-api")), ["anthropic-api", "anthropic-api-2"], "one models.yml block per key");
    assert.deepEqual(result.scenario.chains.default, ["anthropic-api/*", "anthropic-api-2/*", "fake-codex/gpt-fake"], "the overlay names both providers, in the order the keys were saved, ahead of the other provider");
  });

  await t.test("with the usage report telling the truth, the credits follow the first plan's limit error", async () => {
    const result = await runs.truthfulUsage;
    const { run, requests } = result;
    timing("usage truthful", run);
    const here = evidence(result);
    assert.equal(run.timedOut, false, here);
    assert.equal(run.code, 0, here);
    assert.ok(run.stdout.includes("HELLO FROM THE API CREDITS"), here);
    const firstCredits = requests.findIndex((request) => request.kind === "credits");
    assert.ok(firstCredits >= 1, `the plan was tried first${here}`);
    assert.ok(requests.slice(0, firstCredits).every((request) => request.kind === "plan" && request.status === 429), here);
    assert.equal(ofKind(requests, "standin").length, 0, here);
    assert.deepEqual(outcomes(requests, "credits"), ["0001/200"], `the first key answered${here}`);
  });

  await t.test("while a plan has headroom the credits are not touched, and neither is any other provider", async () => {
    const result = await runs.headroom;
    const { run, requests } = result;
    timing("plan with headroom", run);
    const here = evidence(result);
    assert.equal(run.timedOut, false, here);
    assert.equal(run.code, 0, here);
    assert.match(run.stdout, /HELLO FROM THE PLAN \([AB]\)/, here);
    assert.deepEqual(requestKinds(requests).filter((kind) => !kind.startsWith("plan")), [], `only the plan was asked${here}`);
    assert.ok(requests.length >= 1 && requests.every((request) => request.status === 200), here);
  });

  await t.test("a limited first plan account is followed by the second plan account, never by the credits", async () => {
    const result = await runs.secondPlan;
    const { run, requests } = result;
    timing("first plan limited", run);
    const here = evidence(result);
    assert.equal(run.timedOut, false, here);
    assert.equal(run.code, 0, here);
    assert.ok(run.stdout.includes(planText("B")), `the second plan account served${here}`);
    assert.deepEqual(requests.map((request) => [request.kind, request.who, request.status]), [["plan", "A", 429], ["plan", "B", 200]], `the limited account answered first (the usage report ranks it first), then its sibling${here}`);
  });

  await t.test("when the first key is dead the second serves, in either wording of the refusal, and no other provider is dialled", async () => {
    // Anthropic's own wording is an HTTP 400 that omp does not treat as a usage limit, so it never rotates to a sibling key
    // of the SAME provider: that is why every key has a provider of its own and the chain walks them one by one.
    for (const [label, pending, failure] of [["Anthropic's wording (HTTP 400)", runs.deadFirstKey, ANTHROPIC_CREDIT_BALANCE_FAILURE], ["the wording omp rotates on (HTTP 402)", runs.deadFirstKeyRotating, WOULD_EXCEED]]) {
      const result = await pending;
      const { run, requests } = result;
      timing(`first key dead, ${label}`, run);
      const here = `\n[${label}]${evidence(result)}`;
      assert.equal(run.timedOut, false, `omp did not finish${here}`);
      assert.equal(run.code, 0, `omp failed${here}`);
      assert.ok(run.stdout.includes(creditsText("0002")), `the reply is the SECOND key's${here}`);

      const firstCredits = requests.findIndex((request) => request.kind === "credits");
      const before = requests.slice(0, firstCredits);
      assert.ok(firstCredits > 0 && before.every((request) => request.kind === "plan" && request.status === 429), `both plans were refused first${here}`);
      assert.deepEqual([...new Set(before.map((request) => request.who))].sort(), ["A", "B"], here);
      const credited = ofKind(requests, "credits");
      assert.equal(credited[0].who, "0001", `the first key was asked first${here}`);
      assert.equal(credited[0].status, failure.status, `and refused with the fake's reply${here}`);
      assert.deepEqual([credited.at(-1).who, credited.at(-1).status], ["0002", 200], `then the second key answered${here}`);
      assert.ok(credited.findLastIndex((request) => request.who === "0001") < credited.findIndex((request) => request.who === "0002"), `every request to the dead key came before the second key's${here}`);
      assert.deepEqual(requests.slice(firstCredits).map((request) => request.kind), requests.slice(firstCredits).map(() => "credits"), `nothing but the two keys after the plans${here}`);
      assert.equal(ofKind(requests, "standin").length, 0, `the other provider was never dialled${here}`);
      assert.deepEqual(requests.at(-1) && [requests.at(-1).kind, requests.at(-1).who, requests.at(-1).status], ["credits", "0002", 200], here);
    }
    // The usual wording is exactly one refused request to the dead key, then the second key.
    assert.deepEqual(outcomes((await runs.deadFirstKey).requests, "credits"), ["0001/400", "0002/200"]);
  });

  await t.test("when every key is spent too, the chain carries on to the next provider: plans, first key, second key, then the stand-in", async () => {
    const result = await runs.creditsSpent;
    const { run, requests } = result;
    timing("credits spent (Anthropic's wording)", run);
    const here = evidence(result);
    assert.equal(run.timedOut, false, `omp did not finish${here}`);
    const wording = `omp did not carry on past the credits after the fake answered HTTP ${ANTHROPIC_CREDIT_BALANCE_FAILURE.status} "${ANTHROPIC_CREDIT_BALANCE_FAILURE.message}". This scenario depends on how the installed omp CLASSIFIES that wording (pi-ai error/rate-limit.ts and the hard-error fallback in session/turn-recovery.ts), not on Cody's chain: check that before suspecting the overlay.`;
    assert.ok(ofKind(requests, "credits").length >= 1, `the credits were tried before anything else${here}`);
    assert.ok(ofKind(requests, "standin").length >= 1, `${wording}${here}`);
    assert.equal(run.code, 0, `${wording}${here}`);
    assert.ok(run.stdout.includes(STAND_IN_TEXT), `the reply is the stand-in's${here}`);

    const firstCredits = requests.findIndex((request) => request.kind === "credits");
    const firstStandIn = requests.findIndex((request) => request.kind === "standin");
    assert.ok(requests.slice(0, firstCredits).every((request) => request.kind === "plan"), `the plans, then the credits${here}`);
    assert.ok(firstCredits < firstStandIn, `the credits were asked BEFORE the other provider${here}`);
    assert.deepEqual(requests.slice(firstCredits, firstStandIn).map((request) => request.kind), requests.slice(firstCredits, firstStandIn).map(() => "credits"), `nothing but the credits between the plans and the stand-in${here}`);
    assert.ok(requests.slice(firstCredits, firstStandIn).every((request) => request.status === ANTHROPIC_CREDIT_BALANCE_FAILURE.status), `every credits request was refused with the fake's credit-balance reply${here}`);
    assert.deepEqual(outcomes(requests, "credits"), ["0001/400", "0002/400"], `each key was asked once, the first before the second${here}`);
    assert.equal(requests.at(-1).kind, "standin", here);
  });

  await t.test("in the wording omp rotates on, every saved key is tried — the first before the second — before the next provider", async () => {
    const result = await runs.creditsSpentRotating;
    const { run, requests } = result;
    timing("credits spent (rotating wording)", run);
    const here = evidence(result);
    assert.equal(run.timedOut, false, `omp did not finish${here}`);
    const wording = `omp did not behave as this scenario assumes for the fake's HTTP 402 "would exceed your available credits" reply (try each saved key, then carry on). This depends on omp's usage-limit classification of that wording (pi-ai error/rate-limit.ts), not on Cody's chain.`;
    const credited = ofKind(requests, "credits");
    assert.deepEqual([...new Set(credited.map((request) => request.who))], ["0001", "0002"], `${wording} Both keys must be tried, the first one first${here}`);
    assert.ok(credited.findLastIndex((request) => request.who === "0001") < credited.findIndex((request) => request.who === "0002"), `the first key's requests all came before the second key's${here}`);
    assert.ok(ofKind(requests, "standin").length >= 1, `${wording}${here}`);
    assert.equal(run.code, 0, here);
    assert.ok(run.stdout.includes(STAND_IN_TEXT), here);
    const firstStandIn = requests.findIndex((request) => request.kind === "standin");
    assert.ok(requests.slice(0, firstStandIn).every((request) => request.kind !== "standin"), here);
    assert.ok(requests.findLastIndex((request) => request.kind === "credits") < firstStandIn, `every credits request came before the stand-in${here}`);
    assert.ok(requests.findLastIndex((request) => request.kind === "plan") < requests.findIndex((request) => request.kind === "credits"), `and every plan request before the credits${here}`);
  });

  await t.test("after its cooldown omp goes back to the plan by itself, and the credits only served while the plan was out", async () => {
    const result = await runs.revert;
    const here = `\n--- what the fake saw ---\n${result.seen}\n--- omp stderr (tail) ---\n${result.stderr.trim().slice(-500)}`;
    assert.equal(result.ready, true, `omp never became ready${here}`);

    // Turn 1: the plan is out, the credits serve.
    assert.equal(result.one.ended, true, `turn 1 did not finish\n${describeTurn(result.one.events)}${here}`);
    const turnOne = assistantMessages(result.one.events);
    assert.equal(turnOne.at(-1).provider, "anthropic-api", `turn 1 was served by the credits\n${describeTurn(result.one.events)}${here}`);
    assert.ok(textOf(turnOne.at(-1)).startsWith("HELLO FROM THE API CREDITS"), textOf(turnOne.at(-1)));
    const hop = result.one.events.find((event) => event.type === "retry_fallback_applied");
    assert.ok(hop, `omp announced the switch${here}`);
    assert.equal(pure.isClaudeCreditsSwitch(hop.from, hop.to), true, `the event omp REALLY sent, ${JSON.stringify({ from: hop.from, to: hop.to })}, is the plan → credits hop Cody's chat notice looks for`);
    assert.equal(pure.isClaudeCreditsReturn(hop.from, hop.to), false);

    // Turn 2, well past the cooldown, the plan healthy again: the plan serves, with no switch announced.
    assert.equal(result.two.ended, true, `turn 2 did not finish\n${describeTurn(result.two.events)}${here}`);
    const turnTwo = assistantMessages(result.two.events);
    assert.equal(turnTwo.at(-1).provider, "anthropic", `turn 2 was served by the plan again\n${describeTurn(result.two.events)}${here}`);
    assert.equal(turnTwo.at(-1).stopReason, "stop");
    assert.match(textOf(turnTwo.at(-1)), /^HELLO FROM THE PLAN \([AB]\)/);
    assert.equal(result.two.events.some((event) => event.type === "retry_fallback_applied"), false, `no fallback in turn 2${here}`);

    // What the fake saw: the credits only in turn 1, only the plan in turn 2, and no other provider at all.
    const turnOneRequests = result.requests.slice(0, result.afterOne);
    const turnTwoRequests = result.requests.slice(result.afterOne);
    assert.deepEqual([turnOneRequests.at(-1).kind, turnOneRequests.slice(0, -1).every((request) => request.kind === "plan" && request.status === 429)], ["credits", true], `turn 1: the plan's refusal(s), then the credits${here}`);
    assert.equal(turnOneRequests.at(-1).who, "0001", `the first key served${here}`);
    assert.ok(turnTwoRequests.length >= 1 && turnTwoRequests.every((request) => request.kind === "plan" && request.status === 200), `turn 2: the plan alone${here}`);
    assert.equal(ofKind(result.requests, "standin").length, 0, `no other provider in either turn${here}`);
    assert.equal(ofKind(turnTwoRequests, "credits").length, 0, here);
  });

  await t.test("in one chat with the first key dead, omp moves on to the second, keeps off the dead key while it is out of the running, and still returns to the plan by itself", async () => {
    const result = await runs.deadKeyChat;
    const here = `\n--- what the fake saw ---\n${result.seen}\n--- omp stderr (tail) ---\n${result.stderr.trim().slice(-500)}`;
    assert.equal(result.ready, true, `omp never became ready${here}`);
    assert.equal(result.turns.length, 4, here);
    const [one, two, three, four] = result.turns;
    const describe = (turn) => `\n[${turn.label}]\n${describeTurn(turn.events)}\nrequests: ${requestKinds(turn.requests).join(" > ")}${here}`;
    for (const turn of result.turns) assert.equal(turn.ended, true, `${turn.label} did not finish${describe(turn)}`);
    const servedBy = (turn) => assistantMessages(turn.events).at(-1);

    // Turn 1: both plans refuse, the dead key refuses, the second key serves — and nothing else is dialled.
    const plansBefore = one.requests.slice(0, one.requests.findIndex((request) => request.kind === "credits"));
    assert.ok(plansBefore.length >= 1 && plansBefore.every((request) => request.kind === "plan" && request.status === 429), `turn 1 began with the plans' refusals${describe(one)}`);
    assert.deepEqual(outcomes(one.requests, "credits"), ["0001/400", "0002/200"], `turn 1: the dead key was asked once, then the second key answered${describe(one)}`);
    assert.equal(ofKind(one.requests, "standin").length, 0, describe(one));
    assert.equal(servedBy(one).provider, "anthropic-api-2", `turn 1 was served by the second key's provider${describe(one)}`);
    assert.ok(textOf(servedBy(one)).startsWith(creditsText("0002")), textOf(servedBy(one)));
    // The two hops omp announced, as Cody's chat notice reads them: the plan → credits hop is a switch; key → key is neither a switch nor a return.
    const hops = one.events.filter((event) => event.type === "retry_fallback_applied");
    assert.deepEqual(hops.map((hop) => hop.to.split("/")[0]), ["anthropic-api", "anthropic-api-2"], `omp announced one hop per provider it moved to${describe(one)}`);
    assert.deepEqual(hops.map((hop) => [pure.isClaudeCreditsSwitch(hop.from, hop.to), pure.isClaudeCreditsReturn(hop.from, hop.to)]), [[true, false], [false, false]], `the hops, as omp REALLY sent them: ${JSON.stringify(hops.map((hop) => [hop.from, hop.to]))}${describe(one)}`);

    // Turn 2, straight afterwards: the chat stays on the second key. The dead key is not asked again, and nothing else is dialled.
    assert.equal(ofKind(two.requests, "credits").filter((request) => request.who === "0001").length, 0, `turn 2 did not ask the dead key again${describe(two)}`);
    assert.deepEqual([two.requests.at(-1)?.kind, two.requests.at(-1)?.who, two.requests.at(-1)?.status], ["credits", "0002", 200], describe(two));
    assert.equal(servedBy(two).provider, "anthropic-api-2", describe(two));
    assert.equal(ofKind(two.requests, "standin").length, 0, describe(two));

    // Turn 3, past the plans' cooldown with the plans still out: the plan is tried again and refuses, then the second key —
    // never the dead first key, which omp has put out of the running for a while.
    const planAsked = ofKind(three.requests, "plan");
    assert.ok(planAsked.length >= 1 && planAsked.every((request) => request.status === 429), `turn 3 tried the plan again, and it refused${describe(three)}`);
    assert.equal(ofKind(three.requests, "credits").filter((request) => request.who === "0001").length, 0, `turn 3 did not ask the dead key again${describe(three)}`);
    assert.deepEqual([three.requests.at(-1).kind, three.requests.at(-1).who, three.requests.at(-1).status], ["credits", "0002", 200], describe(three));
    assert.equal(servedBy(three).provider, "anthropic-api-2", describe(three));
    assert.equal(ofKind(three.requests, "standin").length, 0, describe(three));

    // Turn 4, the plans recovered and their cooldown over: the plan serves again, by itself, with the credits untouched.
    assert.equal(servedBy(four).provider, "anthropic", `turn 4 was served by the plan again${describe(four)}`);
    assert.match(textOf(servedBy(four)), /^HELLO FROM THE PLAN \([AB]\)/, describe(four));
    assert.ok(four.requests.length >= 1 && four.requests.every((request) => request.kind === "plan" && request.status === 200), `turn 4: the plan alone${describe(four)}`);
    assert.equal(four.events.some((event) => event.type === "retry_fallback_applied"), false, `no fallback in turn 4${describe(four)}`);
    assert.equal(ofKind(result.turns.flatMap((turn) => turn.requests), "standin").length, 0, `no other provider in any turn${here}`);
  });

  await t.test("Cody's keys against omp's real store: one provider per key, replaced and removed without a trace, duplicates caught across providers", async () => {
    const result = await runs.roundtrip;
    const stepNamed = (name) => result.steps.find((step) => step.name === name);
    const summary = (rows) => rows.map((row) => `${row.provider}:${row.type}${row.disabled ? `(disabled: ${row.disabled})` : ""}${row.last4 ? `…${row.last4}` : ""}`);
    const recorded = (step) => step.record.map((entry) => [entry.account, entry.provider]);
    const planRows = ["anthropic:oauth", "anthropic:oauth"];
    const [one, two, three] = ["0001", "0002", "0003"];

    // Two plan accounts, signed in, no key yet.
    assert.deepEqual(result.statuses.before.accounts.map((account) => [account.label, account.key]), [["plan-a@example.test", null], ["plan-b@example.test", null]]);

    const saved = stepNamed("save a key for the first account");
    assert.equal(saved.error, null);
    assert.deepEqual(summary(saved.rows), [...planRows, `anthropic-api:api_key…${one}`], "the key is stored beside the plans under its OWN provider id, as a plain api_key");
    assert.equal(saved.rows.at(-1).source, "login", "the way omp's own API-key login stores it: part of the provider's login pool");
    assert.deepEqual(recorded(saved), [["plan-a@example.test", "anthropic-api"]]);
    assert.equal(saved.record[0].keyId, saved.rows.at(-1).id);
    assert.deepEqual(saved.providers, ["anthropic-api"], "models.yml serves the first key's provider, and only that one");

    const replaced = stepNamed("replace it with another");
    assert.equal(replaced.error, null);
    assert.deepEqual(summary(replaced.rows), [...planRows, `anthropic-api:api_key…${two}`], "the old key is not left behind, not even as a disabled row, and the new one lives where it did");
    assert.notEqual(replaced.rows.at(-1).id, saved.rows.at(-1).id);
    assert.deepEqual(replaced.record.map((entry) => entry.keyId), [replaced.rows.at(-1).id]);
    assert.deepEqual(recorded(replaced), [["plan-a@example.test", "anthropic-api"]]);

    // The same key for the second account would have gone into the second provider; the key helper looks in EVERY credits
    // provider first, which is what lets Cody see "this key is already saved for another account".
    const duplicate = stepNamed("save that same key for the second account");
    assert.deepEqual(duplicate.error, { code: "claude_credits_duplicate_key", status: 409 });
    assert.deepEqual(summary(duplicate.rows), summary(replaced.rows), "nothing was added for the second account");
    assert.deepEqual(duplicate.rows, replaced.rows);
    assert.deepEqual(duplicate.record, replaced.record);
    assert.deepEqual(duplicate.providers, ["anthropic-api"], "and the second provider's block, written before the key was offered, is gone again");

    const both = stepNamed("save a different key for the second account");
    assert.equal(both.error, null);
    assert.deepEqual(summary(both.rows), [...planRows, `anthropic-api:api_key…${two}`, `anthropic-api-2:api_key…${three}`], "the second key lives in the second provider");
    assert.deepEqual(recorded(both), [["plan-a@example.test", "anthropic-api"], ["plan-b@example.test", "anthropic-api-2"]]);
    assert.deepEqual([...both.providers].sort(), ["anthropic-api", "anthropic-api-2"]);
    assert.deepEqual(result.statuses.both.accounts.map((account) => [account.label, account.key?.last4]), [["plan-a@example.test", two], ["plan-b@example.test", three]]);
    assert.deepEqual(result.statuses.both.strayKeys, []);

    const oneGone = stepNamed("remove the first account's key");
    assert.equal(oneGone.error, null);
    assert.deepEqual(summary(oneGone.rows), [...planRows, `anthropic-api-2:api_key…${three}`], "removal deletes the row; a soft-deleted tombstone would still hold the key");
    assert.deepEqual(oneGone.providers, ["anthropic-api-2"], "the emptied provider's block goes with its key; the second key's stays");
    assert.deepEqual(recorded(oneGone), [["plan-b@example.test", "anthropic-api-2"]]);

    // The first provider is free again: the key that comes next goes there, so the first account's credits are tried first.
    const refilled = stepNamed("save a new key for the first account");
    assert.equal(refilled.error, null);
    assert.deepEqual(summary(refilled.rows), [...planRows, `anthropic-api-2:api_key…${three}`, `anthropic-api:api_key…${one}`]);
    assert.deepEqual([...refilled.providers].sort(), ["anthropic-api", "anthropic-api-2"]);
    assert.deepEqual(result.statuses.refilled.accounts.map((account) => [account.label, account.key?.last4]), [["plan-a@example.test", one], ["plan-b@example.test", three]]);

    const secondGone = stepNamed("remove the second account's key");
    assert.equal(secondGone.error, null);
    assert.deepEqual(summary(secondGone.rows), [...planRows, `anthropic-api:api_key…${one}`]);
    assert.deepEqual(secondGone.providers, ["anthropic-api"], "a key is still saved: the credits stay on, in the first provider");

    const lastGone = stepNamed("remove the last key");
    assert.equal(lastGone.error, null);
    assert.deepEqual(summary(lastGone.rows), planRows, "the plan accounts were never touched");
    assert.deepEqual(lastGone.record, []);
    assert.deepEqual(lastGone.providers, [], "no key, no credits provider");
    assert.deepEqual(result.statuses.after.accounts.map((account) => account.key), [null, null]);

    const everything = JSON.stringify(result);
    for (const key of CREDITS_KEYS.concat("sk-ant-api03-FAKE-credits-key-0003")) assert.ok(!everything.includes(key.slice("sk-ant-api03-".length)), "no full key anywhere in what Cody reported");
  });

  // What the proxy refused is omp's own business (it refreshes model catalogs at startup); the point is that it was refused here.
  const hosts = [...new Set(trap.attempts.map((attempt) => attempt.split(" ")[1].replace(/^https?:\/\//, "").replace(/[:/].*$/, "")))].sort();
  t.diagnostic(`omp tried ${trap.attempts.length} outside connection(s), to ${hosts.length} host(s) (${hosts.join(", ")}); the trap refused every one`);
});
