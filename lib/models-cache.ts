export interface ModelsData {
  models: Record<string, string>;
  /** `unpriced`: omp reports every rate as zero or absent — a local model, a
   *  free tier, or a model omp's catalog does not know yet
   *  (lib/model-price-fill.ts decides which). Not set when omp 18.4.5+ tags the
   *  zeros deliberate (`pricingStatus` free/included/variable); that tag is
   *  rare on the wire, so the bundled-catalog judgement still does most work. */
  modelList: { id: string; name: string; provider: string; supportsFastMode?: boolean; contextWindow?: number; unpriced?: true }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  connectedProviders?: { id: string; name: string; disabled: boolean }[];
  modelError?: string;
  /**
   * Set when `modelError` is the engine saying it has no credentials, rather
   * than something breaking. The engine answers in its own CLI's terms — omp
   * says "Use /login or set an API key environment variable … Or create
   * <agent dir>/models.yml" — and none of those are how a Cody user fixes
   * it: there is no slash command to type, and hand-writing models.yml is
   * the last resort, not the first step. The client renders its OWN sentence
   * for this code, pointing at Settings › Providers.
   */
  modelErrorCode?: "no_credentials";
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

/**
 * "No models" because nothing is signed in is not a fault — it is the state
 * every fresh install starts in, and the only useful reply names the panel
 * that fixes it. Matched on what the engine actually says (omp: "No models
 * available. Use /login or set an API key environment variable"), loosely
 * enough to survive a rewording: a miss simply shows the engine's text, as
 * before.
 */
export function classifyModelError(message: string): ModelsData["modelErrorCode"] {
	const text = message.toLowerCase();
	if (text.includes("no models available")) return "no_credentials";
	if (text.includes("set an api key") || text.includes("api key environment variable")) return "no_credentials";
	return undefined;
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
	if (!modelError) return data;
	const modelErrorCode = classifyModelError(modelError);
	return modelErrorCode ? { ...data, modelError, modelErrorCode } : { ...data, modelError };
}

export interface CatalogCacheOptions {
  /** How long a fresh entry is served without a reload. Default 60 s. */
  ttlMs?: number;
  /** Skip the stored entry (fresh or stale) and load now. An in-flight load
   * for the same key is joined rather than duplicated. */
  refresh?: boolean;
}

/**
 * The stored entry under `key` when one exists — fresh OR expired — without
 * loading anything. The rail, the composer footer and the post-install toast
 * paint from this: a status line must never start an engine child, so a cold
 * cache is answered as "pending" by the caller rather than filled here. An
 * expired entry is still returned because the stale-while-revalidate serving
 * path treats it as the current answer too.
 */
export function peekCatalogCache<T>(key: string): T | undefined {
  const entry = getModelsCacheState().entries.get(key);
  return entry ? (entry.data as T) : undefined;
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
