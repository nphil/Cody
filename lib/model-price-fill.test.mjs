import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyPriceFillPlan, hasManualModelConfig, planPriceFill, readPriceFillLedger } = await jiti.import("./model-price-fill.ts");

const NOW = new Date("2026-09-25T03:00:00.000Z");
const devEntry = (providerId, id, cost) => ({ key: `${providerId}/${id}`, providerId, providerName: providerId, id, name: id, cost });
const MODELS_DEV = [
  devEntry("openai", "gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }),
  devEntry("openrouter", "openai/gpt-6-nova", { input: 3, output: 12 }),
  devEntry("openrouter", "free/model", { input: 0, output: 0 }),
];

function inputs(overrides = {}) {
  const bundled = new Set(overrides.bundled ?? []);
  const yml = overrides.yml ?? {};
  return {
    catalog: overrides.catalog ?? [],
    isBundled: (provider, id) => bundled.has(`${provider}/${id}`),
    modelsDev: (provider, id) => (overrides.modelsDev ?? MODELS_DEV).find((entry) => entry.providerId === provider && entry.id === id),
    currentOverride: (provider, id) => yml[`${provider}/${id}`],
    hasManualModelConfig: overrides.hasManualModelConfig ?? (() => false),
    ledger: overrides.ledger ?? {},
    now: NOW,
  };
}

// The case this exists for: a GPT a ChatGPT subscription lists before omp's
// catalog knows it is priced at zero, and every turn on it reads as free.
test("an unpriced model omp does not list gets models.dev's rate, through a declared alias", () => {
  const plan = planPriceFill(inputs({ catalog: [{ provider: "openai-codex", id: "gpt-6-luna", unpriced: true }] }));
  assert.deepEqual(plan.set, [{
    provider: "openai-codex", modelId: "gpt-6-luna",
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    source: "models.dev:openai/gpt-6-luna",
  }]);
  assert.ok(plan.ledger["openai-codex/gpt-6-luna"]);
});

test("an explicit free listing wins over a paid alias and retires an earlier automatic price", () => {
  const model = { provider: "openai-codex", id: "gpt-6-luna", unpriced: true };
  const directFree = devEntry("openai-codex", "gpt-6-luna", { input: 0, output: 0 });
  const modelsDev = [...MODELS_DEV, directFree];
  const key = "openai-codex/gpt-6-luna";
  const cost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };

  assert.deepEqual(planPriceFill(inputs({ catalog: [model], modelsDev })).set, []);
  assert.deepEqual(planPriceFill(inputs({ catalog: [model], modelsDev: [...MODELS_DEV, devEntry("openai-codex", "gpt-6-luna", {})] })).set, [], "an incomplete direct listing also blocks an alias");

  const ledger = { [key]: { provider: model.provider, modelId: model.id, cost, source: "models.dev:openai/gpt-6-luna", writtenAt: NOW.toISOString() } };
  const plan = planPriceFill(inputs({ catalog: [model], modelsDev, ledger, yml: { [key]: cost } }));
  assert.deepEqual(plan.set, []);
  assert.deepEqual(plan.remove, [{ provider: model.provider, modelId: model.id }]);
  assert.equal(plan.ledger[key].freeListed, true, "the direct free listing remains watched for a future price change");
  assert.equal(plan.ledger[key].released, undefined, "an explicit free listing is not a permanent user override");

  const config = { providers: { "openai-codex": { modelOverrides: { [model.id]: { name: "My model name", cost } } } } };
  assert.deepEqual(applyPriceFillPlan(config, plan), { providers: { "openai-codex": { modelOverrides: { [model.id]: { name: "My model name" } } } } });
  const stillFree = planPriceFill(inputs({ catalog: [model], ledger: plan.ledger, modelsDev }));
  assert.deepEqual(stillFree.set, [], "the paid alias cannot override the still-free direct listing");

  const laterPaid = planPriceFill(inputs({
    catalog: [model],
    ledger: plan.ledger,
    modelsDev: [...MODELS_DEV, devEntry("openai-codex", "gpt-6-luna", { input: 0.2, output: 0.6 })],
  }));
  assert.deepEqual(laterPaid.set, [{
    provider: model.provider, modelId: model.id,
    cost: { input: 0.2, output: 0.6 }, source: "models.dev:openai-codex/gpt-6-luna",
  }]);
  assert.equal(laterPaid.ledger[key].freeListed, undefined);

  const userRestored = planPriceFill(inputs({
    catalog: [model], ledger: plan.ledger, yml: { [key]: cost }, modelsDev: [...MODELS_DEV, devEntry("openai-codex", "gpt-6-luna", { input: 0.2, output: 0.6 })],
  }));
  assert.deepEqual(userRestored.set, [], "a user-added override after the free handback is respected");
  assert.equal(userRestored.ledger[key].released, true);
});

test("the ledger keeps free-listing state across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-price-fill-ledger-"));
  try {
    const ledgerPath = join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ entries: {
      "openai-codex/gpt-6-luna": {
        provider: "openai-codex", modelId: "gpt-6-luna", cost: { input: 0.1, output: 0.5 },
        source: "models.dev:openai/gpt-6-luna", writtenAt: NOW.toISOString(), freeListed: true,
      },
    } }));
    assert.equal(readPriceFillLedger(ledgerPath)["openai-codex/gpt-6-luna"].freeListed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omp's own answer, a price already in models.yml, and a free models.dev entry are all left alone", () => {
  const plan = planPriceFill(inputs({
    catalog: [
      // omp's catalog lists it at zero: a deliberate zero (prepaid plan, free tier).
      { provider: "openai-codex", id: "gpt-6-luna", unpriced: true },
      // omp already has a price for it.
      { provider: "openrouter", id: "openai/gpt-6-nova" },
      // models.dev says free: nothing to add.
      { provider: "openrouter", id: "free/model", unpriced: true },
      // a local endpoint models.dev has never heard of.
      { provider: "llama-swap", id: "qwen3-coder", unpriced: true },
    ],
    bundled: ["openai-codex/gpt-6-luna"],
  }));
  assert.deepEqual(plan.set, []);
  const userSet = planPriceFill(inputs({
    catalog: [{ provider: "openrouter", id: "openai/gpt-6-nova", unpriced: true }],
    yml: { "openrouter/openai/gpt-6-nova": { input: 1, output: 1 } },
  }));
  assert.deepEqual(userSet.set, [], "a price the user wrote is never replaced");
  const manualFree = planPriceFill(inputs({
    catalog: [{ provider: "openrouter", id: "openai/gpt-6-nova", unpriced: true }],
    yml: { "openrouter/openai/gpt-6-nova": { input: 0, output: 0 } },
  }));
  assert.deepEqual(manualFree.set, [], "an intentional zero override is also the user's price");
});

test("a filled price follows models.dev, and is handed back once omp ships the model", () => {
  const written = { input: 3, output: 12 };
  const ledger = { "openrouter/openai/gpt-6-nova": { provider: "openrouter", modelId: "openai/gpt-6-nova", cost: written, source: "models.dev:openrouter/openai/gpt-6-nova", writtenAt: "2026-09-24T00:00:00.000Z" } };
  const yml = { "openrouter/openai/gpt-6-nova": written };

  const moved = planPriceFill(inputs({ ledger, yml, modelsDev: [devEntry("openrouter", "openai/gpt-6-nova", { input: 2.5, output: 10 })] }));
  assert.deepEqual(moved.set.map((entry) => entry.cost), [{ input: 2.5, output: 10 }]);

  const shipped = planPriceFill(inputs({ ledger, yml, bundled: ["openrouter/openai/gpt-6-nova"] }));
  assert.deepEqual(shipped.remove, [{ provider: "openrouter", modelId: "openai/gpt-6-nova" }]);
  assert.deepEqual(shipped.ledger, {}, "omp prices it now; Cody forgets it");
});

test("once the user edits or removes a filled price, Cody never writes that model again", () => {
  const ledger = { "openrouter/openai/gpt-6-nova": { provider: "openrouter", modelId: "openai/gpt-6-nova", cost: { input: 3, output: 12 }, source: "x", writtenAt: "" } };
  const edited = planPriceFill(inputs({ ledger, yml: { "openrouter/openai/gpt-6-nova": { input: 4, output: 12 } } }));
  assert.deepEqual(edited.set, []);
  assert.equal(edited.ledger["openrouter/openai/gpt-6-nova"].released, true);
  const extraField = planPriceFill(inputs({ ledger, yml: { "openrouter/openai/gpt-6-nova": { input: 3, output: 12, billingNote: "manual" } } }));
  assert.deepEqual(extraField.set, []);
  assert.deepEqual(extraField.remove, []);
  assert.equal(extraField.ledger["openrouter/openai/gpt-6-nova"].released, true, "unknown manual cost fields are not discarded");

  // Removed from models.yml, so omp prices it at zero again: still hands off.
  const removed = planPriceFill(inputs({
    ledger: edited.ledger,
    catalog: [{ provider: "openrouter", id: "openai/gpt-6-nova", unpriced: true }],
  }));
  assert.deepEqual(removed.set, []);
  assert.deepEqual(removed.remove, []);
});

test("manual model definitions and non-price overrides are never automatic fill targets", () => {
  const key = "openrouter/openai/gpt-6-nova";
  const model = { provider: "openrouter", id: "openai/gpt-6-nova", unpriced: true };
  const custom = { providers: { openrouter: { models: [{ id: model.id, cost: { input: 0, output: 0 } }] } } };
  const metadataOverride = { providers: { openrouter: { modelOverrides: { [model.id]: { name: "My name" } } } } };
  const managed = { providers: { openrouter: { modelOverrides: { [model.id]: { cost: { input: 3, output: 12 } } } } } };

  assert.equal(hasManualModelConfig(custom, model.provider, model.id), true, "a custom zero-cost model is a deliberate definition");
  assert.equal(hasManualModelConfig(metadataOverride, model.provider, model.id), true);
  assert.equal(hasManualModelConfig(managed, model.provider, model.id), false, "Cody's cost-only override remains manageable");
  for (const config of [custom, metadataOverride]) {
    const plan = planPriceFill(inputs({ catalog: [model], hasManualModelConfig: (provider, id) => hasManualModelConfig(config, provider, id) }));
    assert.deepEqual(plan.set, []);
    assert.deepEqual(plan.ledger, {});
  }

  const cost = { input: 3, output: 12 };
  const existing = { providers: { openrouter: { modelOverrides: { [model.id]: { name: "My name", cost } } } } };
  const ledger = { [key]: { provider: model.provider, modelId: model.id, cost, source: `models.dev:${key}`, writtenAt: NOW.toISOString() } };
  const handback = planPriceFill(inputs({ ledger, yml: { [key]: cost }, hasManualModelConfig: (provider, id) => hasManualModelConfig(existing, provider, id) }));
  assert.deepEqual(handback.remove, [{ provider: model.provider, modelId: model.id }]);
  assert.equal(handback.ledger[key].released, true);
  assert.deepEqual(applyPriceFillPlan(existing, handback), metadataOverride);
});

test("applying a plan touches only managed costs, preserving manual overrides and other settings", () => {
  const original = { providers: {
    openrouter: { modelOverrides: {
      "free/model": { cost: { input: 0, output: 0 }, name: "Always free" },
    } },
    "alibaba-token-plan": { modelOverrides: { "qwen3.8-max": { cost: { input: 2, output: 6 } } } },
  } };
  const set = applyPriceFillPlan(original, { set: [
    { provider: "openrouter", modelId: "openai/gpt-6-nova", cost: { input: 3, output: 12 }, source: "x" },
    { provider: "openai-codex", modelId: "gpt-6-luna", cost: { input: 0.1, output: 0.5 }, source: "x" },
  ], remove: [] });
  assert.deepEqual(set.providers.openrouter.modelOverrides["openai/gpt-6-nova"], { cost: { input: 3, output: 12 } });
  assert.deepEqual(set.providers.openrouter.modelOverrides["free/model"], original.providers.openrouter.modelOverrides["free/model"]);
  assert.deepEqual(set.providers["openai-codex"], { modelOverrides: { "gpt-6-luna": { cost: { input: 0.1, output: 0.5 } } } });

  const back = applyPriceFillPlan(set, { set: [], remove: [
    { provider: "openrouter", modelId: "openai/gpt-6-nova" },
    { provider: "openai-codex", modelId: "gpt-6-luna" },
  ] });
  assert.deepEqual(back, original);
});
