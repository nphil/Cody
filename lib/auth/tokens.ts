import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { isRecord } from "../type-guards";
import { getAccessTokensPath } from "./paths";
import { findUserById, listUsers, type UserRecord } from "./users";

/**
 * Personal access tokens — the credential a native client carries instead of a
 * cookie. Same accounts and the same tokenVersion revocation the session cookie
 * uses, so a bearer request resolves to exactly the account the token was minted
 * for and nothing downstream (session ownership included) needs to know which
 * credential arrived.
 *
 * The secret is `cody_pat_` followed by 32 CSPRNG bytes, shown once at creation.
 * Only its digest is stored, in the self-describing shape password.ts
 * established:
 *
 *   sha256$<digest base64>
 *
 * Plain SHA-256 rather than scrypt, deliberately. A token is 256 bits of
 * randomness rather than a human-chosen password, so there is no dictionary to
 * slow down and no salt worth adding — and an unsalted digest is what lets
 * verification be a lookup instead of one scrypt per stored token. That matters:
 * verification runs on every request that carries a bearer header, and the
 * perimeter (guard.ts, proxy.ts, the launcher's upgrade handler) is synchronous.
 */

const TOKEN_PREFIX = "cody_pat_";
const SECRET_BYTES = 32;
const DIGEST_BYTES = 32;
/** Enough to tell two tokens apart in a list; 36 of the secret's 256 bits. */
const PREVIEW_LENGTH = 6;
/** A generous ceiling on the Authorization value, so a pathological header
 * cannot push hashing work into the perimeter. */
const MAX_SECRET_LENGTH = 256;

export const MAX_TOKEN_NAME_LENGTH = 60;
/** Bounds the file an authenticated client can grow. Nobody legitimately needs
 * more, and hitting it is a clearer signal than an unbounded store. */
export const MAX_TOKENS_PER_USER = 32;

/** Use is recorded at this resolution, not per request — see touchLastUsed. */
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

export interface AccessTokenRecord {
  id: string;
  /** The account this token acts as. */
  userId: string;
  name: string;
  /** `sha256$<digest base64>` of the secret. The secret itself is never stored. */
  hash: string;
  /** Leading characters of the secret, for telling tokens apart in a listing. */
  preview: string;
  /** The account's tokenVersion at issue time; a bump revokes this token too. */
  tokenVersion: number;
  createdAt: string;
  lastUsedAt?: string;
}

/** The shape safe to hand to a client. Carries no part of the secret that could
 * narrow a guess, and no hash. */
export interface PublicAccessToken {
  id: string;
  name: string;
  preview: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TokensFile {
  version: 1;
  tokens: AccessTokenRecord[];
}

function parseToken(value: unknown): AccessTokenRecord | null {
  if (!isRecord(value)) return null;
  const { id, userId, name, hash, preview, tokenVersion, createdAt, lastUsedAt } = value;
  if (typeof id !== "string" || typeof userId !== "string" || typeof hash !== "string") return null;
  if (typeof createdAt !== "string") return null;
  if (typeof tokenVersion !== "number" || !Number.isInteger(tokenVersion)) return null;
  return {
    id,
    userId,
    name: typeof name === "string" ? name : "Access token",
    hash,
    preview: typeof preview === "string" ? preview : "",
    tokenVersion,
    createdAt,
    ...(typeof lastUsedAt === "string" ? { lastUsedAt } : {}),
  };
}

function readTokensFile(): TokensFile {
  try {
    const raw = fs.readFileSync(getAccessTokensPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.tokens)) return { version: 1, tokens: [] };
    const tokens = parsed.tokens.map(parseToken).filter((token): token is AccessTokenRecord => token !== null);
    return { version: 1, tokens };
  } catch {
    return { version: 1, tokens: [] };
  }
}

/**
 * Atomic replace at 0600, like the account store, because the file holds
 * credential digests. Records whose account no longer exists are dropped on the
 * way out, so deleting an account needs no extra callsite to clean up after it.
 * Skipped when the account list reads back empty — that is also what a
 * transiently unreadable store looks like, and pruning on it would be data loss.
 */
function writeTokensFile(tokens: AccessTokenRecord[]): void {
  const users = listUsers();
  const live = users.length > 0 ? new Set(users.map((user) => user.id)) : null;
  const kept = live ? tokens.filter((token) => live.has(token.userId)) : tokens;

  const target = getAccessTokensPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, tokens: kept }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function storedDigest(stored: string): Buffer | null {
  const separator = stored.indexOf("$");
  if (separator === -1 || stored.slice(0, separator) !== "sha256") return null;
  try {
    const parsed = Buffer.from(stored.slice(separator + 1), "base64");
    return parsed.length === DIGEST_BYTES ? parsed : null;
  } catch {
    return null;
  }
}

/** Rejects a name the token routes should never have accepted; returns the
 * reason so the caller can surface it, or null when the name is fine. */
export function validateTokenName(name: string): string | null {
  if (!name) return "A token name is required";
  if (name.length > MAX_TOKEN_NAME_LENGTH) {
    return `Token names are at most ${MAX_TOKEN_NAME_LENGTH} characters`;
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Token names cannot contain control characters";
  return null;
}

export function toPublicAccessToken(token: AccessTokenRecord): PublicAccessToken {
  return {
    id: token.id,
    name: token.name,
    preview: token.preview,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null,
  };
}

/** What minting returns: the record to store and list, plus the one-time secret
 * that exists nowhere else. */
export interface IssuedAccessToken {
  secret: string;
  token: AccessTokenRecord;
}

/**
 * Mint a token for an account. The secret is returned exactly once — this is the
 * only moment it exists outside the caller's memory, which is why the route
 * hands it straight to the client and stores nothing.
 */
export function issueAccessToken(user: UserRecord, name: string, now = Date.now()): IssuedAccessToken {
  const invalid = validateTokenName(name);
  if (invalid) throw new Error(invalid);

  const file = readTokensFile();
  let owned = 0;
  for (const token of file.tokens) if (token.userId === user.id) owned += 1;
  if (owned >= MAX_TOKENS_PER_USER) {
    throw new Error(`This account already has ${MAX_TOKENS_PER_USER} access tokens; revoke one first`);
  }

  const body = randomBytes(SECRET_BYTES).toString("base64url");
  const secret = `${TOKEN_PREFIX}${body}`;
  const token: AccessTokenRecord = {
    id: randomUUID(),
    userId: user.id,
    name,
    hash: `sha256$${createHash("sha256").update(secret, "utf8").digest("base64")}`,
    preview: body.slice(0, PREVIEW_LENGTH),
    tokenVersion: user.tokenVersion,
    createdAt: new Date(now).toISOString(),
  };
  file.tokens.push(token);
  writeTokensFile(file.tokens);
  return { secret, token };
}

/**
 * The token out of an Authorization header, or null. Only `Bearer`, only a value
 * shaped like one of ours, and only within a sane length — a stray or hostile
 * header costs a regex and nothing else.
 */
export function bearerTokenFromAuthorizationHeader(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header);
  if (!match) return null;
  const candidate = match[1];
  if (candidate.length > MAX_SECRET_LENGTH || !candidate.startsWith(TOKEN_PREFIX)) return null;
  return candidate;
}

/**
 * Record use at LAST_USED_RESOLUTION_MS granularity. A token listing is only
 * useful if it says when each token was last seen, but verification runs on
 * every bearer request — so this writes once per token per interval rather than
 * once per request. A lost update under concurrency costs a stale timestamp and
 * nothing else; the file it races is replaced atomically either way.
 */
function touchLastUsed(file: TokensFile, record: AccessTokenRecord, now: number): void {
  const previous = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (Number.isFinite(previous) && now - previous < LAST_USED_RESOLUTION_MS) return;
  record.lastUsedAt = new Date(now).toISOString();
  writeTokensFile(file.tokens);
}

/**
 * The verified account behind a token secret, or null. Digest lookup first, then
 * a live account lookup, so a deleted account and a bumped tokenVersion both
 * fail exactly as they do for a session cookie. Every failure returns null
 * rather than throwing: a malformed stored record must not be distinguishable
 * from a wrong token.
 */
export function verifyAccessToken(secret: string | null | undefined, now = Date.now()): UserRecord | null {
  if (typeof secret !== "string" || secret.length > MAX_SECRET_LENGTH) return null;
  if (!secret.startsWith(TOKEN_PREFIX)) return null;

  const file = readTokensFile();
  if (file.tokens.length === 0) return null;
  const expected = createHash("sha256").update(secret, "utf8").digest();

  let match: AccessTokenRecord | null = null;
  for (const token of file.tokens) {
    const stored = storedDigest(token.hash);
    if (stored === null || stored.length !== expected.length) continue;
    if (timingSafeEqual(stored, expected)) {
      match = token;
      break;
    }
  }
  if (!match) return null;

  const user = findUserById(match.userId);
  if (!user || user.tokenVersion !== match.tokenVersion) return null;
  touchLastUsed(file, match, now);
  return user;
}

/** This account's tokens, oldest first. Never includes the secret or its hash —
 * callers pass these through toPublicAccessToken. */
export function listAccessTokens(userId: string): AccessTokenRecord[] {
  return readTokensFile().tokens.filter((token) => token.userId === userId);
}

/** Revoke one of this account's tokens. False when the id is not theirs, so the
 * route cannot be used to probe another account's token ids. */
export function revokeAccessToken(userId: string, id: string): boolean {
  const file = readTokensFile();
  const index = file.tokens.findIndex((token) => token.id === id && token.userId === userId);
  if (index === -1) return false;
  file.tokens.splice(index, 1);
  writeTokensFile(file.tokens);
  return true;
}
