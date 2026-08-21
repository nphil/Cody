import { loadModelsWithCache, withModelRuntimeError, type ModelsData } from "@/lib/models-cache";
import { supportsPriorityFastMode } from "@/lib/fast-mode";
import { getHarness, type HarnessAdapter } from "@/lib/harness";
import { type OmpModel, runUtilityCommand } from "@/lib/omp/rpc-utility";
import { readDisabledProviders } from "@/lib/omp/model-roles";
import { utilityRpcLaunchFor } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// The model registry (omp: auth + models.yml; pi: its own catalog) is global,
// not per-cwd, so one cache entry serves every request — keyed by engine so a
// switch never serves the previous engine's catalog for the TTL.

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

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

async function loadModels(harness: HarnessAdapter): Promise<ModelsData> {
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
    const disabledProviders = readDisabledProviders();
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
    { models: Object.fromEntries(nameMap), modelList, defaultModel, thinkingLevels, connectedProviders },
    undefined,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
};

export async function GET() {
  try {
    const harness = getHarness();
    return Response.json(await loadModelsWithCache(`global:${harness.id}`, () => loadModels(harness)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(withModelRuntimeError(EMPTY_MODELS, message));
  }
}
