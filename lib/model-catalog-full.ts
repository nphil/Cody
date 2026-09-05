import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadCatalogWithCache } from "@/lib/models-cache";
import { type OmpModel, runIsolatedUtilityCommand } from "@/lib/omp/rpc-utility";

/**
 * omp's UNRESTRICTED model catalog — every model the registry knows, with the
 * user's `enabledModels` curation lifted.
 *
 * omp filters `get_available_models` by that setting, so once a restriction
 * is in place the ordinary read (`/api/models`) can no longer see the models
 * it excluded. Two surfaces need the whole thing anyway: the settings panel
 * that EDITS the curation (there is no way to add a model back from a list
 * that hides it), and the "new models" diff (`/api/models/new`), whose whole
 * point is that a model released after the user curated is invisible to
 * the effective list — and nothing told them the catalog grew.
 *
 * A config overlay (`PI_CONFIG_FILES`, omp's own `--config` mechanism) layers
 * `enabledModels: []` over the real config for this one read-only query. The
 * user's config.yml is never written, and the overlay applies only to the
 * throwaway process that answers it.
 *
 * That process is the expensive part — an isolated omp child, started and
 * torn down per call — so the answer is cached for an hour under
 * `full:omp`. It lives in the same cache as the effective catalog so
 * `invalidateModelsCache()` (login, set_model, models.yml writes) drops both;
 * `refresh: true` reloads on demand for the caller that just changed
 * something the cache cannot see (an engine update).
 *
 * omp-only, and deliberately so: the overlay means nothing to another engine,
 * and the route that calls this refuses under one (`requireEngine("omp")`).
 */

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
}

export const FULL_CATALOG_CACHE_KEY = "full:omp";
const FULL_CATALOG_TTL_MS = 60 * 60 * 1000;

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Display order for any model list: by name, then provider, then id, with
 * numeric-aware, case-insensitive comparison so "4.1" sorts after "4". */
export function compareModelEntries(a: CatalogModel, b: CatalogModel): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

async function readUnrestrictedCatalog(): Promise<CatalogModel[]> {
  const overlay = join(tmpdir(), "cody-unrestricted-models.yml");
  await writeFile(overlay, "enabledModels: []\n", "utf8");
  const { models } = await runIsolatedUtilityCommand<{ models: OmpModel[] }>(
    { type: "get_available_models" },
    { env: { PI_CONFIG_FILES: overlay }, timeoutMs: 120_000 },
  );
  return models
    .map((model) => ({ id: model.id, name: model.name || model.id, provider: model.provider }))
    .sort(compareModelEntries);
}

export function loadFullCatalog(options: { refresh?: boolean } = {}): Promise<CatalogModel[]> {
  return loadCatalogWithCache<CatalogModel[]>(FULL_CATALOG_CACHE_KEY, readUnrestrictedCatalog, {
    ttlMs: FULL_CATALOG_TTL_MS,
    refresh: options.refresh === true,
  });
}
