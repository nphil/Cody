import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for Cody accounts, built on node:crypto's scrypt so the
 * feature adds no dependency. Stored form is self-describing:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 *
 * Carrying the parameters means a future cost increase can detect and rehash
 * old records instead of locking everyone out.
 */

/** 128 * N * r = 16 MiB per hash, which stays under scrypt's 32 MiB default
 * maxmem. Raising N past this needs an explicit maxmem or every call throws. */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Long enough to matter, capped so a pathological input cannot be used to
 * push work into the server on an unauthenticated route. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Rejects a password the account routes should never have accepted. Returns
 * the reason so the caller can surface it, or null when the password is fine. */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Constant-time comparison against a stored hash. Every failure path returns
 * false rather than throwing, so a malformed record cannot be told apart from
 * a wrong password by the caller — or by whoever is guessing.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) return false;
  // A record claiming absurd parameters would otherwise let a tampered store
  // turn one login into a memory-exhaustion request.
  if (cost < 1024 || cost > 1_048_576 || blockSize < 1 || blockSize > 32 || parallelization < 1 || parallelization > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, expected.length, { N: cost, r: blockSize, p: parallelization }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with parameters this build no longer uses,
 * so the caller can transparently re-hash on the next successful sign-in. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P;
}
