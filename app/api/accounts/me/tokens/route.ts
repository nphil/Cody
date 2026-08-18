import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError, requireCredential } from "@/lib/auth/http";
import {
  issueAccessToken,
  listAccessTokens,
  toPublicAccessToken,
  validateTokenName,
  type IssuedAccessToken,
} from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

/**
 * The signed-in account's personal access tokens — the credential a native
 * client carries instead of a cookie (see docs/api.md and docs/android.md).
 * Per account, never shared, revocable one at a time.
 */
export function GET(request: Request) {
  const resolved = requireCredential(request);
  if ("response" in resolved) return resolved.response;
  return NextResponse.json(
    { tokens: listAccessTokens(resolved.credential.user.id).map(toPublicAccessToken) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Mint a token. The secret appears in this response and nowhere else, ever —
 * only its digest is stored, so a client that loses it revokes and mints again.
 *
 * A bearer credential may not mint another token: otherwise a leaked token
 * could quietly issue a successor and outlive its own revocation, which would
 * make the revoke button a lie. Minting needs an interactive credential (the
 * session cookie, or Basic with CODY_PASSWORD); listing and revoking do not, so
 * a native client can still show and forget its own token.
 */
export async function POST(request: Request) {
  const resolved = requireCredential(request);
  if ("response" in resolved) return resolved.response;
  const { user, kind } = resolved.credential;

  if (kind === "bearer") {
    return jsonError(
      "An access token cannot create another access token; sign in with your password to mint one",
      403,
      "bearer_forbidden",
    );
  }

  let body: { name?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const nameError = validateTokenName(name);
  if (nameError) return jsonError(nameError, 400, "invalid_token_name");

  // The name is validated above, so the store's only remaining objection is the
  // per-account cap. Catching it here rather than pre-checking keeps one source
  // of the limit and answers a concurrent double-mint with 403 instead of 500.
  let issued: IssuedAccessToken;
  try {
    issued = issueAccessToken(user, name);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create the access token", 403, "token_limit");
  }

  const { secret, token } = issued;
  return NextResponse.json(
    { token: toPublicAccessToken(token), secret },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
