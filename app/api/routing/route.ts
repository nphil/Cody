import { NextResponse } from "next/server";
import { requireAdminOrOpenInstance, requireUser } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { autoBindEnabled, readRouteMemory, setAutoBind } from "@/lib/routing/route-memory";

/**
 * GET /api/routing — Cody's routing memory: whether auto-binding is on, the
 * providers currently blacked out (with their resets), and the roles Cody
 * has re-pointed together with the baselines it will restore, and the
 * fallback chains it has filtered: per chain key, the user's `baseline`, the
 * chain actually `written`, and each `dropped` entry with its reason and
 * source (`credits`, `quota`, `block` for a deadline set after a rejected
 * request rather than measured quota, or `disabled` when every saved
 * credential is disabled).
 *
 * PUT /api/routing {autoBind} — the one switch. ON lets the usage-poll
 * reconciler write `modelRoles` / `retry.fallbackChains` /
 * `task.agentModelOverrides` around blacked-out providers; OFF keeps it observing only. It is a Cody setting, not an
 * engine one: it lives in `cody-route-memory.json`, so an engine update or
 * switch cannot lose it, and it needs no container restart to change.
 *
 * Turning it OFF does not undo an active binding — the engine keeps the
 * roles as they are in config.yml. Restoring baselines is a separate,
 * explicit action so the user can see what would change first.
 */
export const dynamic = "force-dynamic";

function payload() {
  const memory = readRouteMemory();
  return {
    autoBind: autoBindEnabled(),
    blackouts: memory.blackouts,
    bindings: Object.values(memory.bindings),
    chains: Object.values(memory.chains).map((chain) => ({
      key: chain.key,
      baseline: chain.baseline,
      written: chain.active,
      dropped: chain.dropped,
      boundAt: chain.boundAt,
    })),
  };
}

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  const gate = requireEngine("omp", "Usage-aware routing");
  if ("response" in gate) return gate.response;
  return NextResponse.json(payload(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  const gate = requireEngine("omp", "Usage-aware routing");
  if ("response" in gate) return gate.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
  }
  const autoBind = body && typeof body === "object" && !Array.isArray(body) && "autoBind" in body ? body.autoBind : undefined;
  if (typeof autoBind !== "boolean") return NextResponse.json({ error: "autoBind must be a boolean." }, { status: 400 });
  setAutoBind(autoBind);
  return NextResponse.json(payload(), { headers: { "Cache-Control": "no-store" } });
}
