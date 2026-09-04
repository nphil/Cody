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
  // One map serves every catalog shape (the effective ModelsData, the
  // unrestricted omp catalog) so invalidateModelsCache() clears them all in
  // one place — a login, set_model or models.yml write drops EVERY view of the
  // registry, never just the one the caller remembered.
  entries: Map<string, { data: unknown; expiresAt: number }>;
  inFlight: Map<string, Promise<unknown>>;
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

export interface CatalogCacheOptions {
  /** How long a fresh entry is served without a reload. Default 60 s. */
  ttlMs?: number;
  /** Skip the stored entry (fresh or stale) and load now. An in-flight load
   * for the same key is joined rather than duplicated. */
  refresh?: boolean;
}

export function loadModelsWithCache(
  cwd: string,
  loader: () => Promise<ModelsData>,
  options?: CatalogCacheOptions,
): Promise<ModelsData> {
  return loadCatalogWithCache<ModelsData>(cwd, loader, options);
}

/**
 * The same cache for any other catalog shape — the unrestricted omp catalog
 * (`full:omp`, 1 h TTL) lives beside the effective `global:<engine>` entries
 * so one invalidation covers both. Keys are namespaced by the caller; a key is
 * one shape, and reading it back as another is the caller's bug.
 */
export function loadCatalogWithCache<T>(
  key: string,
  loader: () => Promise<T>,
  options: CatalogCacheOptions = {},
): Promise<T> {
  const state = getModelsCacheState();
  const ttlMs = options.ttlMs ?? MODELS_CACHE_TTL_MS;
  const cached = options.refresh ? undefined : state.entries.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data as T);

  const load = (state.inFlight.get(key) as Promise<T> | undefined) ?? startModelsLoad(state, key, loader, ttlMs);

  if (cached) {
    // Stale-while-revalidate: serve the expired entry immediately while the
    // refresh runs in the background. Staleness here only ever means TTL age —
    // invalidateModelsCache() (login, set_model, models.yml writes) clears
    // entries outright, so mutations never serve through this path.
    load.catch(() => {
      // A failed background refresh keeps serving the stale entry; the next
      // request retries.
    });
    return Promise.resolve(cached.data as T);
  }
  return load;
}

function startModelsLoad<T>(
  state: ModelsCacheState,
  key: string,
  loader: () => Promise<T>,
  ttlMs: number,
): Promise<T> {
  const generation = state.generation;
  const loadPromise: Promise<T> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(key) === loadPromise) {
        // Expired entries are kept (they back stale-while-revalidate serving);
        // the entry cap alone bounds the map.
        state.entries.delete(key);
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(key, { data, expiresAt: Date.now() + ttlMs });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(key) === loadPromise) state.inFlight.delete(key);
    });

  state.inFlight.set(key, loadPromise);
  return loadPromise;
}
