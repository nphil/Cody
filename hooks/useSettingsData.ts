"use client";

/**
 * The settings dialog's route cache. Every panel and every rail row reads
 * `/api/...` through `useSettingsRoute`, so the same body serves the Providers
 * status line, the panel that opens next and the search index, and one
 * in-flight request answers every hook that asked while it was pending.
 *
 * Three rules the rest of the shell relies on:
 *   - an `{code:"unsupported"}` answer is CACHED as a value: the section hides
 *     and nothing retries a route the active engine has refused;
 *   - `invalidateSettingsRoutes(prefix)` marks entries stale and every mounted
 *     hook re-fetches, while the stale body keeps rendering (no flash);
 *   - a write never touches this cache directly except through
 *     `setSettingsRouteData` (the optimistic value) and invalidation — the
 *     config writer (`hooks/useConfigWriter`) does both.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

export const UNSUPPORTED_CODE = "unsupported";

export interface RouteEntry<T = unknown> {
  data: T | null;
  error: string | null;
  unsupported: boolean;
  loading: boolean;
  /** Epoch ms of the last successful or failed fetch; 0 = never fetched. */
  fetchedAt: number;
  /** Bumped by invalidation so subscribers re-run their fetch effect. */
  version: number;
  stale: boolean;
}

const EMPTY_ENTRY: RouteEntry = { data: null, error: null, unsupported: false, loading: false, fetchedAt: 0, version: 0, stale: false };

const cache = new Map<string, RouteEntry>();
const inFlight = new Map<string, Promise<RouteEntry>>();
// Per-route request counter: a response from a superseded request (a forced
// reload overtook it) must not overwrite the newer body.
const requestSeq = new Map<string, number>();
const listeners = new Set<() => void>();
// Bumped on every cache mutation: the multi-route hook's snapshot key.
let cacheGeneration = 0;

function notify(): void {
  cacheGeneration += 1;
  listeners.forEach((listener) => listener());
}

function entryOf(route: string): RouteEntry {
  return cache.get(route) ?? EMPTY_ENTRY;
}

function update(route: string, patch: Partial<RouteEntry>): RouteEntry {
  const next = { ...entryOf(route), ...patch };
  cache.set(route, next);
  notify();
  return next;
}

export function subscribeSettingsRoutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached body of a route, or null — never triggers a fetch. */
export function readSettingsRoute<T>(route: string): T | null {
  return (entryOf(route).data as T | null) ?? null;
}

export function readSettingsRouteEntry<T>(route: string): RouteEntry<T> {
  return entryOf(route) as RouteEntry<T>;
}

/** Replace a route's body without a fetch — the optimistic value after a
 * write, so a toggle reads back what was just chosen. */
export function setSettingsRouteData<T>(route: string, data: T): void {
  update(route, { data, error: null, unsupported: false, stale: false });
}

function matches(route: string, prefix: string, exact: boolean): boolean {
  if (exact) return route === prefix || route.startsWith(`${prefix}?`);
  return route === prefix || route.startsWith(`${prefix}/`) || route.startsWith(`${prefix}?`);
}

/** Mark every cached route under `prefix` stale. Mounted hooks re-fetch;
 * unmounted entries re-fetch on their next mount. Bodies stay readable in
 * the meantime. `exact` limits it to the one route (plus its query variants)
 * so invalidating `/api/omp-settings` need not reload `/api/omp-settings/schema`. */
export function invalidateSettingsRoutes(prefix: string, opts?: { exact?: boolean }): void {
  let touched = false;
  for (const [route, entry] of cache) {
    if (!matches(route, prefix, opts?.exact ?? false)) continue;
    cache.set(route, { ...entry, stale: true, version: entry.version + 1 });
    touched = true;
  }
  if (touched) notify();
}

/** Tests only: forget everything. */
export function resetSettingsRouteCache(): void {
  cache.clear();
  inFlight.clear();
  requestSeq.clear();
  notify();
}

async function describeFailure(response: Response): Promise<{ message: string; unsupported: boolean }> {
  let body: { error?: unknown; code?: unknown } | null = null;
  try {
    body = (await response.json()) as { error?: unknown; code?: unknown };
  } catch {
    body = null;
  }
  const unsupported = body?.code === UNSUPPORTED_CODE;
  const message = typeof body?.error === "string" && body.error ? body.error : `HTTP ${response.status}`;
  return { message, unsupported };
}

/**
 * Fetch a route into the cache. Concurrent callers share one request;
 * `force` re-fetches even when the entry is fresh. Resolves to the settled
 * entry (never rejects: the error lives in the entry).
 */
export function fetchSettingsRoute<T = unknown>(route: string, opts?: { force?: boolean }): Promise<RouteEntry<T>> {
  const pending = inFlight.get(route);
  if (pending && !opts?.force) return pending as Promise<RouteEntry<T>>;
  update(route, { loading: true });
  const seq = (requestSeq.get(route) ?? 0) + 1;
  requestSeq.set(route, seq);
  const holder: { promise: Promise<RouteEntry> | null } = { promise: null };
  const settle = (patch: Partial<RouteEntry>): RouteEntry => (requestSeq.get(route) === seq ? update(route, patch) : entryOf(route));
  const request = (async (): Promise<RouteEntry> => {
    try {
      const response = await fetch(route, { cache: "no-store" });
      if (!response.ok) {
        const { message, unsupported } = await describeFailure(response);
        return settle({ loading: false, fetchedAt: Date.now(), stale: false, unsupported, error: unsupported ? null : message, ...(unsupported ? { data: null } : {}) });
      }
      const data = (await response.json()) as unknown;
      return settle({ data, loading: false, fetchedAt: Date.now(), stale: false, unsupported: false, error: null });
    } catch (error) {
      return settle({ loading: false, fetchedAt: Date.now(), stale: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (inFlight.get(route) === holder.promise) inFlight.delete(route);
    }
  })();
  holder.promise = request;
  inFlight.set(route, request);
  return request as Promise<RouteEntry<T>>;
}

const DEFAULT_TTL_MS = 15_000;

/** True when the entry needs (re)fetching: never fetched, invalidated, or
 * older than the ttl. An `unsupported` answer only refetches after an
 * explicit invalidation: the engine said no, and asking again is noise. */
function needsFetch(entry: RouteEntry, ttlMs: number): boolean {
  if (entry.loading) return false;
  if (entry.stale) return true;
  if (entry.unsupported) return false;
  if (entry.fetchedAt === 0) return true;
  return Date.now() - entry.fetchedAt > ttlMs;
}

export interface SettingsRouteResult<T> {
  data: T | null;
  error: string | null;
  unsupported: boolean;
  loading: boolean;
  /** Bumps on every invalidation of this route. */
  version: number;
  reload: () => Promise<RouteEntry<T>>;
}

const getServerSnapshot = () => EMPTY_ENTRY;

/**
 * Read one route through the cache. `enabled: false` (a capability the engine
 * lacks) neither fetches nor errors: data stays null and `loading` false.
 */
export function useSettingsRoute<T = unknown>(route: string | null, opts?: { enabled?: boolean; ttlMs?: number }): SettingsRouteResult<T> {
  const enabled = (opts?.enabled ?? true) && route !== null;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const entry = useSyncExternalStore(
    subscribeSettingsRoutes,
    () => (route ? entryOf(route) : EMPTY_ENTRY),
    getServerSnapshot,
  ) as RouteEntry<T>;

  useEffect(() => {
    if (!enabled || !route) return;
    if (needsFetch(entryOf(route), ttlMs)) void fetchSettingsRoute(route);
    // `entry.version` is the invalidation counter: a bump re-runs this effect
    // and the stale check above re-fetches.
  }, [route, enabled, ttlMs, entry.version]);

  const reload = useCallback(() => {
    if (!route) return Promise.resolve(EMPTY_ENTRY as RouteEntry<T>);
    return fetchSettingsRoute<T>(route, { force: true });
  }, [route]);

  return {
    data: enabled ? entry.data : null,
    error: enabled ? entry.error : null,
    unsupported: enabled ? entry.unsupported : false,
    loading: enabled ? entry.loading : false,
    version: entry.version,
    reload,
  };
}

/**
 * Read several routes at once (the rail's status lines): one subscription,
 * one fetch effect, bodies keyed by route. Routes that answered an error or
 * `unsupported` are simply absent.
 */
export function useSettingsRoutes(routes: readonly string[], opts?: { enabled?: boolean; ttlMs?: number }): Readonly<Record<string, unknown>> {
  const enabled = opts?.enabled ?? true;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const key = routes.join(" ");
  const generation = useSyncExternalStore(subscribeSettingsRoutes, () => cacheGeneration, () => 0);

  useEffect(() => {
    if (!enabled) return;
    for (const route of key ? key.split(" ") : []) {
      if (needsFetch(entryOf(route), ttlMs)) void fetchSettingsRoute(route);
    }
  }, [key, enabled, ttlMs, generation]);

  return useMemo(() => {
    const bodies: Record<string, unknown> = {};
    if (!enabled) return bodies;
    for (const route of key ? key.split(" ") : []) {
      const entry = entryOf(route);
      if (entry.data !== null && !entry.error) bodies[route] = entry.data;
    }
    return bodies;
    // `generation` is the cache's change counter: it is what makes this memo
    // recompute when a body lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, generation]);
}
