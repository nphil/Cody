import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { findUserById, type UserRecord } from "./users";
import { getSessionSecretPath } from "./paths";

/**
 * Stateless signed-cookie sessions. A token is
 *
 *   v1.<payload base64url>.<HMAC-SHA256 base64url>
 *
 * where the payload is JSON {uid, tv, exp}. Statelessness keeps the launcher's
 * WebSocket upgrade path (plain Node, no Next request context) able to verify
 * with one file read and one HMAC; revocation comes from `tv` — bump the
 * user's tokenVersion and every outstanding cookie for that account dies.
 *
 * The HMAC key is generated on first use and persisted 0600 next to the
 * account store, so sessions survive a server restart but not a volume wipe.
 */

export const SESSION_COOKIE_NAME = "cody_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERSION = "v1";

let cachedSecret: Buffer | null = null;

function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const file = getSessionSecretPath();
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const parsed = Buffer.from(raw, "base64");
    if (parsed.length >= 32) {
      cachedSecret = parsed;
      return parsed;
    }
  } catch {
    // Fall through to generation.
  }
  const secret = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, secret.toString("base64"), { mode: 0o600 });
  fs.renameSync(temp, file);
  cachedSecret = secret;
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function issueSessionToken(user: UserRecord, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: user.id, tv: user.tokenVersion, exp: now + SESSION_TTL_MS }),
    "utf8",
  ).toString("base64url");
  return `${VERSION}.${payload}.${sign(payload)}`;
}

/** The verified account behind a token, or null. Signature first, then expiry,
 * then a live lookup so deleted accounts and bumped tokenVersions both fail. */
export function verifySessionToken(token: string | null | undefined, now = Date.now()): UserRecord | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, signature] = parts;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(sign(payload), "base64url");
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { uid, tv, exp } = claims as Record<string, unknown>;
  if (typeof uid !== "string" || typeof tv !== "number" || typeof exp !== "number") return null;
  if (exp <= now) return null;

  const user = findUserById(uid);
  if (!user || user.tokenVersion !== tv) return null;
  return user;
}

/** Cookie attributes for Set-Cookie. HttpOnly + SameSite=Lax; `Secure` is left
 * off because Cody commonly serves plain HTTP on a LAN — an HTTPS reverse
 * proxy in front should set its own transport guarantees. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Extract this cookie's value from a raw Cookie header (the launcher's
 * upgrade handler has no cookie parser). */
export function sessionTokenFromCookieHeader(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Test seam: drop the cached HMAC key so a test can point at a fresh dir. */
export function clearSessionSecretCache(): void {
  cachedSecret = null;
}
