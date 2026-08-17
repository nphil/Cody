import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { isRecord } from "../type-guards";
import { readEnv } from "../env";
import { getAccountsDir, getAccountsFilePath, getAvatarsDir } from "./paths";

/**
 * Cody's account store: a small JSON file of user records, written atomically
 * with 0600 permissions because it carries password hashes. Deliberately not a
 * database — a self-hosted workspace has a handful of users, and a file on the
 * persisted volume survives image updates with nothing to migrate.
 *
 * Two kinds of accounts exist:
 *  - Regular accounts, created through the UI, password hash stored here.
 *  - The env-managed bootstrap account: when CODY_PASSWORD is set, the
 *    username `cody` signs in with that password, checked against the
 *    environment rather than a stored hash. This is the Docker bootstrap the
 *    deployment already relies on; it appears in the store (so it can own
 *    sessions and a profile) but its record carries no hash.
 */

export const ENV_MANAGED_USERNAME = "cody";

export type UserRole = "admin" | "member";

export interface UserRecord {
  id: string;
  /** Lowercase login name, unique. */
  username: string;
  fullName: string;
  role: UserRole;
  /** scrypt string from lib/auth/password.ts; absent on the env-managed account. */
  passwordHash?: string;
  /** True for the bootstrap account whose password is CODY_PASSWORD. */
  envManaged?: boolean;
  /** Bumping this invalidates every session cookie issued for the account. */
  tokenVersion: number;
  /** Relative avatar filename inside getAvatarsDir(), when one was uploaded. */
  avatar?: string;
  createdAt: string;
  /** Reserved seam for a future container-uid mapping; never populated today. */
  osUser?: { uid: number; gid: number; home: string };
}

/** The shape safe to hand to the browser. */
export interface PublicUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  envManaged: boolean;
  hasAvatar: boolean;
  /** Changes on every upload (it is the stored filename, a fresh UUID), so
   * clients append it as ?v= and the avatar response can be cached immutably. */
  avatarKey: string | null;
  createdAt: string;
}

interface AccountsFile {
  version: 1;
  users: UserRecord[];
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const MAX_FULL_NAME_LENGTH = 80;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return "Usernames are 2-32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit";
  }
  return null;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    envManaged: user.envManaged === true,
    hasAvatar: typeof user.avatar === "string",
    avatarKey: user.avatar ?? null,
    createdAt: user.createdAt,
  };
}

function parseUser(value: unknown): UserRecord | null {
  if (!isRecord(value)) return null;
  const { id, username, fullName, role, passwordHash, envManaged, tokenVersion, avatar, createdAt } = value;
  if (typeof id !== "string" || typeof username !== "string" || typeof createdAt !== "string") return null;
  if (role !== "admin" && role !== "member") return null;
  return {
    id,
    username,
    fullName: typeof fullName === "string" ? fullName : username,
    role,
    ...(typeof passwordHash === "string" ? { passwordHash } : {}),
    ...(envManaged === true ? { envManaged: true } : {}),
    tokenVersion: typeof tokenVersion === "number" && Number.isInteger(tokenVersion) ? tokenVersion : 1,
    ...(typeof avatar === "string" && /^[a-f0-9-]+\.(png|jpe?g|webp)$/.test(avatar) ? { avatar } : {}),
    createdAt,
  };
}

function readAccountsFile(): AccountsFile {
  try {
    const raw = fs.readFileSync(getAccountsFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.users)) return { version: 1, users: [] };
    const users = parsed.users.map(parseUser).filter((user): user is UserRecord => user !== null);
    return { version: 1, users };
  } catch {
    return { version: 1, users: [] };
  }
}

/** Atomic replace so a crash mid-write can never truncate the account list,
 * and 0600 throughout because the file holds password hashes. */
function writeAccountsFile(file: AccountsFile): void {
  const target = getAccountsFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/**
 * The env-managed bootstrap record. Materialized into the store on first read
 * when CODY_PASSWORD is set so the account can own sessions, a profile and an
 * avatar like any other; its password never is. Its role is always admin —
 * whoever controls the container environment controls everything anyway.
 */
function ensureEnvManagedUser(file: AccountsFile): boolean {
  if (!readEnv("PASSWORD")) return false;
  const existing = file.users.find((user) => user.username === ENV_MANAGED_USERNAME);
  if (existing) {
    if (existing.envManaged === true && existing.role === "admin") return false;
    existing.envManaged = true;
    existing.role = "admin";
    delete existing.passwordHash;
    return true;
  }
  file.users.push({
    id: randomUUID(),
    username: ENV_MANAGED_USERNAME,
    fullName: "Cody",
    role: "admin",
    envManaged: true,
    tokenVersion: 1,
    createdAt: new Date().toISOString(),
  });
  return true;
}

export function listUsers(): UserRecord[] {
  const file = readAccountsFile();
  if (ensureEnvManagedUser(file)) writeAccountsFile(file);
  return file.users;
}

export function findUserById(id: string): UserRecord | null {
  return listUsers().find((user) => user.id === id) ?? null;
}

export function findUserByUsername(username: string): UserRecord | null {
  const normalized = normalizeUsername(username);
  return listUsers().find((user) => user.username === normalized) ?? null;
}

/** True when no account exists at all — the fresh-install state that turns the
 * login screen into first-run setup. The env-managed account counts: with
 * CODY_PASSWORD set the instance is already reachable, not fresh. */
export function hasAnyUser(): boolean {
  return listUsers().length > 0;
}

/** True once a person has created an account of their own. The env-managed
 * bootstrap account does not count: on a standard Docker install it exists
 * from the first boot, and the first HUMAN account must still become an
 * administrator — otherwise nobody who signs up through the login screen
 * could ever manage users or pick the agent engine. */
export function hasAnyHumanUser(): boolean {
  return listUsers().some((user) => user.envManaged !== true);
}

export function createUser(input: {
  username: string;
  fullName: string;
  passwordHash: string;
  role: UserRole;
}): UserRecord {
  const username = normalizeUsername(input.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const fullName = input.fullName.trim().slice(0, MAX_FULL_NAME_LENGTH) || username;

  const file = readAccountsFile();
  ensureEnvManagedUser(file);
  if (file.users.some((user) => user.username === username)) {
    throw new Error("That username is already taken");
  }
  const user: UserRecord = {
    id: randomUUID(),
    username,
    fullName,
    role: input.role,
    passwordHash: input.passwordHash,
    tokenVersion: 1,
    createdAt: new Date().toISOString(),
  };
  file.users.push(user);
  writeAccountsFile(file);
  return user;
}

/** Apply a partial update to one record. The mutator sees the live record and
 * may edit it in place; the file is rewritten afterwards. */
export function updateUser(id: string, mutate: (user: UserRecord) => void): UserRecord {
  const file = readAccountsFile();
  ensureEnvManagedUser(file);
  const user = file.users.find((candidate) => candidate.id === id);
  if (!user) throw new Error("Account not found");
  mutate(user);
  writeAccountsFile(file);
  return user;
}

export function deleteUser(id: string): void {
  const file = readAccountsFile();
  ensureEnvManagedUser(file);
  const user = file.users.find((candidate) => candidate.id === id);
  if (!user) throw new Error("Account not found");
  if (user.envManaged === true) throw new Error("The environment-managed account cannot be deleted; unset CODY_PASSWORD instead");
  if (user.role === "admin" && !file.users.some((other) => other.id !== id && other.role === "admin")) {
    throw new Error("Cannot delete the last administrator");
  }
  file.users = file.users.filter((candidate) => candidate.id !== id);
  writeAccountsFile(file);
  if (user.avatar) {
    try {
      fs.rmSync(path.join(getAvatarsDir(), user.avatar), { force: true });
    } catch {
      // Orphaned avatar files are harmless.
    }
  }
}

/** Signup policy for the login screen. Default allows account creation (the
 * fresh-install flow depends on it); operators lock it down with
 * CODY_ALLOW_SIGNUP=0 once their accounts exist. First-run setup (no users at
 * all) is always allowed — otherwise a locked-down fresh install is a brick. */
export function isSignupAllowed(): boolean {
  const raw = readEnv("ALLOW_SIGNUP");
  if (raw === undefined) return true;
  return !new Set(["0", "false", "no", "off"]).has(raw.trim().toLowerCase());
}

/** Test seam: accounts state is path-derived, nothing memoized to clear. */
export function accountsDir(): string {
  return getAccountsDir();
}
