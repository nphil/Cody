import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import HttpProxyServer from "http-proxy";
import type { DisplayRequestMode, DisplayTransport } from "./types";
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

export function resolveDisplayTransport(sourceUrl: string, mode: DisplayRequestMode): { transport: DisplayTransport; nativeUrl?: string } {
  const base = configuredBase();
  if (!base || mode === "stream") return { transport: "stream" };
  const target = new URL(normalizeLoopbackUrl(sourceUrl));
  const token = randomBytes(18).toString("hex");
  prune();
  state().routes.set(token, { token, targetOrigin: target.origin, expiresAt: Date.now() + ROUTE_TTL_MS });
  const publicUrl = new URL(base.toString());
  publicUrl.hostname = `${token}.${base.hostname}`;
  publicUrl.pathname = target.pathname;
  publicUrl.search = target.search;
  publicUrl.hash = target.hash;
  return { transport: "native", nativeUrl: publicUrl.toString() };
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
