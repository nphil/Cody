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
 * The dev server's own origin, reachable from the owner's tablet whenever the
 * server bound 0.0.0.0: same port, same path, but the container's routable
 * IPv4 address instead of loopback. Probed per interface, concurrently, so a
 * multi-homed container does not serialize timeouts.
 */
async function directCandidates(target: URL): Promise<DisplayCandidate[]> {
  const hosts = new Set<string>();
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
  const direct = mode === "native" ? [] : await directCandidates(target);
  const native = nativeCandidate(target);
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
  proxy.on("proxyReq", (proxyReq, request) => {
    proxyReq.removeHeader("cookie");
    proxyReq.removeHeader("authorization");
    const route = routeForHost(request.headers.host);
    if (route) {
      proxyReq.setHeader("origin", route.targetOrigin);
      proxyReq.setHeader("referer", `${route.targetOrigin}/`);
    }
  });
  proxy.on("proxyReqWs", (proxyReq, request) => {
    proxyReq.removeHeader("cookie");
    proxyReq.removeHeader("authorization");
    const route = routeForHost(request.headers.host);
    if (route) proxyReq.setHeader("origin", route.targetOrigin);
  });
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
