/**
 * The server half of the Providers hub: gathers the four inputs of
 * `buildProviderDirectory` from the ACTIVE engine and answers the shape
 * `GET /api/providers` serves. Shared with `POST /api/providers/verify`,
 * which needs the same join to know which catalog ids a row sums over.
 *
 * Two modes. The full read asks the engine for its sign-in roster (a child
 * process for every engine but omp's already-running utility child) and
 * for its effective catalog (the shared utility child). The CACHED read
 * (`?cached=1`, the rail's status line) touches neither: it serves the last
 * roster this process saw and peeks the models cache, and marks what it
 * could not answer `pending` rather than starting an engine to find out.
 */
import { providersForEngine } from "./harness/provider-catalog";
import { describeProviders } from "./harness/provider-keys";
import type { HarnessAdapter, ProviderDirectoryInfo, ProviderLoginList } from "./harness/types";
import { countModelsByProvider, loadEffectiveModelsCached, peekEffectiveModels } from "./models-effective";
import { buildProviderDirectory, type ProviderRow, type ProvidersResponse } from "./provider-directory";

declare global {
  // The last roster each engine answered, so a cached read has one to
  // serve. On globalThis to survive dev hot-reload like the other caches.
  var __codyProviderLoginsCache: Map<string, ProviderLoginList> | undefined;
}

function loginsCache(): Map<string, ProviderLoginList> {
  if (!globalThis.__codyProviderLoginsCache) globalThis.__codyProviderLoginsCache = new Map();
  return globalThis.__codyProviderLoginsCache;
}

/** Forget a roster (an engine switch, a sign-in the route did not see). */
export function invalidateProviderLoginsCache(engineId?: string): void {
  if (engineId) loginsCache().delete(engineId);
  else loginsCache().clear();
}

export const SESSION_MODELS_REASON = "Models come from the session";

async function readLogins(harness: HarnessAdapter, cached: boolean): Promise<{ list: ProviderLoginList | null; pending: boolean }> {
  const surface = harness.capabilities.providerLogin ? harness.providerLogins : undefined;
  if (!surface) return { list: null, pending: false };
  const remembered = loginsCache().get(harness.id);
  if (cached) return { list: remembered ?? null, pending: remembered === undefined };
  try {
    const list = await surface.list();
    loginsCache().set(harness.id, list);
    return { list, pending: false };
  } catch (error) {
    // The surface's contract is to answer `{providers: [], reason}` rather
    // than throw; this is the backstop so a roster failure never takes the
    // key rows down with it.
    return { list: { providers: [], reason: error instanceof Error ? error.message : String(error) }, pending: false };
  }
}

async function readCounts(harness: HarnessAdapter, cached: boolean): Promise<{ counts: Record<string, number> | null; reason?: string; pending: boolean }> {
  // No sessionless catalog: an ACP engine's models live in the session.
  if (!harness.rpcUi) return { counts: null, reason: SESSION_MODELS_REASON, pending: false };
  if (cached) {
    const peeked = peekEffectiveModels(harness);
    if (!peeked) return { counts: null, pending: true };
    return { counts: countModelsByProvider(peeked), ...(peeked.modelError ? { reason: peeked.modelError } : {}), pending: false };
  }
  try {
    const data = await loadEffectiveModelsCached(harness);
    return { counts: countModelsByProvider(data), ...(data.modelError ? { reason: data.modelError } : {}), pending: false };
  } catch (error) {
    // A missing binary or a dead RPC is a fact about the engine, reported on
    // the rows as `reason`; it is never a 500 for the hub.
    return { counts: null, reason: error instanceof Error ? error.message : String(error), pending: false };
  }
}

function readDirectory(harness: HarnessAdapter): ProviderDirectoryInfo | null {
  try {
    return harness.providerDirectory?.() ?? null;
  } catch {
    return null;
  }
}

export interface ComposeOptions {
  /** Serve only what this process already knows; never start a child. */
  cached: boolean;
  canEdit: boolean;
}

export async function composeProviderDirectory(harness: HarnessAdapter, options: ComposeOptions): Promise<ProvidersResponse> {
  const [logins, counted] = await Promise.all([readLogins(harness, options.cached), readCounts(harness, options.cached)]);
  const directory = readDirectory(harness);
  const rows: ProviderRow[] = buildProviderDirectory({
    logins: logins.list?.providers ?? null,
    keys: describeProviders(harness.id).map((provider) => ({ id: provider.id, name: provider.name, variables: provider.variables })),
    counts: counted.counts,
    ...(counted.reason ? { countsReason: counted.reason } : {}),
    directory,
    catalog: providersForEngine(harness.id),
    pending: { counts: counted.pending, logins: logins.pending },
  });
  const pending = counted.pending || logins.pending;
  return {
    engine: { id: harness.id, shortName: harness.shortName },
    canEdit: options.canEdit,
    canVerify: Boolean(harness.rpcUi),
    instanceSource: directory?.readOnlyReason ? "readonly" : "writable",
    ...(directory?.readOnlyReason ? { readonlyReason: directory.readOnlyReason } : {}),
    ...(pending ? { pending: true } : {}),
    providers: rows,
  };
}
