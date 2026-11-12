import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  chooseScheduleModel,
  findScheduleModel,
  groupScheduleModels,
  sameScheduleModel,
  scheduleModelKey,
  scheduleModelText,
  scheduleReasoningLevels,
  searchScheduleModels,
  withScheduleReasoning,
} = await jiti.import("./model-ui.ts");

const t = (key) => key;

const OPUS = { provider: "anthropic", modelId: "claude-opus-4-8", name: "Opus 4.8" };
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-5-5", name: "Sonnet 5.5" };
const GPT = { provider: "openai-codex", modelId: "gpt-5.2-codex", name: "GPT-5.2 Codex" };
const OPTIONS = [OPUS, SONNET, GPT];

const catalog = {
  all: OPTIONS,
  levels: {
    "anthropic:claude-opus-4-8": ["off", "low", "medium", "high"],
    "anthropic:claude-sonnet-5-5": ["off"],
    "openai-codex:gpt-5.2-codex": ["off", "low", "high"],
  },
};

test("scheduleModelKey / sameScheduleModel / findScheduleModel agree on what one model is", () => {
  assert.equal(scheduleModelKey(OPUS), "anthropic/claude-opus-4-8");
  assert.equal(sameScheduleModel(OPUS, { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "high" }), true);
  assert.equal(sameScheduleModel(OPUS, SONNET), false);
  assert.equal(sameScheduleModel(OPUS, null), false);
  assert.equal(sameScheduleModel(undefined, null), false);
  assert.deepEqual(findScheduleModel(catalog, { provider: "openai-codex", modelId: "gpt-5.2-codex", thinkingLevel: "low" }), GPT);
  assert.equal(findScheduleModel(catalog, { provider: "anthropic", modelId: "gone" }), null);
  assert.equal(findScheduleModel(catalog, null), null);
});

test("searchScheduleModels: an empty phrase finds everything, in the catalog's order", () => {
  assert.deepEqual(searchScheduleModels(OPTIONS, ""), OPTIONS);
  assert.deepEqual(searchScheduleModels(OPTIONS, "   "), OPTIONS);
  assert.notEqual(searchScheduleModels(OPTIONS, ""), OPTIONS, "a copy: the caller may sort it");
});

test("searchScheduleModels: every word has to appear in the provider, the id or the display name", () => {
  assert.deepEqual(searchScheduleModels(OPTIONS, "opus 4.8"), [OPUS], "a display name's words find the dashed id");
  assert.deepEqual(searchScheduleModels(OPTIONS, "OPUS"), [OPUS], "case does not matter");
  assert.deepEqual(searchScheduleModels(OPTIONS, "claude"), [OPUS, SONNET], "the id counts");
  assert.deepEqual(searchScheduleModels(OPTIONS, "anthropic"), [OPUS, SONNET], "so does the provider");
  assert.deepEqual(searchScheduleModels(OPTIONS, "anthropic/sonnet"), [SONNET], "provider/model reads as two words");
  assert.deepEqual(searchScheduleModels(OPTIONS, "codex gpt"), [GPT], "word order does not matter");
  assert.deepEqual(searchScheduleModels(OPTIONS, "opus sonnet"), [], "every word must match");
  assert.deepEqual(searchScheduleModels(OPTIONS, "nothing like it"), []);
});

test("searchScheduleModels: punctuation is no obstacle either way", () => {
  assert.deepEqual(searchScheduleModels(OPTIONS, "gpt5.2"), [GPT], "letters and digits run together");
  assert.deepEqual(searchScheduleModels(OPTIONS, "gpt-5.2"), [GPT]);
  assert.deepEqual(searchScheduleModels(OPTIONS, "sonnet-5-5"), [SONNET]);
  assert.deepEqual(searchScheduleModels(OPTIONS, "???"), [], "a phrase with no letters or digits matches nothing");
});

test("groupScheduleModels: one group per provider, providers in first-seen order, models as given", () => {
  const groups = groupScheduleModels([OPUS, GPT, SONNET]);
  assert.deepEqual(groups.map((group) => group.id), ["provider:anthropic", "provider:openai-codex"]);
  assert.deepEqual(groups[0].options, [OPUS, SONNET]);
  assert.deepEqual(groups[1].options, [GPT]);
  assert.deepEqual(groupScheduleModels([]), []);
});

test("scheduleReasoningLevels: the model's own ladder, Auto first; a model with no real choice offers none", () => {
  assert.deepEqual(scheduleReasoningLevels(catalog, OPUS), ["auto", "off", "low", "medium", "high"]);
  assert.deepEqual(scheduleReasoningLevels(catalog, GPT), ["auto", "off", "low", "high"]);
  assert.deepEqual(scheduleReasoningLevels(catalog, SONNET), [], "only Off: nothing to choose");
  assert.deepEqual(scheduleReasoningLevels(catalog, { provider: "x", modelId: "unknown" }), [], "no ladder known");
  assert.deepEqual(scheduleReasoningLevels(catalog, null), []);
  assert.deepEqual(scheduleReasoningLevels({ levels: {} }, OPUS), []);
});

test("chooseScheduleModel: the same model keeps a level it offers; another model never inherits the old one", () => {
  const high = { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "high" };
  assert.deepEqual(chooseScheduleModel(catalog, high, OPUS), high, "the same model: the level stays");
  assert.deepEqual(chooseScheduleModel(catalog, high, GPT), { provider: "openai-codex", modelId: "gpt-5.2-codex" }, "another model: Default");
  assert.deepEqual(chooseScheduleModel(catalog, null, OPUS), { provider: "anthropic", modelId: "claude-opus-4-8" });
  const stale = { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "xhigh" };
  assert.deepEqual(chooseScheduleModel(catalog, stale, OPUS), { provider: "anthropic", modelId: "claude-opus-4-8" }, "a level the model does not offer is dropped");
  assert.deepEqual(chooseScheduleModel(catalog, { provider: "anthropic", modelId: "claude-opus-4-8" }, OPUS), { provider: "anthropic", modelId: "claude-opus-4-8" });
});

test("withScheduleReasoning: a level is added, Default (null) takes it away, and nothing else rides along", () => {
  const base = { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low", extra: "ignored" };
  assert.deepEqual(withScheduleReasoning(base, "high"), { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "high" });
  assert.deepEqual(withScheduleReasoning(base, null), { provider: "anthropic", modelId: "claude-opus-4-8" });
});

test("scheduleModelText: the catalog's name (the id when it has none) with the level in words", () => {
  assert.deepEqual(scheduleModelText({ provider: "anthropic", modelId: "claude-opus-4-8" }, "Opus 4.8", t), { name: "Opus 4.8", level: null, text: "Opus 4.8" });
  assert.deepEqual(
    scheduleModelText({ provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "high" }, "Opus 4.8", t),
    { name: "Opus 4.8", level: "chatInput.reasoningLevelHigh", text: "Opus 4.8 · chatInput.reasoningLevelHigh" },
  );
  assert.equal(scheduleModelText({ provider: "x", modelId: "model-id" }, null, t).text, "model-id");
  assert.equal(scheduleModelText({ provider: "x", modelId: "model-id" }, "  ", t).text, "model-id");
  assert.equal(scheduleModelText({ provider: "x", modelId: "model-id", thinkingLevel: "bespoke" }, "Name", t).text, "Name · bespoke", "a level this build has no label for is shown as it is");
});
