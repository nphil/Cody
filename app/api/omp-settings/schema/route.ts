import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { readSchemaSettings, writeSchemaSettings } from "@/lib/omp/settings-values";
import { getHarness } from "@/lib/harness";

/**
 * OMP's own settings schema plus the values currently persisted for it. The
 * settings panel renders from this rather than a hand-kept list, so an upstream
 * addition shows up in its declared tab and group without a Cody release.
 */

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const { path, schema, values } = readSchemaSettings();
    // The active harness names the panel ("All OMP Settings"), so the label
    // follows CODY_HARNESS instead of being baked into the UI.
    const { id, shortName } = getHarness();
    const harness = { id, shortName };
    // The harness binary runs on this machine, so its platform-gated settings
    // (ui.condition "macOS") resolve from the server's own platform.
    const host = { platform: process.platform };
    if (!schema) {
      return NextResponse.json({ path, harness, host, schema: null, values: {}, reason: `${shortName}'s settings schema could not be read from the installed package` });
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
    const written = writeSchemaSettings(patch as Record<string, unknown>);
    if (written.length > 0) {
      // The helper OMP process caches settings for its lifetime, and model
      // visibility derives from several of these paths; drop both so the next
      // read reflects what was just saved.
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    return NextResponse.json({ success: true, written, values: readSchemaSettings().values });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
