import { readEnv } from "../env";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "../web-auth";
import { sessionTokenFromCookieHeader, verifySessionToken } from "./session";
import { ENV_MANAGED_USERNAME, findUserByUsername, hasAnyUser, type UserRecord } from "./users";

/**
 * The one place that answers "who is making this request". Two credentials are
 * accepted, in order:
 *
 *  1. The signed session cookie — every browser sign-in, including the
 *     env-managed account after it logs in through the form.
 *  2. HTTP Basic with CODY_PASSWORD — the pre-account contract. Scripts,
 *     health probes and bookmarked `cody:pass@host` URLs keep working, and it
 *     resolves to the env-managed account so ownership still attaches.
 *
 * Auth is required once any account exists or CODY_PASSWORD is set. A bare
 * `npm run dev` on loopback with neither stays open, exactly as before the
 * account system existed; creating the first account is what locks the door.
 *
 * CODY_REQUIRE_ACCOUNTS=1 (set by the container entrypoint, which binds
 * 0.0.0.0) closes the zero-account window: auth is required from the first
 * request, so a fresh install shows only the first-run setup screen — where
 * the person opening it creates the admin account — instead of an open app.
 */

export function isAuthRequired(): boolean {
  return isWebPasswordEnabled() || hasAnyUser() || readEnv("REQUIRE_ACCOUNTS") === "1";
}

export function getUserForCredentials(
  cookieHeader: string | null | undefined,
  authorizationHeader: string | null | undefined,
): UserRecord | null {
  const fromCookie = verifySessionToken(sessionTokenFromCookieHeader(cookieHeader));
  if (fromCookie) return fromCookie;
  if (isValidBasicAuthorization(authorizationHeader ?? null)) {
    return findUserByUsername(ENV_MANAGED_USERNAME);
  }
  return null;
}

/** Request-level convenience for API route handlers. */
export function getRequestUser(request: Request): UserRecord | null {
  return getUserForCredentials(request.headers.get("cookie"), request.headers.get("authorization"));
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
