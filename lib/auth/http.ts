import { NextResponse } from "next/server";
import { getRequestCredential, isAuthRequired, type ResolvedCredential } from "./guard";
import type { UserRecord } from "./users";

/**
 * Shared request plumbing for the /api/accounts routes. Account routes always
 * resolve a concrete user — except on an open instance (no accounts, no
 * password), where profile routes have nobody to act for and answer 404-ish
 * states the UI treats as "accounts not set up yet".
 */

export function jsonError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
}

/** The signed-in account plus which credential it arrived with, or a
 * ready-to-return 401. Routes that only need identity use requireUser; this
 * exists because minting an access token must not be something an access token
 * can do. */
export function requireCredential(request: Request): { credential: ResolvedCredential } | { response: NextResponse } {
  const credential = getRequestCredential(request);
  if (!credential) {
    return {
      response: isAuthRequired()
        ? jsonError("Authentication required", 401, "auth_required")
        : jsonError("No accounts exist yet", 409, "no_accounts"),
    };
  }
  return { credential };
}

/** The signed-in account, or a ready-to-return 401. */
export function requireUser(request: Request): { user: UserRecord } | { response: NextResponse } {
  const resolved = requireCredential(request);
  if ("response" in resolved) return resolved;
  return { user: resolved.credential.user };
}

/** The signed-in admin, or a ready-to-return 401/403. */
export function requireAdmin(request: Request): { user: UserRecord } | { response: NextResponse } {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved;
  if (resolved.user.role !== "admin") {
    return { response: jsonError("Administrator access required", 403, "admin_required") };
  }
  return resolved;
}
