import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A provider the user removed or disabled must leave Usage and routing, and
 * stay gone. Three things used to hold it there (measured on the owner's
 * install: an OpenRouter key removed weeks earlier still drew a row in Usage):
 *
 *   - a remembered "out of credits" blackout has no expiry and is lifted only
 *     by a successful balance read, which a removed key can never give — and
 *     `applyBlackouts` fabricates an account for a provider the live report no
 *     longer has, so the row never went away;
 *   - a removed provider's other blackouts had no owner left to lift them;
 *   - a provider the engine's config DISABLES stayed in the one snapshot
 *     routing and Usage read.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyBlackouts, blackoutCoverage, withoutProviders } = await jiti.import("./blackouts.ts");
const { clearProviderBlackouts, readRouteMemory, recordBlackouts } = await jiti.import("./route-memory.ts");
const { reconcileRouting } = await jiti.import("./reconcile.ts");
const { applyCredentialBlocks } = await jiti.import("../usage/credential-order.ts");

const account = (overrides) => ({
  provider: "anthropic", id: "acct", identity: null, credentialId: null, label: "Anthropic", planType: null, unlimited: false, windows: [], ...overrides,
});
const snapshot = (accounts, extra = {}) => ({ available: true, accounts, fetchedAt: new Date().toISOString(), stale: false, ...extra });
const credits = { provider: "openrouter", accountId: null, kind: "credits", since: "2026-09-14T06:39:58.150Z", until: null, reason: "out of credits ($0.00 left)" };

/** An agent dir for route memory, restored afterwards. */
function agentDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-removed-providers-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, harness: process.env.CODY_HARNESS, bind: process.env.CODY_ROUTE_AUTOBIND };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CODY_HARNESS = "omp";
  delete process.env.CODY_ROUTE_AUTOBIND;
  t.after(() => {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["CODY_HARNESS", saved.harness], ["CODY_ROUTE_AUTOBIND", saved.bind]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a read that found NO key covers a credits blackout; a failed or unreachable read does not", () => {
  const covered = (openRouter) => blackoutCoverage(snapshot([]), openRouter)(credits);
  assert.equal(covered({ available: true }), true, "a balance read that saw money");
  assert.equal(covered({ available: false, error: { code: "no_key" } }), true, "no key anywhere: nothing left to spend, and no balance read can ever lift it");
  assert.equal(covered({ available: false, error: { code: "unreachable" } }), false, "silence is not headroom");
  assert.equal(covered({ available: false, error: { code: "rate_limited" } }), false);
  assert.equal(covered({ available: false, error: { code: "unauthorized" } }), false, "a rejected key is still a key that cannot spend");
  assert.equal(covered(null), false);
});

test("a removed key's 'out of credits' blackout is lifted by the next read, and Usage stops fabricating an OpenRouter account", (t) => {
  agentDir(t);
  recordBlackouts([credits]);
  assert.equal(readRouteMemory().blackouts.length, 1, "precondition: remembered since September");
  assert.ok(applyBlackouts(snapshot([]), readRouteMemory()).accounts.some((entry) => entry.provider === "openrouter"), "precondition: the blackout fabricates the row");

  const result = reconcileRouting(snapshot([]), { openRouter: { available: false, error: { code: "no_key" } } });
  assert.deepEqual(result.blackouts, []);
  assert.deepEqual(readRouteMemory().blackouts, [], "forgotten for good, not just hidden");
  assert.equal(result.snapshot.accounts.some((entry) => entry.provider === "openrouter"), false);
});

test("an unreachable balance read keeps the blackout: it was not proof of anything", (t) => {
  agentDir(t);
  recordBlackouts([credits]);
  const result = reconcileRouting(snapshot([]), { openRouter: { available: false, error: { code: "unreachable" } } });
  assert.equal(result.blackouts.length, 1);
  assert.ok(result.snapshot.accounts.some((entry) => entry.provider === "openrouter"));
});

test("clearing a provider forgets every blackout of it — any account — and nobody else's", (t) => {
  agentDir(t);
  const quota = (provider, accountId) => ({ provider, accountId, kind: "quota", since: "2026-10-13T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", reason: "7-day window" });
  recordBlackouts([quota("anthropic", "a"), quota("anthropic", "b"), quota("openai-codex", "c"), credits]);
  assert.equal(clearProviderBlackouts("anthropic"), 2);
  assert.deepEqual(readRouteMemory().blackouts.map((entry) => entry.provider).sort(), ["openai-codex", "openrouter"]);
  assert.equal(clearProviderBlackouts("anthropic"), 0, "idempotent: nothing left to forget");
});

test("a provider the engine disables leaves the snapshot, and its remembered blackouts are forgotten — including ones from before it was disabled", (t) => {
  const dir = agentDir(t);
  recordBlackouts([credits]);
  const live = snapshot([account({ provider: "anthropic", id: "a" }), account({ provider: "openai-codex", id: "c" })]);

  const result = reconcileRouting(live, { disabledProviders: ["openrouter", "anthropic"], openRouter: { available: true, credits: { totalCredits: 5, totalUsage: 5, remaining: 0 } } });
  assert.deepEqual(result.snapshot.accounts.map((entry) => entry.provider), ["openai-codex"], "neither the live Claude account nor a fabricated OpenRouter one");
  assert.deepEqual(result.blackouts, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "cody-route-memory.json"), "utf8")).blackouts, [], "gone from the memory itself — GET /api/routing no longer lists it");

  // Enabled again with an empty balance: the next live read derives the blackout afresh.
  const back = reconcileRouting(live, { openRouter: { available: true, credits: { totalCredits: 5, totalUsage: 5, remaining: 0 } } });
  assert.ok(back.snapshot.accounts.some((entry) => entry.provider === "anthropic"));
  assert.deepEqual(back.blackouts.map((entry) => [entry.provider, entry.kind]), [["openrouter", "credits"]]);
});

test("withoutProviders leaves an untouched snapshot as the same object", () => {
  const live = snapshot([account({ provider: "anthropic" })]);
  assert.equal(withoutProviders(live, new Set()), live);
  assert.equal(withoutProviders(live, new Set(["openrouter"])), live);
  assert.deepEqual(withoutProviders(live, new Set(["anthropic"])).accounts, []);
});

test("a block recorded against a credential that is disabled or removed is not a fact about routing", () => {
  const blocked = (overrides) => ({ id: 3, provider: "alibaba-token-plan", type: "api_key", identity: null, planType: null, disabledCause: null, blockedUntil: "2099-01-01T00:00:00.000Z", pinHash: null, ...overrides });
  const live = applyCredentialBlocks(snapshot([]), [blocked({})]);
  assert.equal(live.accounts.length, 1, "a live blocked key is still surfaced");
  const removed = applyCredentialBlocks(snapshot([]), [blocked({ disabledCause: "deleted by user" })]);
  assert.deepEqual(removed.accounts, [], "a removed key must not fabricate a blocked account");
});
