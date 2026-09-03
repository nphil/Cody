import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { bestAvailableModel, deriveChains, heuristicPlan, ROLE_NAMES, validatePlan } = await jiti.import("./derive.ts");

function model(selector, overrides = {}) {
  const slash = selector.indexOf("/");
  const id = selector.slice(slash + 1);
  return {
    selector,
    provider: selector.slice(0, slash),
    id,
    name: id,
    contextWindow: 200_000,
    maxTokens: 8_192,
    reasoning: true,
    thinkingEfforts: [],
    vision: false,
    local: false,
    ...overrides,
  };
}

// Two paid providers and one locally served runtime whose best model is the
// largest in the roster — a naive capability sort would hand it the main
// session.
const ROSTER = [
  model("alpha/big", { contextWindow: 400_000, vision: true }),
  model("alpha/fast", { contextWindow: 200_000, reasoning: false }),
  model("beta/big", { contextWindow: 300_000 }),
  model("beta/fast", { contextWindow: 100_000, reasoning: false }),
  model("homelab/local-big", { contextWindow: 500_000, local: true }),
  model("homelab/local-small", { contextWindow: 32_000, reasoning: false, local: true }),
];
const LADDER = ["alpha", "beta", "homelab"];

test("every assigned role gets its own chain and `default` exists even unassigned (subagent inheritance)", () => {
  // omp resolves a subagent's chain as fallbackChains[role] ?? fallbackChains.default.
  // Wildcard keys are never consulted there, so a role with neither its own key
  // nor a `default` to inherit has no chain at all and its first usage limit is
  // fatal — the subagent dies with zero assistant turns.
  const chains = deriveChains({
    roles: { task: "alpha/big", smol: "alpha/fast" },
    ladder: LADDER,
    roster: ROSTER,
  });

  assert.deepEqual(chains.task, ["beta/big", "homelab/local-big"]);
  // The cheap role degrades to each provider's cheap model, not to its flagship.
  assert.deepEqual(chains.smol, ["beta/fast", "homelab/local-small"]);
  assert.ok(Array.isArray(chains.default) && chains.default.length > 0, "default is the inheritance safety net");
  assert.deepEqual(chains.default, ["alpha/big", "beta/big", "homelab/local-big"]);
});

test("wildcard keys cover each assigned provider, and the last ladder rung gets none", () => {
  const chains = deriveChains({
    roles: { default: "alpha/big", commit: "beta/fast", tiny: "homelab/local-small" },
    ladder: LADDER,
    roster: ROSTER,
  });

  assert.deepEqual(chains["alpha/*"], ["beta/big", "homelab/local-big"]);
  assert.deepEqual(chains["beta/*"], ["homelab/local-small"]);
  // homelab is the bottom of the ladder: no rung below it, so no key at all
  // rather than a key omp would read as "a chain exists and it is empty".
  assert.equal("homelab/*" in chains, false);
  assert.equal("tiny" in chains, false);
});

test("a chain never holds its own model, never repeats, and is omitted when empty", () => {
  const chains = deriveChains({
    // A ladder that names the same provider twice, as an LLM-authored one might.
    roles: { default: "alpha/big", task: "homelab/local-big" },
    ladder: ["alpha", "alpha", "beta"],
    roster: ROSTER,
  });

  assert.deepEqual(chains.default, ["beta/big"]);
  assert.equal(chains.default.includes("alpha/big"), false);
  // homelab is not on this ladder, so every rung is a genuine alternative —
  // and the repeated rung contributes nothing a second time.
  assert.deepEqual(chains.task, ["alpha/big", "beta/big"]);
  for (const [key, chain] of Object.entries(chains)) {
    assert.ok(chain.length > 0, `${key} must be omitted rather than empty`);
    assert.equal(new Set(chain).size, chain.length, `${key} must not repeat a selector`);
  }
});

test("validatePlan drops unknown selectors, repairs a vanished role, and keeps a thinking suffix", () => {
  const { plan, warnings } = validatePlan({
    roles: { default: "alpha/big", plan: "ghost/model", slow: "alpha/big:high" },
    chains: {
      default: ["ghost/model", "beta/big", "beta/big"],
      plan: ["alpha/big"],
    },
  }, ROSTER);

  // The repair lands on the best model the user can actually reach.
  assert.equal(plan.roles.plan, "alpha/big");
  // A thinking suffix is meaningful to omp, so a resolved selector is preserved
  // verbatim rather than normalised to its base model.
  assert.equal(plan.roles.slow, "alpha/big:high");
  assert.deepEqual(plan.chains.default, ["beta/big"]);
  // The `plan` chain was derived against the model that vanished; after the
  // repair its only entry is the role's own model, so the chain goes away.
  assert.equal("plan" in plan.chains, false);
  assert.equal(plan.usageAwareFallback, false, "one provider owns every assignment");
  assert.ok(warnings.some((warning) => warning.includes("ghost/model") && warning.includes("plan")), warnings.join(" | "));
  assert.ok(warnings.some((warning) => warning.includes("default")), warnings.join(" | "));
});

test("validatePlan turns on usage-aware fallback once two providers own assignments", () => {
  const { plan } = validatePlan({ roles: { default: "alpha/big", tiny: "homelab/local-small" }, chains: {} }, ROSTER);
  assert.equal(plan.usageAwareFallback, true);
});

test("heuristicPlan keeps local models off the main session and puts one on tiny", () => {
  const plan = heuristicPlan(ROSTER);

  // homelab/local-big is the largest model in the roster and still must not
  // drive main turns or subagents.
  assert.equal(plan.roles.default, "alpha/big");
  assert.equal(plan.roles.task, "alpha/big");
  assert.equal(plan.roles.tiny, "homelab/local-big");
  assert.equal(plan.roles.vision, "alpha/big", "vision needs a model that accepts images");
  assert.equal(plan.roles.smol, "alpha/fast", "mechanical work goes to the non-reasoning tier");
  assert.deepEqual(plan.ladder, ["alpha", "beta", "homelab"]);
  for (const role of Object.keys(plan.roles)) assert.ok(ROLE_NAMES.includes(role), `unknown role ${role}`);

  const withoutLocal = heuristicPlan(ROSTER.filter((entry) => !entry.local));
  assert.equal(withoutLocal.roles.tiny, "alpha/fast", "with no local model, tiny takes the cheapest reachable one");
  assert.deepEqual(withoutLocal.ladder, ["alpha", "beta"]);
});

test("a self-hosted runtime stays at the bottom of the ladder even when one of its models looks priced", () => {
  const mixed = [
    model("alpha/big", { contextWindow: 400_000 }),
    model("homelab/small", { contextWindow: 32_000, local: true }),
    // Same runtime, but this entry's catalog record carries real prices, so the
    // per-model signal says it is not free. Ranking the rung on that flag alone
    // would hoist local hardware above a provider that still has quota.
    model("homelab/priced-huge", { contextWindow: 900_000 }),
  ];

  assert.deepEqual(heuristicPlan(mixed).ladder, ["alpha", "homelab"]);
});

test("a gateway ranks behind direct providers and ahead of local models", () => {
  // OpenRouter-style aggregators are recognized by their vendor-prefixed model
  // ids (the id itself contains a slash). The gateway's rebadged frontier model
  // out-sizes everything, and still must not drive main turns or lead the
  // ladder: the direct providers hold the quota the user actually pays for.
  const roster = [
    model("alpha/big", { contextWindow: 400_000 }),
    model("beta/big", { contextWindow: 300_000 }),
    model("openrouter/vendor-x/huge", { contextWindow: 2_000_000 }),
    model("openrouter/vendor-y/cheap", { contextWindow: 100_000, reasoning: false }),
    model("homelab/local", { contextWindow: 500_000, local: true }),
  ];
  const plan = heuristicPlan(roster);

  assert.equal(plan.roles.default, "alpha/big", "the gateway model must not drive the main session");
  assert.deepEqual(plan.ladder, ["alpha", "beta", "openrouter", "homelab"], "direct → gateway → local");
});

test("the provider already driving the default role leads its ladder tier", () => {
  const plan = heuristicPlan(ROSTER, { preferredProvider: "beta" });
  assert.deepEqual(plan.ladder, ["beta", "alpha", "homelab"], "the trusted provider leads, local still last");

  const ignored = heuristicPlan(ROSTER, { preferredProvider: "ghost" });
  assert.deepEqual(ignored.ladder, ["alpha", "beta", "homelab"], "an unknown hint changes nothing");
});

test("a reasoning role's chain never degrades to a non-reasoning model", () => {
  // A provider whose only models are chat-class (a lone Haiku-tier entry)
  // must contribute nothing to a thinking role's chain: a non-reasoning
  // fallback under a planning role loops on problems it cannot think
  // through. The reverse substitution (chat role stepping up to a thinking
  // model) stays allowed — merely overqualified.
  const roster = [
    model("alpha/thinker", { contextWindow: 400_000 }),
    model("alpha/chat", { contextWindow: 150_000, reasoning: false }),
    model("cheapco/mini-chat", { contextWindow: 200_000, reasoning: false }),
  ];
  const chains = deriveChains({
    roles: { plan: "alpha/thinker", commit: "alpha/chat" },
    ladder: ["alpha", "cheapco"],
    roster,
  });

  assert.equal(chains.plan, undefined, "no reasoning rung exists below alpha, so plan gets no chain at all");
  assert.deepEqual(chains.commit, ["cheapco/mini-chat"], "the chat role still degrades to cheapco's chat model");
  // The alpha/* wildcard matches against alpha's strongest assignment (the
  // thinker), so it too refuses the chat-only provider below it.
  assert.equal(chains["alpha/*"], undefined);
});

test("a single-provider roster produces no chains rather than empty ones", () => {
  const roster = ROSTER.filter((entry) => entry.provider === "alpha");
  const draft = heuristicPlan(roster);
  const chains = deriveChains({ roles: draft.roles, ladder: draft.ladder, roster });

  assert.deepEqual(draft.ladder, ["alpha"]);
  assert.deepEqual(chains, {}, "nothing to fall back to, so no keys at all");
});

// The engine owns the role vocabulary and it changes between releases (omp
// dropped `designer` in 18.1.5). A plan that assigns a role the installed
// engine no longer has writes a config.yml entry its resolver ignores.
test("a plan only ever names roles the engine still has", () => {
  const roleNames = ["default", "task", "tiny"];
  const plan = heuristicPlan(ROSTER, { roleNames });

  assert.deepEqual(Object.keys(plan.roles).sort(), [...roleNames].sort());
  assert.equal(plan.roles.smol, undefined, "a dropped role is skipped, not assigned");
  for (const line of plan.rationale) {
    assert.ok(line.subject === "ladder" || roleNames.includes(line.subject), `rationale names ${line.subject}`);
  }

  // The same list governs what a model-written plan is allowed to propose.
  const { plan: validated, warnings } = validatePlan(
    { roles: { default: "alpha/big", smol: "alpha/fast" }, chains: {} },
    ROSTER,
    roleNames,
  );
  assert.equal(validated.roles.smol, undefined);
  assert.ok(warnings.some((warning) => warning.includes("smol")), "the dropped role is reported, not silently lost");

  // A role the engine gained but Cody has no opinion about is still accepted.
  const gained = validatePlan({ roles: { conductor: "alpha/big" }, chains: {} }, ROSTER, ["conductor"]);
  assert.equal(gained.plan.roles.conductor, "alpha/big");
});

// Anthropic ships Fable as the tier ABOVE Opus, and both are on record
// shipping identical reasoning/context/output ceilings — the exact shape that
// used to fall through to comparing selector strings, which only landed on
// the right answer (fable, since "f" < "o") by accident. These pin the real
// ladder explicitly, including pairs where alphabetical order gives the
// WRONG model: "haiku" sorts before both "opus" and "sonnet", so a fix that
// merely restored the old fallback would still fail those two.
test("Anthropic's own tiers break a full tie: fable > opus > sonnet > haiku", () => {
  const tiedFlagship = (selector) => model(selector, { contextWindow: 1_000_000, maxTokens: 128_000 });
  const roster = [
    tiedFlagship("anthropic/claude-fable-5-1"),
    tiedFlagship("anthropic/claude-opus-5"),
    tiedFlagship("anthropic/claude-sonnet-5"),
    tiedFlagship("anthropic/claude-haiku-5"),
  ];

  assert.equal(bestAvailableModel(roster).selector, "anthropic/claude-fable-5-1");
  assert.equal(bestAvailableModel(roster.filter((m) => !m.selector.includes("fable"))).selector, "anthropic/claude-opus-5");
  // Opus vs haiku: alphabetically "haiku" < "opus", so the old selector
  // tie-break would have picked haiku here — the case that actually proves
  // the fix, not just the fable/opus case the alphabet already got right.
  assert.equal(
    bestAvailableModel([tiedFlagship("anthropic/claude-opus-5"), tiedFlagship("anthropic/claude-haiku-5")]).selector,
    "anthropic/claude-opus-5",
  );
  // Sonnet vs haiku: same trap ("haiku" < "sonnet" alphabetically).
  assert.equal(
    bestAvailableModel([tiedFlagship("anthropic/claude-sonnet-5"), tiedFlagship("anthropic/claude-haiku-5")]).selector,
    "anthropic/claude-sonnet-5",
  );
});

test("the Anthropic tier ladder covers real-world id shapes, not just the bare form", () => {
  const tiedFlagship = (selector) => model(selector, { contextWindow: 1_000_000, maxTokens: 128_000 });
  // Bedrock's dotted-vendor-prefix id and Vertex's @-suffixed id, kept on one
  // shared provider so the unrelated gateway/direct/local tier ranking (which
  // `bestAvailableModel` applies BEFORE capability) ties and family actually
  // gets to decide the outcome.
  const dotted = [
    tiedFlagship("multiregion/anthropic.claude-opus-4-8-v1:0"),
    tiedFlagship("multiregion/claude-fable-5-1@default"),
  ];
  assert.equal(bestAvailableModel(dotted).selector, "multiregion/claude-fable-5-1@default");

  // OpenRouter's real nested-vendor-path spelling ("anthropic/claude-…" as
  // the id itself) — both entries carry a slash in their id, so the
  // aggregator heuristic in gatewayProviders applies evenly to both and the
  // tier term still ties, isolating the family signal the same way.
  const openrouter = [
    tiedFlagship("openrouter/anthropic/claude-opus-5"),
    tiedFlagship("openrouter/anthropic/claude-fable-5.1"),
  ];
  assert.equal(bestAvailableModel(openrouter).selector, "openrouter/anthropic/claude-fable-5.1");
});

test("an unrecognized family contributes no signal and falls through unaffected", () => {
  // A future Anthropic tier this table has never heard of must not be ranked
  // ahead of OR behind fable/opus/sonnet/haiku by guesswork — it defers to
  // the untouched fallback (context window, then the selector) exactly as an
  // unrelated vendor would.
  const roster = [
    model("anthropic/claude-fable-5-1", { contextWindow: 1_000_000, maxTokens: 128_000 }),
    model("anthropic/claude-future-tier-9", { contextWindow: 2_000_000, maxTokens: 128_000 }),
  ];
  assert.equal(bestAvailableModel(roster).selector, "anthropic/claude-future-tier-9", "a strictly bigger context window still wins when neither side of THIS signal applies");

  // Fully tied too: falls all the way back to the selector, same as before
  // this module knew any vendor's family names.
  const tied = [
    model("anthropic/claude-fable-5-1", { contextWindow: 1_000_000, maxTokens: 128_000 }),
    model("anthropic/claude-future-tier-9", { contextWindow: 1_000_000, maxTokens: 128_000 }),
  ];
  assert.equal(bestAvailableModel(tied).selector, "anthropic/claude-fable-5-1", "alphabetical fallback, unrelated to any family ranking");
});
