import { loadModelsWithCache, withModelRuntimeError, type ModelsData } from "@/lib/models-cache";
import { supportsPriorityFastMode } from "@/lib/fast-mode";
import { requireEngine } from "@/lib/engine-guard";
import { getHarness, type HarnessAdapter } from "@/lib/harness";
import { compareModelEntries, loadFullCatalog } from "@/lib/model-catalog-full";
import { type OmpModel, runUtilityCommand } from "@/lib/omp/rpc-utility";
import { readDisabledProviders } from "@/lib/omp/model-roles";
import { utilityRpcLaunchFor } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// The model registry (omp: auth + models.yml; pi: its own catalog) is global,
// not per-cwd, so one cache entry serves every request — keyed by engine so a
// switch never serves the previous engine's catalog for the TTL.

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

/**
 * The sessionless catalog of an rpc-dialect engine (omp, pi).
 *
 * `utilityRpcLaunchFor` is the whole dispatch: it answers `undefined` for omp
 * and ONLY for omp (rpc-utility's default path spawns the installed omp), a
 * real launch for another rpc-dialect engine, and throws `unsupported` for an
 * engine that speaks neither. It used to answer `undefined` for that last
 * case as well, which is how this route served omp's 150-model catalog as
 * Claude Code's. GET() never calls this for such an engine now, and the throw
 * is the backstop if a future caller forgets.
 */
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

const EMPTY_MODELS: ModelsData = {
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
 * `get_state`. There is nothing for this route to read, and the ONE thing it
 * must never do is hand back the catalog of whatever engine happens to be
 * installed beside the active one.
 *
 * Empty, and NOT an error: `modelError` is a promise that something broke,
 * and nothing has. `catalogSource: "session"` tells the client where the
 * models actually live.
 */
const SESSION_SCOPED_MODELS: ModelsData = { ...EMPTY_MODELS, catalogSource: "session" };

export async function GET(req: Request) {
  try {
    // Curation asks for the full catalog explicitly. Nothing else does: the
    // main UI only ever needs the models a session can actually use.
    const searchParams = new URL(req.url).searchParams;
    if (searchParams.get("catalog") === "full") {
      // Curation edits omp's `enabledModels`; the UNRESTRICTED read behind
      // loadFullCatalog (lib/model-catalog-full.ts) is omp's own --config
      // overlay mechanism. Nothing about it means anything on another
      // engine, so it refuses rather than spawning omp behind one.
      const gate = requireEngine("omp", "The unrestricted model catalog");
      if ("response" in gate) return gate.response;
      // Cached for an hour (an isolated omp child per read is the expensive
      // part); `refresh=1` is for the caller that knows the registry changed
      // behind the cache — an engine update.
      return Response.json({ modelList: await loadFullCatalog({ refresh: searchParams.get("refresh") === "1" }) });
    }
    const harness = getHarness();
    // Dispatch on the ACTIVE engine, before anything can spawn a child. An
    // engine that does not speak the rpc dialect has no global catalog: it
    // gets an honest empty one, never a neighbour's.
    if (!harness.rpcUi) return Response.json(SESSION_SCOPED_MODELS);
    // No allow-list filtering here on purpose: OMP already applied
    // `enabledModels` to this response, using glob semantics Cody must not
    // reimplement (see lib/model-allow-list.ts). What arrives IS the effective
    // set, so the Composer picker, model roles, and fallback chains all shrink
    // to the user's selection with no client-side work.
    return Response.json(await loadModelsWithCache(`global:${harness.id}`, () => loadModels(harness)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(withModelRuntimeError(EMPTY_MODELS, message));
  }
}
