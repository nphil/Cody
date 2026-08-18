import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/auth/http";
import { revokeAccessToken } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

/**
 * Revoke one of this account's tokens. Takes effect on the next request: the
 * digest is gone, so verification finds nothing to match.
 *
 * A token id that belongs to someone else answers the same 404 as one that
 * never existed — the route must not confirm another account's token ids. A
 * bearer credential is allowed here so a native client can forget its own
 * token; only minting is restricted.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const { id } = await params;
  if (!revokeAccessToken(resolved.user.id, id)) {
    return jsonError("Access token not found", 404, "token_not_found");
  }
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
