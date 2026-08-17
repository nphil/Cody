import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { checkEngineUpdates } from "@/lib/harness/updates";

// GET /api/engines/updates[?force=1] — npm-registry update status for every
// installed engine (admin only, mirroring the install routes). Results are
// cached ~10 minutes server-side; force=1 (the card's "Check for updates"
// button) bypasses the cache.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  const force = new URL(request.url).searchParams.get("force") === "1";
  const updates = await checkEngineUpdates(force);
  return NextResponse.json({ updates }, { headers: { "Cache-Control": "no-store" } });
}
