import { readEnv } from "../env";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "../web-auth";
import { sessionTokenFromCookieHeader, verifySessionToken } from "./session";
import { bearerTokenFromAuthorizationHeader, verifyAccessToken } from "./tokens";
import { ENV_MANAGED_USERNAME, findUserByUsername, hasAnyUser, type UserRecord } from "./users";

/**
 * The one place that answers "who is making this request". Three credentials are
 * accepted, in order:
 *
 *  1. The signed session cookie — every browser sign-in, including the
 *     env-managed account after it logs in through the form.
 *  2. `Authorization: Bearer cody_pat_…` — a personal access token from
 *     lib/auth/tokens.ts. Same accounts, same tokenVersion revocation; this is
 *     what native clients carry, because a cookie jar on a phone is awkward and
 *     a token can be revoked on its own without signing the browser out.
 *  3. HTTP Basic with CODY_PASSWORD — the pre-account contract. Scripts,
 *     health probes and bookmarked `cody:pass@host` URLs keep working, and it
 *     resolves to the env-managed account so ownership still attaches.
 *
 * Both header credentials live in Authorization, so at most one of 2 and 3 can
 * be present on a request and their relative order is a formality.
 *
 * Auth is required once any account exists or CODY_PASSWORD is set. A bare
 * `npm run dev` on loopback with neither stays open, exactly as before the
 * account system existed; creating the first account is what locks the door.
 *
 * CODY_REQUIRE_ACCOUNTS=1 (set by the container entrypoint, which binds
 * 0.0.0.0) closes the zero-account window: auth is required from the first
 * request, so a fresh install shows only the first-run setup screen — where
 * the person opening it creates the admin account — instead of an open app.
 *
 * Everything must keep flowing through here: the proxy perimeter, every API
 * route, and the launcher's WebSocket upgrade gate all resolve identity with
 * these functions, which is why adding a credential is a change to this file
 * and not to any of them.
 */

export function isAuthRequired(): boolean {
  return isWebPasswordEnabled() || hasAnyUser() || readEnv("REQUIRE_ACCOUNTS") === "1";
}

/** Which credential a request arrived with. Callers that only need identity use
 * getUserForCredentials; this exists because minting an access token must not be
 * something an access token can do. */
export type CredentialKind = "cookie" | "bearer" | "basic";

export interface ResolvedCredential {
  user: UserRecord;
  kind: CredentialKind;
}

export function resolveCredentials(
  cookieHeader: string | null | undefined,
  authorizationHeader: string | null | undefined,
): ResolvedCredential | null {
  const fromCookie = verifySessionToken(sessionTokenFromCookieHeader(cookieHeader));
  if (fromCookie) return { user: fromCookie, kind: "cookie" };

  const fromToken = verifyAccessToken(bearerTokenFromAuthorizationHeader(authorizationHeader));
  if (fromToken) return { user: fromToken, kind: "bearer" };

  if (isValidBasicAuthorization(authorizationHeader ?? null)) {
    const envUser = findUserByUsername(ENV_MANAGED_USERNAME);
    if (envUser) return { user: envUser, kind: "basic" };
  }
  return null;
}

export function getUserForCredentials(
  cookieHeader: string | null | undefined,
  authorizationHeader: string | null | undefined,
): UserRecord | null {
  return resolveCredentials(cookieHeader, authorizationHeader)?.user ?? null;
}

/** Request-level convenience for API route handlers. */
export function getRequestUser(request: Request): UserRecord | null {
  return getUserForCredentials(request.headers.get("cookie"), request.headers.get("authorization"));
}

export function getRequestCredential(request: Request): ResolvedCredential | null {
  return resolveCredentials(request.headers.get("cookie"), request.headers.get("authorization"));
}

/** Throws a 401-shaped error unless the request is authenticated (or auth is
 * off). Routes use this at the top; the proxy already gates, but routes that
 * mutate account state double-check rather than trust the perimeter. */
export function requireRequestUser(request: Request): UserRecord | null {
  if (!isAuthRequired()) return null;
  const user = getRequestUser(request);
  if (!user) {
    const error = new Error("Authentication required") as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return user;
}
