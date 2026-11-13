import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { getEngineDbStatus, runEngineDbCheck } from "@/lib/omp/engine-db";
import { isRecord } from "@/lib/type-guards";

/**
 * Settings › System › Engine database: the health of omp's own store (saved
 * logins, settings, caches), the last check and repair, and two buttons.
 *
 * Admin-only (or open on an instance with no accounts): the store is shared by
 * everyone and a repair rewrites part of it. `repair` here is the same guarded
 * repair the hourly housekeeping runs: it only ever rebuilds tables the engine
 * refills, and refuses when the damage reaches logins or settings. An engine
 * that is not omp answers `unsupported`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function refuse(request: Request): NextResponse | null {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  if (getHarness().id !== "omp") return jsonError("This engine has no database for Cody to check.", 404, "unsupported");
  return null;
}

export async function GET(request: Request) {
  const refused = refuse(request);
  if (refused) return refused;
  return NextResponse.json(await getEngineDbStatus(), NO_STORE);
}

export async function POST(request: Request) {
  const refused = refuse(request);
  if (refused) return refused;
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  const action = isRecord(body) ? body.action : undefined;
  if (action !== "check" && action !== "repair") return jsonError("Invalid request body", 400, "invalid_request");
  return NextResponse.json(await runEngineDbCheck(action === "repair" ? "auto" : "never"), NO_STORE);
}
