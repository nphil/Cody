function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : requestUrl.origin;
}

/**
 * Reject browser cross-site API requests while preserving non-browser clients
 * and ordinary navigations.
 *
 * CSRF is forged use of AMBIENT CREDENTIALS, so a request carrying none (no
 * cookie, no authorization) is allowed outright: there is nothing to forge
 * with, and rejecting it breaks legitimate credential-stripping proxies. The
 * preview gateway is exactly that — it strips cookies/authorization and
 * rewrites Origin to the target's own origin, while an outer TLS-terminating
 * proxy (Caddy) may stamp x-forwarded-proto: https; comparing that rewritten
 * http Origin against an https-forwarded self-origin read every asset fetch
 * as "cross-origin" and 403'd the whole bundle.
 *
 * Cross-site GET/HEAD *navigations* (a link into Cody from anywhere, the
 * preview gateway's iframe, its detach-to-tab) are allowed even with
 * credentials: navigating is how browsers arrive at any site, it carries no
 * CSRF risk (mutating GET endpoints are bugs by contract), and the
 * SameSite=Lax session cookie stays off cross-site iframe loads regardless.
 * Everything else cross-site with credentials — fetch()/XHR (sec-fetch-mode
 * "cors"/"no-cors") and non-GET navigations (the cross-site form post, the
 * classic CSRF vector) — is refused.
 */
export function isApiRequestOriginAllowed(request: Request): boolean {
  if (!request.headers.has("cookie") && !request.headers.has("authorization")) {
    return true;
  }
  const method = request.method.toUpperCase();
  if ((method === "GET" || method === "HEAD") && request.headers.get("sec-fetch-mode") === "navigate") {
    return true;
  }
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const requestOrigin = getRequestOrigin(request);
  return requestOrigin !== null && canonicalOrigin(origin) === requestOrigin;
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}
