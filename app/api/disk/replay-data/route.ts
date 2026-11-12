import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";
import { runReplayStrip } from "@/lib/omp/gc-strip";

/**
 * Settings › System › Disk: free the replay data (thinking signatures,
 * encrypted reasoning, cached replies) that omp keeps in chats nobody has
 * touched for a while. GET previews what would be freed; POST does it.
 *
 * Admin-only (or open on an instance with no accounts): the strip rewrites
 * every person's idle chats. omp skips any chat a running process holds. An
 * engine that is not omp, or an omp older than 18.18.2, answers `unsupported`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

async function respond(request: Request, apply: boolean): Promise<NextResponse> {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  if (getHarness().id !== "omp") return jsonError("This engine cannot free replay data.", 404, "unsupported");
  try {
    const result = await runReplayStrip(apply);
    if (!result.supported) return jsonError("This omp is too old to free replay data (needs 18.18.2 or newer).", 404, "unsupported");
    return NextResponse.json({ apply, ...result }, NO_STORE);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502, "gc_failed");
  }
}

export const GET = (request: Request) => respond(request, false);
export const POST = (request: Request) => respond(request, true);
