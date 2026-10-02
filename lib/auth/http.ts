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

/**
 * The signed-in account, or `null` on an OPEN instance (no accounts, no
 * password) where whoever is looking acts for the instance itself — the same
 * reading `requireAdminOrOpenInstance` gives a write. For per-person
 * preferences that fall back to one instance-level record when there are no
 * people (lib/time-zone-prefs.ts). Any other failure is the ready-to-return
 * response.
 */
export function requireUserOrOpenInstance(request: Request): { user: UserRecord | null } | { response: NextResponse } {
  const resolved = requireCredential(request);
  if ("credential" in resolved) return { user: resolved.credential.user };
  return resolved.response.status === 409 ? { user: null } : resolved;
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

/**
 * Admin-only, except that "no accounts exist yet" (`no_accounts`) is not a
 * missing permission — it is the OPEN-INSTANCE case, where whoever is looking
 * is already treated as the administrator (the un-gated `/api/omp-settings`
 * PUT lets that same viewer write the engine's own config), so refusing an
 * instance-state write here would only make a feature inert rather than
 * protect anything.
 *
 * Null means "allowed"; a response means "return this". Used by the writes to
 * Cody-level instance state: the model catalog's seen ledger and Distill's
 * model chain.
 */
export function requireAdminOrOpenInstance(request: Request): NextResponse | null {
  const resolved = requireCredential(request);
  if ("response" in resolved) return resolved.response.status === 409 ? null : resolved.response;
  if (resolved.credential.user.role !== "admin") {
    return jsonError("Administrator access required", 403, "admin_required");
  }
  return null;
}
