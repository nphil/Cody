/**
 * The browser's half of wireless ADB: the two calls the Devices panel makes to `/api/devices/wireless`, how often it asks,
 * and the checks it makes on what a person typed before anything is sent. Pure (no React, no Node), so a test drives it with
 * a fake `fetch`.
 *
 * The pairing code is the one secret here. It exists only as an argument to `pairAction`'s caller and in the body of one
 * POST: it is never put in a URL, a header, storage or a message shown to the person (`scrub` removes it from errors).
 */
import type { WirelessAction, WirelessShellAction, WirelessSnapshot } from "./wireless-types";
import { WIRELESS_PAIRING_CODE_LENGTH } from "./wireless-types";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const ENDPOINT = "/api/devices/wireless";

interface WirelessPageContext {
  isSecureContext: boolean;
  location: { protocol: string; hostname: string };
}

function requireSecurePage(page: WirelessPageContext | undefined): void {
  // Check the scheme as well: a browser flag can make remote HTTP report isSecureContext.
  const loopback = page?.location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(page.location.hostname);
  if (page?.isSecureContext && (page.location.protocol === "https:" || loopback)) return;
  throw new WirelessRequestError("Open Cody over HTTPS to control wireless Android.", "secure_context_required");
}

/** A refusal or a failed call, with the server's code when it gave one. The message never contains a pairing code. */
export class WirelessRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "WirelessRequestError";
  }
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (!response.ok) {
    const message = typeof record.error === "string" && record.error ? record.error : `The server answered ${response.status}.`;
    throw new WirelessRequestError(message, typeof record.code === "string" ? record.code : undefined, response.status);
  }
  return record;
}

async function answer(response: Response, sessionId: string): Promise<WirelessSnapshot> {
  const record = await jsonRecord(response);
  // An answer for another chat must never paint this one: a late reply after a session switch is dropped here too.
  if (typeof record.status !== "string" || record.sessionId !== sessionId) throw new WirelessRequestError("The server's answer was not about this chat.");
  return record as unknown as WirelessSnapshot;
}

export async function readWireless(sessionId: string, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<WirelessSnapshot> {
  const response = await fetcher(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", referrerPolicy: "no-referrer", signal });
  return answer(response, sessionId);
}

function postJson(url: string, body: object, fetcher: Fetcher, page: WirelessPageContext | undefined, signal?: AbortSignal): Promise<Response> {
  requireSecurePage(page);
  return fetcher(url, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function sendWireless(action: WirelessAction, fetcher: Fetcher = fetch, page: WirelessPageContext | undefined = typeof window === "undefined" ? undefined : window): Promise<WirelessSnapshot> {
  return answer(await postJson(ENDPOINT, action, fetcher, page), action.sessionId);
}

export interface WirelessShellResult { exitCode: number; stdout: string; stderr: string }

/** The user already reviewed this exact command and its ability to elevate. */
export async function sendWirelessShell(action: WirelessShellAction, signal?: AbortSignal, fetcher: Fetcher = fetch, page: WirelessPageContext | undefined = typeof window === "undefined" ? undefined : window): Promise<WirelessShellResult> {
  const { exitCode, stdout, stderr } = await jsonRecord(await postJson(`${ENDPOINT}/shell`, action, fetcher, page, signal));
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || typeof stdout !== "string" || typeof stderr !== "string") {
    throw new WirelessRequestError("The server did not return a command result.");
  }
  return { exitCode, stdout, stderr };
}

/** `text` with every copy of `secret` replaced, for an error that must be shown but could have echoed what was sent. */
export function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("•".repeat(secret.length)) : text;
}

/**
 * Milliseconds until the next look at the server, or null for "do not look until something wakes us" (the tab is hidden,
 * or this server cannot do wireless ADB at all). Quick while something is changing, steady while a tablet is paired
 * (an agent's root request must reach the person soon), slow while nothing is paired.
 */
export function pollDelay(snapshot: WirelessSnapshot | null, hidden: boolean): number | null {
  if (hidden) return null;
  if (!snapshot) return 8_000;
  if (!snapshot.supported) return null;
  if (snapshot.status === "pairing" || snapshot.status === "connecting") return 1_500;
  if (snapshot.rootRequests.length > 0) return 2_000;
  if (snapshot.device) return 5_000;
  return 15_000;
}

// ---- what a person typed ----------------------------------------------------------------------------------------------

export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= MIN_PORT && port <= MAX_PORT && port !== 5037 && port !== 5555 ? port : null;
}

/** A numeric private IPv4 address as shown on Android's Wireless debugging screen. */
export function isPrivateIpv4(text: string): boolean {
  const parts = text.trim().split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** "192.168.1.50:37099", as copied from the Android screen, split into the address and the port. Anything else is not a pair. */
export function splitHostPort(text: string): { host: string; port: string } | null {
  const match = /^\s*(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\s*$/.exec(text);
  return match ? { host: match[1], port: match[2] } : null;
}

export function isPairingCode(text: string): boolean {
  return new RegExp(`^\\d{${WIRELESS_PAIRING_CODE_LENGTH}}$`).test(text);
}

type EndpointProblem = "address" | "connectPort" | "pairingPort" | "samePort" | "code";

/** The first thing wrong with a pairing form, or null when it can be sent. Every field is checked, in the order they are filled in. */
export function pairingProblem(fields: { host: string; connectPort: string; pairingPort: string; code: string }): EndpointProblem | null {
  const endpoint = endpointProblem(fields);
  if (endpoint) return endpoint;
  const pairingPort = parsePort(fields.pairingPort);
  if (pairingPort === null) return "pairingPort";
  if (pairingPort === parsePort(fields.connectPort)) return "samePort";
  if (!isPairingCode(fields.code)) return "code";
  return null;
}

/** The same for the "address changed" form, which needs no code. */
export function endpointProblem(fields: { host: string; connectPort: string }): "address" | "connectPort" | null {
  if (!isPrivateIpv4(fields.host)) return "address";
  if (parsePort(fields.connectPort) === null) return "connectPort";
  return null;
}
