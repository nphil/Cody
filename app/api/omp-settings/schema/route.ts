import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { requireCapability } from "@/lib/engine-guard";

/**
 * The ACTIVE engine's own settings schema plus the values currently persisted
 * for it. The settings panel renders from this rather than a hand-kept list,
 * so an upstream addition shows up in its declared tab and group without a
 * Cody release.
 *
 * Engine-NEUTRAL, and neutral by construction: the engine supplies both
 * halves through `HarnessAdapter.settings` (omp from its TypeScript schema,
 * Hermes from its Python DEFAULT_CONFIG, pi from the settings tables in its
 * shipped docs), and this route only dispatches. It used to switch on engine
 * ids — `active.id === "hermes" ? … : ompBranch` — which made "no branch of
 * mine" mean "omp's branch": every other engine fell through and got omp's
 * ~550-key schema and omp's config.yml values back, stamped with its OWN id
 * and shortName ("All Pi Settings" over omp's settings). PUT was worse than
 * misleading: it wrote omp's config.yml while another engine was active and
 * reported success. An adapter hook cannot do that — an engine either
 * implements the surface or the route refuses it.
 *
 * The capability flag stays the outer gate (it is what hides the tab), and
 * the hook is the inner one, so an engine that declares `nativeSettings`
 * without implementing the surface refuses rather than borrowing someone
 * else's.
 */

export const dynamic = "force-dynamic";

const SURFACE = "a settings schema of its own";

/** The 400 an engine gets when it declares the capability but implements no
 * settings surface — the same `unsupported` code, and the same shape, the
 * capability gate itself answers with, because the client hides on that. */
function noSurface(shortName: string) {
  return NextResponse.json(
    { error: `${shortName} does not expose ${SURFACE} that Cody can read.`, code: "unsupported" },
    { status: 400 },
  );
}

export function GET() {
  try {
    const gate = requireCapability("nativeSettings", SURFACE);
    if ("response" in gate) return gate.response;
    const active = gate.harness;
    // The active harness names the panel ("All OMP Settings"), so the label
    // follows the engine selection instead of being baked into the UI.
    const { id, shortName } = active;
    const harness = { id, shortName };
    // The harness binary runs on this machine, so its platform-gated settings
    // (ui.condition "macOS") resolve from the server's own platform.
    const host = { platform: process.platform };
    if (!active.settings) return noSurface(shortName);
    const { path, schema, values, reason } = active.settings.readSchema();
    if (!schema) {
      return NextResponse.json({
        path,
        harness,
        host,
        schema: null,
        values: {},
        reason: reason ?? `${shortName}'s settings schema could not be read from the installed package`,
      });
    }
    return NextResponse.json({ path, harness, host, schema, values });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { patch?: unknown };
    const patch = body.patch;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return NextResponse.json({ error: "patch must be an object of setting paths" }, { status: 400 });
    }
    const gate = requireCapability("nativeSettings", SURFACE);
    if ("response" in gate) return gate.response;
    const active = gate.harness;
    if (!active.settings) return noSurface(active.shortName);

    const { written, rejected, values } = active.settings.write(patch as Record<string, unknown>);
    if (written.length > 0) {
      // Settings decide which models an engine offers and how its helper child
      // behaves, and the shared utility process caches both for its lifetime.
      // Dropping them here is engine-neutral: pi's `enabledModels` and
      // `defaultModel` reach /api/models through the very same cache omp's
      // model-visibility settings do.
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    if (rejected.length === 0) return NextResponse.json({ success: true, written, values });
    // A save that did not happen is never reported as one. The panel shows
    // `error`, so the keys the engine would not take are named there.
    return NextResponse.json({
      success: false,
      written,
      rejected,
      values,
      error: `Not saved — ${rejected.map((entry) => `${entry.key}: ${entry.reason}`).join("; ")}`,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
