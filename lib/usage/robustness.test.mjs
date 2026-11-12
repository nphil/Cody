import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { fetchOmpUsageSnapshot, parseOmpUsageOutput, parseOmpUsagePayload, unavailableUsageSnapshot } = await jiti.import("./omp-usage.ts");
const { constrainingWindows, cursorPoolOf, isAccountWideWindow, isCodexSparkModel, tierOfBlockScope } = await jiti.import("./quota-tiers.ts");
const { cannotServe, pickAvailableRoute, resolveModelAvailability } = await jiti.import("./availability.ts");
const { CARRY_FORWARD_MAX_AGE_MS, LAST_GOOD_MAX_AGE_MS, carryForwardMissingAccounts, reserveLastGood } = await jiti.import("./last-good.ts");
const { mergeUsageRead } = await jiti.import("./client-merge.ts");
const { getUsageSnapshot, markStale, resetUsageCache } = await jiti.import("./cache.ts");
const { rankProviderAccounts } = await jiti.import("./select.ts");
const { invalidateOmpCliCache, resolveOmpBin } = await jiti.import("../omp/omp-cli.ts");

/**
 * The fixtures are `omp usage --json` run for real: 18.8.3 (the installed
 * engine) and 18.19.0, same two accounts (Claude + Codex, fake identities).
 * The synthetic payloads below cover what neither account happened to show.
 */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
const byProvider = (snapshot, provider) => snapshot.accounts.find((account) => account.provider === provider);
const windowIds = (account) => account.windows.map((window) => window.id);

function win(overrides = {}) {
  return { id: "w", label: "w", utilization: 10, resetsAt: null, state: "ok", windowMs: null, tier: null, shared: true, ...overrides };
}
function acct(provider, windows, overrides = {}) {
  return {
    provider,
    id: `${provider}-1`,
    identity: null,
    credentialId: null,
    label: provider,
    planType: null,
    unlimited: false,
    windows,
    ...overrides,
  };
}
function snap(accounts, overrides = {}) {
  return { available: true, accounts, fetchedAt: "2026-11-12T10:00:00.000Z", stale: false, ...overrides };
}
/** What credential-order.ts builds for one credential's block. */
function block(provider, scope, overrides = {}) {
  return win({
    id: scope ? `${provider}:blocked:7:${scope}` : `${provider}:blocked:7`,
    label: "blocked",
    utilization: 100,
    state: "exhausted",
    source: "block",
    blockScope: scope,
    tier: tierOfBlockScope(scope),
    shared: false,
    ...overrides,
  });
}
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

// --- the parser, on what the engines really print ---------------------------

test("18.19.0 reports each account's routing policy; 18.8.3 reports none and parses the same windows", () => {
  const next = parseOmpUsageOutput(fixture("omp-18.19.0-usage-plan"));
  const prev = parseOmpUsageOutput(fixture("omp-18.8.3-usage-plan"));
  assert.equal(next.available, true);
  assert.equal(prev.available, true);

  assert.deepEqual(byProvider(next, "anthropic").policy, {
    priority: 2,
    reservePct: 15,
    reserveSource: "override",
    reclaimAbovePct: 80,
    state: "eligible",
    remainingPct: 70,
  });
  assert.equal(byProvider(next, "openai-codex").policy, undefined, "an account no policy matches has none");
  for (const account of prev.accounts) assert.equal("policy" in account, false);

  const shape = (snapshot) => snapshot.accounts.map((account) => [account.provider, account.windows.map((w) => [w.id, w.label, w.utilization, w.state, w.tier])]);
  assert.deepEqual(shape(prev), shape(next), "the new fields add information; they never change an old reading");
});

test("a Claude account with no session open lists its 5-hour gate as inactive instead of reading as a missing window", () => {
  const next = parseOmpUsageOutput(fixture("omp-18.19.0-usage-no-claude-session"));
  const claude = byProvider(next, "anthropic");
  assert.deepEqual(claude.inactiveGates, ["5h"]);
  assert.deepEqual(windowIds(claude), ["anthropic:7d"]);

  const prev = parseOmpUsageOutput(fixture("omp-18.8.3-usage-no-claude-session"));
  assert.equal(byProvider(prev, "anthropic").inactiveGates, undefined, "18.8.3 does not say why the window is missing");
  assert.deepEqual(windowIds(byProvider(prev, "anthropic")), ["anthropic:7d"]);
});

test("a Codex spend cap keeps its credit amount, reads as one account-wide cap, and gates only models the plan windows do not", () => {
  const snapshot = parseOmpUsageOutput(fixture("omp-18.19.0-usage-codex-spend-cap"));
  const codex = byProvider(snapshot, "openai-codex");
  const [cap] = codex.windows;
  assert.equal(cap.id, "openai-codex:spend-cap");
  assert.equal(cap.label, "credit spend cap");
  assert.equal(cap.utilization, 40);
  assert.deepEqual(cap.amount, { unit: "credits", used: 40, limit: 100 });

  // A credit-billed seat has no 5-hour/weekly windows, so the cap stands in for them on chat models; Spark has its own meter.
  assert.deepEqual(constrainingWindows(codex.windows, "openai-codex", "gpt-5.5").map((w) => w.id), ["openai-codex:spend-cap"]);
  assert.deepEqual(constrainingWindows(codex.windows, "openai-codex", "gpt-5.3-codex-spark"), []);

  // Beside plan windows the cap only bounds credit-funded overage: it gates nothing.
  const planned = byProvider(parseOmpUsageOutput(fixture("omp-18.19.0-usage-plan")), "openai-codex");
  const both = [...planned.windows, cap];
  assert.deepEqual(constrainingWindows(both, "openai-codex", "gpt-5.5").map((w) => w.id), ["openai-codex:primary", "openai-codex:secondary"]);
});

test("percent windows carry no amount; only money and credit meters do", () => {
  const snapshot = parseOmpUsageOutput(fixture("omp-18.19.0-usage-plan"));
  for (const account of snapshot.accounts) for (const window of account.windows) assert.equal(window.amount, undefined, window.id);
});

test("capacity keeps the meter on both engines, so the Fable weekly bucket is not read as the plain weekly one", () => {
  for (const name of ["omp-18.8.3-usage-plan", "omp-18.19.0-usage-codex-spend-cap"]) {
    const claude = parseOmpUsageOutput(fixture(name)).capacity.anthropic;
    assert.deepEqual(claude.filter((stat) => stat.windowId === "7d").map((stat) => stat.meter), [null, "fable"], name);
  }
  const spend = parseOmpUsageOutput(fixture("omp-18.19.0-usage-codex-spend-cap"));
  assert.deepEqual(spend.capacity["openai-codex"].map((stat) => [stat.windowId, stat.meter]), [["Spend cap", "credits"]]);
  const chat = parseOmpUsageOutput(fixture("omp-18.19.0-usage-plan")).capacity["openai-codex"];
  assert.deepEqual(chat.map((stat) => [stat.windowId, stat.meter]), [["5h", "chat"], ["7d", "chat"]]);
});

test("a LiteLLM key budget and user budget keep their dollar amounts and say whose money they cap", () => {
  const meter = (id, used) => ({
    id,
    label: "LiteLLM budget",
    scope: { provider: "litellm", windowId: "budget" },
    window: { id: "budget", label: "Budget" },
    amount: { used, limit: 10, unit: "usd" },
    status: "ok",
  });
  const snapshot = parseOmpUsagePayload({
    generatedAt: 1_794_474_777_502,
    reports: [{ provider: "litellm", fetchedAt: 1_794_474_777_000, limits: [meter("litellm:key:budget", 3.2), meter("litellm:user:budget", 9)], metadata: { accountId: "acct-l" } }],
  });
  const [key, user] = snapshot.accounts[0].windows;
  assert.deepEqual([key.label, user.label], ["key budget", "user budget"]);
  assert.deepEqual(key.amount, { unit: "usd", used: 3.2, limit: 10 });
  assert.deepEqual([key.utilization, key.state, user.utilization, user.state], [32, "ok", 90, "warning"]);
  assert.equal(key.windowMs, null, "a budget has no span, and nothing invents one for the pace marker");
});

test("saved-reset expiry counts only credits that are still usable", () => {
  const snapshot = parseOmpUsagePayload({
    reports: [{
      provider: "anthropic",
      fetchedAt: 1_794_474_777_000,
      limits: [{ id: "anthropic:7d", scope: { provider: "anthropic", windowId: "7d", shared: true }, window: { id: "7d", durationMs: 604_800_000 }, amount: { unit: "percent", usedFraction: 0.3 }, status: "ok" }],
      metadata: { accountId: "acct-a" },
      resetCredits: {
        availableCount: 1,
        redeemableCount: 1,
        eligible: true,
        credits: [
          { id: "spent", expiresAt: "2026-11-14T00:00:00.000Z", remainingCount: 0, status: "redeemed" },
          { id: "usable", expiresAt: "2026-11-20T00:00:00.000Z", remainingCount: 1, status: "available" },
        ],
      },
    }],
  });
  assert.deepEqual(snapshot.accounts[0].resetCredits, { availableCount: 1, earliestExpiresAt: "2026-11-20T00:00:00.000Z" });
});

test("logins omp could not read are listed apart from the accounts, and are never invented as quota-less ones", () => {
  const payload = JSON.parse(fixture("omp-18.19.0-usage-plan"));
  payload.accountsWithoutUsage = [
    { provider: "zai", type: "api_key", accountId: "zai-key-1" },
    { provider: "cursor", type: "oauth", email: "q@example.invalid", policy: { priority: 1, state: "eligible" } },
    "junk",
    { type: "oauth" },
  ];
  const snapshot = parseOmpUsagePayload(payload);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.accounts.map((account) => account.provider), ["anthropic", "openai-codex"]);
  assert.deepEqual(snapshot.unreportedAccounts.map((row) => [row.provider, row.type, row.identity]), [["zai", "api_key", "zai-key-1"], ["cursor", "oauth", "q@example.invalid"]]);
  assert.equal(snapshot.unreportedAccounts[1].policy.priority, 1);
});

test("when nothing could be measured but logins exist, the read says how many went quiet", () => {
  const snapshot = parseOmpUsagePayload({ reports: [], accountsWithoutUsage: [{ provider: "cursor", type: "oauth" }, { provider: "zai", type: "api_key" }] });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, "omp could not read the quota of 2 signed-in accounts");
  assert.equal(snapshot.unreportedAccounts.length, 2);
  assert.equal(parseOmpUsagePayload({ reports: [] }).reason, "omp usage reported no quota windows");
});

test("a notice printed around the JSON does not turn a good reading into malformed output", () => {
  const raw = fixture("omp-18.8.3-usage-plan");
  const wrapped = `Update available: 18.19.0\n${raw}\nRun \`omp update\`\n`;
  assert.equal(parseOmpUsageOutput(wrapped).available, true);
  assert.equal(parseOmpUsageOutput(`${raw.slice(0, 200)}\n`).reason, "omp usage returned malformed JSON");
});

// --- the real command ---------------------------------------------------------

/** Runs `fetchOmpUsageSnapshot` with the engine pinned by `bin` and an empty agent dir, then restores everything. */
async function withEngine(bin, run) {
  const scratch = mkdtempSync(path.join(process.env.CODY_SCRATCH || os.tmpdir(), "cody-usage-robust-"));
  const keys = ["CODY_OMP_BIN", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "HOME", "OMP_PROFILE", "PI_PROFILE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  mkdirSync(path.join(scratch, "home"), { recursive: true });
  process.env.CODY_OMP_BIN = bin;
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  process.env.PI_CONFIG_FILES = "";
  process.env.HOME = path.join(scratch, "home");
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  invalidateOmpCliCache();
  try {
    return await run(scratch);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    invalidateOmpCliCache();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function fakeOmp(scratch, script) {
  const bin = path.join(scratch, "omp");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("a non-zero exit that still printed a reading is a reading: the other accounts' numbers are good", async () => {
  const scratch = mkdtempSync(path.join(process.env.CODY_SCRATCH || os.tmpdir(), "cody-usage-exit-"));
  try {
    const payload = path.join(scratch, "payload.json");
    writeFileSync(payload, fixture("omp-18.19.0-usage-plan"));
    const bin = fakeOmp(scratch, `cat "${payload}"\necho "one provider failed" >&2\nexit 1`);
    const snapshot = await withEngine(bin, () => fetchOmpUsageSnapshot());
    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.accounts.map((account) => account.provider), ["anthropic", "openai-codex"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a non-zero exit with nothing readable is a failure that carries the engine's own words", async () => {
  const scratch = mkdtempSync(path.join(process.env.CODY_SCRATCH || os.tmpdir(), "cody-usage-exit-"));
  try {
    const bin = fakeOmp(scratch, `echo "usage service unreachable" >&2\nexit 3`);
    const snapshot = await withEngine(bin, () => fetchOmpUsageSnapshot());
    assert.equal(snapshot.available, false);
    assert.match(snapshot.reason, /usage service unreachable/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Whichever engine CODY_OMP_BIN names (or the installed one): an agent with no logins must read as "no quota", not as an error,
// and the keys the parser relies on must still be where it looks.
const engineBin = process.env.CODY_OMP_BIN && existsSync(process.env.CODY_OMP_BIN) ? process.env.CODY_OMP_BIN : resolveOmpBin();
test("the real engine's usage command answers an agent with no logins in the shape the parser reads", { skip: engineBin ? false : "no omp is installed on this machine" }, async () => {
  const snapshot = await withEngine(engineBin, () => fetchOmpUsageSnapshot({ timeoutMs: 60_000 }));
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, "omp usage reported no quota windows");
  assert.deepEqual(snapshot.unreportedAccounts, [], "the engine printed accountsWithoutUsage (an empty list), and the parser kept it");
});

// --- which windows bind which model, and what a scoped block means -----------

test("a block scoped to one Claude family refuses that family only, and is not the whole account being out", () => {
  const fable = block("anthropic", "tier:fable");
  assert.equal(fable.tier, "fable");
  assert.equal(isAccountWideWindow(fable), false);
  const windows = [win({ id: "anthropic:5h", utilization: 12 }), win({ id: "anthropic:7d", utilization: 30 }), fable];

  assert.ok(constrainingWindows(windows, "anthropic", "claude-fable-5").includes(fable));
  assert.equal(constrainingWindows(windows, "anthropic", "claude-opus-5-5").includes(fable), false);

  const account = acct("anthropic", windows);
  assert.equal(resolveModelAvailability(snap([account]), "anthropic", "claude-opus-5-5").state, "ok", "Opus keeps routing");
  const spent = resolveModelAvailability(snap([account]), "anthropic", "claude-fable-5");
  assert.equal(spent.state, "exhausted");
  assert.equal(spent.allAccountsExhausted, true);
});

test("an unscoped block, and one with a scope this Cody does not know, refuse the whole account", () => {
  for (const scope of ["", "something-newer"]) {
    const refusal = block("anthropic", scope);
    assert.equal(isAccountWideWindow(refusal), true, `scope "${scope}"`);
    for (const modelId of ["claude-opus-5-5", "claude-fable-5", ""]) {
      assert.deepEqual(constrainingWindows([refusal], "anthropic", modelId), [refusal], `${scope || "(none)"} / ${modelId || "(provider view)"}`);
    }
  }
  assert.equal(isAccountWideWindow(block("anthropic", undefined, { blockScope: undefined })), true, "an engine with no scope concept");
});

test("Codex: a Spark block refuses Spark models only and a chat block refuses everything but Spark", () => {
  const spark = block("openai-codex", "spark");
  const chat = block("openai-codex", "chat");
  const shared = block("openai-codex", "shared");
  const covers = (window, modelId) => constrainingWindows([window], "openai-codex", modelId).length === 1;
  assert.deepEqual([covers(spark, "gpt-5.3-codex-spark"), covers(spark, "gpt-5.5")], [true, false]);
  assert.deepEqual([covers(chat, "gpt-5.3-codex-spark"), covers(chat, "gpt-5.5")], [false, true]);
  assert.deepEqual([covers(shared, "gpt-5.3-codex-spark"), covers(shared, "gpt-5.5")], [true, true], "the legacy scope blocks everything");
  assert.equal(isAccountWideWindow(spark), false, "a Spark block does not take ordinary Codex chat out of routing");
  assert.equal(isAccountWideWindow(chat), true);
  assert.equal(isCodexSparkModel("gpt-5.3-codex-spark"), true);
  assert.equal(isCodexSparkModel("gpt-5.5"), false);
});

test("Cursor: a pool block refuses the models that spend that pool, not the other pool", () => {
  const api = block("cursor", "pool:api");
  const auto = block("cursor", "pool:auto");
  const covers = (window, modelId) => constrainingWindows([window], "cursor", modelId).length === 1;
  assert.deepEqual([cursorPoolOf("composer-2.5"), cursorPoolOf("default"), cursorPoolOf("grok-4"), cursorPoolOf("claude-opus-4-5")], ["auto", "auto", "auto", "api"]);
  assert.deepEqual([covers(api, "claude-opus-4-5"), covers(api, "composer-2.5")], [true, false]);
  assert.deepEqual([covers(auto, "claude-opus-4-5"), covers(auto, "composer-2.5")], [false, true]);
  assert.equal(isAccountWideWindow(api), false);
  assert.equal(isAccountWideWindow(auto), false);
});

test("the tier a block scope implies", () => {
  assert.equal(tierOfBlockScope("tier:fable"), "fable");
  assert.equal(tierOfBlockScope(" TIER:Mythos "), "mythos");
  assert.equal(tierOfBlockScope("tier:"), null);
  assert.equal(tierOfBlockScope("spark"), "spark");
  for (const scope of ["", "chat", "shared", "pool:api", undefined, null]) assert.equal(tierOfBlockScope(scope), null, String(scope));
});

test("both Cursor pools are weighed separately; a model is limited only by its own pool", () => {
  const auto = win({ id: "cursor:usd:individual-auto", label: "weekly pool", utilization: 100, state: "exhausted" });
  const apiPool = win({ id: "cursor:usd:individual-api", label: "prepaid credits", utilization: 20 });
  const account = acct("cursor", [auto, apiPool]);
  assert.equal(resolveModelAvailability(snap([account]), "cursor", "composer-2.5").state, "exhausted");
  assert.equal(resolveModelAvailability(snap([account]), "cursor", "claude-opus-4-5").state, "ok");
});

// --- a provider with no usable login ------------------------------------------

// An ended login (the provider refused the refresh for good) and a deliberate removal are different to the owner, but to routing both mean "this provider has no login that can serve".
const EXPIRED_LOGIN = 'oauth refresh failed: OAuthError: anthropic token refresh failed: 400 {"type":"error","error":{"type":"invalid_grant","message":"Refresh token expired"}}';
const LOGGED_OUT = "logged out by user";

test("a provider whose every login is signed out or disabled reads 'unavailable', which is not the quota being spent", () => {
  const expired = acct("anthropic", [], { disabled: { cause: EXPIRED_LOGIN } });
  const availability = resolveModelAvailability(snap([expired]), "anthropic", "claude-opus-5-5");
  assert.equal(availability.state, "unavailable");
  assert.equal(availability.unusable, "signed_out");
  assert.equal(cannotServe(availability), true);
  assert.notEqual(availability.state, "exhausted", "nothing that writes config may treat a signed-out login as a spent quota");

  const removed = resolveModelAvailability(snap([acct("anthropic", [], { disabled: { cause: LOGGED_OUT } })]), "anthropic", "claude-opus-5-5");
  assert.deepEqual([removed.state, removed.unusable], ["unavailable", "disabled"]);

  const mixed = resolveModelAvailability(snap([expired, acct("anthropic", [win({ id: "anthropic:5h" })], { id: "second" })]), "anthropic", "claude-opus-5-5");
  assert.equal(mixed.state, "ok", "a sibling that can serve keeps the provider usable");
  assert.equal(resolveModelAvailability(snap([]), "anthropic", "claude-opus-5-5").state, "unknown", "no account at all is no evidence, not a verdict");
});

test("route picking passes over a provider with no usable login and says why nothing was chosen", () => {
  const snapshot = snap([
    acct("anthropic", [], { disabled: { cause: "logged out by user" } }),
    acct("openai-codex", [win({ id: "openai-codex:primary" })]),
    acct("zai", [win({ id: "zai:5h", utilization: 100, state: "exhausted" })]),
  ]);
  const chosen = pickAvailableRoute(snapshot, [
    { provider: "anthropic", modelId: "claude-opus-5-5" },
    { provider: "openai-codex", modelId: "gpt-5.5" },
  ]);
  assert.deepEqual(chosen.chosen, { provider: "openai-codex", modelId: "gpt-5.5" });
  assert.deepEqual(chosen.skipped.map((s) => [s.provider, s.state]), [["anthropic", "unavailable"]]);

  const onlySignedOut = pickAvailableRoute(snapshot, [{ provider: "anthropic", modelId: "claude-opus-5-5" }]);
  assert.deepEqual([onlySignedOut.chosen, onlySignedOut.chosenState], [null, "unavailable"]);
  const mixedOut = pickAvailableRoute(snapshot, [{ provider: "anthropic", modelId: "claude-opus-5-5" }, { provider: "zai", modelId: "glm-5" }]);
  assert.deepEqual([mixedOut.chosen, mixedOut.chosenState], [null, "exhausted"], "one spent candidate makes the whole answer a quota one");
});

test("a signed-out login ranks after every usable one, whatever the usable ones report, and ahead of a plain disabled one", () => {
  const out = acct("anthropic", [win({ id: "anthropic:5h", utilization: 1 })], { id: "out", disabled: { cause: EXPIRED_LOGIN } });
  const removed = acct("anthropic", [], { id: "removed", disabled: { cause: LOGGED_OUT } });
  const busy = acct("anthropic", [win({ id: "anthropic:5h", utilization: 95, state: "warning" })], { id: "busy" });
  assert.deepEqual(
    rankProviderAccounts([removed, out, busy], "anthropic", "claude-opus-5-5").map((rank) => [rank.account.id, rank.state]),
    [["busy", "in_use"], ["out", "signed_out"], ["removed", "disabled"]],
  );
});

// --- keeping the last good reading --------------------------------------------

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("a failed read serves the last good reading, flagged stale with when and why it failed", () => {
  const good = snap([acct("anthropic", [win()])], { fetchedAt: iso(T0) });
  const failed = unavailableUsageSnapshot("omp usage timed out");
  const served = reserveLastGood({ snapshot: good, readAt: T0 }, failed, T0 + 5 * 60_000);
  assert.equal(served.available, true);
  assert.equal(served.stale, true);
  assert.equal(served.fetchedAt, good.fetchedAt, "the numbers keep the time they were read at");
  assert.deepEqual(served.refreshFailed, { at: iso(T0 + 5 * 60_000), reason: "omp usage timed out" });
  assert.equal(good.stale, false, "the original reading is not mutated");
  assert.equal(reserveLastGood({ snapshot: good, readAt: T0 }, unavailableUsageSnapshot("  "), T0).refreshFailed.reason, "the usage read failed");
});

test("a reading too old to describe the present, or none at all, is not served in place of a failure", () => {
  const good = snap([acct("anthropic", [win()])]);
  const failed = unavailableUsageSnapshot("down");
  assert.equal(reserveLastGood({ snapshot: good, readAt: T0 }, failed, T0 + LAST_GOOD_MAX_AGE_MS).available, true, "right at the limit it still stands in");
  assert.equal(reserveLastGood({ snapshot: good, readAt: T0 }, failed, T0 + LAST_GOOD_MAX_AGE_MS + 1), failed);
  assert.equal(reserveLastGood(null, failed, T0), failed);
  assert.equal(reserveLastGood({ snapshot: failed, readAt: T0 }, failed, T0), failed, "a failure is never a good reading");
});

test("an account the newest read skipped is carried forward briefly, its readings labelled with when they were taken", () => {
  const a = acct("anthropic", [win({ id: "a:5h", resetsAt: iso(T0 + 3_600_000) })], { id: "a" });
  const b = acct("openai-codex", [win({ id: "b:5h", resetsAt: iso(T0 + 3_600_000) })], { id: "b" });
  const merged = carryForwardMissingAccounts({ snapshot: snap([a, b]), readAt: T0 }, snap([a]), T0 + 10 * 60_000);
  assert.deepEqual(merged.accounts.map((account) => account.id), ["a", "b"]);
  assert.equal(merged.accounts[0].windowsStaleSince, undefined, "what the newest read measured is not labelled");
  assert.equal(merged.accounts[1].windowsStaleSince, iso(T0));
  assert.equal("windowsStaleSince" in b, false, "inputs are not mutated");
});

test("carry-forward keeps the original reading time, so a skipped account ages out instead of being refreshed forever", () => {
  const a = acct("anthropic", [win({ id: "a:5h", resetsAt: iso(T0 + 6 * 3_600_000) })], { id: "a" });
  const b = acct("openai-codex", [win({ id: "b:5h", resetsAt: iso(T0 + 6 * 3_600_000) })], { id: "b" });
  const first = carryForwardMissingAccounts({ snapshot: snap([a, b]), readAt: T0 }, snap([a]), T0 + 10 * 60_000);
  const second = carryForwardMissingAccounts({ snapshot: first, readAt: T0 + 10 * 60_000 }, snap([a]), T0 + 20 * 60_000);
  assert.equal(second.accounts[1].windowsStaleSince, iso(T0), "carried twice, still stamped with the real reading");
  const third = carryForwardMissingAccounts({ snapshot: second, readAt: T0 + 20 * 60_000 }, snap([a]), T0 + CARRY_FORWARD_MAX_AGE_MS + 60_000);
  assert.deepEqual(third.accounts.map((account) => account.id), ["a"]);
});

test("carry-forward never resurrects a window that has reset, a disabled login, or an account the newest read does name", () => {
  const live = win({ id: "live", resetsAt: iso(T0 + 3_600_000) });
  const elapsed = win({ id: "elapsed", resetsAt: iso(T0 + 60_000) });
  const partlyReset = acct("anthropic", [live, elapsed], { id: "partly" });
  const allReset = acct("openai-codex", [elapsed], { id: "all-reset" });
  const parked = acct("zai", [live], { id: "parked", disabled: { cause: "logged out by user" } });
  const named = acct("cursor", [live], { id: "named" });
  const previous = { snapshot: snap([partlyReset, allReset, parked, named]), readAt: T0 };
  const newest = snap([acct("cursor", [], { id: "named", disabled: { cause: "logged out by user" } })]);
  const merged = carryForwardMissingAccounts(previous, newest, T0 + 10 * 60_000);
  assert.deepEqual(merged.accounts.map((account) => account.id), ["named", "partly"]);
  assert.deepEqual(windowIds(merged.accounts[1]), ["live"]);
  assert.equal(merged.accounts[0].disabled.cause, "logged out by user", "the newest word on an account is never hidden by an older reading");
});

test("a failed newest read, or no previous reading, leaves carry-forward alone", () => {
  const fresh = snap([acct("anthropic", [win()])]);
  assert.equal(carryForwardMissingAccounts(null, fresh, T0), fresh);
  assert.equal(carryForwardMissingAccounts({ snapshot: unavailableUsageSnapshot("x"), readAt: T0 }, fresh, T0), fresh);
  const failed = unavailableUsageSnapshot("y");
  assert.equal(carryForwardMissingAccounts({ snapshot: fresh, readAt: T0 }, failed, T0), failed);
});

// --- the cache keeps a good reading through a failed one -----------------------

test("a failed refresh serves the last good numbers (stale, with the failure) instead of 'no data', and does not respawn per caller", async () => {
  resetUsageCache();
  const good = snap([acct("anthropic", [win({ id: "anthropic:5h", utilization: 41 })])]);
  let loads = 0;
  let mode = "good";
  const load = async () => {
    loads += 1;
    return mode === "good" ? good : unavailableUsageSnapshot("omp usage timed out");
  };
  assert.equal((await getUsageSnapshot({ load })).available, true);

  mode = "failing";
  markStale();
  const second = await getUsageSnapshot({ load, awaitFresh: true });
  assert.equal(second.available, true);
  assert.equal(second.stale, true);
  assert.equal(second.accounts[0].windows[0].utilization, 41);
  assert.match(second.refreshFailed.reason, /timed out/);
  assert.equal(loads, 2);

  // Inside the failure back-off every caller gets the same answer without another spawn — maxAgeMs cannot shorten it.
  const third = await getUsageSnapshot({ load, maxAgeMs: 0 });
  assert.equal(third.refreshFailed.at, second.refreshFailed.at);
  assert.equal(loads, 2);
  resetUsageCache();
});

test("once the engine answers again the failure flag is gone and the new numbers are served", async () => {
  resetUsageCache();
  let utilization = 41;
  let failing = false;
  const load = async () => (failing ? unavailableUsageSnapshot("down") : snap([acct("anthropic", [win({ id: "anthropic:5h", utilization })])]));
  await getUsageSnapshot({ load });
  failing = true;
  markStale();
  assert.ok((await getUsageSnapshot({ load, awaitFresh: true })).refreshFailed);
  failing = false;
  utilization = 62;
  markStale();
  const recovered = await getUsageSnapshot({ load, awaitFresh: true });
  assert.equal(recovered.refreshFailed, undefined);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.accounts[0].windows[0].utilization, 62);
  resetUsageCache();
});

test("the very first read failing is a plain failure: there is no earlier reading to stand in", async () => {
  resetUsageCache();
  const first = await getUsageSnapshot({ load: async () => unavailableUsageSnapshot("no engine") });
  assert.equal(first.available, false);
  assert.equal(first.refreshFailed, undefined);
  resetUsageCache();
});

test("a successful read that skipped an account keeps it, labelled, instead of letting it blink out", async () => {
  resetUsageCache();
  const a = acct("anthropic", [win({ id: "a:5h", resetsAt: inAnHour() })], { id: "a" });
  const b = acct("openai-codex", [win({ id: "b:5h", resetsAt: inAnHour() })], { id: "b" });
  const reads = [snap([a, b]), snap([a])];
  const load = async () => reads.shift();
  await getUsageSnapshot({ load });
  markStale();
  const second = await getUsageSnapshot({ load, awaitFresh: true });
  assert.deepEqual(second.accounts.map((account) => account.id), ["a", "b"]);
  assert.ok(second.accounts[1].windowsStaleSince);
  assert.equal(second.stale, false, "the read itself succeeded");
  resetUsageCache();
});

test("a read that was in flight when the cache was reset cannot become the 'last good' reading of the new world", async () => {
  resetUsageCache();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = getUsageSnapshot({ load: async () => { await gate; return snap([acct("anthropic", [win()])]); } });
  resetUsageCache(); // an engine switch or a login lands while the old read is still running
  release();
  assert.equal((await slow).available, true, "its own caller still gets its answer");
  const after = await getUsageSnapshot({ load: async () => unavailableUsageSnapshot("down") });
  assert.equal(after.available, false, "the new world has no reading, and says so");
  resetUsageCache();
});

// --- the browser keeps a good reading through a failed poll ---------------------

test("a poll that finds the server with nothing to give marks the reading on screen stale instead of erasing it", () => {
  const onScreen = snap([acct("anthropic", [win()])], { fetchedAt: iso(T0) });
  const empty = unavailableUsageSnapshot("starting up");
  const kept = mergeUsageRead(onScreen, empty, T0 + 90_000);
  assert.equal(kept.available, true);
  assert.equal(kept.stale, true);
  assert.deepEqual(kept.refreshFailed, { at: iso(T0 + 90_000), reason: "starting up" });
  // The second failed poll does not move the time the failure began.
  const again = mergeUsageRead(kept, empty, T0 + 180_000);
  assert.equal(again.refreshFailed.at, iso(T0 + 90_000));
});

test("a newer good reading always replaces the one on screen, and nothing replaces a good reading with a missing one", () => {
  const old = snap([acct("anthropic", [win({ utilization: 10 })])], { fetchedAt: iso(T0), stale: true, refreshFailed: { at: iso(T0), reason: "x" } });
  const next = snap([acct("anthropic", [win({ utilization: 20 })])], { fetchedAt: iso(T0 + 90_000) });
  assert.equal(mergeUsageRead(old, next, T0 + 90_000), next);
  assert.equal(mergeUsageRead(old, null, T0), old);
  assert.equal(mergeUsageRead(old, undefined, T0), old);
  assert.equal(mergeUsageRead(null, null, T0), null);
});

test("an empty screen shows the failure; a reading too old to describe the present is not kept on screen", () => {
  const failed = unavailableUsageSnapshot("no engine");
  assert.equal(mergeUsageRead(null, failed, T0), failed);
  assert.equal(mergeUsageRead(failed, failed, T0), failed);
  const old = snap([acct("anthropic", [win()])], { fetchedAt: iso(T0) });
  assert.equal(mergeUsageRead(old, failed, T0 + LAST_GOOD_MAX_AGE_MS + 1), failed);
});
