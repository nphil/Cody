import { randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { isRecord } from "../type-guards";
import { getSessionOwnersPath } from "./paths";
import type { UserRecord } from "./users";

/**
 * Which account owns which agent session. The harness owns the session JSONL
 * files themselves (their format is omp's, not Cody's), so ownership lives in
 * a sidecar map keyed by session id rather than inside the files.
 *
 * Visibility policy (see the accounts design in AGENTS.md):
 *  - a session with an owner is visible only to that owner;
 *  - a session with no owner — anything created before accounts existed, from
 *    the terminal, or by a since-deleted account — is visible to everyone.
 * Grandfathering unowned sessions keeps pre-account history from vanishing
 * the moment someone creates a personal account.
 */

interface OwnersFile {
  version: 1;
  owners: Record<string, string>;
}

function readOwners(): OwnersFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getSessionOwnersPath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.owners)) return { version: 1, owners: {} };
    const owners: Record<string, string> = {};
    for (const [sessionId, userId] of Object.entries(parsed.owners)) {
      if (typeof userId === "string") owners[sessionId] = userId;
    }
    return { version: 1, owners };
  } catch {
    return { version: 1, owners: {} };
  }
}

function writeOwners(file: OwnersFile): void {
  const target = getSessionOwnersPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

export function setSessionOwner(sessionId: string, userId: string): void {
  if (!sessionId || !userId) return;
  const file = readOwners();
  if (file.owners[sessionId] === userId) return;
  file.owners[sessionId] = userId;
  writeOwners(file);
}

export function getSessionOwner(sessionId: string): string | null {
  return readOwners().owners[sessionId] ?? null;
}

/** May this account see this session? Unowned sessions are visible to all;
 * `user` is null when auth is off, which sees everything. */
export function canAccessSession(sessionId: string, user: UserRecord | null): boolean {
  const owner = getSessionOwner(sessionId);
  if (owner === null || user === null) return true;
  return owner === user.id;
}

/** Filter a session listing down to what this account may see, in one read of
 * the sidecar instead of one per session. */
export function filterSessionsForUser<T extends { id: string }>(sessions: T[], user: UserRecord | null): T[] {
  if (user === null) return sessions;
  const { owners } = readOwners();
  return sessions.filter((session) => {
    const owner = owners[session.id];
    return owner === undefined || owner === user.id;
  });
}

/** Called when a session is deleted so the sidecar does not grow forever. */
export function forgetSession(sessionId: string): void {
  const file = readOwners();
  if (!(sessionId in file.owners)) return;
  delete file.owners[sessionId];
  writeOwners(file);
}
