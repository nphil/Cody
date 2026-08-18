import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { getUserForCredentials, isAuthRequired } from "@/lib/auth/guard";
import { buildContentSecurityPolicy } from "@/lib/display/csp";

/**
 * The auth perimeter. Every request passes through here; a browser signs in on
 * /login and carries a signed session cookie, a native client sends
 * `Authorization: Bearer cody_pat_…`, and HTTP Basic with CODY_PASSWORD keeps
 * working for scripts, health probes and the pre-account contract. All three
 * resolve through lib/auth/guard.ts, so this file never learns to tell them
 * apart — an unauthenticated API request is 401 JSON and unauthenticated HTML
 * still redirects to /login, whichever credential was missing.
 *
 * When neither account nor password exists (bare `npm run dev` on loopback),
 * the perimeter is open — creating the first account arms it.
 */

/** Paths a signed-out visitor needs: the login screen itself, the account
 * routes that power it, and the hashed build assets it renders with. */
const PUBLIC_PREFIXES = ["/_next/static", "/_next/image", "/login", "/api/accounts/state", "/api/accounts/login", "/api/accounts/signup"];
const PUBLIC_EXACT = new Set([
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
  "/manifest.webmanifest",
  // The PWA surface: install probes and the service worker fetch signed-out.
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/api/internal/display",
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAuthRequired() && !isPublicPath(pathname)) {
    const user = getUserForCredentials(request.headers.get("cookie"), request.headers.get("authorization"));
    if (!user) {
      if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) {
        // No WWW-Authenticate here: a challenge would summon the browser's
        // native Basic dialog over the login screen. Non-browser clients send
        // Basic proactively (curl -u, the container healthcheck matches on
        // status), so nothing depends on being challenged first.
        return NextResponse.json(
          { error: "Authentication required", code: "auth_required" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }
      const login = request.nextUrl.clone();
      login.pathname = "/login";
      login.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname + request.nextUrl.search)}` : "";
      return NextResponse.redirect(login, { headers: { "Cache-Control": "no-store" } });
    }
  }

  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", buildContentSecurityPolicy());
  return response;
}

export const config = { matcher: "/:path*" };
