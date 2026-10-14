import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * Saved Claude API credits change what "this Claude model is out" means.
 *
 * omp's own fallback chain puts a plan model's API twin FIRST, so a plan that is
 * out of room is still answered by the same model, on the credits. The routing
 * passes that used to route around a spent plan — re-pointing a role at Codex,
 * dropping the entry from a chain, calling an agent's pin "exhausted" — would
 * now jump ahead of the credits the user set aside for exactly that moment.
 * Every case below runs the real passes against a real config.yml in a throwaway
 * agent dir; nothing here touches the instance's own.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "cody-credits-cover-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CODY_PACKAGE_DIR", "PI_CONFIG_FILES", "CODY_HARNESS", "CODY_ROUTE_AUTOBIND", "HOME", "OPENROUTER_API_KEY"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent-initial");
process.env.CODY_PACKAGE_DIR = repoRoot;
process.env.PI_CONFIG_FILES = "";
process.env.CODY_HARNESS = "omp";
process.env.HOME = scratch;
delete process.env.CODY_ROUTE_AUTOBIND;
delete process.env.OPENROUTER_API_KEY;

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { reconcileRoleBindings } = await jiti.import("./role-binding.ts");
const { planChainBindings, reconcileChainBindings } = await jiti.import("./chain-binding.ts");
const { planAgentRoleOverrides } = await jiti.import("./agent-roles.ts");
const { coveredByClaudeCredits } = await jiti.import("./credits-cover.ts");
const { readRouteMemory } = await jiti.import("./route-memory.ts");
const { readModelRoles } = await jiti.import("../omp/model-roles.ts");
const { readNativeSettings } = await jiti.import("../omp/settings-config.ts");
const { applyCredentialBlocks } = await jiti.import("../usage/credential-order.ts");

const window = (overrides) => ({
  id: "w", label: "7 days", utilization: 0, resetsAt: null, state: "ok", windowMs: 604800000, tier: null, shared: true, ...overrides,
});
// Far future: a window whose reset has passed reads as reset.
const spent = (overrides = {}) => window({ utilization: 100, state: "exhausted", resetsAt: "2099-01-01T00:00:00.000Z", ...overrides });
const account = (overrides) => ({
  provider: "anthropic", id: "acct", identity: null, credentialId: null, label: "Anthropic", planType: null, unlimited: false, windows: [], ...overrides,
});
const snapshot = (accounts, extra = {}) => ({ available: true, accounts, fetchedAt: new Date().toISOString(), stale: false, ...extra });

/** Nitin's two Claude plan accounts, both out of room. */
const PLANS_SPENT = [account({ id: "a", credentialId: 1, windows: [spent()] }), account({ id: "b", credentialId: 2, windows: [spent()] })];
const plansSpent = () => snapshot(PLANS_SPENT);
/** The credits' own key is blocked: how Cody's usage snapshot reports spent credits (credential-order.ts). */
const creditsRow = (overrides = {}) => ({ id: 7, provider: "anthropic-api", type: "api_key", identity: null, planType: null, disabledCause: null, blockedUntil: null, pinHash: null, ...overrides });
const creditsSpent = () => applyCredentialBlocks(plansSpent(), [creditsRow({ blockedUntil: "2099-01-02T00:00:00.000Z" })]);

/** The Claude models models.yml's `anthropic-api` block serves: all the credits can answer for. */
const COVER = { modelIds: new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) };

/** A fresh agent dir for this test; the next test points the env at its own. */
let counter = 0;
function agentDir(config = "") {
  const dir = path.join(scratch, `agent-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dir;
  if (config) writeFileSync(path.join(dir, "config.yml"), config);
  return dir;
}
const configText = (dir) => readFileSync(path.join(dir, "config.yml"), "utf8");
const roles = () => readModelRoles().roles;
const chainsOnDisk = () => readNativeSettings().settings.retry?.fallbackChains ?? {};

const ROLE_CONFIG = [
  "# the user's own comment survives",
  "modelRoles:",
  "  default: anthropic/claude-opus-5-5:high",
  "  smol: llama-swap/gemma4-e4b",
  "retry:",
  "  fallbackChains:",
  "    default:",
  "      - openai-codex/gpt-6-astra",
  "      - llama-swap/qwen3.8-27b",
  "",
].join("\n");

test("coveredByClaudeCredits: only a Claude plan model the credits serve, and only while the credits are not spent", () => {
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic", "claude-opus-5-5", COVER), true);
  // No credits saved, or nothing to cover with.
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic", "claude-opus-5-5", null), false);
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic", "claude-opus-5-5", undefined), false);
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic", "claude-opus-5-5", { modelIds: new Set() }), false);
  // A model the credits' block does not list, another provider's model, and the credits' own provider id.
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic", "claude-legacy-1", COVER), false);
  assert.equal(coveredByClaudeCredits(plansSpent(), "openai-codex", "claude-opus-5-5", COVER), false);
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic-api", "claude-opus-5-5", COVER), false);
  // The credits' only key is blocked: they cannot answer, so nothing is covered.
  assert.equal(coveredByClaudeCredits(creditsSpent(), "anthropic", "claude-opus-5-5", COVER), false);
  // The same fact written directly as a spent account, and with no snapshot at all.
  const direct = snapshot([...PLANS_SPENT, account({ provider: "anthropic-api", id: "key", windows: [spent()] })]);
  assert.equal(coveredByClaudeCredits(direct, "anthropic", "claude-opus-5-5", COVER), false);
  assert.equal(coveredByClaudeCredits(null, "anthropic", "claude-opus-5-5", COVER), true, "no evidence the credits are spent");
  assert.equal(coveredByClaudeCredits(snapshot([]), "anthropic", "claude-opus-5-5", COVER), true);
});

test("coveredByClaudeCredits with several keys: the credits are spent only when EVERY saved key is, each key being a provider of its own", () => {
  const key = (id, provider, windows) => account({ provider, id: `${provider}#${id}`, credentialId: id, windows });
  const oneBlocked = snapshot([...PLANS_SPENT, key(7, "anthropic-api", [spent()])]);
  const bothBlocked = snapshot([...PLANS_SPENT, key(7, "anthropic-api", [spent()]), key(8, "anthropic-api-2", [spent()])]);
  const two = { ...COVER, keyCount: 2 };

  assert.equal(coveredByClaudeCredits(oneBlocked, "anthropic", "claude-opus-5-5", two), true, "the second key still has credit, and omp's chain moves on to its provider");
  assert.equal(coveredByClaudeCredits(bothBlocked, "anthropic", "claude-opus-5-5", two), false);
  assert.equal(coveredByClaudeCredits(snapshot([...PLANS_SPENT, key(8, "anthropic-api-2", [spent()])]), "anthropic", "claude-opus-5-5", two), true, "it is the SECOND key alone that is blocked: the first still answers");
  assert.equal(coveredByClaudeCredits(plansSpent(), "anthropic", "claude-opus-5-5", two), true, "no key reported blocked");
  // A cover that does not say how many keys there are means one.
  assert.equal(coveredByClaudeCredits(oneBlocked, "anthropic", "claude-opus-5-5", COVER), false);
  assert.equal(coveredByClaudeCredits(oneBlocked, "anthropic", "claude-opus-5-5", { ...COVER, keyCount: 1 }), false);
  // A tier-scoped exhaustion or a healthy window is not a blocked key.
  assert.equal(coveredByClaudeCredits(snapshot([...PLANS_SPENT, key(7, "anthropic-api", [spent({ tier: "opus" })])]), "anthropic", "claude-opus-5-5", COVER), true);
  assert.equal(coveredByClaudeCredits(snapshot([...PLANS_SPENT, key(7, "anthropic-api", [window({ utilization: 10 })])]), "anthropic", "claude-opus-5-5", COVER), true);

  // Every slot counts, up to the eighth, and nothing outside the family does: not the plans' own pool, not a ninth name.
  const eight = { ...COVER, keyCount: 8 };
  const slots = ["anthropic-api", ...Array.from({ length: 7 }, (_, index) => `anthropic-api-${index + 2}`)];
  const blockedSlots = (count) => snapshot([...PLANS_SPENT, ...slots.slice(0, count).map((provider, index) => key(20 + index, provider, [spent()]))]);
  assert.equal(coveredByClaudeCredits(blockedSlots(7), "anthropic", "claude-opus-5-5", eight), true, "seven of eight blocked");
  assert.equal(coveredByClaudeCredits(blockedSlots(8), "anthropic", "claude-opus-5-5", eight), false, "all eight blocked");
  const stray = (provider) => snapshot([...PLANS_SPENT, key(30, provider, [spent()])]);
  for (const outside of ["anthropic-api-9", "anthropic-api-1", "anthropic-api-10", "openai-codex", "anthropic"]) {
    assert.equal(coveredByClaudeCredits(stray(outside), "anthropic", "claude-opus-5-5", COVER), true, `a spent account of ${outside} is not a blocked credits key`);
  }
  assert.equal(coveredByClaudeCredits(stray("anthropic-api-8"), "anthropic", "claude-opus-5-5", COVER), false);
  // A credits provider is not a plan provider: its models are never "covered" by themselves.
  for (const provider of slots) assert.equal(coveredByClaudeCredits(plansSpent(), provider, "claude-opus-5-5", COVER), false, provider);
});

test("with two keys saved, one blocked key keeps the plan models covered and both blocked take the cover away: through the real usage pipeline", () => {
  const two = { ...COVER, keyCount: 2 };
  const blocked = (...rows) => applyCredentialBlocks(plansSpent(), rows.map(([id, until, provider]) => creditsRow({ id, provider, blockedUntil: until })));
  const until = "2099-01-02T00:00:00.000Z";
  assert.equal(coveredByClaudeCredits(blocked([7, null, "anthropic-api"], [8, null, "anthropic-api-2"]), "anthropic", "claude-opus-5-5", two), true, "no key blocked");
  assert.equal(coveredByClaudeCredits(blocked([7, until, "anthropic-api"], [8, null, "anthropic-api-2"]), "anthropic", "claude-opus-5-5", two), true, "one key blocked, the other can still answer");
  assert.equal(coveredByClaudeCredits(blocked([7, null, "anthropic-api"], [8, until, "anthropic-api-2"]), "anthropic", "claude-opus-5-5", two), true, "the second key blocked, the first can still answer");
  assert.equal(coveredByClaudeCredits(blocked([7, until, "anthropic-api"], [8, until, "anthropic-api-2"]), "anthropic", "claude-opus-5-5", two), false, "every key blocked: the credits are spent, so the old behaviour returns");
  // A block that has expired is no block.
  assert.equal(coveredByClaudeCredits(blocked([7, "2001-01-01T00:00:00.000Z", "anthropic-api"], [8, "2001-01-01T00:00:00.000Z", "anthropic-api-2"]), "anthropic", "claude-opus-5-5", two), true);
  // A key row under a provider that is not the credits' is not a credits key, blocked or not.
  assert.equal(coveredByClaudeCredits(blocked([7, until, "anthropic-api"], [8, until, "anthropic-api-9"]), "anthropic", "claude-opus-5-5", two), true);
});

test("two blocked rows in ONE provider are both counted: a replaced key's old row can sit beside the new one until omp lets it go", () => {
  // The usage snapshot reports a blocked credential row for each provider that has no account of its own. Cody once
  // built one account per provider, so two refused rows read as one spent key and one usable: that must not come back.
  const until = "2099-01-02T00:00:00.000Z";
  const rows = [creditsRow({ id: 7, blockedUntil: until }), creditsRow({ id: 8, blockedUntil: until })];
  const piped = applyCredentialBlocks(plansSpent(), rows);
  assert.equal(piped.accounts.filter((entry) => entry.provider === "anthropic-api").length, 2, "one account per refused row");
  assert.equal(coveredByClaudeCredits(piped, "anthropic", "claude-opus-5-5", { ...COVER, keyCount: 2 }), false);
  assert.equal(coveredByClaudeCredits(applyCredentialBlocks(plansSpent(), [rows[0], creditsRow({ id: 8 })]), "anthropic", "claude-opus-5-5", { ...COVER, keyCount: 2 }), true, "one of the two rows is still usable");
});

test("control: without credits a Claude role on a spent plan is re-pointed at the first usable chain entry", () => {
  const dir = agentDir(ROLE_CONFIG);
  const { changes } = reconcileRoleBindings({ snapshot: plansSpent(), chains: { default: ["openai-codex/gpt-6-astra", "llama-swap/qwen3.8-27b"] } });
  assert.deepEqual(changes, [{
    role: "default",
    from: "anthropic/claude-opus-5-5:high",
    to: "openai-codex/gpt-6-astra",
    kind: "bound",
    reason: "anthropic is out of quota",
  }]);
  assert.equal(roles().default, "openai-codex/gpt-6-astra");
  assert.equal(roles().smol, "llama-swap/gemma4-e4b", "a role that is fine is not touched");
  assert.equal(readRouteMemory().bindings.default.baseline, "anthropic/claude-opus-5-5:high", "the user's assignment, thinking level included, is remembered");
  assert.match(configText(dir), /the user's own comment survives/);
});

test("with credits saved the same role is left alone: nothing written, nothing remembered", () => {
  const dir = agentDir(ROLE_CONFIG);
  const before = configText(dir);
  const result = reconcileRoleBindings({ snapshot: plansSpent(), chains: { default: ["openai-codex/gpt-6-astra", "llama-swap/qwen3.8-27b"] }, claudeCredits: COVER });
  assert.deepEqual(result.changes, []);
  assert.equal(result.roles.default, "anthropic/claude-opus-5-5:high");
  assert.equal(configText(dir), before, "config.yml is byte-for-byte what the user wrote");
  assert.deepEqual(readRouteMemory().bindings, {});
});

test("a role Cody already re-pointed is restored the moment the credits cover it, and the change says why", () => {
  agentDir(ROLE_CONFIG);
  const chains = { default: ["openai-codex/gpt-6-astra", "llama-swap/qwen3.8-27b"] };
  // Before the credits were saved: the old behaviour bound the role to Codex.
  reconcileRoleBindings({ snapshot: plansSpent(), chains });
  assert.equal(roles().default, "openai-codex/gpt-6-astra");

  const { changes } = reconcileRoleBindings({ snapshot: plansSpent(), chains, claudeCredits: COVER });
  assert.equal(changes.length, 1);
  assert.deepEqual({ ...changes[0], reason: undefined }, {
    role: "default",
    from: "openai-codex/gpt-6-astra",
    to: "anthropic/claude-opus-5-5:high",
    kind: "restored",
    reason: undefined,
  });
  assert.match(changes[0].reason, /credits/i, "the notice names the credits, not 'quota restored'");
  assert.equal(roles().default, "anthropic/claude-opus-5-5:high", "restored verbatim, thinking level included");
  assert.deepEqual(readRouteMemory().bindings, {}, "the binding is forgotten once the baseline is back");

  // And it stays put on the next pass.
  assert.deepEqual(reconcileRoleBindings({ snapshot: plansSpent(), chains, claudeCredits: COVER }).changes, []);
});

test("when the credits are spent too the role is routed around again, and comes back when the credits do", () => {
  agentDir(ROLE_CONFIG);
  const chains = { default: ["openai-codex/gpt-6-astra", "llama-swap/qwen3.8-27b"] };
  const input = (snap) => ({ snapshot: snap, chains, claudeCredits: COVER });

  assert.deepEqual(reconcileRoleBindings(input(plansSpent())).changes, [], "plans spent, credits healthy: Claude keeps the role");

  // The credits' key is blocked (credit balance gone): the old behaviour returns.
  const bound = reconcileRoleBindings(input(creditsSpent()));
  assert.deepEqual(bound.changes.map((change) => [change.kind, change.from, change.to]), [["bound", "anthropic/claude-opus-5-5:high", "openai-codex/gpt-6-astra"]]);
  assert.equal(roles().default, "openai-codex/gpt-6-astra");

  // Still spent on the next pass: nothing moves again.
  assert.deepEqual(reconcileRoleBindings(input(creditsSpent())).changes, []);

  // Topped up: the credits answer again, so Claude gets its role back — with the plan still spent.
  const back = reconcileRoleBindings(input(plansSpent()));
  assert.deepEqual(back.changes.map((change) => [change.kind, change.to]), [["restored", "anthropic/claude-opus-5-5:high"]]);
  assert.match(back.changes[0].reason, /credits/i);
  assert.equal(roles().default, "anthropic/claude-opus-5-5:high");
});

test("the same holds when the spent credits are a plain exhausted account in the snapshot", () => {
  agentDir(ROLE_CONFIG);
  const snap = snapshot([...PLANS_SPENT, account({ provider: "anthropic-api", id: "anthropic-api#7", credentialId: 7, windows: [spent()] })]);
  const { changes } = reconcileRoleBindings({ snapshot: snap, chains: { default: ["openai-codex/gpt-6-astra"] }, claudeCredits: COVER });
  assert.deepEqual(changes.map((change) => [change.kind, change.to]), [["bound", "openai-codex/gpt-6-astra"]]);
});

test("the credits cover only the Claude models they serve", () => {
  agentDir("modelRoles:\n  default: anthropic/claude-legacy-1\n  smol: openai-codex/gpt-6-astra\n");
  const chains = { default: ["llama-swap/qwen3.8-27b"], smol: ["llama-swap/gemma4-e4b"] };
  const snap = snapshot([...PLANS_SPENT, account({ provider: "openai-codex", id: "codex", windows: [spent()] })]);
  const { changes } = reconcileRoleBindings({ snapshot: snap, chains, claudeCredits: COVER });
  // A Claude model the credits' block does not list, and a Codex role: both are routed around as before.
  assert.deepEqual(changes.map((change) => [change.role, change.kind, change.to]).sort(), [
    ["default", "bound", "llama-swap/qwen3.8-27b"],
    ["smol", "bound", "llama-swap/gemma4-e4b"],
  ]);
});

test("a covered Claude model is a valid destination for a role whose own provider ran dry", () => {
  const config = "modelRoles:\n  smol: openai-codex/gpt-6-astra\n";
  const snap = snapshot([...PLANS_SPENT, account({ provider: "openai-codex", id: "codex", windows: [spent()] })]);
  const chains = { smol: ["anthropic/claude-haiku-5-5", "llama-swap/gemma4-e4b"] };

  agentDir(config);
  assert.equal(reconcileRoleBindings({ snapshot: snap, chains }).changes[0].to, "llama-swap/gemma4-e4b", "control: the spent plan model is skipped");
  agentDir(config);
  assert.equal(reconcileRoleBindings({ snapshot: snap, chains, claudeCredits: COVER }).changes[0].to, "anthropic/claude-haiku-5-5", "with credits it can serve, so it is the first usable entry");
  agentDir(config);
  const creditsGone = applyCredentialBlocks(snap, [creditsRow({ blockedUntil: "2099-01-02T00:00:00.000Z" })]);
  assert.equal(reconcileRoleBindings({ snapshot: creditsGone, chains, claudeCredits: COVER }).changes[0].to, "llama-swap/gemma4-e4b", "credits spent too: the Claude entry is skipped again");
});

test("one healthy plan account needs no cover: nothing is routed around either way", () => {
  const dir = agentDir(ROLE_CONFIG);
  const before = configText(dir);
  const snap = snapshot([account({ id: "a", windows: [spent()] }), account({ id: "b", windows: [window({ utilization: 18 })] })]);
  for (const claudeCredits of [null, COVER]) {
    assert.deepEqual(reconcileRoleBindings({ snapshot: snap, chains: { default: ["openai-codex/gpt-6-astra"] }, claudeCredits }).changes, []);
  }
  assert.equal(configText(dir), before);
});

// ── Fallback chains ──────────────────────────────────────────────────────────

const CHAIN_CONFIG = [
  "# the user's own comment survives",
  "retry:",
  "  fallbackChains:",
  "    default:",
  "      - anthropic/claude-opus-5-5",
  "      - openrouter/moonshotai/kimi-k2.6",
  "      - llama-swap/qwen3.8-27b",
  "    slow:",
  "      - anthropic/claude-sonnet-5-5:high",
  "      - llama-swap/qwen3.8-27b",
  "    smol:",
  "      - anthropic/claude-legacy-1",
  "      - llama-swap/gemma4-e4b",
  "",
].join("\n");

test("control: without credits a chain entry on a spent plan is left out", () => {
  const dir = agentDir(CHAIN_CONFIG);
  const { changes } = reconcileChainBindings({ snapshot: plansSpent(), chains: chainsOnDisk() });
  assert.deepEqual(changes.map((change) => [change.chain, change.kind]).sort(), [["default", "filtered"], ["slow", "filtered"], ["smol", "filtered"]]);
  assert.deepEqual(chainsOnDisk().default, ["openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"]);
  assert.deepEqual(chainsOnDisk().slow, ["llama-swap/qwen3.8-27b"]);
  assert.match(configText(dir), /the user's own comment survives/);
});

test("with credits saved a covered plan entry stays in the chain, so the walk keeps its place", () => {
  const dir = agentDir(CHAIN_CONFIG);
  const { changes, chains } = reconcileChainBindings({ snapshot: plansSpent(), chains: chainsOnDisk(), claudeCredits: COVER });
  // The entry the credits do not serve (claude-legacy-1) is still dropped; the covered ones are kept.
  assert.deepEqual(changes.map((change) => [change.chain, change.kind]), [["smol", "filtered"]]);
  assert.deepEqual(chains.default, ["anthropic/claude-opus-5-5", "openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"]);
  assert.deepEqual(chains.slow, ["anthropic/claude-sonnet-5-5:high", "llama-swap/qwen3.8-27b"], "a thinking suffix does not hide the model from the cover");
  assert.deepEqual(chains.smol, ["llama-swap/gemma4-e4b"]);
  assert.deepEqual(chainsOnDisk().default, ["anthropic/claude-opus-5-5", "openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"]);
  assert.match(configText(dir), /the user's own comment survives/);
});

test("with credits saved and nothing else spent, no chain is rewritten and nothing is remembered", () => {
  const dir = agentDir(CHAIN_CONFIG.replace(/anthropic\/claude-legacy-1/, "anthropic/claude-haiku-5-5"));
  const before = configText(dir);
  const result = reconcileChainBindings({ snapshot: plansSpent(), chains: chainsOnDisk(), claudeCredits: COVER });
  assert.deepEqual(result.changes, []);
  assert.equal(configText(dir), before, "config.yml is byte-for-byte what the user wrote");
  assert.deepEqual(readRouteMemory().chains, {});
});

test("an entry filtered before the credits were saved comes back once they cover it; spent credits drop it again", () => {
  agentDir(CHAIN_CONFIG.replace(/anthropic\/claude-legacy-1/, "anthropic/claude-haiku-5-5"));
  const original = { ...chainsOnDisk() };
  reconcileChainBindings({ snapshot: plansSpent(), chains: chainsOnDisk() });
  assert.deepEqual(chainsOnDisk().default, ["openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"]);

  const restored = reconcileChainBindings({ snapshot: plansSpent(), chains: chainsOnDisk(), claudeCredits: COVER });
  assert.deepEqual(restored.changes.map((change) => change.kind).sort(), ["restored", "restored", "restored"]);
  assert.deepEqual(chainsOnDisk(), original, "every chain is back exactly as the user wrote it");
  assert.deepEqual(readRouteMemory().chains, {});

  // The credits' key is blocked: the plan entry is dropped once more.
  const dropped = reconcileChainBindings({ snapshot: creditsSpent(), chains: chainsOnDisk(), claudeCredits: COVER });
  assert.deepEqual(dropped.changes.map((change) => change.kind).sort(), ["filtered", "filtered", "filtered"]);
  assert.deepEqual(chainsOnDisk().default, ["openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"]);
});

test("planChainBindings: the cover is judged per entry, against the snapshot it is given", () => {
  const chains = { default: ["anthropic/claude-opus-5-5", "anthropic/claude-legacy-1", "openai-codex/gpt-6-astra", "llama-swap/qwen3.8-27b"] };
  const codexSpent = [account({ provider: "openai-codex", id: "codex", windows: [spent()] })];
  const plan = (snap, claudeCredits) => planChainBindings({ snapshot: snap, chains, claudeCredits }, {}).chains.default;

  assert.deepEqual(plan(snapshot([...PLANS_SPENT, ...codexSpent]), COVER), ["anthropic/claude-opus-5-5", "llama-swap/qwen3.8-27b"], "the cover does not shield Codex or an unserved Claude model");
  assert.deepEqual(plan(snapshot([...PLANS_SPENT, ...codexSpent]), null), ["llama-swap/qwen3.8-27b"]);
  assert.deepEqual(plan(snapshot(PLANS_SPENT), { modelIds: new Set() }), chains.default.filter((entry) => !entry.startsWith("anthropic/")), "an empty cover covers nothing");
});

// ── Agent pins ───────────────────────────────────────────────────────────────

test("a Claude pin the credits carry is not called exhausted; spent credits or an unserved model are", () => {
  const catalog = ["anthropic/claude-opus-5-5", "anthropic/claude-legacy-1", "openai-codex/gpt-6-astra"];
  const plan = (pin, snap, claudeCredits) => planAgentRoleOverrides({ overrides: { luna: pin }, agents: ["luna"], catalog, snapshot: snap, claudeCredits });

  const control = plan("anthropic/claude-opus-5-5", plansSpent(), null);
  assert.deepEqual(control.changes, [{ agent: "luna", from: "anthropic/claude-opus-5-5", to: "@smol", reason: "exhausted" }]);

  const covered = plan("anthropic/claude-opus-5-5", plansSpent(), COVER);
  assert.deepEqual(covered.changes, [], "a working pin is the user's choice");
  assert.deepEqual(covered.overrides, { luna: "anthropic/claude-opus-5-5" });

  assert.deepEqual(plan("anthropic/claude-opus-5-5", creditsSpent(), COVER).changes.map((change) => change.reason), ["exhausted"]);
  assert.deepEqual(plan("anthropic/claude-legacy-1", plansSpent(), COVER).changes.map((change) => change.reason), ["exhausted"]);
  // A pin on another provider is judged as it always was.
  const codexSpent = snapshot([account({ provider: "openai-codex", id: "codex", windows: [spent()] })]);
  assert.deepEqual(plan("openai-codex/gpt-6-astra", codexSpent, COVER).changes.map((change) => change.reason), ["exhausted"]);
});

// ── The whole pass ───────────────────────────────────────────────────────────

test("the full routing pass hands the cover to all three stages", async () => {
  const config = [
    "modelRoles:",
    "  default: anthropic/claude-opus-5-5:high",
    "retry:",
    "  fallbackChains:",
    "    default:",
    "      - anthropic/claude-opus-5-5",
    "      - llama-swap/qwen3.8-27b",
    "task:",
    "  agentModelOverrides:",
    "    luna: anthropic/claude-opus-5-5",
    "",
  ].join("\n");
  const { reconcileRouting } = await jiti.import("./reconcile.ts");
  const deps = { agents: ["luna"], catalog: ["anthropic/claude-opus-5-5", "llama-swap/qwen3.8-27b"] };
  process.env.CODY_ROUTE_AUTOBIND = "1";
  try {
    // Control: no credits. Everything on the spent plan is routed around.
    agentDir(config);
    const without = reconcileRouting(plansSpent(), deps);
    assert.equal(without.autoBind, true);
    assert.deepEqual(without.chainChanges.map((change) => change.kind), ["filtered"]);
    assert.deepEqual(without.roleChanges.map((change) => change.kind), ["bound"]);
    assert.deepEqual(without.agentChanges.map((change) => change.reason), ["exhausted"]);

    // The same snapshot with the credits saved: all three leave Claude where it is.
    const dir = agentDir(config);
    const before = configText(dir);
    const covered = reconcileRouting(plansSpent(), { ...deps, claudeCredits: COVER });
    assert.equal(covered.autoBind, true);
    assert.deepEqual(covered.chainChanges, []);
    assert.deepEqual(covered.roleChanges, []);
    assert.deepEqual(covered.agentChanges, []);
    assert.equal(configText(dir), before, "not one byte of config.yml moved");

    // The credits' own key is blocked too: the full old behaviour is back.
    agentDir(config);
    const spentToo = reconcileRouting(creditsSpent(), { ...deps, claudeCredits: COVER });
    assert.deepEqual(spentToo.chainChanges.map((change) => change.kind), ["filtered"]);
    assert.deepEqual(spentToo.roleChanges.map((change) => change.kind), ["bound"]);
    assert.deepEqual(spentToo.agentChanges.map((change) => change.reason), ["exhausted"]);
  } finally {
    delete process.env.CODY_ROUTE_AUTOBIND;
  }
});

test("the request-level pass reads the saved credits, key count included, from the instance's own files", async () => {
  const { reconcileRoutingForRequest } = await jiti.import("./request.ts");
  const { syncClaudeCreditsProviders } = await jiti.import("../omp/claude-credits.ts");
  const { writeClaudeCreditsStore } = await jiti.import("../omp/claude-credits-store.ts");
  const until = "2099-01-02T00:00:00.000Z";
  const PROVIDERS = ["anthropic-api", "anthropic-api-2", "anthropic-api-3"];
  /** One refused row per key, each under the provider its key lives in (null: that key is not blocked). */
  const blocked = (...untils) => applyCredentialBlocks(plansSpent(), untils.map((blockedUntil, index) => creditsRow({ id: 10 + index, provider: PROVIDERS[index], blockedUntil })));
  /** An agent dir with a saved key under each of `providers` and the provider blocks that serve them. */
  const withKeys = (providers) => {
    agentDir(ROLE_CONFIG);
    if (providers.length === 0) return;
    writeClaudeCreditsStore(providers.map((provider, index) => ({ keyId: 10 + index, provider, account: `plan-${index}@example.test`, addedAt: "2026-10-01T00:00:00.000Z" })));
    syncClaudeCreditsProviders(providers, { baseUrl: "http://127.0.0.1:9", models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
  };
  const roleKinds = async (snapshotToRead) => (await reconcileRoutingForRequest(snapshotToRead)).roleChanges.map((change) => change.kind);
  process.env.CODY_ROUTE_AUTOBIND = "1";
  try {
    withKeys([]);
    assert.deepEqual(await roleKinds(plansSpent()), ["bound"], "no credits saved: the spent plan's role is routed around, as before");

    withKeys(PROVIDERS.slice(0, 1));
    assert.deepEqual(await roleKinds(plansSpent()), [], "one key saved and not blocked: the credits carry the plan model");
    withKeys(PROVIDERS.slice(0, 1));
    assert.deepEqual(await roleKinds(blocked(until)), ["bound"], "the one key is blocked: the credits are spent");

    withKeys(PROVIDERS.slice(0, 2));
    assert.deepEqual(await roleKinds(blocked(until, null)), [], "two keys saved, one blocked: the other still answers, so Claude keeps the role");
    withKeys(PROVIDERS.slice(0, 2));
    assert.deepEqual(await roleKinds(blocked(null, until)), [], "…whichever of the two it is");
    withKeys(PROVIDERS.slice(0, 2));
    assert.deepEqual(await roleKinds(blocked(until, until)), ["bound"], "two keys saved, both blocked: the old behaviour is back");

    withKeys(PROVIDERS);
    assert.deepEqual(await roleKinds(blocked(until, until, null)), [], "three keys saved, two blocked: the third still answers");
    withKeys(PROVIDERS);
    assert.deepEqual(await roleKinds(blocked(until, until, until)), ["bound"], "three keys saved, all blocked");

    // The first key was removed: the second provider alone holds the one key, and its block is the one that counts.
    withKeys(["anthropic-api-2"]);
    assert.deepEqual(await roleKinds(plansSpent()), [], "the credits carry the model from the second slot too");
    withKeys(["anthropic-api-2"]);
    assert.deepEqual(await roleKinds(applyCredentialBlocks(plansSpent(), [creditsRow({ id: 10, provider: "anthropic-api-2", blockedUntil: until })])), ["bound"], "and are spent when that key is blocked");

    // A block with no key behind it, or a key with no block serving it, is not "credits saved".
    agentDir(ROLE_CONFIG);
    syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: "http://127.0.0.1:9", models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
    assert.deepEqual(await roleKinds(plansSpent()), ["bound"]);
    agentDir(ROLE_CONFIG);
    writeClaudeCreditsStore([{ keyId: 10, provider: "anthropic-api", account: "plan-0@example.test", addedAt: "2026-10-01T00:00:00.000Z" }]);
    assert.deepEqual(await roleKinds(plansSpent()), ["bound"]);
    // A key in the second slot while only the first slot's block exists: the second key is not served, so it is not counted…
    agentDir(ROLE_CONFIG);
    writeClaudeCreditsStore([{ keyId: 10, provider: "anthropic-api-2", account: "plan-0@example.test", addedAt: "2026-10-01T00:00:00.000Z" }]);
    syncClaudeCreditsProviders(["anthropic-api"], { baseUrl: "http://127.0.0.1:9", models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
    assert.deepEqual(await roleKinds(plansSpent()), ["bound"], "…and with no served key there is nothing to cover with");
  } finally {
    delete process.env.CODY_ROUTE_AUTOBIND;
  }
});
