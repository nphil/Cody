import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";
import { composeProviderDirectory } from "@/lib/provider-directory-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/providers[?cached=1] — the Providers hub's one list for the
 * ACTIVE engine: every provider the engine can reach, joined from its own
 * sign-in roster, Cody's key store (flags, never values), its effective
 * model catalog (counts per provider) and its own registry file, as
 * `ProvidersResponse` (lib/provider-directory.ts). Any signed-in user may
 * read it; `canEdit` says whether this caller may change anything.
 *
 * `?cached=1` is the rail's status line: it never starts an engine child,
 * serving the last roster this process saw and peeking the models cache,
 * and marks what it could not answer `pending`. A spawn or RPC failure on
 * the full read lands on the rows as `modelCount: null` plus `reason` —
 * this route does not answer 500 for a fact about the engine.
 */
export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  const cached = new URL(request.url).searchParams.get("cached") === "1";
  const body = await composeProviderDirectory(getHarness(), { cached, canEdit: resolved.user.role === "admin" });
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
