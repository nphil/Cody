import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * "Disable provider" is omp's `disabledProviders`, read by an engine child AT
 * SPAWN. Saving it used to flush Cody's model cache and nothing else: a chat
 * that was already open went on offering — and spending — the provider the
 * owner had just switched off. A CHANGED list now restarts idle children (a
 * reply in progress is never cut off); a write that leaves the list alone,
 * which is every model-curation save (the Models hub spreads the whole
 * settings object), restarts nothing.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-disable-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-disable-accounts-"));
delete process.env.CODY_PASSWORD;
fs.writeFileSync(path.join(agentDir, "cody-engine.json"), JSON.stringify({ version: 1, activeEngine: "omp", onboarded: true, updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(agentDir, "config.yml"), "# the owner's own comment\nenabledModels:\n  - anthropic/claude-opus-5-5\n");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const settingsRoute = await jiti.import("../app/api/omp-settings/route.ts");
const enableRoute = await jiti.import("../app/api/providers/enable/route.ts");
const modelsConfigRoute = await jiti.import("../app/api/models-config/route.ts");
const { readNativeSettings } = await jiti.import("./omp/settings-config.ts");
const { readRouteMemory, recordBlackouts } = await jiti.import("./routing/route-memory.ts");

const destroyed = [];
const fake = (name, running) => ({ isRunning: () => running, destroyAndWait: async () => { destroyed.push(name); }, destroy() {} });
const sessions = () => { globalThis.__ompSessions = new Map([["idle", fake("idle", false)], ["busy", fake("busy", true)]]); };
test.after(() => { delete globalThis.__ompSessions; });

const putSettings = async (settings) => {
  const response = await settingsRoute.PUT(new Request("http://cody.test/api/omp-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }) }));
  return { status: response.status, body: await response.json() };
};
const enable = async (provider) => {
  const response = await enableRoute.POST(new Request("http://cody.test/api/providers/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) }));
  return { status: response.status, body: await response.json() };
};

test("disabling a provider restarts idle chats, leaves a running reply alone, and forgets what was remembered about it", async () => {
  sessions();
  destroyed.length = 0;
  recordBlackouts([
    { provider: "openrouter", accountId: null, kind: "credits", since: "2026-09-14T06:39:58.150Z", until: null, reason: "out of credits ($0.00 left)" },
    { provider: "anthropic", accountId: "a", kind: "quota", since: "2026-10-13T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", reason: "7-day window" },
  ]);
  const { status, body } = await putSettings({ disabledProviders: ["openrouter"] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(readNativeSettings().settings.disabledProviders, ["openrouter"]);
  assert.deepEqual([body.restarted, body.active], [1, 1]);
  assert.deepEqual(destroyed, ["idle"], "the next turn of an idle chat cannot offer the disabled provider");
  assert.deepEqual(readRouteMemory().blackouts.map((entry) => entry.provider), ["anthropic"], "OpenRouter's 'out of credits' (no expiry) is gone; another provider's is not touched");
  assert.match(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"), /the owner's own comment/);
});

test("a curation save that leaves the disabled list as it was restarts nothing", async () => {
  sessions();
  destroyed.length = 0;
  const same = await putSettings({ disabledProviders: ["openrouter"], enabledModels: ["anthropic/claude-opus-5-5", "openrouter/auto"] });
  assert.equal(same.status, 200);
  assert.equal("restarted" in same.body, false);
  const reordered = await putSettings({ disabledProviders: ["openrouter"] });
  assert.equal("restarted" in reordered.body, false);
  assert.deepEqual(destroyed, []);
});

test("enabling a provider that was disabled restarts idle chats; enabling one that never was does not", async () => {
  await putSettings({ disabledProviders: ["openrouter", "anthropic"] });
  sessions();
  destroyed.length = 0;
  const back = await enable("openrouter");
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(readNativeSettings().settings.disabledProviders, ["anthropic"], "only that provider comes back");
  assert.deepEqual([back.body.restarted, back.body.active], [1, 1]);
  assert.deepEqual(destroyed, ["idle"]);

  sessions();
  destroyed.length = 0;
  const never = await enable("llama-swap");
  assert.equal(never.status, 200);
  assert.deepEqual([never.body.restarted, never.body.active], [0, 0], "nothing changed, so nothing restarts");
  assert.deepEqual(destroyed, []);
});

test("enabling needs a provider", async () => {
  const { status, body } = await enable("  ");
  assert.equal(status, 400);
  assert.match(body.error, /provider is required/);
});

test("removing a custom endpoint from models.yml restarts idle chats; saving or adding one does not", async () => {
  const endpoint = (port) => ({ baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", auth: "none", models: [{ id: "m1", name: "M1", contextWindow: 8192, maxTokens: 2048 }] });
  const put = async (providers) => {
    const response = await modelsConfigRoute.PUT(new Request("http://cody.test/api/models-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers }) }));
    return { status: response.status, body: await response.json() };
  };
  sessions();
  destroyed.length = 0;
  assert.equal((await put({ alpha: endpoint(9001), beta: endpoint(9002) })).status, 200);
  const edited = await put({ alpha: endpoint(9003), beta: endpoint(9002) });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal("restarted" in edited.body, false, "editing or adding an endpoint is not a removal");
  assert.deepEqual(destroyed, []);

  const removed = await put({ beta: endpoint(9002) });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual([removed.body.restarted, removed.body.active], [1, 1]);
  assert.deepEqual(destroyed, ["idle"], "the next turn of an idle chat cannot reach the endpoint the owner just deleted");
});
