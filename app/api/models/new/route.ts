import { getHarness, type HarnessAdapter } from "@/lib/harness";
import { modelKey } from "@/lib/model-allow-list";
import { type CatalogModel, compareModelEntries, FULL_CATALOG_CACHE_KEY, loadFullCatalog } from "@/lib/model-catalog-full";
import { diffNewModels, readSeenLedger } from "@/lib/model-catalog-seen";
import { loadCatalogWithCache, peekCatalogCache } from "@/lib/models-cache";
import { type OmpModel, runUtilityCommand } from "@/lib/omp/rpc-utility";
import { utilityRpcLaunchFor } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * Models the ACTIVE engine's catalog has that the user has never been shown
 * (the "seen" ledger, lib/model-catalog-seen.ts).
 *
 * Under omp the comparison runs against the UNRESTRICTED catalog: a model
 * hidden by an exact-id `enabledModels` allowlist still counts as new, which
 * is the whole point — the allowlist is exactly what hides a model released
 * after the user curated. Another rpc-dialect engine (pi) has no curation
 * layer Cody knows about, so its effective list IS its catalog. An ACP
 * engine has no sessionless catalog at all (`catalogSource: "session"`, see
 * /api/models), so there is nothing to diff and no child is spawned.
 *
 * Fails soft exactly like /api/models: a loader failure (engine not
 * installed, RPC error) is a 200 with an empty list and `modelError`, never a
 * 500 — this feeds a status line, and a status line must not break the
 * panel it sits in.
 *
 * `?cached=1` answers from the catalog cache ONLY and never starts an engine
 * child: the settings rail, the composer footer and the post-install toast
 * all paint from it, and a status line that cold-starts an isolated omp
 * process on every open (measured at 20 s on a real install) is not a
 * status line. A cold cache is reported as `pending: true` with an empty
 * list; the hub's own open and its Refresh button run the full read.
 */

interface NewModelsResponse {
  newModels: CatalogModel[];
  total: number;
  seenAt: string | null;
  firstRun: boolean;
  catalogSource: "global" | "session";
  modelError?: string;
  /** `?cached=1` only: the catalog cache was cold, so nothing was compared. */
  pending?: true;
}

const EFFECTIVE_CATALOG_KEY = (engineId: string) => `catalog:${engineId}`;

/** The effective catalog of a non-omp rpc-dialect engine, cached beside the
 * `/api/models` entry so repeated polls reuse one `get_available_models`. */
function loadEffectiveCatalog(harness: HarnessAdapter): Promise<CatalogModel[]> {
  return loadCatalogWithCache<CatalogModel[]>(EFFECTIVE_CATALOG_KEY(harness.id), async () => {
    const launch = utilityRpcLaunchFor(harness);
    const { models } = await runUtilityCommand<{ models: OmpModel[] }>(
      { type: "get_available_models" },
      120_000,
      launch,
    );
    return models
      .map((model) => ({ id: model.id, name: model.name || model.id, provider: model.provider }))
      .sort(compareModelEntries);
  });
}

function diffResponse(catalog: CatalogModel[], ledger: ReturnType<typeof readSeenLedger>): NewModelsResponse {
  const { newKeys, firstRun } = diffNewModels(catalog.map(modelKey), ledger);
  const fresh = new Set(newKeys);
  return {
    newModels: catalog
      .filter((model) => fresh.has(modelKey(model)))
      .map(({ provider, id, name }) => ({ provider, id, name })),
    total: catalog.length,
    seenAt: ledger.seenAt,
    firstRun,
    catalogSource: "global",
  };
}

export async function GET(request: Request) {
  const harness = getHarness();
  if (!harness.rpcUi) {
    const sessionScoped: NewModelsResponse = { newModels: [], total: 0, seenAt: null, firstRun: false, catalogSource: "session" };
    return Response.json(sessionScoped);
  }
  const ledger = readSeenLedger(harness.id);
  // Older callers (the route tests) invoke GET() bare; a missing request is
  // the full read.
  const cachedOnly = typeof request?.url === "string" && new URL(request.url).searchParams.get("cached") === "1";
  if (cachedOnly) {
    const cached = peekCatalogCache<CatalogModel[]>(harness.id === "omp" ? FULL_CATALOG_CACHE_KEY : EFFECTIVE_CATALOG_KEY(harness.id));
    if (!cached) {
      const pending: NewModelsResponse = { newModels: [], total: 0, seenAt: ledger.seenAt, firstRun: ledger.seenAt === null, catalogSource: "global", pending: true };
      return Response.json(pending);
    }
    return Response.json(diffResponse(cached, ledger));
  }
  try {
    const catalog = harness.id === "omp" ? await loadFullCatalog() : await loadEffectiveCatalog(harness);
    return Response.json(diffResponse(catalog, ledger));
  } catch (error) {
    const failed: NewModelsResponse = {
      newModels: [],
      total: 0,
      seenAt: ledger.seenAt,
      firstRun: ledger.seenAt === null,
      catalogSource: "global",
      modelError: error instanceof Error ? error.message : String(error),
    };
    return Response.json(failed);
  }
}
