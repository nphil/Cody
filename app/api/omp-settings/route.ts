import { NextResponse } from "next/server";
import { requireEngine } from "@/lib/engine-guard";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { deleteNativeSettingsPaths, deleteNativeSettingsSections, readNativeSettings, writeNativeSettings, type NativeSettings } from "@/lib/omp/settings-config";
import { settleProviderChange } from "@/lib/provider-state";
import { restartIdleRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * This is omp's `~/.omp/agent/config.yml`, read and written key by key with
 * omp's own shape (approval modes, advisor, compaction, autolearn).
 *
 * It is NOT "the active engine's native settings", and the distinction matters:
 * an engine can declare `capabilities.nativeSettings` truthfully — it has its
 * own config — and the Settings dialog then fetched this route under it,
 * showing omp's real values under that engine's heading, with a Save that wrote
 * to a file the engine never reads. An engine's own schema-driven settings go
 * through /api/omp-settings/schema, which dispatches per engine; this one is
 * omp's and says so.
 */
const SURFACE = "OMP's config.yml";

export function GET() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    return NextResponse.json(readNativeSettings());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

/** The set a `disabledProviders` list names, order-free. */
function sameProviderSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((provider) => right.has(provider));
}

export async function PUT(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const body = await request.json() as { settings?: NativeSettings };
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
      return NextResponse.json({ error: "settings must be an object" }, { status: 400 });
    }
    const disabledBefore = readNativeSettings().settings.disabledProviders;
    writeNativeSettings(body.settings);
    if (body.settings.enabledModels !== undefined || body.settings.disabledProviders !== undefined || body.settings.modelProviderOrder !== undefined) {
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    const settings = readNativeSettings().settings;
    // Disabling or enabling a provider is read by an engine child at spawn: a
    // live idle one would keep offering (and spending) a provider the user
    // just switched off. Only a CHANGED list restarts them — the Models hub
    // spreads the whole object on every curation write. A newly disabled
    // provider is gone from routing too: what Cody remembered about it (an
    // "out of credits" blackout has no expiry) must not keep it in Usage.
    if (!sameProviderSet(disabledBefore, settings.disabledProviders)) {
      const switchedOff = (settings.disabledProviders ?? []).filter((provider) => !(disabledBefore ?? []).includes(provider));
      const settled = await settleProviderChange({ engineId: gate.harness.id, removedProviders: switchedOff });
      return NextResponse.json({ success: true, settings, ...settled });
    }
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reset config.yml overrides back to OMP defaults by deleting them: whole
 * sections (`{ sections: ["retry"] }`) and/or individual keys
 * (`{ paths: ["defaultThinkingLevel"] }` — only the paths settings-config
 * lists as resettable). Idle sessions restart so the defaults take effect
 * immediately; running turns finish on the old values. */
export async function DELETE(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const body = await request.json().catch(() => ({})) as { sections?: unknown; paths?: unknown };
    const sections = body.sections === undefined ? [] : body.sections;
    const paths = body.paths === undefined ? [] : body.paths;
    if (!isStringArray(sections) || !isStringArray(paths) || sections.length + paths.length === 0) {
      return NextResponse.json({ error: "sections and/or paths must be non-empty string arrays" }, { status: 400 });
    }
    const removed = [
      ...(sections.length > 0 ? deleteNativeSettingsSections(sections) : []),
      ...(paths.length > 0 ? deleteNativeSettingsPaths(paths) : []),
    ];
    const { restarted, active } = await restartIdleRpcSessions();
    return NextResponse.json({ success: true, removed, restarted, active, settings: readNativeSettings().settings });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
