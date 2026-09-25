import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveModelAvailability, pickAvailableRoute } = await jiti.import("../usage/availability.ts");
const { deriveBlackouts, applyBlackouts } = await jiti.import("./blackouts.ts");
const { parseRoleSelector } = await jiti.import("./role-binding.ts");
const { planAgentRoleOverrides } = await jiti.import("./agent-roles.ts");

const window = (overrides) => ({
  id: "w",
  label: "7 days",
  utilization: 0,
  resetsAt: null,
  state: "ok",
  windowMs: 604800000,
  tier: null,
  shared: true,
  ...overrides,
});

const account = (overrides) => ({
  provider: "anthropic",
  id: "acct",
  identity: null,
  credentialId: null,
  label: "Anthropic",
  planType: null,
  unlimited: false,
  windows: [],
  ...overrides,
});

const snapshot = (accounts) => ({ available: true, accounts, fetchedAt: new Date().toISOString(), stale: false });

test("a provider that reports no quota at all stays usable", () => {
  // The rule that keeps ordinary API keys and local endpoints routable: only
  // positive evidence of exhaustion may take a model off the table.
  const state = resolveModelAvailability(snapshot([]), "llama-swap", "qwen3.8-27b").state;
  assert.equal(state, "unknown");
});

test("an exhausted sibling account never marks the model exhausted", () => {
  // The live shape of the reported bug: one Anthropic account is spent for
  // the week, the other is untouched, and Opus must keep routing.
  const accounts = [
    account({ id: "spent", windows: [window({ id: "a:7d", utilization: 100, state: "exhausted", resetsAt: "2026-09-20T00:00:00.000Z" })] }),
    account({ id: "healthy", windows: [window({ id: "b:7d", utilization: 4 })] }),
  ];
  const availability = resolveModelAvailability(snapshot(accounts), "anthropic", "claude-opus-5");
  assert.equal(availability.state, "ok");
  assert.equal(availability.accountId, "healthy");
});

test("every account exhausted reports the provider as gone until its reset", () => {
  const accounts = [
    account({ id: "one", windows: [window({ utilization: 100, state: "exhausted", resetsAt: "2026-09-20T00:00:00.000Z" })] }),
    account({ id: "two", windows: [window({ utilization: 100, state: "exhausted", resetsAt: "2026-09-19T00:00:00.000Z" })] }),
  ];
  const availability = resolveModelAvailability(snapshot(accounts), "anthropic", "claude-opus-5");
  assert.equal(availability.state, "exhausted");
  assert.equal(availability.allAccountsExhausted, true);
  assert.equal(availability.resetsAt, "2026-09-19T00:00:00.000Z");
});

test("a tier-scoped exhaustion does not black out the account", () => {
  // Anthropic's Fable weekly bucket is tiered; spending it must not take
  // Opus off the same account.
  const accounts = [account({ windows: [window({ id: "a:7d:fable", tier: "fable", utilization: 100, state: "exhausted" })] })];
  assert.equal(resolveModelAvailability(snapshot(accounts), "anthropic", "claude-opus-5").state, "unknown");
  assert.equal(deriveBlackouts(snapshot(accounts)).length, 0);
});

test("the user's chain order is honored, and skipped entries are reported", () => {
  const accounts = [account({ provider: "openai-codex", id: "codex", windows: [window({ utilization: 100, state: "exhausted" })] })];
  const choice = pickAvailableRoute(snapshot(accounts), [
    { provider: "openai-codex", modelId: "gpt-6-astra" },
    { provider: "anthropic", modelId: "claude-opus-5" },
  ]);
  assert.deepEqual(choice.chosen, { provider: "anthropic", modelId: "claude-opus-5" });
  assert.equal(choice.skipped.length, 1);
  assert.equal(choice.skipped[0].provider, "openai-codex");
});

test("an exhausted untiered weekly window takes its tiers down with it", () => {
  // The account has 5% left on the Fable bucket, but the account-wide weekly
  // window is spent — so Fable cannot run either until the weekly resets.
  // A tiered window must never be read as headroom that outlives the
  // untiered window containing it.
  const spent = account({
    id: "spent",
    windows: [
      window({ id: "a:7d", utilization: 100, state: "exhausted", resetsAt: "2026-09-20T00:00:00.000Z" }),
      window({ id: "a:7d:fable", tier: "fable", utilization: 95, state: "warning", resetsAt: "2026-09-20T00:00:00.000Z" }),
    ],
  });
  const only = snapshot([spent]);
  assert.equal(resolveModelAvailability(only, "anthropic", "claude-fable-5-1").state, "exhausted");
  assert.equal(resolveModelAvailability(only, "anthropic", "claude-opus-5").state, "exhausted");
  // And the whole account is blacked out, not just the untiered bucket.
  const blackouts = deriveBlackouts(only);
  assert.equal(blackouts.length, 1);
  assert.equal(blackouts[0].accountId, "spent");
  assert.equal(blackouts[0].until, "2026-09-20T00:00:00.000Z");

  // With a healthy sibling present, Fable still routes — on the sibling.
  const withSibling = snapshot([spent, account({ id: "healthy", windows: [window({ utilization: 4 })] })]);
  const fable = resolveModelAvailability(withSibling, "anthropic", "claude-fable-5-1");
  assert.equal(fable.state, "ok");
  assert.equal(fable.accountId, "healthy");
});

test("a credential blocked by the provider is unusable however good its quota looks", async () => {
  // Measured on a live install: an Anthropic account reporting 4% used was
  // rate-limit-blocked until 03:20Z, and omp refused to send on it — while
  // the ring showed headroom and every turn fell back to another provider.
  // The block is a separate store from the usage API, so it has to be
  // folded into the snapshot or nothing downstream can see it.
  const { applyCredentialBlocks } = await jiti.import("../usage/credential-order.ts");
  const healthy = account({ id: "nathan", credentialId: 5, windows: [window({ utilization: 4 })] });
  const now = Date.parse("2026-09-14T02:00:00.000Z");
  const blocked = applyCredentialBlocks(
    snapshot([healthy]),
    [{ id: 5, provider: "anthropic", identity: "nathan", blockedUntil: "2026-09-14T03:20:00.000Z" }],
    now,
  );
  const availability = resolveModelAvailability(blocked, "anthropic", "claude-opus-5");
  assert.equal(availability.state, "exhausted");
  assert.equal(availability.resetsAt, "2026-09-14T03:20:00.000Z");

  // Once the block expires the account is simply healthy again — no
  // lingering penalty, and no write to undo.
  const later = applyCredentialBlocks(
    snapshot([healthy]),
    [{ id: 5, provider: "anthropic", identity: "nathan", blockedUntil: "2026-09-14T03:20:00.000Z" }],
    Date.parse("2026-09-14T04:00:00.000Z"),
  );
  assert.equal(resolveModelAvailability(later, "anthropic", "claude-opus-5").state, "ok");
});

test("a remembered blackout survives telemetry going quiet", () => {
  // The whole point of the registry: a failed `omp usage` read reports
  // nothing, and "nothing" must not read as "healthy" for a provider that
  // is out for another six days.
  const memory = {
    blackouts: [{ provider: "openai-codex", accountId: null, kind: "quota", since: "2026-09-13T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z", reason: "7 days" }],
    bindings: {},
  };
  const effective = applyBlackouts(snapshot([]), memory, Date.parse("2026-09-14T00:00:00.000Z"));
  assert.equal(resolveModelAvailability(effective, "openai-codex", "gpt-6-astra").state, "exhausted");
});

test("observation never writes to the engine's config; binding is opt-in", async (t) => {
  // The guard that makes an UPDATE safe: installing a new version must not
  // re-point anyone's roles on the first usage poll. Blackouts are Cody's
  // own state and are always recorded; modelRoles and agentModelOverrides
  // are touched only once the user opts in.
  const { mkdtempSync, copyFileSync, readFileSync, existsSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-autobind-"));
  const config = path.join(dir, "config.yml");
  copyFileSync(fileURLToPath(new URL("./fixtures/routing-config.yml", import.meta.url)), config);
  const before = readFileSync(config, "utf8");

  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousBind = process.env.CODY_ROUTE_AUTOBIND;
  const previousHarness = process.env.CODY_HARNESS;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CODY_HARNESS = "omp";
  delete process.env.CODY_ROUTE_AUTOBIND;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousBind === undefined) delete process.env.CODY_ROUTE_AUTOBIND; else process.env.CODY_ROUTE_AUTOBIND = previousBind;
    if (previousHarness === undefined) delete process.env.CODY_HARNESS; else process.env.CODY_HARNESS = previousHarness;
  });

  const { reconcileRouting } = await jiti.import("./reconcile.ts");
  const exhausted = snapshot([account({
    provider: "openai-codex",
    id: "codex",
    credentialId: 1,
    // Far future: a window whose reset has already passed reads as reset.
    windows: [window({ utilization: 100, state: "exhausted", resetsAt: "2099-09-20T03:15:02.000Z" })],
  })]);

  const observed = reconcileRouting(exhausted, { agents: ["task", "luna"], catalog: [] });
  assert.equal(observed.autoBind, false);
  assert.deepEqual(observed.roleChanges, []);
  assert.deepEqual(observed.agentChanges, []);
  assert.equal(readFileSync(config, "utf8"), before, "config.yml must be untouched while observing");
  assert.ok(observed.blackouts.length > 0, "blackouts are still recorded");
  assert.ok(existsSync(path.join(dir, "cody-route-memory.json")), "Cody's own state is still written");

  process.env.CODY_ROUTE_AUTOBIND = "1";
  const bound = reconcileRouting(exhausted, { agents: ["task", "luna"], catalog: [] });
  assert.equal(bound.autoBind, true);
  assert.ok(bound.agentChanges.length > 0, "opting in writes the agent role aliases");
  assert.notEqual(readFileSync(config, "utf8"), before);
});

test("a prepaid balance blacks out only on a successful read, and a dust balance counts as spent", () => {
  const failed = deriveBlackouts(snapshot([]), { available: false, credits: null });
  assert.equal(failed.length, 0, "a failed balance read is not a zero balance");
  const empty = deriveBlackouts(snapshot([]), { available: true, credits: { totalCredits: 5, totalUsage: 5, remaining: 0 } });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].kind, "credits");
  assert.equal(empty[0].until, null, "money does not come back on a timer");
  // The live case: a few cents left answered every request with
  // "402 … can only afford 17889 tokens" and, being positive, won a chain walk.
  const dust = deriveBlackouts(snapshot([]), { available: true, credits: { totalCredits: 20, totalUsage: 19.6, remaining: 0.4 } });
  assert.equal(dust.length, 1, "a balance that cannot start a request is out of credits");
  const funded = deriveBlackouts(snapshot([]), { available: true, credits: { totalCredits: 20, totalUsage: 5, remaining: 15 } });
  assert.equal(funded.length, 0);
  // A capped key is exhausted on its own limit even with money in the account.
  const capped = deriveBlackouts(snapshot([]), { available: true, credits: { totalCredits: 20, totalUsage: 5, remaining: 15 }, key: { limitRemaining: 0.1 } });
  assert.equal(capped.length, 1);
});

test("a thinking suffix is split off a role selector but a model's own colon is not", () => {
  assert.deepEqual(parseRoleSelector("openai-codex/gpt-6-astra:medium"), { provider: "openai-codex", modelId: "gpt-6-astra", suffix: ":medium" });
  assert.deepEqual(parseRoleSelector("openrouter/moonshotai/kimi-k2.6:free"), { provider: "openrouter", modelId: "moonshotai/kimi-k2.6:free", suffix: "" });
});

test("an agent pinned to a concrete model loses its role fallback chain, so the pin is replaced", () => {
  // luna.md pins `openai-codex/gpt-5.6-luna`. omp only keys a child's
  // inherited fallback chain off a ROLE alias, so a concrete pin means no
  // chain at all — and an unresolvable one silently runs the subagent on
  // the parent's (expensive) model.
  const planned = planAgentRoleOverrides({
    overrides: { luna: "openai-codex/gpt-5.6-luna" },
    agents: ["luna"],
    catalog: ["anthropic/claude-opus-5"],
    snapshot: snapshot([]),
  });
  assert.deepEqual(planned.changes, [{ agent: "luna", from: "openai-codex/gpt-5.6-luna", to: "@smol", reason: "unresolvable" }]);
});

test("an agent with no override at all is given its role", () => {
  const planned = planAgentRoleOverrides({ overrides: {}, agents: ["scout", "task"], catalog: [], snapshot: snapshot([]) });
  assert.deepEqual(planned.overrides, { scout: "@smol", task: "@task" });
});

test("a working concrete pin and a user's own role alias are both left alone", () => {
  const planned = planAgentRoleOverrides({
    overrides: { luna: "anthropic/claude-haiku-4-5", scout: "@tiny" },
    agents: ["luna", "scout"],
    catalog: ["anthropic/claude-haiku-4-5"],
    snapshot: snapshot([]),
  });
  assert.deepEqual(planned.changes, []);
});

test("without a cached catalog an existing pin is never judged unresolvable", () => {
  const planned = planAgentRoleOverrides({
    overrides: { luna: "openai-codex/gpt-5.6-luna" },
    agents: ["luna"],
    catalog: [],
    snapshot: snapshot([]),
  });
  assert.deepEqual(planned.changes, []);
});
