import { NextResponse } from "next/server";
import { jsonError, requireAdmin, requireUser } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { describeProviders, isKnownProviderVariable, setProviderKey } from "@/lib/harness/provider-keys";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";

/**
 * Provider keys for the active engine — the in-app answer to "the engine has
 * no credentials", which every engine but omp could previously only fix from
 * a terminal inside the container.
 *
 * GET answers which providers are configured and by which route (saved here
 * or set on the container); it never returns a value. PUT stores one variable
 * (an empty value clears it) and is admin-only, because a key applies to the
 * whole instance: every user's sessions on this engine will spend it.
 */

export const dynamic = "force-dynamic";

const MAX_KEY_LENGTH = 4_096;
/** Anything that would corrupt an environment block silently. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function answer() {
  const engine = getHarness();
  return NextResponse.json(
    { engine: { id: engine.id, shortName: engine.shortName }, providers: describeProviders(engine.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  return answer();
}

export async function PUT(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: { name?: unknown; value?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 8_192);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || !isKnownProviderVariable(name)) {
    return jsonError("Unknown provider variable", 400, "unknown_provider_variable");
  }
  const value = typeof body.value === "string" ? body.value : "";
  if (value.length > MAX_KEY_LENGTH) return jsonError("Value is too long", 400);
  if (CONTROL_CHARACTERS.test(value)) return jsonError("Value contains control characters", 400);

  setProviderKey(name, value);
  // The catalog an rpc-dialect engine reports is gated on which providers
  // have credentials, and the sessionless utility child that answers it was
  // spawned with the OLD environment. Drop both so the next read reflects the
  // key that was just saved; live chat sessions keep their environment until
  // they restart, which the panel says.
  invalidateModelsCache();
  disposeUtilityRpc();
  return answer();
}
