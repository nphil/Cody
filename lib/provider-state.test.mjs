import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `settleProviderChange` is what makes a removal STICK. Removing an account
 * used to clear the roster and the model list and nothing else, so the account
 * came back from the usage snapshot (cached a minute, served stale while it
 * refreshed), from OpenRouter's cached balance, from a remembered blackout and
 * from the saved-reset balances. Each cache is primed here, the change is
 * settled, and every one must answer from scratch.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { settleProviderChange } = await jiti.import("./provider-state.ts");
const { getUsageSnapshot } = await jiti.import("./usage/cache.ts");
const { getOpenRouterAccount } = await jiti.import("./openrouter/account.ts");
const { loadModelsWithCache } = await jiti.import("./models-cache.ts");
const { readRouteMemory, recordBlackouts } = await jiti.import("./routing/route-memory.ts");

const usage = (label) => ({ available: true, accounts: [{ provider: "anthropic", id: label, identity: null, credentialId: null, label, planType: null, unlimited: false, windows: [] }], fetchedAt: new Date().toISOString(), stale: false });
const credits = { provider: "openrouter", accountId: null, kind: "credits", since: "2026-09-14T06:39:58.150Z", until: null, reason: "out of credits" };

function agentDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-provider-state-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("every cache that remembered the provider answers from scratch afterwards", async (t) => {
  agentDir(t);
  let usageLoads = 0;
  const loadUsage = async () => { usageLoads += 1; return usage(`read-${usageLoads}`); };
  assert.equal((await getUsageSnapshot({ load: loadUsage })).accounts[0].id, "read-1");
  assert.equal((await getUsageSnapshot({ load: loadUsage })).accounts[0].id, "read-1", "precondition: the usage read is cached");

  const openRouterCalls = [];
  const openRouterDeps = {
    fetcher: async (url) => { openRouterCalls.push(String(url)); return new Response(JSON.stringify(String(url).includes("/credits") ? { data: { total_credits: 10, total_usage: 1 } } : { data: { usage: 1 } }), { status: 200 }); },
    resolveKey: () => ({ key: "sk-or-test", source: "engine" }),
    resolveManagementKey: () => null,
  };
  await getOpenRouterAccount({ ...openRouterDeps, refresh: true });
  await getOpenRouterAccount(openRouterDeps);
  const before = openRouterCalls.length;
  await getOpenRouterAccount(openRouterDeps);
  assert.equal(openRouterCalls.length, before, "precondition: the balance is cached");

  let modelLoads = 0;
  const loadModels = async () => { modelLoads += 1; return { models: [] }; };
  await loadModelsWithCache("/cwd", loadModels);
  await loadModelsWithCache("/cwd", loadModels);
  assert.equal(modelLoads, 1, "precondition: the model list is cached");

  globalThis.__codyResetCreditsCache = { snapshot: null, liveAt: 0, nextLiveAt: Date.now() + 600_000, failures: 0, inFlight: null, confirmed: null };
  t.after(() => { delete globalThis.__codyResetCreditsCache; });
  recordBlackouts([credits]);

  const restarts = [];
  const result = await settleProviderChange(
    { engineId: "omp", removedProviders: ["openrouter"] },
    { restartIdle: async () => { restarts.push("restart"); return { restarted: 2, active: 1 }; } },
  );

  assert.deepEqual(result, { restarted: 2, active: 1 }, "the caller learns how many chats were restarted and how many are mid-reply");
  assert.deepEqual(restarts, ["restart"]);
  assert.equal((await getUsageSnapshot({ load: loadUsage })).accounts[0].id, "read-2", "the removed account is not served from the usage cache, stale or otherwise");
  await getOpenRouterAccount(openRouterDeps);
  assert.ok(openRouterCalls.length > before, "the balance is read again, not served from the old key's entry");
  await loadModelsWithCache("/cwd", loadModels);
  assert.equal(modelLoads, 2, "the model list is rebuilt");
  assert.equal(globalThis.__codyResetCreditsCache.nextLiveAt, 0, "the saved-reset balances go live on the next read, which drops the removed account");
  assert.deepEqual(readRouteMemory().blackouts, [], "the removed provider's remembered 'out of credits' is forgotten");
});

test("a provider that was only changed, not removed, keeps its remembered blackouts", async (t) => {
  agentDir(t);
  recordBlackouts([credits]);
  await settleProviderChange({ engineId: "omp" }, { restartIdle: async () => ({ restarted: 0, active: 0 }) });
  assert.equal(readRouteMemory().blackouts.length, 1);
});

test("a plain key save does not restart anything; a failed restart never fails the change", async (t) => {
  agentDir(t);
  let restarts = 0;
  const restartIdle = async () => { restarts += 1; throw new Error("the engine would not stop"); };
  assert.deepEqual(await settleProviderChange({ engineId: "omp", restart: false }, { restartIdle }), { restarted: 0, active: 0 });
  assert.equal(restarts, 0);
  assert.deepEqual(await settleProviderChange({ engineId: "omp" }, { restartIdle }), { restarted: 0, active: 0 }, "the removal stands; the restart failure is not its failure");
  assert.equal(restarts, 1);
});

test("a removed credential takes the blackout of the usage account it served with it — a sibling's stays", async (t) => {
  agentDir(t);
  // Blackouts are remembered under the USAGE account's id, which is not the credential's row id.
  const account = (id, credentialId) => ({ provider: "anthropic", id, identity: null, credentialId, label: "Anthropic", planType: null, unlimited: false, windows: [] });
  const read = { available: true, accounts: [account("expired-acct", 7), account("live-acct", 5)], fetchedAt: new Date().toISOString(), stale: false };
  await getUsageSnapshot({ load: async () => read });
  const quota = (accountId) => ({ provider: "anthropic", accountId, kind: "quota", since: "2026-10-14T02:33:21.816Z", until: null, reason: "oauth refresh failed: invalid_grant" });
  recordBlackouts([quota("expired-acct"), quota("live-acct")]);

  await settleProviderChange(
    { engineId: "omp", removedCredentials: [{ provider: "anthropic", credentialId: 7 }] },
    { restartIdle: async () => ({ restarted: 0, active: 0 }) },
  );
  assert.deepEqual(readRouteMemory().blackouts.map((entry) => entry.accountId), ["live-acct"], "a Usage row for an account that no longer exists would otherwise be fabricated from it");
});
