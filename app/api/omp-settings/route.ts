import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { deleteNativeSettingsSections, readNativeSettings, writeNativeSettings, type NativeSettings } from "@/lib/omp/settings-config";
import { restartIdleRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return NextResponse.json(readNativeSettings());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { settings?: NativeSettings };
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
      return NextResponse.json({ error: "settings must be an object" }, { status: 400 });
    }
    writeNativeSettings(body.settings);
    if (body.settings.enabledModels !== undefined || body.settings.disabledProviders !== undefined || body.settings.modelProviderOrder !== undefined) {
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    return NextResponse.json({ success: true, settings: readNativeSettings().settings });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

/** Reset whole config.yml sections (e.g. { sections: ["retry"] }) back to OMP
 * defaults by deleting the overrides. Idle sessions restart so the defaults
 * take effect immediately; running turns finish on the old values. */
export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { sections?: unknown };
    if (!Array.isArray(body.sections) || body.sections.length === 0 || body.sections.some((section) => typeof section !== "string")) {
      return NextResponse.json({ error: "sections must be a non-empty string array" }, { status: 400 });
    }
    const removed = deleteNativeSettingsSections(body.sections as string[]);
    const { restarted, active } = await restartIdleRpcSessions();
    return NextResponse.json({ success: true, removed, restarted, active, settings: readNativeSettings().settings });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
