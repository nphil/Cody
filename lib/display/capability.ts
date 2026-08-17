import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface DisplayCapabilityPayload {
  v: 1;
  sid: string;
  exp: number;
  nonce: string;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function secret(): Buffer {
  const value = process.env.CODY_INTERNAL_DISPLAY_SECRET;
  if (!value) throw new Error("CODY_INTERNAL_DISPLAY_SECRET is not configured");
  return Buffer.from(value, "base64url");
}

function sign(encoded: string): string {
  return createHmac("sha256", secret()).update(encoded).digest("base64url");
}

export function issueDisplayCapability(sessionId: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!sessionId) throw new Error("Display session is required");
  const payload: DisplayCapabilityPayload = { v: 1, sid: sessionId, exp: Date.now() + ttlMs, nonce: randomBytes(12).toString("base64url") };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyDisplayCapability(token: string): DisplayCapabilityPayload | null {
  const [encoded, supplied, extra] = token.split(".");
  if (!encoded || !supplied || extra) return null;
  const expected = sign(encoded);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<DisplayCapabilityPayload>;
    if (parsed.v !== 1 || typeof parsed.sid !== "string" || !parsed.sid || typeof parsed.exp !== "number" || parsed.exp <= Date.now() || typeof parsed.nonce !== "string") return null;
    return parsed as DisplayCapabilityPayload;
  } catch {
    return null;
  }
}

export function displayInternalEndpoint(): string {
  const origin = process.env.CODY_INTERNAL_DISPLAY_ORIGIN;
  if (!origin) throw new Error("CODY_INTERNAL_DISPLAY_ORIGIN is not configured");
  return `${origin.replace(/\/$/, "")}/api/internal/display`;
}
