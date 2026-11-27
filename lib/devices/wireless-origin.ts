import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isLoopbackHost } from "../display/ladder";
import { readEnv } from "../env";

const HEADER = "x-cody-internal-wireless-origin";
const KEY = "CODY_INTERNAL_WIRELESS_ORIGIN_KEY";
const WIRELESS = "/api/devices/wireless";
const AUTHORITY = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

function originFor(protocol: "http" | "https", host: string | undefined): URL | undefined {
  if (!host || !AUTHORITY.test(host)) return;
  try { return new URL(`${protocol}://${host}`); } catch { return; }
}

/** Canonicalize literal IPs only, including an IPv4 peer on a dual-stack listener. */
function address(value: string | undefined): string | undefined {
  if (!value) return;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes("%")) return;
  const ip = new URL(`http://[${value}]`).hostname;
  const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(ip);
  if (!mapped) return ip;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function mac(key: string, origin: string): Buffer {
  return createHmac("sha256", key).update(origin).digest();
}

/** The custom launcher calls this on the original HTTP socket, before passing requests to Next. */
export function createWirelessOriginGate(env: NodeJS.ProcessEnv = process.env): (request: IncomingMessage, upgraded?: boolean) => void {
  const key = env[KEY] = randomBytes(32).toString("base64url");
  const publicHost = /^https:\/\/([^/]+)\/?$/.exec(readEnv("PUBLIC_ORIGIN", env) ?? "")?.[1];
  const publicOrigin = originFor("https", publicHost)?.origin;
  const proxy = address(readEnv("TRUSTED_PROXY_IP", env));
  return (request, upgraded) => {
    const { headers, rawHeaders, socket } = request;
    if (Object.hasOwn(headers, HEADER)) {
      delete headers[HEADER];
      for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
        if (rawHeaders[i].toLowerCase() === HEADER) rawHeaders.splice(i, 2);
      }
    }
    if (upgraded || !request.url?.startsWith(WIRELESS)) return;
    const pathname = request.url.split("?", 1)[0];
    if (pathname !== WIRELESS && pathname !== `${WIRELESS}/shell`) return;

    const peer = address(socket.remoteAddress);
    const forwarded = headers["x-forwarded-proto"];
    let origin: string | undefined;
    if (publicOrigin && proxy && peer === proxy && forwarded === "https"
        && originFor("https", headers.host)?.origin === publicOrigin) {
      origin = publicOrigin;
    } else if (isLoopbackHost(peer) && isLoopbackHost(address(socket.localAddress))
        && forwarded === undefined && headers["x-forwarded-host"] === undefined
        && headers["x-forwarded-for"] === undefined && headers["x-forwarded-ssl"] === undefined && headers.forwarded === undefined) {
      const direct = originFor("http", headers.host);
      if (direct && isLoopbackHost(direct.hostname)) origin = direct.origin;
    }
    // Sign the assertion so using a raw Next listener cannot bypass the launcher either.
    if (origin) headers[HEADER] = `${origin} ${mac(key, origin).toString("base64url")}`;
  };
}

export function verifiedWirelessOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env[KEY];
  const proof = request.headers.get(HEADER);
  if (!key || !proof) return;
  const boundary = proof.indexOf(" ");
  if (boundary < 1) return;
  const signature = proof.slice(boundary + 1);
  if (!/^[a-z0-9_-]{43}$/i.test(signature)) return;
  const origin = proof.slice(0, boundary);
  if (timingSafeEqual(Buffer.from(signature, "base64url"), mac(key, origin))) return origin;
}
