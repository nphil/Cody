import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyCredentialBlocks } = await jiti.import("./credential-order.ts");
const { constrainingWindows, isAccountWideWindow } = await jiti.import("./quota-tiers.ts");
const { rankProviderAccounts } = await jiti.import("./select.ts");
const { resolveModelAvailability } = await jiti.import("./availability.ts");
const { deriveBlackouts } = await jiti.import("../routing/blackouts.ts");

/**
 * omp 18.19 stores each rate-limit block with a scope. A block aimed at one
 * model family (Claude's Fable tier, Codex's Spark lane, one Cursor pool) used
 * to be folded into ONE untiered exhausted window and so read as the whole
 * account being out, routing Opus and ordinary chat models around a healthy
 * account for nothing.
 */

const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const HOUR = 3_600_000;
const UNTIL = NOW + 2 * HOUR;
const UNTIL_ISO = new Date(UNTIL).toISOString();

const measured = (id, utilization = 10, extra = {}) => ({ id, label: id, utilization, resetsAt: null, state: utilization >= 100 ? "exhausted" : "ok", windowMs: null, ...extra });
const account = (provider, credentialId, windows) => ({ provider, id: `${provider}-${credentialId}`, identity: `${provider}@example.com`, credentialId, label: provider, planType: null, unlimited: false, windows });
const snapshot = (...accounts) => ({ available: true, stale: false, fetchedAt: "now", accounts });
const row = (id, provider, blocks, extra = {}) => ({ id, provider, type: "oauth", identity: `${provider}@example.com`, planType: null, disabledCause: null, blockedUntil: blocks.length ? new Date(Math.max(...blocks.map((b) => b.until))).toISOString() : null, blocks, pinHash: null, ...extra });
const apply = (snap, rows) => applyCredentialBlocks(snap, rows, NOW);
const windowsOf = (snap, provider = undefined) => snap.accounts.filter((a) => !provider || a.provider === provider).flatMap((a) => a.windows);
const verdict = (snap, provider, modelId) => resolveModelAvailability(snap, provider, modelId).state;

test("an unscoped block keeps its original id and still blocks the whole account", () => {
  const out = apply(snapshot(account("anthropic", 5, [measured("anthropic:5h")])), [row(5, "anthropic", [{ scope: "", until: UNTIL }])]);
  const block = windowsOf(out).find((w) => w.source === "block");
  assert.equal(block.id, "anthropic:blocked:5");
  assert.equal(block.blockScope, "");
  assert.equal(block.tier, null);
  assert.equal(block.resetsAt, UNTIL_ISO);
  assert.equal(block.label, "rate-limit block");
  assert.equal(isAccountWideWindow(block), true);
  assert.equal(verdict(out, "anthropic", "claude-opus-5-5"), "exhausted");
  assert.equal(verdict(out, "anthropic", "claude-fable-5-1"), "exhausted");
});

test("a row without a blocks list (older source) reads as one unscoped block", () => {
  const out = apply(snapshot(account("anthropic", 5, [measured("anthropic:5h")])), [{ id: 5, provider: "anthropic", identity: null, blockedUntil: UNTIL_ISO }]);
  assert.deepEqual(windowsOf(out).filter((w) => w.source === "block").map((w) => [w.id, w.blockScope, w.resetsAt]), [["anthropic:blocked:5", "", UNTIL_ISO]]);
});

test("a Fable-tier block takes only the Fable model out; Opus keeps serving", () => {
  const out = apply(snapshot(account("anthropic", 5, [measured("anthropic:5h")])), [row(5, "anthropic", [{ scope: "tier:fable", until: UNTIL }])]);
  const block = windowsOf(out).find((w) => w.source === "block");
  assert.equal(block.id, "anthropic:blocked:5:tier:fable");
  assert.equal(block.blockScope, "tier:fable");
  assert.equal(block.tier, "fable");
  assert.equal(isAccountWideWindow(block), false);

  assert.equal(verdict(out, "anthropic", "claude-fable-5-1"), "exhausted");
  assert.equal(verdict(out, "anthropic", "claude-opus-5-5"), "ok");
  assert.equal(verdict(out, "anthropic", "claude-sonnet-5-5"), "ok");
  assert.deepEqual(constrainingWindows(out.accounts[0].windows, "anthropic", "claude-opus-5-5").map((w) => w.id), ["anthropic:5h"]);
  const [ranked] = rankProviderAccounts(out.accounts, "anthropic", "claude-opus-5-5");
  assert.notEqual(ranked.state, "limited", "the account still serves Opus");
  assert.deepEqual(deriveBlackouts(out).filter((b) => b.provider === "anthropic"), [], "a tier block is not a provider-wide blackout");
});

test("a block on every Claude account is still a blackout only when it is account-wide", () => {
  const wide = apply(snapshot(account("anthropic", 5, [measured("anthropic:5h")])), [row(5, "anthropic", [{ scope: "", until: UNTIL }])]);
  assert.equal(deriveBlackouts(wide).filter((b) => b.provider === "anthropic").length, 1);
});

test("one window per scope, each with its own id and deadline", () => {
  const later = UNTIL + HOUR;
  const out = apply(snapshot(account("anthropic", 5, [measured("anthropic:5h")])), [row(5, "anthropic", [{ scope: "tier:fable", until: UNTIL }, { scope: "tier:mythos", until: later }])]);
  const blocks = windowsOf(out).filter((w) => w.source === "block");
  assert.deepEqual(blocks.map((w) => [w.id, w.tier, w.resetsAt]), [
    ["anthropic:blocked:5:tier:fable", "fable", UNTIL_ISO],
    ["anthropic:blocked:5:tier:mythos", "mythos", new Date(later).toISOString()],
  ]);
  assert.equal(verdict(out, "anthropic", "claude-mythos-5"), "exhausted");
  assert.equal(verdict(out, "anthropic", "claude-opus-5-5"), "ok");
});

test("Codex: a spark block spares chat models, a chat block spares Spark", () => {
  const codex = () => account("openai-codex", 7, [measured("openai-codex:primary", 5), measured("openai-codex:secondary", 5)]);
  const spark = apply(snapshot(codex()), [row(7, "openai-codex", [{ scope: "spark", until: UNTIL }])]);
  const sparkBlock = windowsOf(spark).find((w) => w.source === "block");
  assert.equal(sparkBlock.id, "openai-codex:blocked:7:spark");
  assert.equal(sparkBlock.tier, "spark");
  assert.equal(isAccountWideWindow(sparkBlock), false);
  assert.equal(verdict(spark, "openai-codex", "gpt-5.3-codex-spark"), "exhausted");
  assert.equal(verdict(spark, "openai-codex", "gpt-5.5"), "ok");

  const chat = apply(snapshot(codex()), [row(7, "openai-codex", [{ scope: "chat", until: UNTIL }])]);
  const chatBlock = windowsOf(chat).find((w) => w.source === "block");
  assert.equal(chatBlock.id, "openai-codex:blocked:7:chat");
  assert.equal(chatBlock.blockScope, "chat");
  assert.equal(verdict(chat, "openai-codex", "gpt-5.5"), "exhausted");
  assert.notEqual(verdict(chat, "openai-codex", "gpt-5.3-codex-spark"), "exhausted", "no Spark meter is reported, so nothing constrains Spark");

  const shared = apply(snapshot(codex()), [row(7, "openai-codex", [{ scope: "shared", until: UNTIL }])]);
  assert.equal(verdict(shared, "openai-codex", "gpt-5.5"), "exhausted");
  assert.equal(verdict(shared, "openai-codex", "gpt-5.3-codex-spark"), "exhausted");
});

test("Cursor: a pool:api block refuses only the prepaid pool's models", () => {
  const cursor = () => account("cursor", 3, [measured("cursor:usd:individual-auto", 10), measured("cursor:usd:individual-api", 10)]);
  const api = apply(snapshot(cursor()), [row(3, "cursor", [{ scope: "pool:api", until: UNTIL }])]);
  const block = windowsOf(api).find((w) => w.source === "block");
  assert.equal(block.id, "cursor:blocked:3:pool:api");
  assert.equal(block.blockScope, "pool:api");
  assert.equal(isAccountWideWindow(block), false);
  assert.equal(verdict(api, "cursor", "claude-sonnet-4-5"), "exhausted");
  assert.equal(verdict(api, "cursor", "composer-2.5"), "ok");

  const auto = apply(snapshot(cursor()), [row(3, "cursor", [{ scope: "pool:auto", until: UNTIL }])]);
  assert.equal(verdict(auto, "cursor", "composer-2.5"), "exhausted");
  assert.equal(verdict(auto, "cursor", "claude-sonnet-4-5"), "ok");
});

test("an unknown scope is read as account-wide", () => {
  const out = apply(snapshot(account("zai", 9, [measured("zai:5h")])), [row(9, "zai", [{ scope: "counter:weird", until: UNTIL }])]);
  const block = windowsOf(out).find((w) => w.source === "block");
  assert.equal(block.id, "zai:blocked:9:counter:weird");
  assert.equal(block.tier, null);
  assert.equal(isAccountWideWindow(block), true);
  assert.equal(verdict(out, "zai", "glm-5"), "exhausted");
});

test("a disabled account, an expired block and a block without a deadline add no window", () => {
  const base = snapshot(account("anthropic", 5, [measured("anthropic:5h")]));
  assert.equal(apply(base, [row(5, "anthropic", [{ scope: "tier:fable", until: UNTIL }], { disabledCause: "revoked" })]), base);
  assert.equal(apply(base, [row(5, "anthropic", [{ scope: "", until: NOW - HOUR }], { blockedUntil: new Date(NOW - HOUR).toISOString() })]), base);
  assert.equal(apply(base, [row(5, "anthropic", [{ scope: "tier:fable", until: null }], { blockedUntil: null })]), base);
});

test("a blocked key on a provider that reports no usage gets its own account with the scoped window", () => {
  const out = apply(snapshot(account("anthropic", 5, [measured("anthropic:5h")])), [
    row(11, "openrouter", [{ scope: "", until: UNTIL }, { scope: "credits", until: UNTIL }], { type: "api_key" }),
  ]);
  const synthesized = out.accounts.find((a) => a.provider === "openrouter");
  assert.deepEqual(synthesized.windows.map((w) => w.id), ["openrouter:blocked:11", "openrouter:blocked:11:credits"]);
  assert.equal(synthesized.credentialId, 11);
});
