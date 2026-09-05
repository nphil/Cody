import { withModelRuntimeError } from "@/lib/models-cache";
import { requireEngine } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";
import { loadFullCatalog } from "@/lib/model-catalog-full";
import { EMPTY_MODELS, loadEffectiveModelsCached, SESSION_SCOPED_MODELS } from "@/lib/models-effective";

export const dynamic = "force-dynamic";

// The model registry (omp: auth + models.yml; pi: its own catalog) is global,
// not per-cwd, so one cache entry serves every request — keyed by engine so a
// switch never serves the previous engine's catalog for the TTL. The loader
// itself lives in lib/models-effective.ts, shared with /api/providers, which
// counts the same catalog per provider.

export async function GET(req: Request) {
  try {
    // Curation asks for the full catalog explicitly. Nothing else does: the
    // main UI only ever needs the models a session can actually use.
    const searchParams = new URL(req.url).searchParams;
    if (searchParams.get("catalog") === "full") {
      // Curation edits omp's `enabledModels`; the UNRESTRICTED read behind
      // loadFullCatalog (lib/model-catalog-full.ts) is omp's own --config
      // overlay mechanism. Nothing about it means anything on another
      // engine, so it refuses rather than spawning omp behind one.
      const gate = requireEngine("omp", "The unrestricted model catalog");
      if ("response" in gate) return gate.response;
      // Cached for an hour (an isolated omp child per read is the expensive
      // part); `refresh=1` is for the caller that knows the registry changed
      // behind the cache — an engine update.
      return Response.json({ modelList: await loadFullCatalog({ refresh: searchParams.get("refresh") === "1" }) });
    }
    const harness = getHarness();
    // Dispatch on the ACTIVE engine, before anything can spawn a child. An
    // engine that does not speak the rpc dialect has no global catalog: it
    // gets an honest empty one, never a neighbour's.
    if (!harness.rpcUi) return Response.json(SESSION_SCOPED_MODELS);
    // No allow-list filtering here on purpose: OMP already applied
    // `enabledModels` to this response, using glob semantics Cody must not
    // reimplement (see lib/model-allow-list.ts). What arrives IS the effective
    // set, so the Composer picker, model roles, and fallback chains all shrink
    // to the user's selection with no client-side work.
    return Response.json(await loadEffectiveModelsCached(harness));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(withModelRuntimeError(EMPTY_MODELS, message));
  }
}
