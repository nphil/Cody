import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getNotificationsSecretPath } from "../auth/paths";
import { isRecord } from "../type-guards";

/**
 * The credential an answer button carries.
 *
 * The phone's tap is a plain HTTP POST from the ntfy app with no cookie and no
 * Cody login, so the button itself must be the authority — and what it grants
 * has to be as small as possible: ONE answer, to ONE pending request, for ONE
 * recipient, for a limited time, usable once. A token is
 *
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, first part))
 *
 * The secret is 32 random bytes persisted 0600 beside the account store, so a
 * button survives a Cody restart (the request it answers does not, and the
 * route checks that separately) and dies only with the volume.
 *
 * Single use is a set of spent nonces kept until each token would have expired
 * anyway. It lives on globalThis because the route and the rest of the server
 * can be separate module instances, and a per-module set would not see a spend
 * made through the other.
 */

export interface AnswerTokenPayload {
  v: 1;
  /** The session id when the notification was sent. */
  sid: string;
  /** The pending request this token answers. */
  rid: string;
  /** The recipient (account id or the open-instance key) the button was issued to. */
  u: string;
  /** `ui`: an omp dialog; `permission`: an ACP approval. */
  k: "ui" | "permission";
  /** Digest of the request's content (lib/notifications/compose.ts): the answer is only valid for THIS request. */
  d: string;
  /** The answer, merged into the command the browser would have sent. */
  a: Record<string, unknown>;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /** Unique per token; what "used" is recorded against. */
  n: string;
}

export type TokenVerdict =
  | { ok: true; payload: AnswerTokenPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

/** A button lives this long at most, whatever the request's own deadline. */
export const ANSWER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;
const MAX_SPENT_NONCES = 10_000;

declare global {
  var __codyNotificationSecrets: Map<string, Buffer> | undefined;
  var __codyAnswerNonces: Map<string, number> | undefined;
}

function readSecretFile(file: string): Buffer | null {
  try {
    const decoded = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    return decoded.length >= 32 ? decoded : null;
  } catch {
    return null;
  }
}

/** The signing key, created on first use. Cached per file so a test that moves the accounts directory gets its own. */
function signingSecret(): Buffer {
  const file = getNotificationsSecretPath();
  if (!globalThis.__codyNotificationSecrets) globalThis.__codyNotificationSecrets = new Map();
  const cache = globalThis.__codyNotificationSecrets;
  const cached = cache.get(file);
  if (cached) return cached;
  let secret = readSecretFile(file);
  if (!secret) {
    secret = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temp, secret.toString("base64"), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  cache.set(file, secret);
  return secret;
}

function sign(encoded: string): Buffer {
  return createHmac("sha256", signingSecret()).update(encoded).digest();
}

function spentNonces(): Map<string, number> {
  if (!globalThis.__codyAnswerNonces) globalThis.__codyAnswerNonces = new Map();
  return globalThis.__codyAnswerNonces;
}

export interface IssueAnswerTokenInput {
  sid: string;
  rid: string;
  u: string;
  k: AnswerTokenPayload["k"];
  d: string;
  a: Record<string, unknown>;
  /** The request's own deadline, if it has one. */
  expiresAt?: number;
}

/** Sign one answer. Expires with the request, or in 24 hours, whichever is sooner. */
export function issueAnswerToken(input: IssueAnswerTokenInput, now = Date.now()): string {
  const payload: AnswerTokenPayload = {
    v: 1,
    sid: input.sid,
    rid: input.rid,
    u: input.u,
    k: input.k,
    d: input.d,
    a: input.a,
    exp: Math.min(input.expiresAt ?? Number.POSITIVE_INFINITY, now + ANSWER_TOKEN_TTL_MS),
    n: randomBytes(12).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded).toString("base64url")}`;
}

function nonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function readPayload(value: unknown): AnswerTokenPayload | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!nonEmptyString(value.sid) || !nonEmptyString(value.rid) || !nonEmptyString(value.u) || !nonEmptyString(value.d, 64) || !nonEmptyString(value.n, 64)) {
    return null;
  }
  if ((value.k !== "ui" && value.k !== "permission") || !isRecord(value.a)) return null;
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null;
  return { v: 1, sid: value.sid, rid: value.rid, u: value.u, k: value.k, d: value.d, a: value.a, exp: value.exp, n: value.n };
}

/** Check a token's signature, shape and expiry. It does not spend it: see claimAnswerToken. */
export function verifyAnswerToken(token: unknown, now = Date.now()): TokenVerdict {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return { ok: false, reason: "malformed" };
  const [encoded, supplied] = parts as [string, string];
  const actual = Buffer.from(supplied, "base64url");
  const expected = sign(encoded);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: "signature" };
  let payload: AnswerTokenPayload | null;
  try {
    payload = readPayload(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    payload = null;
  }
  if (!payload) return { ok: false, reason: "malformed" };
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/**
 * Spend a token. True the first time, false for every later try — including a
 * second request already in flight, because the claim is made before anything
 * is awaited. Entries are dropped once their token has expired (an expired
 * token fails verification anyway), and the set is capped so a flood of
 * answers can never grow it without bound.
 */
export function claimAnswerToken(payload: Pick<AnswerTokenPayload, "n" | "exp">, now = Date.now()): boolean {
  const spent = spentNonces();
  for (const [nonce, exp] of spent) {
    if (exp <= now) spent.delete(nonce);
  }
  if (spent.has(payload.n)) return false;
  if (spent.size >= MAX_SPENT_NONCES) {
    const oldest = spent.keys().next();
    if (!oldest.done) spent.delete(oldest.value);
  }
  spent.set(payload.n, payload.exp);
  return true;
}

/** Give a claim back: the answer never reached the session (it was restarting), so the person may tap again. */
export function releaseAnswerToken(payload: Pick<AnswerTokenPayload, "n">): void {
  spentNonces().delete(payload.n);
}
