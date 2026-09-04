import { getHarness, type HarnessAdapter } from "@/lib/harness";
import { modelKey } from "@/lib/model-allow-list";
import { type CatalogModel, compareModelEntries, loadFullCatalog } from "@/lib/model-catalog-full";
import { diffNewModels, readSeenLedger } from "@/lib/model-catalog-seen";
import { loadCatalogWithCache } from "@/lib/models-cache";
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
 */

interface NewModelsResponse {
  newModels: CatalogModel[];
  total: number;
  seenAt: string | null;
  firstRun: boolean;
  catalogSource: "global" | "session";
  modelError?: string;
}

/** The effective catalog of a non-omp rpc-dialect engine, cached beside the
 * `/api/models` entry so repeated polls reuse one `get_available_models`. */
function loadEffectiveCatalog(harness: HarnessAdapter): Promise<CatalogModel[]> {
  return loadCatalogWithCache<CatalogModel[]>(`catalog:${harness.id}`, async () => {
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

export async function GET() {
  const harness = getHarness();
  if (!harness.rpcUi) {
    const sessionScoped: NewModelsResponse = { newModels: [], total: 0, seenAt: null, firstRun: false, catalogSource: "session" };
    return Response.json(sessionScoped);
  }
  const ledger = readSeenLedger(harness.id);
  try {
    const catalog = harness.id === "omp" ? await loadFullCatalog() : await loadEffectiveCatalog(harness);
    const { newKeys, firstRun } = diffNewModels(catalog.map(modelKey), ledger);
    const fresh = new Set(newKeys);
    const response: NewModelsResponse = {
      newModels: catalog
        .filter((model) => fresh.has(modelKey(model)))
        .map(({ provider, id, name }) => ({ provider, id, name })),
      total: catalog.length,
      seenAt: ledger.seenAt,
      firstRun,
      catalogSource: "global",
    };
    return Response.json(response);
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
