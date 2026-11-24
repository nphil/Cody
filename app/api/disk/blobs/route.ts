import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";
import { runBlobSweep } from "@/lib/omp/gc-blobs";

/**
 * Settings › System › Disk space › What is using space: free the engine's
 * unreferenced blobs with its own sweep (`omp gc --blobs`). GET previews what
 * would go, POST does it. Admin-only (or open on an instance with no accounts).
 * Any other engine answers `unsupported`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

async function respond(request: Request, apply: boolean): Promise<NextResponse> {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  if (getHarness().id !== "omp") return jsonError("This engine cannot sweep blobs.", 404, "unsupported");
  try {
    return NextResponse.json({ apply, ...(await runBlobSweep(apply)) }, NO_STORE);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502, "gc_failed");
  }
}

export const GET = (request: Request) => respond(request, false);
export const POST = (request: Request) => respond(request, true);
