import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { ModelCatalogEntry } from "./model-catalog";
import { invalidateModelsCache } from "./models-cache";
import { loadModelsDevCatalog } from "./models-dev";
import { bundledModelKey, readBundledModelKeys } from "./omp/bundled-catalog";
import { readModelsConfigFile, writeModelsConfig, type ModelsFileConfig } from "./omp/models-config";
import { getAgentDir } from "./omp/paths";
import { disposeUtilityRpc } from "./omp/rpc-utility";
import { isRecord } from "./type-guards";

/**
 * Prices for models omp has no price for yet, from models.dev.
 *
 * omp prices every turn from the catalog bundled with the installed version.
 * A model that appears before omp's next release — reached through runtime
 * discovery (a ChatGPT subscription listing a new GPT, an OpenRouter or
 * Copilot roster) — is priced at zero until that release, so every turn on
 * it reads as free. models.dev usually lists it the day it ships.
 *
 * The fill writes models.dev's rate into omp's `models.yml`
 * (`providers.<id>.modelOverrides.<model>.cost`), the same channel as the
 * Alibaba overlay, so omp itself keeps doing the cost math everywhere. It is
 * deliberately narrow:
 *
 * - only a model with NO price (every rate zero or absent) that omp's
 *   bundled catalog does not list. A model omp lists at zero is omp's own
 *   decision (a prepaid plan, a free tier) and is left alone;
 * - only an EXACT models.dev match on the same provider and model id — or a
 *   declared alias (`PRICE_PROVIDER_ALIASES`) — with a real, nonzero rate;
 * - never over a price, custom model definition, or non-price model override
 *   already in models.yml. An explicit free models.dev listing also wins over
 *   an aliased paid rate. Every value Cody writes is
 *   recorded in a ledger (`cody-price-fill.json` in the instance data dir);
 *   if the file no longer holds exactly that value, the user changed it and
 *   Cody lets that model go for good;
 * - handed back: once omp's bundled catalog lists the model (an omp update),
 *   Cody removes its value so omp's own price applies again.
 *
 * models.yml's `cost` override takes four flat rates, so a long-context tier
 * (a higher rate above some prompt size) is not carried: turns over that size
 * are under-priced until omp ships the model.
 */

export interface FlatCost { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** One model in the effective catalog, as `/api/models` lists it: `unpriced`
 *  when omp reports every rate as zero or absent. */
export interface CatalogModel { provider?: string; id?: string; unpriced?: boolean }

/** `released`: the user changed Cody's cost or added manual model configuration.
 *  Kept as a tombstone so Cody never writes a price for that model again.
 *  `freeListed`: models.dev explicitly lists the model as free; Cody removed its
 *  old automatic cost, but keeps watching the direct listing in case it changes. */
export interface PriceFillLedgerEntry { provider: string; modelId: string; cost: FlatCost; source: string; writtenAt: string; released?: boolean; freeListed?: true }
export type PriceFillLedger = Record<string, PriceFillLedgerEntry>;

/**
 * omp provider → models.dev provider, where omp's own bundled catalog prices
 * the one exactly like the other. `openai-codex` (a ChatGPT subscription
 * reaching OpenAI's models) carries OpenAI's API rates in omp's catalog —
 * checked on every model the two share — so a GPT the subscription lists
 * before omp knows it gets OpenAI's published rate, which is what omp will
 * ship. Nothing is aliased on a guess.
 */
export const PRICE_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "openai-codex": "openai",
};

export interface PriceFillWrite { provider: string; modelId: string; cost: FlatCost; source: string }
export interface PriceFillPlan {
  /** Set these costs in models.yml (new models, or a models.dev price that moved). */
  set: PriceFillWrite[];
  /** Remove Cody's cost: omp now prices it, models.dev says free, or the user configured it. */
  remove: { provider: string; modelId: string }[];
  ledger: PriceFillLedger;
}

export interface PriceFillInputs {
  catalog: readonly CatalogModel[];
  /** Whether omp's bundled catalog lists this model. */
  isBundled: (provider: string, modelId: string) => boolean;
  /** models.dev's entry for this exact provider + model id, if any. */
  modelsDev: (provider: string, modelId: string) => ModelCatalogEntry | undefined;
  /** The cost in modelOverrides, or null for an override entry without cost. */
  currentOverride: (provider: string, modelId: string) => unknown;
  /** A user-defined model or non-price override that Cody must leave alone. */
  hasManualModelConfig: (provider: string, modelId: string) => boolean;
  ledger: PriceFillLedger;
  now: Date;
}

export function ledgerKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function positive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** models.dev's flat rate for this model, or undefined when it has no real
 *  one. Cache rates are carried only when models.dev states them: a missing
 *  one is left to omp's default rather than guessed. */
function priceFrom(entry: ModelCatalogEntry | undefined): FlatCost | undefined {
  if (!entry) return undefined;
  const { input, output, cacheRead, cacheWrite } = entry.cost;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!positive(input) && !positive(output)) return undefined;
  return {
    input,
    output,
    ...(typeof cacheRead === "number" ? { cacheRead } : {}),
    ...(typeof cacheWrite === "number" ? { cacheWrite } : {}),
  };
}

export function sameCost(value: unknown, cost: FlatCost): boolean {
  if (!isRecord(value)) return false;
  const keys: (keyof FlatCost)[] = ["input", "output", "cacheRead", "cacheWrite"];
  return Object.keys(value).length === Object.keys(cost).length
    && keys.every((key) => value[key] === cost[key]);
}

function explicitlyFree(entry: ModelCatalogEntry): boolean {
  const { input, output, cacheRead, cacheWrite } = entry.cost;
  return input === 0 && output === 0 && (cacheRead === undefined || cacheRead === 0) && (cacheWrite === undefined || cacheWrite === 0);
}

function lookup(inputs: PriceFillInputs, provider: string, modelId: string): { cost: FlatCost; source: string } | "free" | undefined {
  const directEntry = inputs.modelsDev(provider, modelId);
  if (directEntry) {
    if (explicitlyFree(directEntry)) return "free";
    const direct = priceFrom(directEntry);
    // A provider's own listing takes precedence over an aliased API price,
    // even when the listing has no usable rate yet.
    return direct ? { cost: direct, source: `models.dev:${provider}/${modelId}` } : undefined;
  }
  const alias = PRICE_PROVIDER_ALIASES[provider];
  const aliased = alias ? priceFrom(inputs.modelsDev(alias, modelId)) : undefined;
  return aliased ? { cost: aliased, source: `models.dev:${alias}/${modelId}` } : undefined;
}

/** What to change, decided from the inputs alone. Pure. */
export function planPriceFill(inputs: PriceFillInputs): PriceFillPlan {
  const set: PriceFillWrite[] = [];
  const remove: PriceFillPlan["remove"] = [];
  const ledger: PriceFillLedger = {};
  const writtenAt = inputs.now.toISOString();

  // What Cody already wrote: keep it current, hand it back, or let it go.
  for (const [key, entry] of Object.entries(inputs.ledger)) {
    const { provider, modelId } = entry;
    if (entry.released) {
      ledger[key] = entry;
      continue;
    }
    if (entry.freeListed) {
      // A free listing removed Cody's prior cost. Do not mistake that expected
      // absence for a user deletion, but do honor any config the user added
      // after the removal. Only the direct provider listing may re-enable a
      // cost; an alias must not override a provider's explicit-free decision.
      if (inputs.currentOverride(provider, modelId) !== undefined || inputs.hasManualModelConfig(provider, modelId)) {
        ledger[key] = { ...entry, released: true };
        continue;
      }
      const direct = inputs.modelsDev(provider, modelId);
      const directCost = direct && !explicitlyFree(direct) ? priceFrom(direct) : undefined;
      if (!directCost || inputs.isBundled(provider, modelId)) {
        ledger[key] = entry;
        continue;
      }
      set.push({ provider, modelId, cost: directCost, source: `models.dev:${provider}/${modelId}` });
      ledger[key] = { provider, modelId, cost: directCost, source: `models.dev:${provider}/${modelId}`, writtenAt };
      continue;
    }
    // The file no longer holds exactly what Cody wrote: the user edited or
    // removed it. Their choice stands; Cody never touches this model again.
    if (!sameCost(inputs.currentOverride(provider, modelId), entry.cost)) {
      ledger[key] = { ...entry, released: true };
      continue;
    }
    if (inputs.hasManualModelConfig(provider, modelId)) {
      // The user added a definition or other override fields after Cody's
      // price. Remove only Cody's cost; their model configuration stays.
      remove.push({ provider, modelId });
      ledger[key] = { ...entry, released: true };
      continue;
    }
    if (inputs.isBundled(provider, modelId)) {
      remove.push({ provider, modelId });
      continue;
    }
    const latest = lookup(inputs, provider, modelId);
    if (latest === "free") {
      remove.push({ provider, modelId });
      ledger[key] = { ...entry, freeListed: true };
    } else if (latest && !sameCost(latest.cost, entry.cost)) {
      set.push({ provider, modelId, ...latest });
      ledger[key] = { provider, modelId, ...latest, writtenAt };
    } else {
      // Unchanged, or models.dev stopped listing it: the last known rate is
      // still better than zero.
      ledger[key] = entry;
    }
  }

  for (const model of inputs.catalog) {
    const provider = typeof model.provider === "string" ? model.provider.trim() : "";
    const modelId = typeof model.id === "string" ? model.id.trim() : "";
    if (!provider || !modelId) continue;
    const key = ledgerKey(provider, modelId);
    if (key in inputs.ledger || key in ledger) continue;
    if (model.unpriced !== true) continue;
    if (inputs.isBundled(provider, modelId)) continue;
    if (inputs.hasManualModelConfig(provider, modelId)) continue;
    if (inputs.currentOverride(provider, modelId) !== undefined) continue;
    const found = lookup(inputs, provider, modelId);
    if (!found || found === "free") continue;
    set.push({ provider, modelId, ...found });
    ledger[key] = { provider, modelId, ...found, writtenAt };
  }

  return { set, remove, ledger };
}

/** Apply a plan to a models.yml config. Pure: returns a new config. Only the
 *  `cost` key of each override is touched; an override, `modelOverrides` map
 *  or provider entry left empty by a removal is dropped, so a handback leaves
 *  the file as it was before Cody wrote to it. */
export function applyPriceFillPlan(config: ModelsFileConfig, plan: Pick<PriceFillPlan, "set" | "remove">): ModelsFileConfig {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(config.providers ?? {})) providers[id] = isRecord(value) ? { ...value } : {};
  const touched = new Set<string>();
  const overridesOf = (provider: string): Record<string, unknown> => {
    const providerConfig = providers[provider] ?? (providers[provider] = {});
    const overrides = isRecord(providerConfig.modelOverrides) ? { ...providerConfig.modelOverrides } : {};
    providerConfig.modelOverrides = overrides;
    touched.add(provider);
    return overrides;
  };
  for (const { provider, modelId, cost } of plan.set) {
    const overrides = overridesOf(provider);
    const model = isRecord(overrides[modelId]) ? { ...overrides[modelId] } : {};
    overrides[modelId] = { ...model, cost };
  }
  for (const { provider, modelId } of plan.remove) {
    if (!providers[provider]) continue;
    const overrides = overridesOf(provider);
    if (!isRecord(overrides[modelId])) continue;
    const model: Record<string, unknown> = { ...overrides[modelId] };
    delete model.cost;
    if (Object.keys(model).length === 0) delete overrides[modelId];
    else overrides[modelId] = model;
  }
  // Only providers this plan touched are tidied: anything else in the file is
  // the user's, exactly as they wrote it.
  for (const id of touched) {
    const providerConfig = providers[id];
    if (isRecord(providerConfig.modelOverrides) && Object.keys(providerConfig.modelOverrides).length === 0) {
      delete providerConfig.modelOverrides;
    }
    if (Object.keys(providerConfig).length === 0) delete providers[id];
  }
  return { ...config, providers };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const LEDGER_FILE = "cody-price-fill.json";

function ledgerPath(): string {
  return join(getAgentDir(), LEDGER_FILE);
}

function isFlatCost(value: unknown): value is FlatCost {
  return isRecord(value) && typeof value.input === "number" && typeof value.output === "number";
}

export function readPriceFillLedger(path = ledgerPath()): PriceFillLedger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const entries = isRecord(parsed) && isRecord(parsed.entries) ? parsed.entries : {};
    const ledger: PriceFillLedger = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string" || !isFlatCost(value.cost)) continue;
      ledger[key] = {
        provider: value.provider,
        modelId: value.modelId,
        cost: value.cost,
        source: typeof value.source === "string" ? value.source : "models.dev",
        writtenAt: typeof value.writtenAt === "string" ? value.writtenAt : "",
        ...(value.released === true ? { released: true } : {}),
        ...(value.freeListed === true ? { freeListed: true } : {}),
      };
    }
    return ledger;
  } catch {
    return {};
  }
}

function writePriceFillLedger(ledger: PriceFillLedger, path = ledgerPath()): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ version: 1, entries: ledger }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function overrideCost(config: ModelsFileConfig, provider: string, modelId: string): unknown {
  const providerConfig = config.providers?.[provider];
  if (!isRecord(providerConfig) || !isRecord(providerConfig.modelOverrides)) return undefined;
  if (!Object.hasOwn(providerConfig.modelOverrides, modelId)) return undefined;
  const model = providerConfig.modelOverrides[modelId];
  return isRecord(model) ? (model.cost === undefined ? null : model.cost) : null;
}

/** Manual models and non-price override fields are never price-fill targets. */
export function hasManualModelConfig(config: ModelsFileConfig, provider: string, modelId: string): boolean {
  const providerConfig = config.providers?.[provider];
  if (!isRecord(providerConfig)) return false;
  if (Array.isArray(providerConfig.models)
    && providerConfig.models.some((model) => isRecord(model) && model.id === modelId)) return true;
  if (!isRecord(providerConfig.modelOverrides) || !Object.hasOwn(providerConfig.modelOverrides, modelId)) return false;
  const override = providerConfig.modelOverrides[modelId];
  return !isRecord(override) || Object.keys(override).some((key) => key !== "cost");
}

export interface PriceFillResult {
  filled: string[];
  updated: string[];
  handedBack: string[];
  reason?: string;
}

/** One reconcile against the live inputs. Writes models.yml and the ledger
 *  only when something changed. */
export async function fillMissingModelPrices(catalog: readonly CatalogModel[]): Promise<PriceFillResult> {
  const empty: PriceFillResult = { filled: [], updated: [], handedBack: [] };
  // Without omp's own list Cody cannot tell a deliberate zero from a missing
  // price, so it does nothing rather than guess.
  const bundled = readBundledModelKeys();
  if (!bundled) return { ...empty, reason: "omp's bundled catalog could not be read" };
  const entries = await loadModelsDevCatalog();
  // The fetch can take seconds. Read models.yml after it completes so a
  // manual edit made while waiting is part of the plan and is not overwritten.
  const file = readModelsConfigFile();
  if (file.parseError) return { ...empty, reason: file.parseError };
  const byKey = new Map<string, ModelCatalogEntry>();
  for (const entry of entries) byKey.set(`${entry.providerId}\u0000${entry.id}`, entry);

  const ledger = readPriceFillLedger();
  const plan = planPriceFill({
    catalog,
    isBundled: (provider, modelId) => bundled.has(bundledModelKey(provider, modelId)),
    modelsDev: (provider, modelId) => byKey.get(`${provider}\u0000${modelId}`),
    currentOverride: (provider, modelId) => overrideCost(file.config, provider, modelId),
    hasManualModelConfig: (provider, modelId) => hasManualModelConfig(file.config, provider, modelId),
    ledger,
    now: new Date(),
  });

  const ledgerChanged = JSON.stringify(plan.ledger) !== JSON.stringify(ledger);
  if (plan.set.length === 0 && plan.remove.length === 0) {
    if (ledgerChanged) writePriceFillLedger(plan.ledger);
    return empty;
  }
  writeModelsConfig(applyPriceFillPlan(file.config, plan));
  writePriceFillLedger(plan.ledger);
  // The registry — and the shared utility child — loaded models.yml at start.
  invalidateModelsCache();
  disposeUtilityRpc();
  const keyOf = (entry: { provider: string; modelId: string }) => ledgerKey(entry.provider, entry.modelId);
  return {
    filled: plan.set.filter((entry) => !(keyOf(entry) in ledger)).map(keyOf),
    updated: plan.set.filter((entry) => keyOf(entry) in ledger).map(keyOf),
    handedBack: plan.remove.map(keyOf),
  };
}

const FILL_INTERVAL_MS = 30 * 60_000;

declare global {
  var __codyPriceFillState: { lastRunAt: number; inFlight: Promise<PriceFillResult> | null } | undefined;
}

/**
 * Reconcile at most every half hour, in the background, for omp only
 * (models.yml is omp's file). Never throws and never delays the caller: a
 * price is an improvement on zero, not a requirement. `onChanged` runs after
 * models.yml was written, so the caller can restart idle sessions onto it.
 */
export function fillMissingModelPricesInBackground(
  engineId: string,
  catalog: readonly CatalogModel[],
  onChanged?: (result: PriceFillResult) => void | Promise<void>,
): void {
  if (engineId !== "omp" || catalog.length === 0) return;
  const state = (globalThis.__codyPriceFillState ??= { lastRunAt: 0, inFlight: null });
  if (state.inFlight || Date.now() - state.lastRunAt < FILL_INTERVAL_MS) return;
  state.lastRunAt = Date.now();
  state.inFlight = fillMissingModelPrices(catalog)
    .then(async (result) => {
      if (result.filled.length || result.updated.length || result.handedBack.length) await onChanged?.(result);
      return result;
    })
    .catch((error: unknown): PriceFillResult => ({ filled: [], updated: [], handedBack: [], reason: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      state.inFlight = null;
    });
}
