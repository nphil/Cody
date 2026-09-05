import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { invalidateModelsCache } from "@/lib/models-cache";
import { countModelsByProvider, loadEffectiveModelsCached } from "@/lib/models-effective";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { composeProviderDirectory } from "@/lib/provider-directory-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/verify {providerId} — "Check models" for one provider
 * of an rpc-dialect engine: drop the shared utility child (it was spawned
 * with the environment BEFORE the key was saved) and the models cache, read
 * the effective catalog once, and count the models this provider now
 * serves. `{ok, modelCount, error?, checkedAt}`, admin-only.
 *
 * What it can and cannot tell: a registry provider's catalog read never
 * contacts the vendor, so a wrong key still yields a catalog — which is why
 * the UI calls this "Check models" and only a custom endpoint (whose models
 * omp resolves from the declared base URL) gets "Verify key". An engine with
 * no sessionless catalog (ACP) answers 400 `unsupported`, and the hub hides
 * the control on that code. One check runs per provider at a time; a second
 * caller joins the first.
 */
export interface VerifyResult {
  ok: boolean;
  modelCount: number;
  error?: string;
  checkedAt: string;
}

declare global {
  var __codyProviderVerifyInFlight: Map<string, Promise<VerifyResult>> | undefined;
}

function inFlight(): Map<string, Promise<VerifyResult>> {
  if (!globalThis.__codyProviderVerifyInFlight) globalThis.__codyProviderVerifyInFlight = new Map();
  return globalThis.__codyProviderVerifyInFlight;
}

async function verify(providerId: string, canEdit: boolean): Promise<VerifyResult> {
  const harness = getHarness();
  // The cached join costs no child and is enough to learn which catalog ids
  // the row sums over; an unknown id (a roster the process has not read
  // yet) falls back to the id itself.
  const directory = await composeProviderDirectory(harness, { cached: true, canEdit });
  const row = directory.providers.find((entry) => entry.id === providerId);
  const catalogIds = row?.catalogIds ?? [providerId];
  const custom = row?.methods.some((method) => method.kind === "custom") ?? false;
  const checkedAt = new Date().toISOString();
  disposeUtilityRpc();
  invalidateModelsCache();
  try {
    const data = await loadEffectiveModelsCached(harness, { refresh: true });
    const counts = countModelsByProvider(data);
    const modelCount = catalogIds.reduce((total, id) => total + (counts[id] ?? 0), 0);
    if (data.modelError) return { ok: false, modelCount, error: data.modelError, checkedAt };
    if (modelCount === 0) {
      return {
        ok: false,
        modelCount,
        error: custom
          ? `${row?.name ?? providerId} resolved no models — check its base URL and key.`
          : `${harness.shortName} serves no ${row?.name ?? providerId} models — check the key, or that the provider is not disabled.`,
        checkedAt,
      };
    }
    return { ok: true, modelCount, checkedAt };
  } catch (error) {
    return { ok: false, modelCount: 0, error: error instanceof Error ? error.message : String(error), checkedAt };
  }
}

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  const harness = getHarness();
  if (!harness.rpcUi) {
    return jsonError(`${harness.displayName} has no sessionless model catalog to check a provider against; its models come from the session.`, 400, "unsupported");
  }
  let body: { providerId?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 2_048);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
  if (!providerId) return jsonError("providerId is required", 400, "provider_id_required");

  const running = inFlight();
  const key = `${harness.id}:${providerId}`;
  let pending = running.get(key);
  if (!pending) {
    pending = verify(providerId, true).finally(() => {
      if (running.get(key) === pending) running.delete(key);
    });
    running.set(key, pending);
  }
  return NextResponse.json(await pending, { headers: { "Cache-Control": "no-store" } });
}
