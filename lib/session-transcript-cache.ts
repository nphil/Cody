import type { AgentMessage, SessionTreeNode } from "./types";
import type { TodoPhase } from "./pi-types";
import type { UsageTotals } from "./session-usage";
import type { HistoryPageFields, HistoryStats } from "./session-history-page";

/**
 * Per-session, in-memory transcript cache: keep recent history pages so a
 * session can paint immediately while the browser fetches current data.
 *
 * Module-scoped so it survives AppShell's per-switch `key={sessionKey}`
 * remount of ChatWindow (and the useAgentSession instance inside it) — that
 * remount is intentional (see AppShell.tsx's session-select handlers), so
 * the cache has to live ABOVE the component that gets torn down and
 * recreated on every switch, not inside it.
 *
 * The hook uses this same response type so cached and fresh pages retain
 * identical cursor, branch and session-wide accounting information.
 *
 * A cache hit is never treated as ground truth by itself — the caller always
 * re-fetches immediately after hydrating from it (stale-while-revalidate)
 * and overwrites this entry with the fresh response. A hit only removes the
 * blank/loading flash for however long that revalidation takes to land.
 */
export interface CachedSessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    todoPhases: TodoPhase[];
    goal?: unknown;
  } & Partial<HistoryPageFields>;
  historyStats?: HistoryStats;
  planOverlay?: unknown;
  modelUsage?: UsageTotals;
}

interface CacheEntry {
  data: CachedSessionData;
  cachedAt: number;
  weight: number;
}

// Charge the entire JSON-shaped payload (including metadata and arrays), not
// just visible text. This estimates retention, not the VM's exact heap size.
const MAX_CACHE_WEIGHT = 4 * 1024 * 1024;
let cacheWeight = 0;

function payloadWeight(value: unknown, remaining: number, depth = 0): number {
  if (typeof value === "string") return 24 + 2 * value.length;
  if (value === null || typeof value !== "object") return 8;
  if (depth > 64) return Infinity;
  let weight = 48;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && weight <= remaining; i++) {
      weight += 8 + payloadWeight(value[i], remaining - weight, depth + 1);
    }
    return weight;
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    weight += 16 + 2 * key.length;
    weight += payloadWeight((value as Record<string, unknown>)[key], remaining - weight, depth + 1);
    if (weight > remaining) break;
  }
  return weight;
}
const MAX_CACHED_SESSIONS = 12;

// Long enough to help a quick back-and-forth between a handful of sessions;
// short enough that a tab left open for hours does not repaint an ancient
// transcript for even the one frame before revalidation replaces it.
const MAX_CACHE_AGE_MS = 15 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/**
 * Pure lookup: never mutates the cache (no eviction, no recency bump), so it
 * is safe to call directly from a component's render body or a `useState`
 * initializer, not just from effects/callbacks.
 */
export function getCachedSessionData(sessionId: string, now: number = Date.now()): CachedSessionData | undefined {
  const entry = cache.get(sessionId);
  if (!entry) return undefined;
  if (now - entry.cachedAt > MAX_CACHE_AGE_MS) return undefined;
  return entry.data;
}

/** Insert-or-replace, keeping Map iteration order as recency order (oldest
 * write first) so eviction below always drops the least-recently-WRITTEN
 * entry. Every cache hit is immediately followed by a revalidating fetch, so
 * "recency" only needs to track successful writes, not reads. */
export function setCachedSessionData(sessionId: string, data: CachedSessionData, now: number = Date.now()): void {
  clearCachedSessionData(sessionId);
  const weight = payloadWeight(data, MAX_CACHE_WEIGHT);
  if (weight > MAX_CACHE_WEIGHT) return;
  cache.set(sessionId, { data, cachedAt: now, weight });
  cacheWeight += weight;
  while (cacheWeight > MAX_CACHE_WEIGHT || cache.size > MAX_CACHED_SESSIONS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    clearCachedSessionData(oldestKey);
  }
}

export function clearCachedSessionData(sessionId: string): void {
  cacheWeight -= cache.get(sessionId)?.weight ?? 0;
  cache.delete(sessionId);
}

/** Test-only: drop every entry so tests never leak state into each other. */
export function __resetSessionTranscriptCacheForTests(): void {
  cache.clear();
  cacheWeight = 0;
}
