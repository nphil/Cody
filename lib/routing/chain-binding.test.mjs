import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { planChainBindings } = await jiti.import("./chain-binding.ts");
const { applyBlackouts, blackoutCoverage, deriveBlackouts, lapseResetWindows } = await jiti.import("./blackouts.ts");
const { DEFAULT_AGENT_ROLES, planAgentRoleOverrides } = await jiti.import("./agent-roles.ts");
const { resolveModelAvailability } = await jiti.import("../usage/availability.ts");

const window = (overrides) => ({
  id: "w", label: "7 days", utilization: 0, resetsAt: null, state: "ok", windowMs: 604800000, tier: null, shared: true, ...overrides,
});
const spent = (overrides = {}) => window({ utilization: 100, state: "exhausted", resetsAt: "2099-01-01T00:00:00.000Z", ...overrides });
const account = (overrides) => ({
  provider: "anthropic", id: "acct", identity: null, credentialId: null, label: "Anthropic", planType: null, unlimited: false, windows: [], ...overrides,
});
const snapshot = (accounts, extra = {}) => ({ available: true, accounts, fetchedAt: new Date().toISOString(), stale: false, ...extra });

const CHAIN = ["anthropic/claude-opus-5", "openrouter/moonshotai/kimi-k2.6", "alibaba-token-plan/qwen3.8-max", "llama-swap/qwen3.8-27b"];
const plan = (snap, chains = { default: CHAIN }, memory = {}) => planChainBindings({ snapshot: snap, chains }, memory);

test("one spent account beside a healthy sibling leaves the chain alone", () => {
  const result = plan(snapshot([
    account({ id: "a", windows: [spent()] }),
    account({ id: "b", windows: [window({ utilization: 18 })] }),
  ]));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.chains.default, CHAIN);
  assert.deepEqual(result.record, []);
});

test("a provider whose only saved credentials are disabled is unavailable, but a disabled sibling is ignored", () => {
  const disabled = account({ id: "disabled", disabled: { cause: "auth failure" } });
  const allDisabled = resolveModelAvailability(snapshot([disabled]), "anthropic", "claude-opus-5");
  assert.equal(allDisabled.state, "exhausted");
  assert.equal(allDisabled.allAccountsExhausted, true);

  const filtered = plan(snapshot([disabled]));
  assert.deepEqual(filtered.chains.default, CHAIN.slice(1));
  assert.deepEqual(filtered.record[0].dropped[0], {
    entry: CHAIN[0], provider: "anthropic", reason: "all accounts disabled", until: null, source: "disabled",
  });

  const activeSibling = plan(snapshot([
    disabled,
    account({ id: "active", windows: [window({ utilization: 18 })] }),
  ]));
  assert.deepEqual(activeSibling.changes, [], "a healthy active sibling remains usable");
  assert.deepEqual(activeSibling.chains.default, CHAIN);
});

test("every account of a provider spent drops that provider's entries, in the user's order", () => {
  const result = plan(snapshot([
    account({ id: "a", windows: [spent()] }),
    account({ id: "b", windows: [spent()] }),
  ]));
  assert.deepEqual(result.chains.default, CHAIN.slice(1));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, "filtered");
  assert.deepEqual(result.record[0].baseline, CHAIN, "the user's chain is remembered to restore");
});

test("a spent prepaid balance drops the gateway, and the entry returns once the balance does", () => {
  const credits = { provider: "openrouter", accountId: null, kind: "credits", since: "2026-09-20T00:00:00.000Z", until: null, reason: "out of credits" };
  const broke = applyBlackouts(snapshot([]), { blackouts: [credits] });
  const filtered = plan(broke);
  assert.deepEqual(filtered.chains.default, CHAIN.filter((entry) => !entry.startsWith("openrouter/")));

  // Next poll: the balance read shows money, the blackout is not re-derived,
  // and Cody's own write is recognised and undone.
  const memory = { default: filtered.record[0] };
  const funded = plan(snapshot([]), { default: filtered.chains.default }, memory);
  assert.deepEqual(funded.chains.default, CHAIN);
  assert.equal(funded.changes[0].kind, "restored");
  assert.deepEqual(funded.forget, ["default"]);
});

test("a blackout whose reset has passed restores the entry without a fresh read", () => {
  const memory = [{ provider: "alibaba-token-plan", accountId: "alibaba-token-plan#4", kind: "quota", since: "2026-09-20T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z", reason: "rate-limit block" }];
  const before = applyBlackouts(snapshot([]), { blackouts: memory }, Date.parse("2026-09-20T12:00:00.000Z"));
  assert.ok(!plan(before).chains.default.includes("alibaba-token-plan/qwen3.8-max"));
  const after = applyBlackouts(snapshot([]), { blackouts: memory }, Date.parse("2026-09-22T00:00:00.000Z"));
  assert.deepEqual(plan(after).chains.default, CHAIN);

  // Same for a cached read that still says "exhausted" past its own reset.
  const cached = snapshot([account({ provider: "alibaba-token-plan", id: "x", windows: [spent({ resetsAt: "2026-09-21T00:00:00.000Z" })] })]);
  const lapsed = lapseResetWindows(cached, Date.parse("2026-09-22T00:00:00.000Z"));
  assert.equal(resolveModelAvailability(lapsed, "alibaba-token-plan", "qwen3.8-max").state, "ok");
  assert.equal(deriveBlackouts(lapsed).length, 0);
});

test("a chain the user edited while filtered becomes the new baseline", () => {
  const memory = { default: { key: "default", baseline: CHAIN, active: CHAIN.slice(1), reason: "anthropic out of quota", boundAt: "2026-09-20T00:00:00.000Z" } };
  const edited = ["llama-swap/qwen3.8-27b", "openrouter/moonshotai/kimi-k2.6"];
  const result = plan(snapshot([]), { default: edited }, memory);
  assert.deepEqual(result.chains.default, edited, "the user's edit is kept, not overwritten with the old baseline");
  assert.deepEqual(result.baselines.default, edited);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.forget, ["default"]);
});

test("a chain with every entry spent is left as the user wrote it", () => {
  const chain = ["anthropic/claude-opus-5", "openrouter/moonshotai/kimi-k2.6"];
  const credits = { provider: "openrouter", accountId: null, kind: "credits", since: "2026-09-20T00:00:00.000Z", until: null, reason: "out of credits" };
  const snap = applyBlackouts(snapshot([account({ id: "a", windows: [spent()] })]), { blackouts: [credits] });
  const result = plan(snap, { default: chain });
  assert.deepEqual(result.chains.default, chain);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.record, []);
});

test("a read that cannot see a target does not lift its blackout; one that sees headroom does", () => {
  const blackout = { provider: "anthropic", accountId: "a", kind: "quota", since: "", until: "2099-01-01T00:00:00.000Z", reason: "" };
  const credits = { provider: "openrouter", accountId: null, kind: "credits", since: "", until: null, reason: "" };
  assert.equal(blackoutCoverage({ available: false, accounts: [] }, null)(blackout), false, "a failed read is silence");
  assert.equal(blackoutCoverage(snapshot([account({ id: "a" })], { stale: true }), null)(blackout), false, "a stale read is old news");
  assert.equal(blackoutCoverage(snapshot([account({ id: "b" })]), null)(blackout), false, "an account missing from the report is silence");
  assert.equal(blackoutCoverage(snapshot([account({ id: "a" })]), null)(blackout), true);
  assert.equal(blackoutCoverage(snapshot([]), { available: false })(credits), false);
  assert.equal(blackoutCoverage(snapshot([]), { available: true })(credits), true);
});

test("both reviewers resolve through the slow role", () => {
  assert.equal(DEFAULT_AGENT_ROLES.reviewer, "@slow");
  assert.equal(DEFAULT_AGENT_ROLES["security-reviewer"], "@slow");
  const planned = planAgentRoleOverrides({ overrides: {}, agents: ["reviewer", "security-reviewer"], catalog: [], snapshot: snapshot([]) });
  assert.deepEqual(planned.overrides, { reviewer: "@slow", "security-reviewer": "@slow" });
});

test("reconcile filters a chain on disk, remembers it across a failed read, and restores it", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-chains-"));
  const config = path.join(dir, "config.yml");
  writeFileSync(config, [
    "# the user's own comment survives",
    "retry:",
    "  fallbackChains:",
    "    default:",
    ...CHAIN.map((entry) => `      - ${entry}`),
    "    smol:",
    "      - llama-swap/gemma4-e4b",
    "modelRoles:",
    "  default: llama-swap/qwen3.8-27b",
    "",
  ].join("\n"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, bind: process.env.CODY_ROUTE_AUTOBIND, harness: process.env.CODY_HARNESS };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CODY_ROUTE_AUTOBIND = "1";
  process.env.CODY_HARNESS = "omp";
  t.after(() => {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["CODY_ROUTE_AUTOBIND", saved.bind], ["CODY_HARNESS", saved.harness]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { reconcileRouting } = await jiti.import("./reconcile.ts");
  const { readNativeSettings } = await jiti.import("../omp/settings-config.ts");
  const chains = () => readNativeSettings().settings.retry.fallbackChains;

  const broke = { available: true, credits: { totalCredits: 20, totalUsage: 20, remaining: 0 } };
  const first = reconcileRouting(snapshot([]), { openRouter: broke });
  assert.equal(first.chainChanges.length, 1);
  assert.deepEqual(chains().default, CHAIN.filter((entry) => !entry.startsWith("openrouter/")));
  assert.deepEqual(chains().smol, ["llama-swap/gemma4-e4b"], "an untouched chain is not rewritten");
  assert.match(readFileSync(config, "utf8"), /the user's own comment survives/);

  // A poll whose balance read failed is not a top-up.
  const quiet = reconcileRouting(snapshot([]), { openRouter: { available: false } });
  assert.deepEqual(quiet.chainChanges, []);
  assert.ok(!chains().default.some((entry) => entry.startsWith("openrouter/")));

  const funded = reconcileRouting(snapshot([]), { openRouter: { available: true, credits: { totalCredits: 40, totalUsage: 20, remaining: 20 } } });
  assert.equal(funded.chainChanges[0]?.kind, "restored");
  assert.deepEqual(chains().default, CHAIN);

  // Nothing moved: nothing is written.
  const before = readFileSync(config, "utf8");
  reconcileRouting(snapshot([]), { openRouter: { available: true, credits: { totalCredits: 40, totalUsage: 20, remaining: 20 } } });
  assert.equal(readFileSync(config, "utf8"), before);
});

test("every dropped entry says why, in words the UI can show", async () => {
  const { applyCredentialBlocks } = await jiti.import("../usage/credential-order.ts");
  const credits = { provider: "openrouter", accountId: null, kind: "credits", since: "", until: null, reason: "out of credits ($0.40 left)" };
  // Alibaba reports no usage: its only evidence is omp's block on the key.
  const blocked = applyCredentialBlocks(
    snapshot([account({ id: "a", windows: [spent({ resetsAt: "2099-01-02T00:00:00.000Z" })] }), account({ id: "b", windows: [spent()] })]),
    [{ id: 4, provider: "alibaba-token-plan", identity: null, blockedUntil: "2099-01-03T00:00:00.000Z" }],
    Date.parse("2026-09-22T00:00:00.000Z"),
  );
  const block = blocked.accounts.find((entry) => entry.provider === "alibaba-token-plan");
  assert.equal(block.windows[0].source, "block", "a block is labelled as a block, not a measurement");
  const blackouts = [credits, ...deriveBlackouts(blocked)];
  assert.equal(blackouts.find((entry) => entry.provider === "alibaba-token-plan").source, "block");
  assert.equal(blackouts.find((entry) => entry.provider === "anthropic").source, undefined);

  const effective = applyBlackouts(blocked, { blackouts });
  const result = planChainBindings({ snapshot: effective, blackouts, chains: { default: CHAIN } }, {});
  assert.deepEqual(result.chains.default, ["llama-swap/qwen3.8-27b"]);
  const dropped = Object.fromEntries(result.record[0].dropped.map((entry) => [entry.provider, entry]));
  assert.deepEqual(dropped.openrouter, { entry: CHAIN[1], provider: "openrouter", reason: "out of credits ($0.40 left)", until: null, source: "credits" });
  assert.deepEqual(dropped.anthropic, { entry: CHAIN[0], provider: "anthropic", reason: "all accounts exhausted until 2099-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", source: "quota" });
  assert.deepEqual(dropped["alibaba-token-plan"], { entry: CHAIN[2], provider: "alibaba-token-plan", reason: "blocked after a rejected request until 2099-01-03T00:00:00.000Z", until: "2099-01-03T00:00:00.000Z", source: "block" });
});

test("a remembered block from an older file is still recognised as a block", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-legacy-block-"));
  writeFileSync(path.join(dir, "cody-route-memory.json"), JSON.stringify({
    version: 1,
    blackouts: [{ provider: "alibaba-token-plan", accountId: "alibaba-token-plan#4", kind: "quota", since: "2026-09-20T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", reason: "rate-limit block" }],
    bindings: {},
  }));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; });
  const { readRouteMemory } = await jiti.import("./route-memory.ts");
  const memory = readRouteMemory();
  assert.equal(memory.blackouts[0].source, "block");
  assert.deepEqual(memory.chains, {}, "a file from before chain bindings parses with none");
});

test("a disabled-account chain reason survives route-memory serialization", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-disabled-chain-"));
  writeFileSync(path.join(dir, "cody-route-memory.json"), JSON.stringify({
    version: 1,
    blackouts: [],
    bindings: {},
    chains: {
      default: {
        key: "default",
        baseline: CHAIN,
        active: CHAIN.slice(1),
        dropped: [{ entry: CHAIN[0], provider: "anthropic", reason: "all accounts disabled", until: null, source: "disabled" }],
        reason: "anthropic: all accounts disabled",
        boundAt: "2026-09-23T00:00:00.000Z",
      },
    },
  }));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; });
  const { readRouteMemory } = await jiti.import("./route-memory.ts");
  assert.equal(readRouteMemory().chains.default.dropped[0].source, "disabled");
});

test("another engine still observes quota, but nothing is written to omp's config", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-other-engine-"));
  const config = path.join(dir, "config.yml");
  writeFileSync(config, `retry:\n  fallbackChains:\n    default:\n${CHAIN.map((entry) => `      - ${entry}`).join("\n")}\n`);
  const before = readFileSync(config, "utf8");
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, bind: process.env.CODY_ROUTE_AUTOBIND, harness: process.env.CODY_HARNESS };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CODY_ROUTE_AUTOBIND = "1";
  process.env.CODY_HARNESS = "claude";
  t.after(() => {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["CODY_ROUTE_AUTOBIND", saved.bind], ["CODY_HARNESS", saved.harness]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { reconcileRouting } = await jiti.import("./reconcile.ts");
  const result = reconcileRouting(snapshot([]), { openRouter: { available: true, credits: { totalCredits: 20, totalUsage: 20, remaining: 0 } } });
  assert.equal(result.autoBind, false, "binding is omp-only");
  assert.equal(result.blackouts.length, 1, "observation is not");
  assert.equal(resolveModelAvailability(result.snapshot, "openrouter", "moonshotai/kimi-k2.6").state, "exhausted");
  assert.equal(readFileSync(config, "utf8"), before);
});
