import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness, getHarnessById, selectHarness } from "@/lib/harness";
import { restartAllRpcSessions } from "@/lib/rpc-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";
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

  // Re-selecting the engine that is already active is the onboarding
  // "decide later" path: nothing changes, the choice is just persisted. It
  // must work even before the engine is installed — the image ships no
  // engine, so on a fresh instance NOTHING is installed yet — and it must
  // not restart anything.
  const reaffirming = getHarness().id === adapter.id;

  if (!reaffirming && adapter.resolveBinary() === null) {
    return jsonError(
      `${adapter.displayName} is not installed. Install it before making it the active engine.`,
      409,
      "engine_not_installed",
    );
  }

  selectHarness(adapter.id);
  // The sidebar's session list is sourced from the ACTIVE engine's sessions
  // root (or its engine-session index); a cached list from the old engine
  // must not survive the switch.
  invalidateSessionListCache();
  if (!reaffirming) {
    try {
      await restartAllRpcSessions();
    } catch {
      // The selection is what had to stick. A child that refused to die
      // cleanly is already orphaned from the new engine and times out on its
      // own; failing the request here would report a switch that actually
      // happened as an error.
    }
  }

  return getEngines(request);
}
