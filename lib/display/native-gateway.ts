import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import HttpProxyServer from "http-proxy";
import type { DisplayCandidate, DisplayRequestMode } from "./types";
import { normalizeLoopbackUrl } from "./validation";

interface NativeRoute {
  token: string;
  targetOrigin: string;
  expiresAt: number;
}

interface NativeState {
  routes: Map<string, NativeRoute>;
  proxy: HttpProxyServer | null;
}

declare global {
  var __codyNativeDisplayState: NativeState | undefined;
}

const ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROUTES = 128;

/**
 * Direct probes fan out over every routable interface at once, so this bounds
 * the whole DIRECT rung rather than each address. Long enough for a dev server
 * that is mid-compile, short enough that open_preview still feels immediate.
 */
const DIRECT_PROBE_TIMEOUT_MS = 1_500;

function state(): NativeState {
  return globalThis.__codyNativeDisplayState ??= { routes: new Map(), proxy: null };
}

function configuredBase(): URL | null {
  const raw = process.env.CODY_PREVIEW_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/") return null;
    return url;
  } catch {
    return null;
  }
}

function prune(): void {
  const current = state();
  const now = Date.now();
  for (const [token, route] of current.routes) if (route.expiresAt <= now) current.routes.delete(token);
  while (current.routes.size > MAX_ROUTES) current.routes.delete(current.routes.keys().next().value as string);
}

/**
 * True when a socket is bound at the URL. Any HTTP answer proves it — a 404 or
 * 500 still means the dev server is listening on that interface. Only a
 * connection failure (or the timeout) disqualifies an address.
 */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS) });
    void response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Every origin that serves the dev server AS ITSELF, best first:
 *
 *  1. The loopback origin we were handed. When Cody runs beside its browser —
 *     the Windows desktop shell, an on-device Android build, plain
 *     `npm run dev` — this is the whole answer: the real page, no hops, no
 *     configuration, and no Chromium to run. Clients that are NOT on this
 *     machine discard it (see lib/display/ladder.ts); it is offered, not
 *     imposed.
 *  2. The container's routable addresses, for a browser elsewhere on the LAN or
 *     tailnet — same port and path, reachable only if the dev server bound
 *     0.0.0.0. Probed per interface, concurrently, so a multi-homed host does
 *     not serialize timeouts.
 */
async function directCandidates(target: URL): Promise<DisplayCandidate[]> {
  const hosts = new Set<string>([target.hostname]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") continue;
      hosts.add(address.address);
    }
  }
  const probed = await Promise.all([...hosts].map(async (host): Promise<DisplayCandidate | null> => {
    const candidate = new URL(target.toString());
    candidate.hostname = host;
    return (await answers(new URL("/", candidate).toString())) ? { kind: "direct", url: candidate.toString(), host } : null;
  }));
  return probed.filter((candidate): candidate is DisplayCandidate => candidate !== null);
}

/**
 * Whether the gateway could usefully render this target: it must answer a
 * cookie-less request with a 2xx. The gateway strips credentials in BOTH
 * directions (see getProxy below), so an auth-gated target could at most
 * render a login form whose session cookie is discarded — a dead end — and a
 * Cody dev server's cross-site guard answers plain 403 JSON. Such targets are
 * simply not offered this rung; the streamed rung is their fidelity floor and
 * always present. Framing headers are deliberately NOT probed: getProxy
 * removes x-frame-options and the frame-ancestors directive when it re-serves
 * the response under the gateway's own origin, like any port-forwarding
 * preview proxy.
 *
 * Do NOT "fix" auth-gated targets by forwarding cookies through the gateway:
 * set-cookie pass-through would let a previewed dev server toss cookies onto
 * the parent preview domain — session fixation against Cody itself.
 */
async function gatewayRenderable(target: URL): Promise<boolean> {
  try {
    const response = await fetch(target, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS) });
    void response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** Mints a single-use wildcard-subdomain route through Cody's own origin. */
function nativeCandidate(target: URL): DisplayCandidate | null {
  const base = configuredBase();
  if (!base) return null;
  const token = randomBytes(18).toString("hex");
  prune();
  state().routes.set(token, { token, targetOrigin: target.origin, expiresAt: Date.now() + ROUTE_TTL_MS });
  const publicUrl = new URL(base.toString());
  publicUrl.hostname = `${token}.${base.hostname}`;
  publicUrl.pathname = target.pathname;
  publicUrl.search = target.search;
  publicUrl.hash = target.hash;
  return { kind: "native", url: publicUrl.toString(), host: publicUrl.hostname };
}

/**
 * The fidelity ladder, best first: real-origin iframes the client can prove
 * routable, then the native gateway when one is configured, then the raster
 * stream as the floor that always works.
 */
export async function resolveDisplayCandidates(sourceUrl: string, mode: DisplayRequestMode): Promise<DisplayCandidate[]> {
  if (mode === "stream") return [{ kind: "stream" }];
  const target = new URL(normalizeLoopbackUrl(sourceUrl));
  const [direct, frameable] = await Promise.all([
    mode === "native" ? Promise.resolve<DisplayCandidate[]>([]) : directCandidates(target),
    configuredBase() === null ? Promise.resolve(false) : gatewayRenderable(target),
  ]);
  const native = frameable ? nativeCandidate(target) : null;
  return [...direct, ...(native ? [native] : []), { kind: "stream" }];
}

function routeForHost(hostHeader: string | undefined): NativeRoute | null {
  const base = configuredBase();
  if (!base || !hostHeader) return null;
  prune();
  const hostname = hostHeader.startsWith("[") ? hostHeader : hostHeader.split(":")[0].toLowerCase();
  const suffix = `.${base.hostname.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const token = hostname.slice(0, -suffix.length);
  if (!/^[a-f0-9]{36}$/.test(token)) return null;
  const route = state().routes.get(token);
  return route && route.expiresAt > Date.now() ? route : null;
}

export function isNativePreviewHost(hostHeader: string | undefined): boolean {
  return routeForHost(hostHeader) !== null;
}
function getProxy(): HttpProxyServer {
  const current = state();
  if (current.proxy) return current.proxy;
  const proxy = HttpProxyServer.createProxyServer({ ws: true, xfwd: true, changeOrigin: true, secure: false, autoRewrite: true });
  // Re-origination: the upstream must see a self-consistent local request.
  // Browser-sent origin/referer are TRANSLATED into the target's own origin —
  // never fabricated onto requests that carried none — and the outer edge's
  // forwarding metadata is overwritten with the target's reality: a
  // TLS-terminating proxy in front of Cody stamps x-forwarded-proto: https,
  // and an upstream that derives its self-origin from that while reading a
  // rewritten http Origin header sees a phantom cross-origin request.
  const toUpstreamHeaders = (proxyReq: import("node:http").ClientRequest, request: IncomingMessage) => {
    proxyReq.removeHeader("cookie");
    proxyReq.removeHeader("authorization");
    const route = routeForHost(request.headers.host);
    if (!route) return;
    const target = new URL(route.targetOrigin);
    proxyReq.setHeader("x-forwarded-proto", target.protocol.replace(":", ""));
    proxyReq.setHeader("x-forwarded-host", target.host);
    if (request.headers.origin) proxyReq.setHeader("origin", route.targetOrigin);
    if (request.headers.referer) proxyReq.setHeader("referer", `${route.targetOrigin}/`);
  };
  proxy.on("proxyReq", toUpstreamHeaders);
  proxy.on("proxyReqWs", toUpstreamHeaders);
  proxy.on("proxyRes", (proxyRes) => {
    delete proxyRes.headers["set-cookie"];
    delete proxyRes.headers["x-frame-options"];
    const csp = proxyRes.headers["content-security-policy"];
    if (typeof csp === "string") proxyRes.headers["content-security-policy"] = csp.replace(/(?:^|;)\s*frame-ancestors[^;]*/gi, "");
  });
  current.proxy = proxy;
  return proxy;
}

export function proxyNativeHttp(request: IncomingMessage, response: ServerResponse): boolean {
  const route = routeForHost(request.headers.host);
  if (!route) return false;
  getProxy().web(request, response, { target: route.targetOrigin }, (error: Error) => {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end(`Preview upstream unavailable: ${error.message}`);
  });
  return true;
}

export function proxyNativeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const route = routeForHost(request.headers.host);
  if (!route) return false;
  getProxy().ws(request, socket, head, { target: route.targetOrigin }, () => socket.destroy());
  return true;
}

export function closeNativeGateway(): void {
  state().proxy?.close();
  state().proxy = null;
}

export function previewFrameSource(): string | null {
  const base = configuredBase();
  return base ? `${base.protocol}//*.${base.host}` : null;
}
