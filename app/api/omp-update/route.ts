import { NextResponse } from "next/server";
import { requireAdmin, requireUser } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { getHarnessById } from "@/lib/harness";
import { EngineInstallError, installEngine, readInstallHistory } from "@/lib/harness/install";
import { invalidateOmpCliCache } from "@/lib/omp/omp-cli";
import { runIsolatedUtilityCommand } from "@/lib/omp/rpc-utility";
import { checkOmpUpdate } from "@/lib/omp/updates";
import { restartAllRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // Every branch below is omp's: omp's registry check, omp's installer,
    // omp's RPC health probe, omp's session restart. The client already gates
    // the button on `capabilities.updates`, but a client flag is not a guard —
    // probed directly under Hermes this reported omp's version as the active
    // engine's, and its `update` action would have installed omp.
    const gate = requireEngine("omp", "The OMP runtime update check");
    if ("response" in gate) return gate.response;
    const body = await request.json() as { action?: unknown };
    if (body.action === "check") {
      // Read-only: any signed-in user may see update status.
      const resolved = requireUser(request);
      if ("response" in resolved) return resolved.response;
      return NextResponse.json(await checkOmpUpdate());
    }
    // Mutations are admin territory, same as the engine install routes.
    const resolved = requireAdmin(request);
    if ("response" in resolved) return resolved.response;
    if (body.action === "update") {
      // Same mechanism as the engine install route: npm against the persistent tools
      // prefix (spec pins @latest), which the runtime resolves ahead of any
      // stale copy. Live sessions restart so nothing runs the old binary.
      const adapter = getHarnessById("omp");
      if (!adapter?.installSpec) {
        return NextResponse.json({ error: "The omp engine is not installable here.", code: "not_installable" }, { status: 400 });
      }
      try {
        const currentVersion = await adapter.getVersion();
        await installEngine({ id: adapter.id, installSpec: adapter.installSpec, binaryName: adapter.binaryName, currentVersion });
      } catch (error) {
        const detail = error instanceof EngineInstallError ? error.detail : "";
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error), code: "update_failed", ...(detail ? { detail } : {}) },
          { status: 500 },
        );
      }
      invalidateOmpCliCache();
      const sessionsRestarted = await restartAllRpcSessions().catch(() => 0);
      // A version probe can succeed while RPC-mode boot is broken, so health
      // is a real throwaway RPC round-trip. On failure, name the escape
      // hatch: the recorded previous version in the engine card.
      let healthy = true;
      let healthError: string | null = null;
      try {
        await runIsolatedUtilityCommand({ type: "get_state" });
      } catch (error) {
        healthy = false;
        healthError = error instanceof Error ? error.message : String(error);
      }
      const previousVersion = readInstallHistory().omp?.previousVersion ?? null;
      return NextResponse.json({
        success: healthy,
        version: await adapter.getVersion(),
        sessionsRestarted,
        healthy,
        ...(healthError ? { error: `The updated engine failed a health check: ${healthError}${previousVersion ? ` (revert to v${previousVersion} from Settings, System & Updates)` : ""}`, code: "unhealthy_after_update" } : {}),
      }, healthy ? undefined : { status: 502 });
    }
    if (body.action === "restart") {
      const sessionsRestarted = await restartAllRpcSessions();
      return NextResponse.json({ success: true, sessionsRestarted });
    }
    return NextResponse.json({ error: "action must be check, update or restart", code: "invalid_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
