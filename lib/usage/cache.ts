import { listOmpCredentials, type OmpCredentialRow } from "../harness/omp-credentials";
import { applyCredentialBlocks, applyCredentialOrder } from "./credential-order";
import { fetchOmpUsageSnapshot, unavailableUsageSnapshot } from "./omp-usage";
import { ALIBABA_TOKEN_PLAN_PROVIDER, fetchAlibabaTokenPlanUsage, type AlibabaUsageResult } from "./alibaba-usage";
import type { UsageSnapshot } from "./types";

/**
 * The default read: quota numbers, then the credential store's ordering laid
 * over them (see credential-order.ts — it is what keeps the composer and
 * Settings naming the same account "Primary"). The store read is best-effort
 * and adds one helper spawn per cache refresh, not per request; a failure
 * leaves the engine's own ordering exactly as it was.
 *
 * Providers the ENGINE cannot report are merged in here, so every consumer
 * — ring, popup, availability, routing — keeps reading exactly one snapshot.
 * Alibaba's Token Plan is the first: omp has no usage provider for it, but
 * the plan itself reports a 5-hour and a weekly window through Alibaba's
 * own CLI (see alibaba-usage.ts). Its absence is carried as a REASON rather
 * than silence, so the UI can offer to connect it instead of showing a gap.
 */
async function loadUsageSnapshot(): Promise<UsageSnapshot> {
  const [engine, alibaba] = await Promise.all([
    fetchOmpUsageSnapshot(),
    fetchAlibabaTokenPlanUsage().catch((): AlibabaUsageResult => ({ unavailable: true, reason: "failed" })),
  ]);
  let snapshot = engine;
  if (snapshot.available) {
    try {
      const stored = await listOmpCredentials();
      if (stored.available) {
        // Order first (it assigns credentialId), then blocks, which are
        // keyed by that id.
        snapshot = applyCredentialBlocks(applyCredentialOrder(snapshot, stored.credentials), stored.credentials);
        recordCredentialPins(stored.credentials);
      }
    } catch {
      // Ordering is a nicety; quota numbers are the point of this read.
    }
  }
  if ("account" in alibaba) {
    // A provider the engine cannot see still makes the snapshot available:
    // otherwise a machine with only a Token Plan would report "no quota".
    return { ...snapshot, available: true, accounts: [...snapshot.accounts, alibaba.account] };
  }
  return {
    ...snapshot,
    unavailableProviders: [
      ...(snapshot.unavailableProviders ?? []),
      { provider: ALIBABA_TOKEN_PLAN_PROVIDER, reason: alibaba.reason },
    ],
  };
}

/** One stored OAuth credential, addressed by omp's `credential_pin` digest. */
export interface CredentialPinTarget { provider: string; credentialId: number }

declare global {
  var __codyCredentialPinIndex: Map<string, CredentialPinTarget> | undefined;
}

/** Replace the digest → credential index from a fresh credential-store read.
 *  Server-only: the digests identify accounts and never go to the browser. */
function recordCredentialPins(rows: readonly OmpCredentialRow[]): void {
  const index = new Map<string, CredentialPinTarget>();
  for (const row of rows) {
    if (row.pinHash && !row.disabledCause) index.set(row.pinHash, { provider: row.provider, credentialId: row.id });
  }
  globalThis.__codyCredentialPinIndex = index;
}

/** The credential a session's `credential_pin` digest names, from the last
 *  credential-store read — or null when it names none (logged out, or no read
 *  has happened yet). */
export function credentialForPin(hash: string): CredentialPinTarget | null {
  return globalThis.__codyCredentialPinIndex?.get(hash) ?? null;
}

/**
 * The single shared usage read.
 *
 * Quota is account-wide, not per-session: every chat, subagent and poller in the
 * process wants the same numbers. This cache is the invariant that keeps that
 * cheap — N concurrent callers cause exactly ONE `omp usage` spawn, and a warm
 * entry is reused for its whole TTL. Pinned on globalThis because Next.js
 * reloads modules in dev, and a per-module cache would silently multiply into
 * one spawn per module instance.
 *
 * Modeled on lib/models-cache.ts: TTL entry, in-flight dedup, stale-while-
 * revalidate, plus a short backoff so a machine without omp is not re-probed on
 * every request.
 */

interface UsageCacheEntry {
  snapshot: UsageSnapshot;
  storedAt: number;
  expiresAt: number;
}

interface UsageCacheState {
  entry: UsageCacheEntry | null;
  inFlight: Promise<UsageSnapshot> | null;
  generation: number;
}

declare global {
  var __codyUsageCacheState: UsageCacheState | undefined;
}

export const USAGE_CACHE_TTL_MS = 60_000;
/** A failed read is cached too, briefly — otherwise a missing engine turns every
 * request into a fresh process spawn. */
const USAGE_FAILURE_BACKOFF_MS = 10_000;

type UsageLoader = () => Promise<UsageSnapshot>;

export interface GetUsageSnapshotOptions {
  /** Serve a cached entry only while it is younger than this. Never shortens
   * the failure backoff — that exists to protect the spawn path. */
  maxAgeMs?: number;
  /** Loader seam; defaults to the omp CLI read. */
  load?: UsageLoader;
  /**
   * Wait for the refresh instead of taking the stale-while-revalidate path.
   *
   * `stale` is a claim to the user that the numbers may have moved, so it has
   * to mean "we could not get fresh data" — not merely "the entry aged out".
   * A background poll has no render waiting on it and the underlying read hits
   * omp's own cache, so the poller waits; only a refresh that actually fails
   * falls back to the last good entry, and only that is flagged stale.
   */
  awaitFresh?: boolean;
}

function getUsageCacheState(): UsageCacheState {
  if (!globalThis.__codyUsageCacheState) {
    globalThis.__codyUsageCacheState = { entry: null, inFlight: null, generation: 0 };
  }
  return globalThis.__codyUsageCacheState;
}

/**
 * Mark the cached snapshot as needing a refresh — called when a turn completes,
 * because that is exactly when quota moved. The stale entry keeps serving while
 * the refresh runs, so a finished turn never blocks the next render.
 */
export function markStale(): void {
  const state = getUsageCacheState();
  if (state.entry) state.entry.expiresAt = 0;
}

/** The cached snapshot, or null when nothing is cached — never a read. For a
 * caller that wants to know which account a credential was serving without
 * paying for an `omp usage` spawn. */
export function peekUsageSnapshot(): UsageSnapshot | null {
  return getUsageCacheState().entry?.snapshot ?? null;
}

/** Drop everything, including any in-flight read (engine switch, logout, tests). */
export function resetUsageCache(): void {
  const state = getUsageCacheState();
  state.generation += 1;
  state.entry = null;
  state.inFlight = null;
}

export function getUsageSnapshot(options: GetUsageSnapshotOptions = {}): Promise<UsageSnapshot> {
  const state = getUsageCacheState();
  const entry = state.entry;
  if (entry && isFresh(entry, options.maxAgeMs)) return Promise.resolve(entry.snapshot);

  const load = state.inFlight ?? startUsageLoad(state, options.load ?? loadUsageSnapshot);

  if (entry && entry.snapshot.available) {
    const lastGood = entry.snapshot;
    const markedStale = lastGood.stale ? lastGood : { ...lastGood, stale: true };
    if (options.awaitFresh) {
      // Fall back to the last good numbers only when the refresh genuinely
      // could not produce any — that is the one case worth flagging stale.
      return load
        .then((fresh) => (fresh.available ? fresh : markedStale))
        .catch(() => markedStale);
    }
    // Stale-while-revalidate: hand back the last good numbers immediately and
    // let the refresh land in the cache. Quota drifts slowly; a blocked render
    // is worse than a minute-old percentage.
    load.catch(() => {
      // A failed background refresh keeps serving the stale entry.
    });
    return Promise.resolve(markedStale);
  }
  return load;
}

function isFresh(entry: UsageCacheEntry, maxAgeMs: number | undefined): boolean {
  const now = Date.now();
  if (entry.expiresAt <= now) return false;
  // An unavailable entry is held for the whole backoff regardless of maxAgeMs:
  // callers must not be able to turn a failing probe into a spawn loop.
  if (!entry.snapshot.available) return true;
  return maxAgeMs === undefined || now - entry.storedAt <= maxAgeMs;
}

function startUsageLoad(state: UsageCacheState, load: UsageLoader): Promise<UsageSnapshot> {
  const generation = state.generation;
  const loadPromise: Promise<UsageSnapshot> = Promise.resolve()
    .then(load)
    .catch((error: unknown) => unavailableUsageSnapshot(`usage read failed: ${String(error)}`))
    .then((snapshot) => {
      if (state.generation === generation && state.inFlight === loadPromise) {
        const storedAt = Date.now();
        state.entry = {
          snapshot,
          storedAt,
          expiresAt: storedAt + (snapshot.available ? USAGE_CACHE_TTL_MS : USAGE_FAILURE_BACKOFF_MS),
        };
      }
      return snapshot;
    })
    .finally(() => {
      if (state.inFlight === loadPromise) state.inFlight = null;
    });

  state.inFlight = loadPromise;
  return loadPromise;
}
