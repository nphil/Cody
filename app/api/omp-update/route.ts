import { NextResponse } from "next/server";
import { getHarnessById } from "@/lib/harness";
import { EngineInstallError, installEngine } from "@/lib/harness/install";
import { invalidateOmpCliCache } from "@/lib/omp/omp-cli";
import { checkOmpUpdate } from "@/lib/omp/updates";
import { restartAllRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown };
    if (body.action === "check") return NextResponse.json(await checkOmpUpdate());
    if (body.action === "update") {
      // Same mechanism as the engine card: npm against the persistent tools
      // prefix (spec pins @latest), which the runtime resolves ahead of any
      // stale copy. Live sessions restart so nothing runs the old binary.
      const adapter = getHarnessById("omp");
      if (!adapter?.installSpec) {
        return NextResponse.json({ error: "The omp engine is not installable here.", code: "not_installable" }, { status: 400 });
      }
      try {
        await installEngine({ id: adapter.id, installSpec: adapter.installSpec, binaryName: adapter.binaryName });
      } catch (error) {
        const detail = error instanceof EngineInstallError ? error.detail : "";
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error), code: "update_failed", ...(detail ? { detail } : {}) },
          { status: 500 },
        );
      }
      invalidateOmpCliCache();
      const sessionsRestarted = await restartAllRpcSessions().catch(() => 0);
      return NextResponse.json({ success: true, version: await adapter.getVersion(), sessionsRestarted });
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
