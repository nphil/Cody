import { NextResponse } from "next/server";
import { requireEngine } from "@/lib/engine-guard";
import { invalidateModelsCache } from "@/lib/models-cache";
import { clearModelRoles, readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";
import { restartIdleRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * Model roles live in omp's own `config.yml` and are consumed by omp's role
 * resolver. Served unguarded they reached every engine — the composer's
 * "Smart" row is gated on `chatExtras`, which pi also has, so a pi session's
 * Smart pick was resolved from omp's roles. `unsupported` is the honest
 * answer; the composer already treats a failed lookup as "no Smart model".
 */
const SURFACE = "Model roles";

export function GET() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    return NextResponse.json(readModelRoles());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const body = await request.json() as { roles?: unknown };
    if (!body.roles || typeof body.roles !== "object" || Array.isArray(body.roles)) {
      return NextResponse.json({ error: "roles must be an object" }, { status: 400 });
    }
    const roles = Object.fromEntries(Object.entries(body.roles).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0].trim().length > 0 && entry[1].trim().length > 0,
    ));
    writeModelRoles(roles);
    invalidateModelsCache();
    const { restarted, active } = await restartIdleRpcSessions();
    return NextResponse.json({ success: true, roles, restarted, active });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

/** Reset to OMP defaults: drop the modelRoles section so omp's built-in
 * per-role priorities apply, exactly as on a fresh install. */
export async function DELETE() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const cleared = clearModelRoles();
    invalidateModelsCache();
    const { restarted, active } = await restartIdleRpcSessions();
    return NextResponse.json({ success: true, cleared, restarted, active });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
