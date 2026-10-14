import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  CLAUDE_CREDITS_MAX_KEYS,
  CLAUDE_CREDITS_PROVIDERS,
  claudeCreditsModelSuffix,
  claudeCreditsProvider,
  claudeCreditsSlot,
  claudeCreditsTwin,
  isClaudeCreditsReturn,
  isClaudeCreditsSelector,
  isClaudeCreditsSwitch,
  isClaudePlanSelector,
  selectorProvider,
  withClaudeCreditsFallback,
} = await jiti.import("./claude-credits.ts");

// The literals omp reads: "the failing model's id, on the anthropic-api provider". Spelled out here
// rather than imported, so a rename of a constant cannot silently change the contract with omp.
const WILDCARD = "anthropic-api/*";
const WILDCARD_2 = "anthropic-api-2/*";
const TWO = ["anthropic-api", "anthropic-api-2"];

const clone = (value) => JSON.parse(JSON.stringify(value));

test("the credits wildcard goes first in every role chain, and the rest of the user's chain keeps its order", () => {
  const chains = {
    default: ["openai-codex/gpt-6-astra", "openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"],
    slow: ["openai-codex/gpt-6-astra"],
    smol: ["local/tiny", "openrouter/free"],
    "my-custom-role": ["alibaba-token-plan/qwen3.8-max"],
  };
  const out = withClaudeCreditsFallback(chains);
  assert.deepEqual(out, {
    default: [WILDCARD, "openai-codex/gpt-6-astra", "openrouter/moonshotai/kimi-k2.6", "llama-swap/qwen3.8-27b"],
    slow: [WILDCARD, "openai-codex/gpt-6-astra"],
    smol: [WILDCARD, "local/tiny", "openrouter/free"],
    "my-custom-role": [WILDCARD, "alibaba-token-plan/qwen3.8-max"],
  });
});

test("the chains of Claude plan models take the wildcard too, but another provider's model keys are left alone", () => {
  const out = withClaudeCreditsFallback({
    default: ["openai-codex/gpt-6-astra"],
    "anthropic/claude-opus-5-5": ["openai-codex/gpt-6-astra"],
    "anthropic/claude-sonnet-5-5:high": ["local/qwen"],
    "anthropic/*": ["openrouter/free"],
    "openai-codex/gpt-6-astra": ["openai-codex/gpt-5.6-terra"],
    "local/*": ["cloud/main"],
    "openrouter/anthropic/claude-opus-5-5": ["openrouter/free"],
    // The credits providers' own chains, in any slot, are none of the credits' business either.
    "anthropic-api/claude-opus-5-5": ["openai-codex/gpt-6-astra"],
    "anthropic-api-2/claude-opus-5-5": ["openai-codex/gpt-6-astra"],
    "anthropic-api-2/*": ["openai-codex/gpt-6-astra"],
  });
  assert.deepEqual(out, {
    default: [WILDCARD, "openai-codex/gpt-6-astra"],
    "anthropic/claude-opus-5-5": [WILDCARD, "openai-codex/gpt-6-astra"],
    "anthropic/claude-sonnet-5-5:high": [WILDCARD, "local/qwen"],
    "anthropic/*": [WILDCARD, "openrouter/free"],
  });
});

test("an exact plan entry is followed by its credits twin, with the thinking suffix carried", () => {
  const out = withClaudeCreditsFallback({
    // A Claude model parked AFTER a Codex model is behind the leading wildcard: it needs its own twin.
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5:high", "local/qwen", "anthropic/claude-haiku-5-5"],
  });
  assert.deepEqual(out.default, [
    WILDCARD,
    "openai-codex/gpt-6-astra",
    "anthropic/claude-opus-5-5:high",
    "anthropic-api/claude-opus-5-5:high",
    "local/qwen",
    "anthropic/claude-haiku-5-5",
    "anthropic-api/claude-haiku-5-5",
  ]);
});

test("a wildcard the user wrote on the plan, and entries that are not plan models, get no twin", () => {
  const out = withClaudeCreditsFallback({
    default: ["anthropic/*", "openai-codex/gpt-6-astra", "openrouter/anthropic/claude-opus-5-5", "anthropic/"],
  });
  assert.deepEqual(out.default, [WILDCARD, "anthropic/*", "openai-codex/gpt-6-astra", "openrouter/anthropic/claude-opus-5-5", "anthropic/"]);
});

test("an empty chain is the user saying no fallback here, and a tombstone is a retired chain: neither is revived", () => {
  const out = withClaudeCreditsFallback({
    default: ["openai-codex/gpt-6-astra"],
    commit: [],
    tiny: null,
    plan: undefined,
    "anthropic/claude-opus-5-5": [],
    "anthropic/*": null,
  });
  assert.deepEqual(out, { default: [WILDCARD, "openai-codex/gpt-6-astra"] });
  assert.ok(!("commit" in out) && !("tiny" in out) && !("plan" in out), "a skipped key stays out of the overlay, so the user's own value reaches omp untouched");
});

test("a missing default chain is created, because every role without a chain of its own inherits it", () => {
  assert.deepEqual(withClaudeCreditsFallback({}), { default: [WILDCARD] });
  assert.deepEqual(withClaudeCreditsFallback({ slow: ["openai-codex/gpt-6-astra"] }), {
    slow: [WILDCARD, "openai-codex/gpt-6-astra"],
    default: [WILDCARD],
  });
  // Only another provider's model chains exist: the default is still needed.
  assert.deepEqual(withClaudeCreditsFallback({ "openai-codex/gpt-6-astra": ["x/y"] }), { default: [WILDCARD] });
});

test("an explicitly empty default chain is the user's word and stays out of the overlay", () => {
  assert.deepEqual(withClaudeCreditsFallback({ default: [], slow: ["openai-codex/gpt-6-astra"] }), { slow: [WILDCARD, "openai-codex/gpt-6-astra"] });
});

test("a wildcard the user already listed is moved to the front once, never duplicated", () => {
  const out = withClaudeCreditsFallback({
    default: ["openai-codex/gpt-6-astra", WILDCARD, "local/qwen"],
    slow: [WILDCARD],
    smol: [WILDCARD, "local/qwen", WILDCARD],
  });
  assert.deepEqual(out.default, [WILDCARD, "openai-codex/gpt-6-astra", "local/qwen"]);
  assert.deepEqual(out.slow, [WILDCARD]);
  assert.deepEqual(out.smol, [WILDCARD, "local/qwen"]);
});

test("a twin the user already listed is not doubled, wherever it stands", () => {
  const out = withClaudeCreditsFallback({
    after: ["anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "local/qwen"],
    before: ["anthropic-api/claude-opus-5-5", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"],
    // The same plan model listed twice: one entry, one twin.
    twice: ["anthropic/claude-opus-5-5", "local/qwen", "anthropic/claude-opus-5-5"],
  });
  assert.deepEqual(out.after, [WILDCARD, "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "local/qwen"]);
  assert.deepEqual(out.before, [WILDCARD, "anthropic-api/claude-opus-5-5", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"]);
  assert.deepEqual(out.twice, [WILDCARD, "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "local/qwen"]);
});

test("applying it twice gives what applying it once gave", () => {
  const chains = {
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5:high", "local/qwen"],
    slow: [WILDCARD, "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5"],
    smol: ["local/tiny"],
    commit: [],
    retired: null,
    "anthropic/claude-opus-5-5": ["openai-codex/gpt-6-astra", "anthropic/claude-sonnet-5-5"],
    "anthropic/*": ["openrouter/free"],
    "openai-codex/gpt-6-astra": ["openai-codex/gpt-5.6-terra"],
  };
  const once = withClaudeCreditsFallback(chains);
  assert.deepEqual(withClaudeCreditsFallback(once), once);
  assert.deepEqual(withClaudeCreditsFallback(withClaudeCreditsFallback(once)), once);
  // …and from nothing, too: the created default chain is itself a fixed point.
  assert.deepEqual(withClaudeCreditsFallback(withClaudeCreditsFallback({})), { default: [WILDCARD] });
});

test("the user's chains are read, never changed", () => {
  const chains = {
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"],
    smol: [],
    retired: null,
  };
  const before = clone(chains);
  const out = withClaudeCreditsFallback(chains);
  assert.deepEqual(chains, before);
  out.default.push("tampered");
  assert.deepEqual(chains, before, "the result shares nothing with the input");
});

test("claudeCreditsTwin names the credits copy of a plan model on one credits provider, and of nothing else", () => {
  assert.equal(claudeCreditsTwin("anthropic/claude-opus-5-5"), "anthropic-api/claude-opus-5-5", "the first key's provider by default");
  assert.equal(claudeCreditsTwin("anthropic/claude-opus-5-5:high"), "anthropic-api/claude-opus-5-5:high");
  assert.equal(claudeCreditsTwin("anthropic/claude-opus-5-5:high", "anthropic-api-2"), "anthropic-api-2/claude-opus-5-5:high", "the thinking suffix is carried onto every slot's twin");
  // A model id that itself contains a slash keeps everything after the provider.
  assert.equal(claudeCreditsTwin("anthropic/vendor/claude-x"), "anthropic-api/vendor/claude-x");
  for (const notAPlanModel of [
    "anthropic/*", // a wildcard has no single twin
    "anthropic-api/claude-opus-5-5", // already a twin
    "anthropic-api-2/claude-opus-5-5", // already a twin, in another slot
    "anthropic-api/*",
    "anthropic/", // no model
    "anthropic", // no provider/model split
    "openai-codex/gpt-6-astra",
    "openrouter/anthropic/claude-opus-5-5",
    "",
  ]) {
    assert.equal(claudeCreditsTwin(notAPlanModel), null, JSON.stringify(notAPlanModel));
    assert.equal(claudeCreditsTwin(notAPlanModel, "anthropic-api-2"), null, JSON.stringify(notAPlanModel));
  }
});

test("selectorProvider reads the provider half of a selector, and only of a selector", () => {
  assert.equal(selectorProvider("anthropic/claude-opus-5-5:high"), "anthropic");
  assert.equal(selectorProvider("anthropic-api/*"), "anthropic-api");
  assert.equal(selectorProvider("openrouter/moonshotai/kimi-k2.6:free"), "openrouter", "only the FIRST slash splits");
  assert.equal(selectorProvider("anthropic/"), "anthropic");
  for (const notASelector of ["claude-opus-5-5", "/claude-opus-5-5", "", "default", null, undefined, 5, {}, ["anthropic/x"]]) {
    assert.equal(selectorProvider(notASelector), null, String(notASelector));
  }
  assert.equal(isClaudePlanSelector("anthropic/claude-opus-5-5"), true);
  assert.equal(isClaudePlanSelector("anthropic-api/claude-opus-5-5"), false, "the credits are not the plan");
  assert.equal(isClaudeCreditsSelector("anthropic-api/claude-opus-5-5"), true);
  assert.equal(isClaudeCreditsSelector("anthropic/claude-opus-5-5"), false);
});

test("omp's own fallback events tell a hop onto the credits from the hop back to the plan", () => {
  // The events omp emits: `retry_fallback_applied.from/to` are `provider/id[:level]`.
  assert.equal(isClaudeCreditsSwitch("anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5"), true);
  assert.equal(isClaudeCreditsReturn("anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5"), false);
  assert.equal(isClaudeCreditsReturn("anthropic-api/claude-opus-5-5:high", "anthropic/claude-opus-5-5"), true);
  assert.equal(isClaudeCreditsSwitch("anthropic-api/claude-opus-5-5:high", "anthropic/claude-opus-5-5"), false);
  // Neither is a credits hop when another provider is involved, or when the input is not a selector at all.
  assert.equal(isClaudeCreditsSwitch("anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"), false);
  assert.equal(isClaudeCreditsSwitch("openai-codex/gpt-6-astra", "anthropic-api/claude-opus-5-5"), false);
  assert.equal(isClaudeCreditsReturn("openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"), false);
  assert.equal(isClaudeCreditsReturn("anthropic-api/claude-opus-5-5", "local/qwen"), false);
  assert.equal(isClaudeCreditsSwitch("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"), false, "another plan model is not the credits");
  for (const junk of [undefined, null, 7, {}, ""]) {
    assert.equal(isClaudeCreditsSwitch(junk, "anthropic-api/x"), false);
    assert.equal(isClaudeCreditsSwitch("anthropic/x", junk), false);
    assert.equal(isClaudeCreditsReturn(junk, "anthropic/x"), false);
    assert.equal(isClaudeCreditsReturn("anthropic-api/x", junk), false);
  }
});

// ── One provider per key ─────────────────────────────────────────────────────

test("a key's provider is `anthropic-api`, then `anthropic-api-2` … up to eight, and the slot is read back from the id", () => {
  const ids = ["anthropic-api", "anthropic-api-2", "anthropic-api-3", "anthropic-api-4", "anthropic-api-5", "anthropic-api-6", "anthropic-api-7", "anthropic-api-8"];
  assert.equal(CLAUDE_CREDITS_MAX_KEYS, 8);
  assert.deepEqual([...CLAUDE_CREDITS_PROVIDERS], ids, "the order is the order the chain tries them in");
  ids.forEach((id, slot) => {
    assert.equal(claudeCreditsProvider(slot), id);
    assert.equal(claudeCreditsSlot(id), slot);
    assert.equal(isClaudeCreditsSelector(`${id}/claude-opus-5-5:high`), true, id);
    assert.equal(isClaudeCreditsSelector(`${id}/*`), true, id);
  });
  // What is NOT a credits provider: the plan's own, a first slot spelled with a number, one past the ceiling, and junk.
  for (const notOurs of ["anthropic", "anthropic-api-1", "anthropic-api-0", "anthropic-api-9", "anthropic-api-10", "anthropic-api-", "anthropic-api2", "anthropic-apix", "Anthropic-API", "openai-codex", "", null, undefined, 2, {}, ["anthropic-api"]]) {
    assert.equal(claudeCreditsSlot(notOurs), null, JSON.stringify(notOurs));
  }
  for (const notOurs of ["anthropic/claude-opus-5-5", "anthropic-api-1/claude-opus-5-5", "anthropic-api-9/claude-opus-5-5", "anthropic-api", "openai-codex/gpt-6-astra", "", null, 5]) {
    assert.equal(isClaudeCreditsSelector(notOurs), false, JSON.stringify(notOurs));
  }
});

test("the text next to a model says which key's credits serve it", () => {
  assert.equal(claudeCreditsModelSuffix("anthropic-api"), " (API credits)");
  for (let slot = 1; slot < 8; slot += 1) assert.equal(claudeCreditsModelSuffix(`anthropic-api-${slot + 1}`), ` (API credits ${slot + 1})`);
  assert.equal(claudeCreditsModelSuffix("anthropic"), " (API credits)", "anything that is not a later slot reads as the first");
});

test("with two keys each provider's wildcard goes first, in slot order, and every exact plan entry is followed by its twins in slot order", () => {
  const out = withClaudeCreditsFallback({
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5:high", "local/qwen"],
    slow: ["anthropic/claude-sonnet-5-5", "anthropic/*"],
    "anthropic/claude-opus-5-5": ["openrouter/free"],
    commit: [],
    retired: null,
  }, TWO);
  assert.deepEqual(out, {
    default: [WILDCARD, WILDCARD_2, "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5:high", "anthropic-api-2/claude-opus-5-5:high", "local/qwen"],
    slow: [WILDCARD, WILDCARD_2, "anthropic/claude-sonnet-5-5", "anthropic-api/claude-sonnet-5-5", "anthropic-api-2/claude-sonnet-5-5", "anthropic/*"],
    "anthropic/claude-opus-5-5": [WILDCARD, WILDCARD_2, "openrouter/free"],
  });
});

test("the providers are put in the order they are given, and a wildcard the user listed for one of them moves to the front once", () => {
  assert.deepEqual(withClaudeCreditsFallback({ default: ["local/qwen"] }, ["anthropic-api-2", "anthropic-api"]).default, [WILDCARD_2, WILDCARD, "local/qwen"]);
  const out = withClaudeCreditsFallback({ default: ["local/qwen", WILDCARD_2, "openai-codex/gpt-6-astra", WILDCARD, WILDCARD_2] }, TWO);
  assert.deepEqual(out.default, [WILDCARD, WILDCARD_2, "local/qwen", "openai-codex/gpt-6-astra"]);
  const three = withClaudeCreditsFallback({ default: ["anthropic/claude-opus-5-5"] }, ["anthropic-api", "anthropic-api-2", "anthropic-api-3"]);
  assert.deepEqual(three.default, ["anthropic-api/*", "anthropic-api-2/*", "anthropic-api-3/*", "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5", "anthropic-api-3/claude-opus-5-5"]);
});

test("a twin the user already listed is not doubled, whichever provider it is on", () => {
  const out = withClaudeCreditsFallback({
    one: ["anthropic/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5", "local/qwen"],
    both: ["anthropic-api/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5", "anthropic/claude-opus-5-5"],
  }, TWO);
  // The first twin is missing, so it follows the plan entry; the second the user already placed, ahead of it.
  assert.deepEqual(out.one, [WILDCARD, WILDCARD_2, "anthropic/claude-opus-5-5", "anthropic-api/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5", "local/qwen"]);
  assert.deepEqual(out.both, [WILDCARD, WILDCARD_2, "anthropic-api/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
});

test("a missing default chain is just the wildcards, one per key, and applying it twice changes nothing", () => {
  assert.deepEqual(withClaudeCreditsFallback({}, TWO), { default: [WILDCARD, WILDCARD_2] });
  assert.deepEqual(withClaudeCreditsFallback({ slow: ["openai-codex/gpt-6-astra"] }, TWO), { slow: [WILDCARD, WILDCARD_2, "openai-codex/gpt-6-astra"], default: [WILDCARD, WILDCARD_2] });
  const chains = {
    default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5:high", "local/qwen"],
    slow: [WILDCARD_2, "anthropic/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5"],
    smol: ["local/tiny"],
    commit: [],
    retired: null,
    "anthropic/claude-opus-5-5": ["openai-codex/gpt-6-astra", "anthropic/claude-sonnet-5-5"],
    "anthropic/*": ["openrouter/free"],
  };
  const once = withClaudeCreditsFallback(chains, TWO);
  assert.deepEqual(withClaudeCreditsFallback(once, TWO), once);
  assert.deepEqual(withClaudeCreditsFallback(withClaudeCreditsFallback(once, TWO), TWO), once);
  assert.deepEqual(withClaudeCreditsFallback(withClaudeCreditsFallback({}, TWO), TWO), { default: [WILDCARD, WILDCARD_2] });
});

test("a key that was removed leaves the chains: the overlay is rebuilt from the providers that still hold one", () => {
  const chains = { default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"] };
  const both = withClaudeCreditsFallback(chains, TWO);
  assert.deepEqual(withClaudeCreditsFallback(chains, ["anthropic-api-2"]).default, [WILDCARD_2, "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic-api-2/claude-opus-5-5"], "the second key alone: its wildcard and its twin, nothing of the first");
  assert.ok(!both.default.includes("anthropic-api-3/*"));
  assert.deepEqual(chains, { default: ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"] }, "the user's chain is read, never changed");
});

test("omp's fallback events are read across the whole family: the plan to any key, any key to the plan, and key to key is neither", () => {
  for (const provider of CLAUDE_CREDITS_PROVIDERS) {
    assert.equal(isClaudeCreditsSwitch("anthropic/claude-opus-5-5:high", `${provider}/claude-opus-5-5`), true, provider);
    assert.equal(isClaudeCreditsReturn("anthropic/claude-opus-5-5:high", `${provider}/claude-opus-5-5`), false, provider);
    assert.equal(isClaudeCreditsReturn(`${provider}/claude-opus-5-5:high`, "anthropic/claude-opus-5-5"), true, provider);
    assert.equal(isClaudeCreditsSwitch(`${provider}/claude-opus-5-5:high`, "anthropic/claude-opus-5-5"), false, provider);
  }
  // The second hop omp makes when the first key is empty: from one key's twin to the next. The chat already said "credits".
  const hop = ["anthropic-api/claude-opus-5-5:high", "anthropic-api-2/claude-opus-5-5"];
  assert.equal(isClaudeCreditsSwitch(...hop), false);
  assert.equal(isClaudeCreditsReturn(...hop), false);
  assert.equal(isClaudeCreditsSwitch("anthropic-api-2/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5"), false);
  assert.equal(isClaudeCreditsReturn("anthropic-api-2/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5"), false);
  // What is not a credits provider is not a credits hop.
  assert.equal(isClaudeCreditsSwitch("anthropic/claude-opus-5-5", "anthropic-api-9/claude-opus-5-5"), false);
  assert.equal(isClaudeCreditsReturn("anthropic-api-1/claude-opus-5-5", "anthropic/claude-opus-5-5"), false);
});
