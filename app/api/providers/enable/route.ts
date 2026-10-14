import { NextResponse } from "next/server";
import { requireEngine } from "@/lib/engine-guard";
import { enableProvider } from "@/lib/omp/model-roles";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { readNativeSettings } from "@/lib/omp/settings-config";
import { settleProviderChange } from "@/lib/provider-state";

export async function POST(request: Request) {
  try {
    // Writes omp's `disabledProviders` in its own config.yml.
    const gate = requireEngine("omp", "Provider enablement");
    if ("response" in gate) return gate.response;
    const body = await request.json() as { provider?: unknown };
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    const wasDisabled = (readNativeSettings().settings.disabledProviders ?? []).includes(body.provider);
    enableProvider(body.provider);
    disposeUtilityRpc();
    // An engine child reads `disabledProviders` at spawn: when the provider
    // really was switched off, idle ones restart so its models come back
    // without waiting for a new chat. (The Providers hub enables every id a
    // row owns, most of which were never disabled.)
    const settled = await settleProviderChange({ engineId: gate.harness.id, restart: wasDisabled });
    return NextResponse.json({ success: true, ...settled });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
