/**
 * The EFFECTIVE model catalog of an rpc-dialect engine (omp, pi): what a
 * session can actually pick, read sessionless from the engine's own
 * `get_available_models` on the shared utility child. `GET /api/models`
 * serves it to the composer; `GET /api/providers` counts it per provider so
 * a row can say "Connected · 149 models". One loader, one cache key, so the
 * two never disagree about which models exist.
 *
 * Extracted from the models route so the providers route could share it
 * without importing a route module.
 */
import { supportsPriorityFastMode } from "./fast-mode";
import type { HarnessAdapter } from "./harness/types";
import { compareModelEntries } from "./model-catalog-full";
import { loadModelsWithCache, peekCatalogCache, withModelRuntimeError, type ModelsData } from "./models-cache";
import { readDisabledProviders } from "./omp/model-roles";
import { type OmpModel, runUtilityCommand } from "./omp/rpc-utility";
import { utilityRpcLaunchFor } from "./rpc-manager";

// "off" is always a valid selector; the concrete efforts come from the model's
// baked thinking metadata (omp: getSupportedEfforts = reasoning ? efforts : []).
// pi's catalog carries a bare `reasoning` boolean with no per-model efforts —
// its set_thinking_level accepts the dialect's global levels for any
// reasoning model, so those are the honest options to offer.
const RPC_DIALECT_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
function thinkingLevelsFor(model: OmpModel, fallbackEfforts: boolean): string[] {
  if (!model.reasoning) return ["off"];
  const efforts = model.thinking?.efforts ?? (fallbackEfforts ? RPC_DIALECT_EFFORTS : []);
  return ["off", ...efforts];
}

export const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  catalogSource: "global",
};

/**
 * What an engine with no sessionless catalog answers.
 *
 * ACP engines (claude, codex, hermes) carry model selection as a per-SESSION
 * config option that only exists once `session/new` has run — see
 * lib/harness/acp-session.ts, which captures it and reports it through
 * `get_state`. There is nothing to read, and the ONE thing this must never
 * do is hand back the catalog of whatever engine happens to be installed
 * beside the active one.
 *
 * Empty, and NOT an error: `modelError` is a promise that something broke,
 * and nothing has. `catalogSource: "session"` tells the client where the
 * models actually live.
 */
export const SESSION_SCOPED_MODELS: ModelsData = { ...EMPTY_MODELS, catalogSource: "session" };

/** The cache key `/api/models` and `/api/providers` share for one engine. */
export function effectiveModelsCacheKey(harness: Pick<HarnessAdapter, "id">): string {
  return `global:${harness.id}`;
}

/**
 * The sessionless catalog of an rpc-dialect engine (omp, pi).
 *
 * `utilityRpcLaunchFor` is the whole dispatch: it answers `undefined` for omp
 * and ONLY for omp (rpc-utility's default path spawns the installed omp), a
 * real launch for another rpc-dialect engine, and throws `unsupported` for an
 * engine that speaks neither. It used to answer `undefined` for that last
 * case as well, which is how the models route served omp's 150-model catalog
 * as Claude Code's. Callers check `harness.rpcUi` before calling this, and
 * the throw is the backstop if a future caller forgets.
 */
export async function loadEffectiveModels(harness: HarnessAdapter): Promise<ModelsData> {
  const launch = utilityRpcLaunchFor(harness);
  // Engines with a restricted RPC vocabulary (pi) must only be sent commands
  // they answer; an unknown command's response cannot settle the request.
  const vocabulary = harness.rpcUi?.commands;
  const fallbackEfforts = harness.id !== "omp";
  const { models: available } = await runUtilityCommand<{ models: OmpModel[] }>(
    { type: "get_available_models" },
    120_000,
    launch,
  );

  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};
  const modelList = available
    .map((model) => ({
      id: model.id,
      // pi catalog entries may omit a display name; the id reads fine.
      name: model.name || model.id,
      provider: model.provider,
      thinkingLevels: thinkingLevelsFor(model, fallbackEfforts),
      supportsFastMode: supportsPriorityFastMode(model),
      ...(typeof model.contextWindow === "number"
        && Number.isFinite(model.contextWindow)
        && model.contextWindow > 0
        ? { contextWindow: model.contextWindow }
        : {}),
    }))
    .sort(compareModelEntries);
  // Provider login state is an omp surface (agent.db credentials); engines
  // without the command manage auth themselves (pi: auth.json / env keys).
  let connectedProviders: Array<{ id: string; name: string; disabled: boolean }> = [];
  if (!vocabulary || vocabulary.has("get_login_providers")) {
    const { providers: loginProviders } = await runUtilityCommand<{ providers: Array<{ id: string; name: string; authenticated: boolean }> }>(
      { type: "get_login_providers" },
      30_000,
      launch,
    );
    // `disabledProviders` is a key of omp's own config.yml. Applying it to
    // another engine's provider list would grey out providers on the strength
    // of a file that engine never reads, so it is read only for omp — the
    // engine whose file it is.
    const disabledProviders = harness.id === "omp" ? readDisabledProviders() : new Set<string>();
    connectedProviders = loginProviders
      .filter((provider) => provider.authenticated)
      .map((provider) => ({ id: provider.id, name: provider.name, disabled: disabledProviders.has(provider.id) }));
  }
  for (const m of available) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name || m.id);
    thinkingLevels[key] = thinkingLevelsFor(m, fallbackEfforts);
  }

  // The engine resolves the default model at session start; a --no-session
  // utility process reports it via get_state.
  let defaultModel: { provider: string; modelId: string } | null = null;
  try {
    const state = await runUtilityCommand<{ model?: { provider?: string; id?: string } }>(
      { type: "get_state" },
      30_000,
      launch,
    );
    const provider = state.model?.provider;
    const modelId = state.model?.id;
    if (provider && modelId && available.some((m) => m.provider === provider && m.id === modelId)) {
      defaultModel = { provider, modelId };
    }
  } catch {
    // Default model is cosmetic — the models list is still useful without it.
  }

  return withModelRuntimeError(
    { models: Object.fromEntries(nameMap), modelList, defaultModel, thinkingLevels, connectedProviders, catalogSource: "global" },
    undefined,
  );
}

/** The effective catalog through the 60 s cache: what `/api/models` serves. */
export function loadEffectiveModelsCached(harness: HarnessAdapter, options?: { refresh?: boolean }): Promise<ModelsData> {
  return loadModelsWithCache(effectiveModelsCacheKey(harness), () => loadEffectiveModels(harness), options);
}

/**
 * The cached catalog when the cache holds one (fresh or expired), else
 * undefined — WITHOUT loading anything. `GET /api/providers?cached=1` paints
 * the rail's status line from this: a status line must never spawn an
 * engine child.
 */
export function peekEffectiveModels(harness: Pick<HarnessAdapter, "id">): ModelsData | undefined {
  return peekCatalogCache<ModelsData>(effectiveModelsCacheKey(harness));
}

/** Models per provider id, from any catalog shape that carries a modelList. */
export function countModelsByProvider(models: Pick<ModelsData, "modelList">): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const model of models.modelList) counts[model.provider] = (counts[model.provider] ?? 0) + 1;
  return counts;
}
