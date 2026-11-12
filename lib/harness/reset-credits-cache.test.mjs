import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { mergeResetCredits, getResetCredits, resetResetCreditsCache, RESET_CREDITS_TTL_MS } = await jiti.import("./reset-credits-cache.ts");

const account = (overrides) => ({ id: "claude-1", label: "Claude (Org)", provider: "anthropic", position: 0, availableCount: 1, canRedeem: true, credits: [{ id: "juniper_tide", expiresAt: null }], ...overrides });
const live = (accounts) => ({ available: true, accounts, fetchedAt: "2026-09-25T02:00:00.000Z" });
const NOW = new Date("2026-09-25T02:30:00.000Z");

// Measured: Anthropic answered 429 to every reset check, and each Claude row
// read "Failed to load saved resets" while each account held one reset. A
// failed check must not erase what the provider last confirmed.
test("a failed check keeps the account's last confirmed balance, marked as carried over", () => {
  const confirmed = new Map([["claude-1", { account: account({ checkedAt: "2026-09-25T01:00:00.000Z" }), checkedAt: "2026-09-25T01:00:00.000Z" }]]);
  const result = mergeResetCredits(live([account({ availableCount: 0, canRedeem: false, credits: [], error: "Failed to load saved resets" })]), confirmed, NOW);

  assert.equal(result.failed, true);
  const [row] = result.snapshot.accounts;
  assert.equal(row.availableCount, 1);
  assert.equal(row.stale, true);
  assert.equal(row.checkedAt, "2026-09-25T01:00:00.000Z");
  assert.equal(row.error, undefined, "a carried-over balance is not an error");
  assert.equal(result.confirmed.get("claude-1").checkedAt, "2026-09-25T01:00:00.000Z");
});

test("a failed check with nothing confirmed says it will retry instead of reporting zero as fact", () => {
  const result = mergeResetCredits(live([account({ availableCount: 0, canRedeem: false, credits: [], error: "Failed to load saved resets" })]), new Map(), NOW);
  assert.equal(result.snapshot.accounts[0].retrying, true);
  assert.equal(result.failed, true);
});

test("an answered check replaces the confirmed balance and drops accounts that are gone", () => {
  const confirmed = new Map([
    ["claude-1", { account: account({ availableCount: 1 }), checkedAt: "2026-09-25T01:00:00.000Z" }],
    ["logged-out", { account: account({ id: "logged-out" }), checkedAt: "2026-09-25T01:00:00.000Z" }],
  ]);
  const result = mergeResetCredits(live([account({ availableCount: 0, canRedeem: false, credits: [] })]), confirmed, NOW);

  assert.equal(result.failed, false);
  assert.equal(result.snapshot.accounts[0].availableCount, 0, "a real answer of zero is shown as zero");
  assert.equal(result.snapshot.accounts[0].stale, undefined);
  assert.deepEqual([...result.confirmed.keys()], ["claude-1"]);
  assert.equal(result.confirmed.get("claude-1").checkedAt, NOW.toISOString());
});

test("a listing that failed outright still serves every confirmed balance", () => {
  const confirmed = new Map([["claude-1", { account: account(), checkedAt: "2026-09-25T01:00:00.000Z" }]]);
  const result = mergeResetCredits({ available: false, accounts: [], fetchedAt: NOW.toISOString(), reason: "helper failed" }, confirmed, NOW);
  assert.equal(result.snapshot.available, true);
  assert.equal(result.snapshot.accounts[0].stale, true);
  assert.equal(result.snapshot.accounts[0].availableCount, 1);
});

test("a provider the listing could not read keeps its confirmed accounts as stale and is not reported as logged out", () => {
  const codex = account({ id: "codex-1", provider: "openai-codex", label: "OpenAI Codex" });
  const confirmed = new Map([
    ["claude-1", { account: account({ checkedAt: "2026-09-25T01:00:00.000Z" }), checkedAt: "2026-09-25T01:00:00.000Z" }],
    ["codex-1", { account: codex, checkedAt: "2026-09-25T01:00:00.000Z" }],
  ]);
  const result = mergeResetCredits({ ...live([codex]), failedProviders: ["anthropic"] }, confirmed, NOW);

  assert.equal(result.failed, true);
  assert.deepEqual(result.snapshot.accounts.map((row) => row.id), ["codex-1", "claude-1"]);
  const claude = result.snapshot.accounts.find((row) => row.id === "claude-1");
  assert.equal(claude.stale, true);
  assert.equal(claude.availableCount, 1);
  assert.equal(claude.checkedAt, "2026-09-25T01:00:00.000Z");
  assert.equal(result.snapshot.accounts.find((row) => row.id === "codex-1").stale, undefined);
  assert.ok(result.confirmed.has("claude-1"), "the carried-over answer is still the confirmed one");
  assert.equal("failedProviders" in result.snapshot, false, "the internal marker does not reach the popover");
});

test("without a failed provider, an account missing from the listing is still dropped", () => {
  const confirmed = new Map([["claude-1", { account: account(), checkedAt: "2026-09-25T01:00:00.000Z" }]]);
  const result = mergeResetCredits({ ...live([]), failedProviders: ["openai-codex"] }, confirmed, NOW);
  assert.deepEqual(result.snapshot.accounts, []);
  assert.equal(result.confirmed.size, 0);
});

test("getResetCredits keeps serving the last good reading, marked stale, when later reads fail", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cody-reset-cache-"));
  const previousMode = process.env.CODY_RESET_STUB_MODE;
  try {
    const stub = path.join(dir, "helper.mjs");
    await writeFile(stub, [
      "const good = { type: \"list\", ok: true, accounts: [{ id: \"claude-1\", label: \"Claude (Org)\", provider: \"anthropic\", position: 0, availableCount: 1, canRedeem: true, credits: [{ id: \"g1\", expiresAt: null }] }] };",
      "const bad = { type: \"list\", ok: false, code: \"credit_list_failed\", message: \"boom\" };",
      "process.stdout.write(JSON.stringify(process.env.CODY_RESET_STUB_MODE === \"fail\" ? bad : good));",
    ].join("\n"));
    const deps = { helperPath: stub, bunBin: process.execPath, packageRoot: () => dir, agentDir: () => dir };
    resetResetCreditsCache();
    let clock = Date.parse("2026-09-25T02:00:00.000Z");
    process.env.CODY_RESET_STUB_MODE = "ok";
    const first = await getResetCredits({ deps, now: () => clock });
    assert.equal(first.accounts[0].availableCount, 1);
    assert.equal(first.accounts[0].stale, undefined);

    process.env.CODY_RESET_STUB_MODE = "fail";
    clock += RESET_CREDITS_TTL_MS + 1;
    const second = await getResetCredits({ deps, now: () => clock });
    assert.equal(second.available, true, "a failed read never turns the popover into 'unavailable'");
    assert.equal(second.accounts[0].availableCount, 1);
    assert.equal(second.accounts[0].stale, true);
    assert.equal(second.accounts[0].checkedAt, first.accounts[0].checkedAt);

    // The retry is backed off: a call a moment later is served from the cache, not a new read.
    process.env.CODY_RESET_STUB_MODE = "ok";
    clock += 1_000;
    const third = await getResetCredits({ deps, now: () => clock });
    assert.equal(third.accounts[0].stale, true);

    // After a restart (empty memory) the persisted answer is still served stale while reads fail.
    resetResetCreditsCache();
    process.env.CODY_RESET_STUB_MODE = "fail";
    const afterRestart = await getResetCredits({ deps, now: () => clock });
    assert.equal(afterRestart.accounts[0].availableCount, 1);
    assert.equal(afterRestart.accounts[0].stale, true);
  } finally {
    resetResetCreditsCache();
    if (previousMode === undefined) delete process.env.CODY_RESET_STUB_MODE; else process.env.CODY_RESET_STUB_MODE = previousMode;
    await rm(dir, { recursive: true, force: true });
  }
});
