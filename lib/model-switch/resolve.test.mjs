import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What an agent typed -> exactly one model of the chat's live catalog and one
 * reasoning level that model really has. The contract that matters is the
 * negative one: a phrase that fits several models is ambiguous, never resolved
 * to the likeliest, and a level the model lacks is refused, never rounded.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { looksLikeLevel, modelKey, modelThinkingLevels, resolveModel, resolveThinkingLevel } = await jiti.import("./resolve.ts");

const OPUS_48 = { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh"] } };
const OPUS_47 = { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } };
const SONNET = { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } };
const GPT = { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true, thinking: { efforts: ["minimal", "low", "medium", "high", "xhigh"] } };
const GPT_MINI = { provider: "openai", id: "gpt-5.5-mini", name: "GPT-5.5 mini", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } };
const VIA_ROUTER = { provider: "openrouter", id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8 (via OpenRouter)", reasoning: true, thinking: { efforts: ["low", "high"] } };
const LOCAL = { provider: "local", id: "qwen3-8b", name: "Qwen3 8B", reasoning: false };
const CATALOG = [OPUS_48, OPUS_47, SONNET, GPT, GPT_MINI, VIA_ROUTER, LOCAL];

const keys = (models) => models.map(modelKey);

test("an exact provider/id resolves to that model — also when another provider carries the same id inside its own", () => {
  assert.deepEqual(resolveModel("anthropic/claude-opus-4-8", CATALOG), { kind: "resolved", model: OPUS_48 });
  assert.deepEqual(resolveModel("openrouter/anthropic/claude-opus-4-8", CATALOG), { kind: "resolved", model: VIA_ROUTER });
});

test("case, surrounding space and punctuation do not change which model is meant", () => {
  assert.equal(resolveModel("  ANTHROPIC/Claude-Opus-4-8 ", CATALOG).model, OPUS_48);
  assert.equal(resolveModel("claude-sonnet-4.6", CATALOG).model, SONNET, "4.6 is 4-6 once punctuation is dropped");
  assert.equal(resolveModel("Claude Sonnet 4.6", CATALOG).model, SONNET, "the display name");
  assert.equal(resolveModel("gpt 5.5", CATALOG).model, GPT, "an exact squashed match beats the longer gpt-5.5-mini that also contains it");
});

test("a bare id resolves when one model has it, and the unique fragment of a name resolves too", () => {
  assert.equal(resolveModel("qwen3-8b", CATALOG).model, LOCAL);
  assert.equal(resolveModel("sonnet", CATALOG).model, SONNET);
  assert.equal(resolveModel("opus 4.7", CATALOG).model, OPUS_47);
});

test("a phrase that fits several models answers with all of them and chooses none", () => {
  const byName = resolveModel("opus 4.8", CATALOG);
  assert.equal(byName.kind, "ambiguous");
  assert.deepEqual(keys(byName.candidates), ["anthropic/claude-opus-4-8", "openrouter/anthropic/claude-opus-4-8"]);

  const family = resolveModel("opus", CATALOG);
  assert.equal(family.kind, "ambiguous");
  assert.deepEqual(keys(family.candidates), ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-7", "openrouter/anthropic/claude-opus-4-8"]);

  const sameIdTwice = resolveModel("shared-model", [
    { provider: "alpha", id: "shared-model" },
    { provider: "beta", id: "shared-model" },
  ]);
  assert.equal(sameIdTwice.kind, "ambiguous", "one bare id under two providers is two models, not one");
});

test("the same provider/id listed twice by the engine is one model, not an ambiguity", () => {
  assert.equal(resolveModel("claude-sonnet-4-6", [SONNET, { ...SONNET }]).model, SONNET);
});

test("an unknown name resolves to nothing and offers the nearest models, best first", () => {
  const typo = resolveModel("opuss 4.8", CATALOG);
  assert.equal(typo.kind, "unknown");
  assert.ok(typo.suggestions.length > 0 && typo.suggestions.length <= 5, "a short list of near misses");
  assert.equal(typo.suggestions[0], OPUS_48, "the closest spelling leads");
  assert.ok(typo.suggestions.every((model) => model.id.includes("opus")), `only near misses are offered: ${keys(typo.suggestions)}`);

  const nothingLike = resolveModel("zzzz qqqq", CATALOG);
  assert.deepEqual(nothingLike, { kind: "unknown", suggestions: [] });
  assert.deepEqual(resolveModel("   ", CATALOG), { kind: "unknown", suggestions: [] });
});

test("a model's levels are its own: auto and off plus its efforts, in the composer's order — a model without reasoning has only off", () => {
  assert.deepEqual(modelThinkingLevels(OPUS_48), ["auto", "off", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelThinkingLevels(GPT), ["auto", "off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelThinkingLevels(LOCAL), ["off"]);
  assert.deepEqual(modelThinkingLevels({ provider: "p", id: "m", reasoning: true }), ["auto", "off"], "reasoning with no listed efforts");
  assert.deepEqual(modelThinkingLevels({ provider: "p", id: "m", reasoning: true, thinking: { efforts: ["low", "turbo"] } }), ["auto", "off", "low", "turbo"], "a provider-defined level stays");
});

test("a level is accepted in the spellings people use and comes back as the engine's own word", () => {
  assert.deepEqual(resolveThinkingLevel("high", OPUS_48), { ok: true, level: "high" });
  assert.deepEqual(resolveThinkingLevel("  HIGH ", OPUS_48), { ok: true, level: "high" });
  assert.deepEqual(resolveThinkingLevel("extra high", OPUS_48), { ok: true, level: "xhigh" });
  assert.deepEqual(resolveThinkingLevel("x-high", OPUS_48), { ok: true, level: "xhigh" });
  assert.deepEqual(resolveThinkingLevel("extra_high", OPUS_48), { ok: true, level: "xhigh" });
  assert.deepEqual(resolveThinkingLevel("med", OPUS_48), { ok: true, level: "medium" });
  assert.deepEqual(resolveThinkingLevel("none", OPUS_48), { ok: true, level: "off" });
  assert.deepEqual(resolveThinkingLevel("min", GPT), { ok: true, level: "minimal" });
  assert.deepEqual(resolveThinkingLevel("auto", OPUS_48), { ok: true, level: "auto" });
});

test("a level the model lacks is refused with the levels it has — never rounded to a neighbour", () => {
  const noMax = resolveThinkingLevel("max", OPUS_48);
  assert.deepEqual(noMax, { ok: false, valid: ["auto", "off", "low", "medium", "high", "xhigh"] });
  assert.deepEqual(resolveThinkingLevel("minimal", OPUS_48), { ok: false, valid: modelThinkingLevels(OPUS_48) });
  assert.deepEqual(resolveThinkingLevel("high", LOCAL), { ok: false, valid: ["off"] }, "a model without reasoning takes only off");
  assert.deepEqual(resolveThinkingLevel("off", LOCAL), { ok: true, level: "off" });
  assert.deepEqual(resolveThinkingLevel("", OPUS_48), { ok: false, valid: modelThinkingLevels(OPUS_48) });
  assert.deepEqual(resolveThinkingLevel("banana", OPUS_48), { ok: false, valid: modelThinkingLevels(OPUS_48) });
});

test("a trailing word that is a reasoning level is recognised, so a level typed into the model name can be pointed out", () => {
  for (const word of ["high", "xhigh", "extra high", "none", "Med", "auto", "off", "max"]) assert.equal(looksLikeLevel(word), true, word);
  for (const word of ["opus", "4.8", "sonnet", ""]) assert.equal(looksLikeLevel(word), false, word);
});
