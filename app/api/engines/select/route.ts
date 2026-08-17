import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarnessById, selectHarness } from "@/lib/harness";
import { restartAllRpcSessions } from "@/lib/rpc-manager";
import { GET as getEngines } from "../route";

/**
 * Switch the active engine (admin only). The switch is instance-wide: the
 * selection is persisted, every live agent child is stopped so nothing keeps
 * running on the engine that was just replaced, and the browser reconnects on
 * demand against the new one.
 *
 * The response is the same payload GET /api/engines returns, so the picker and
 * the Settings card can swap their whole state in one round trip instead of
 * re-fetching after the switch.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: { id?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const adapter = id ? getHarnessById(id) : undefined;
  if (!adapter) return jsonError(`Unknown engine "${id}"`, 400, "unknown_engine");

  if (adapter.resolveBinary() === null) {
    return jsonError(
      `${adapter.displayName} is not installed. Install it before making it the active engine.`,
      409,
      "engine_not_installed",
    );
  }

  selectHarness(adapter.id);
  try {
    await restartAllRpcSessions();
  } catch {
    // The selection is what had to stick. A child that refused to die cleanly
    // is already orphaned from the new engine and times out on its own; failing
    // the request here would report a switch that actually happened as an error.
  }

  return getEngines(request);
}
