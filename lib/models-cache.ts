export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; supportsFastMode?: boolean; contextWindow?: number }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  connectedProviders?: { id: string; name: string; disabled: boolean }[];
  modelError?: string;
  /**
   * Where the ACTIVE engine's pickable models actually come from.
   *
   * "global" — a sessionless catalog, which is what `modelList` here IS
   * (omp, pi: `get_available_models` on a `--no-session` utility child).
   *
   * "session" — the engine only offers models INSIDE a live session, so
   * `modelList` is empty by design and the models are in the session's own
   * `get_state`. ACP is the case: model selection is a session config option
   * the agent reports at `session/new`.
   *
   * The distinction exists because the two look identical from the client —
   * an empty list — and the difference between "this engine has no models"
   * and "ask the session" is the difference between a hidden picker and a
   * working one.
   */
  catalogSource?: "global" | "session";
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);

  const load = state.inFlight.get(cwd) ?? startModelsLoad(state, cwd, loader);

  if (cached) {
    // Stale-while-revalidate: serve the expired entry immediately while the
    // refresh runs in the background. Staleness here only ever means TTL age —
    // invalidateModelsCache() (login, set_model, models.yml writes) clears
    // entries outright, so mutations never serve through this path.
    load.catch(() => {
      // A failed background refresh keeps serving the stale entry; the next
      // request retries.
    });
    return Promise.resolve(cached.data);
  }
  return load;
}

function startModelsLoad(
  state: ModelsCacheState,
  cwd: string,
  loader: () => Promise<ModelsData>,
): Promise<ModelsData> {
  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        // Expired entries are kept (they back stale-while-revalidate serving);
        // the entry cap alone bounds the map.
        state.entries.delete(cwd);
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
