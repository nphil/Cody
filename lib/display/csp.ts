import { networkInterfaces } from "node:os";

/**
 * The `Content-Security-Policy` every response carries (applied in `proxy.ts`).
 *
 * THREAT MODEL — why `frame-src` reaches past loopback
 * ---------------------------------------------------
 * The Preview panel's top rung is a REAL iframe against the dev server the
 * agent started. The operator reaches Cody over LAN/Tailscale at this
 * container's own address, so a dev server bound to `0.0.0.0` is already
 * reachable from their tablet — a live page beats a video of one, and the
 * raster stream stays as the guaranteed floor beneath it.
 *
 * Every host added below is an origin the operator's own device can ALREADY
 * reach on a trusted network; framing it grants no new reachability (a
 * cross-origin document still cannot be read) and only lets the Preview panel
 * show the real thing. Public-internet origins stay unframeable: no bare `*`,
 * no `http:`/`https:` scheme-source, and a non-private interface address is
 * deliberately excluded even though a `direct` candidate may name one.
 * `script-src`/`style-src`/`object-src` are untouched — this widens what we
 * may EMBED, never what we may EXECUTE.
 *
 * CSP SYNTAX — why these are exact hosts and not ranges
 * ----------------------------------------------------
 * CSP host-source has no CIDR notation, and its host grammar accepts a
 * wildcard only as the leftmost LABEL (as the gateway's `*.<base host>` entry
 * below uses) — never inside an octet.
 * Chromium rejects `http://192.168.*.*:*` outright ("contains an invalid
 * source: ... It will be ignored"), which would silently collapse `frame-src`
 * and block every direct preview. So RFC1918/CGNAT coverage is expressed as
 * the exact private addresses THIS host answers on — precisely the set
 * `direct` candidates are built from. Bracketed IPv6 host-sources
 * (`http://[fd00::1]:*`) are rejected by Chromium too, so IPv6 is omitted;
 * direct candidates are IPv4-only for the same reason.
 */

/** Loopback: the agent's own dev servers, the original preview case. */
const LOOPBACK_SOURCES = ["http://localhost:*", "http://127.0.0.1:*", "https://localhost:*", "https://127.0.0.1:*"];

// No MagicDNS entry: candidates are minted server-side as raw interface IPv4
// literals, so no code path can produce a `.ts.net` frame src or probe target.
// If we ever mint MagicDNS-based candidates, add this host's OWN tailnet domain
// (`*.<tailnet>.ts.net`) here — never the whole `*.ts.net` space.

/** RFC1918 private space, plus Tailscale's CGNAT range. */
function isTrustedPrivateV4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private (Docker bridges live here)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private (typical home LAN / br0)
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 — CGNAT, Tailscale's tailnet addresses
}

/**
 * This host's own private addresses, any port — the exact origins `direct`
 * candidates target. Re-read periodically rather than frozen at boot, because
 * `tailscale0` may appear after Cody starts.
 */
function privateInterfaceSources(): string[] {
  const sources: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || !isTrustedPrivateV4(entry.address)) continue;
      const insecure = `http://${entry.address}:*`;
      if (sources.includes(insecure)) continue; // one address may be listed on several interfaces
      sources.push(insecure, `https://${entry.address}:*`);
    }
  }
  return sources;
}

/** The optional `CODY_PREVIEW_BASE_URL` gateway's wildcard-subdomain origin. */
function previewFrameSource(): string | null {
  const raw = process.env.CODY_PREVIEW_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const base = new URL(raw);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.pathname !== "/") return null;
    return `${base.protocol}//*.${base.host}`;
  } catch {
    return null;
  }
}

function composePolicy(): string {
  // Shared by frame-src and connect-src: the client probes a candidate with a
  // no-cors fetch before committing to it, and a framed dev server's HMR
  // socket dials back out.
  const previewable = [...LOOPBACK_SOURCES, ...privateInterfaceSources()];
  const native = previewFrameSource();
  if (native) previewable.push(native);
  const hosts = previewable.join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `frame-src 'self' ${hosts}`,
    "object-src 'none'",
    "worker-src 'self'",
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    `connect-src 'self' ws: wss: ${hosts}`,
    "font-src 'self' data:",
  ].join("; ");
}

/**
 * Middleware runs this on every request, so the composed string is memoized.
 * The TTL (rather than a permanent memo) is what lets a newly-joined tailnet
 * interface become previewable without a restart.
 */
const POLICY_TTL_MS = 30_000;
let cached: { value: string; expiresAt: number } | null = null;

export function buildContentSecurityPolicy(): string {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const value = composePolicy();
  cached = { value, expiresAt: now + POLICY_TTL_MS };
  return value;
}
