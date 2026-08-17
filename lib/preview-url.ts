/**
 * Loopback preview URL logic shared by the Preview panel, the agent-facing
 * open_preview host tool, and the assistant-text auto-open detection.
 *
 * Only loopback origins are previewable: Cody's CSP frame-src is restricted to
 * localhost/127.0.0.1 (any port), and embedding arbitrary origins in an
 * authenticated tool would be a phishing surface. Everything else gets the
 * "open in its own window" affordance instead.
 */

/**
 * Hosts that mean "this machine" but that the CSP source list cannot express.
 * Wildcard binds (0.0.0.0, [::]) are what dev servers print when listening on
 * all interfaces; bracketed IPv6 loopback cannot carry a port wildcard in CSP
 * (browsers reject "http://[::1]:*" outright). All of them canonicalize to
 * localhost, which resolves to ::1 anyway on dual-stack hosts.
 */
const LOCALHOST_ALIASES = new Set(["0.0.0.0", "[::]", "[::1]", "[0:0:0:0:0:0:0:1]"]);

export function normalizePreviewUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (LOCALHOST_ALIASES.has(host)) {
    url.hostname = "localhost";
  } else if (host !== "localhost" && host !== "127.0.0.1") {
    return null;
  }
  return url.toString();
}

/**
 * Loopback URLs mentioned in assistant prose ("running at
 * http://localhost:3000"). Scheme-ful matches only: bare host:port shapes in
 * running text are too ambiguous to auto-open a panel over. Trailing
 * punctuation and markdown/link delimiters are not part of the URL.
 */
const LOOPBACK_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[0:0:0:0:0:0:0:1\])(?::\d{1,5})?(?:\/[^\s<>"'`)\]]*)?/gi;

const MAX_EXTRACTED_URLS = 3;

export function extractLoopbackUrls(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LOOPBACK_URL_PATTERN)) {
    // The path class excludes closers but not dots/commas, so a match at the
    // end of a sentence can drag its punctuation along ("…/app.").
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    const normalized = normalizePreviewUrl(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(normalized);
    if (found.length >= MAX_EXTRACTED_URLS) break;
  }
  return found;
}

/**
 * True when something answers at the URL. An opaque no-cors response still
 * proves a server answered; a network error means nothing is listening. The
 * page's CSP connect-src already allows loopback origins.
 */
export async function probeLoopbackUrl(url: string, timeoutMs = 4_000): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
