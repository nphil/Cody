/**
 * The one shared OpenRouter account read, cached like `lib/usage/cache.ts`.
 *
 * The composer polls this every 90s while someone is looking at the meter, and
 * the Settings drawer reads it too. Both want the same numbers, so N callers
 * cause at most ONE pair of upstream requests per TTL. Pinned on `globalThis`
 * for the same reason the usage cache is: Next.js re-imports modules in dev,
 * and a per-module cache would quietly become one cache per module instance.
 *
 * The TTL is deliberately shorter than the usage cache's 60s. A prepaid
 * balance is the number a user watches while topping up ("did my $10 land?"),
 * and `refresh: true` exists so the top-up flow can bypass the entry entirely
 * rather than waiting out a stale one.
 */
import {
  fetchActivity,
  fetchCredits,
  fetchKeyInfo,
  type OpenRouterActivityDay,
  type OpenRouterCredits,
  type OpenRouterError,
  type OpenRouterKeyInfo,
} from "./api";
import { resolveOpenRouterKey, resolveOpenRouterManagementKey, type OpenRouterKeySource } from "./key";

export const OPENROUTER_CACHE_TTL_MS = 30_000;
/** A failed read is cached briefly too, so an unreachable gateway cannot turn
 * every poll into a fresh 10-second timeout. */
const FAILURE_BACKOFF_MS = 10_000;

/**
 * What Cody knows about the account right now.
 *
 * `available: false` is a VALUE, not an error — exactly as in `UsageSnapshot`.
 * No key configured is a well-formed answer, and the popover hides its credit
 * section on it rather than painting an error over a working composer.
 */
export interface OpenRouterAccountSnapshot {
  available: boolean;
  /** Which store the key came from; null when there is no key. */
  keySource: OpenRouterKeySource | null;
  credits: OpenRouterCredits | null;
  key: OpenRouterKeyInfo | null;
  /** Present only with a management key; null otherwise (never an error). */
  activity: OpenRouterActivityDay[] | null;
  /** True when a management key is configured, so the UI stops offering one
   * and starts showing what it unlocked. */
  hasManagementKey: boolean;
  /** Why `available` is false, or why a part of the snapshot is missing. */
  error: OpenRouterError | null;
  fetchedAt: string;
  /** Served past its TTL because the refresh behind it failed. */
  stale: boolean;
}

interface CacheEntry {
  snapshot: OpenRouterAccountSnapshot;
  expiresAt: number;
}

interface CacheState {
  entry: CacheEntry | null;
  inFlight: Promise<OpenRouterAccountSnapshot> | null;
  /** Bumped by `invalidateOpenRouterAccount`: a read that started before a key
   * changed describes the OLD key and must not be cached when it lands. */
  generation: number;
}

declare global {
  var __codyOpenRouterAccount: CacheState | undefined;
}

function state(): CacheState {
  if (!globalThis.__codyOpenRouterAccount) globalThis.__codyOpenRouterAccount = { entry: null, inFlight: null, generation: 0 };
  return globalThis.__codyOpenRouterAccount;
}

export function unavailableAccount(error: OpenRouterError | null): OpenRouterAccountSnapshot {
  return {
    available: false,
    keySource: null,
    credits: null,
    key: null,
    activity: null,
    hasManagementKey: false,
    error,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

export interface ReadAccountDeps {
  fetcher?: typeof fetch;
  resolveKey?: typeof resolveOpenRouterKey;
  resolveManagementKey?: typeof resolveOpenRouterManagementKey;
}

async function readAccount(deps: ReadAccountDeps = {}): Promise<OpenRouterAccountSnapshot> {
  const resolved = (deps.resolveKey ?? resolveOpenRouterKey)();
  if (!resolved) return unavailableAccount({ code: "no_key", message: "No OpenRouter key is configured." });
  const managementKey = (deps.resolveManagementKey ?? resolveOpenRouterManagementKey)();
  const options = deps.fetcher ? { fetcher: deps.fetcher } : {};

  // Credits and key info are independent reads on the same credential, and
  // the popover shows them together — serializing them would double the
  // latency of the section for no benefit. Activity rides along only when a
  // management key exists, because with an inference key it is a guaranteed
  // 403 and asking anyway would burn a request per poll to learn nothing.
  const [credits, keyInfo, activity] = await Promise.all([
    fetchCredits(resolved.key, options),
    fetchKeyInfo(resolved.key, options),
    managementKey ? fetchActivity(managementKey, options) : Promise.resolve(null),
  ]);

  // The balance is the load-bearing number: without it there is no credit
  // section worth drawing, so its failure is the snapshot's failure. Key info
  // and activity are enrichment — a 403 on either leaves the balance standing.
  if (!credits.ok) {
    return {
      ...unavailableAccount(credits.error),
      keySource: resolved.source,
      hasManagementKey: managementKey !== null,
    };
  }

  return {
    available: true,
    keySource: resolved.source,
    credits: credits.value,
    key: keyInfo.ok ? keyInfo.value : null,
    activity: activity && activity.ok ? activity.value : null,
    hasManagementKey: managementKey !== null,
    // A partial failure is worth reporting, but must not mask the balance.
    error: keyInfo.ok ? null : keyInfo.error,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

export interface GetAccountOptions extends ReadAccountDeps {
  /** Ignore the cached entry and read upstream. The top-up flow uses this:
   * "check my balance now" must never be answered from a 30s-old entry. */
  refresh?: boolean;
}

/** The shared read. Concurrent callers join one upstream request. */
export function getOpenRouterAccount(options: GetAccountOptions = {}): Promise<OpenRouterAccountSnapshot> {
  const cache = state();
  const now = Date.now();
  if (!options.refresh && cache.entry && cache.entry.expiresAt > now) {
    return Promise.resolve(cache.entry.snapshot);
  }
  if (cache.inFlight) return cache.inFlight;

  const previous = cache.entry?.snapshot ?? null;
  const generation = cache.generation;
  const request = readAccount(options)
    .then((snapshot) => {
      // A key changed while this read was out: it describes the old one.
      if (cache.generation !== generation) return snapshot;
      // A failed refresh must not discard a good balance the user can still
      // act on: serve the last one, flagged, exactly as the usage cache does.
      // `no_key` is not a failed refresh but the answer — the key is gone, so
      // its last balance is no longer anyone's to show (it used to be served
      // stale forever after a removal).
      if (!snapshot.available && previous?.available && snapshot.error?.code !== "no_key") {
        const fallback: OpenRouterAccountSnapshot = { ...previous, stale: true, error: snapshot.error };
        cache.entry = { snapshot: fallback, expiresAt: Date.now() + FAILURE_BACKOFF_MS };
        return fallback;
      }
      cache.entry = {
        snapshot,
        expiresAt: Date.now() + (snapshot.available ? OPENROUTER_CACHE_TTL_MS : FAILURE_BACKOFF_MS),
      };
      return snapshot;
    })
    .catch((error: unknown) => {
      // readAccount is built to fail soft; this guards the truly unexpected.
      const snapshot = unavailableAccount({
        code: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      });
      if (cache.generation === generation) cache.entry = { snapshot, expiresAt: Date.now() + FAILURE_BACKOFF_MS };
      return snapshot;
    })
    .finally(() => {
      if (cache.inFlight === request) cache.inFlight = null;
    });

  cache.inFlight = request;
  return request;
}

/** Drop the cached entry — after a key changes, its numbers belong to a
 * different account and must never be shown for the new one. A read already
 * in flight is abandoned too: it would otherwise cache the old key's balance. */
export function invalidateOpenRouterAccount(): void {
  const cache = state();
  cache.generation += 1;
  cache.entry = null;
  cache.inFlight = null;
}
