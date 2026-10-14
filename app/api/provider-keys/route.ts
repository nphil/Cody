import { NextResponse } from "next/server";
import { jsonError, requireAdmin, requireUser } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { describeProviders, isKnownProviderVariable, readProviderKeys, setProviderKey } from "@/lib/harness/provider-keys";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { OPENROUTER_KEY_VARIABLE, resolveOpenRouterKey } from "@/lib/openrouter/key";
import { settleProviderChange } from "@/lib/provider-state";

/**
 * Provider keys for the active engine — the in-app answer to "the engine has
 * no credentials", which every engine but omp could previously only fix from
 * a terminal inside the container.
 *
 * GET answers which providers are configured and by which route (saved here
 * or set on the container); it never returns a value. PUT stores one variable
 * (an empty value clears it) and is admin-only, because a key applies to the
 * whole instance: every user's sessions on this engine will spend it.
 *
 * Clearing is honest about what it can do. A key saved in Cody is forgotten,
 * and idle engines restart so the next turn's environment no longer carries
 * it. A variable the SERVER'S ENVIRONMENT sets is not Cody's to remove: that
 * answers 409 `set_in_environment` instead of pretending to succeed.
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
  const cleared = value.trim() === "";
  if (cleared && !(name in readProviderKeys())) {
    // Nothing saved in Cody. A value the server's environment sets would still
    // be there after a "successful" clear, so say so rather than no-op.
    if (process.env[name]) return jsonError("Set in the server's environment — remove it there.", 409, "set_in_environment");
    return answer();
  }

  setProviderKey(name, value);
  // The catalog an rpc-dialect engine reports is gated on which providers
  // have credentials, and the sessionless utility child that answers it was
  // spawned with the OLD environment: drop it. `settleProviderChange` drops
  // every other cache that remembered the old key (models, usage, the
  // OpenRouter balance) and, for a CLEAR, restarts idle engines — a live child
  // read the variable at spawn and would go on spending a key the user just
  // removed. A SAVE does not restart: sessions started afterwards use it,
  // which the panel says.
  disposeUtilityRpc();
  const keyGone = cleared && name === OPENROUTER_KEY_VARIABLE && resolveOpenRouterKey() === null;
  await settleProviderChange({
    engineId: getHarness().id,
    restart: cleared,
    ...(keyGone ? { removedProviders: ["openrouter"] } : {}),
  });
  return answer();
}
