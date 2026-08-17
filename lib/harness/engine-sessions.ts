import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

/**
 * Cody's index of sessions owned by a non-omp engine.
 *
 * omp sessions are discovered by walking its transcript directory, which only
 * works because Cody can read omp's on-disk format. Claude Code and Codex keep
 * their own private transcript stores, so the sidebar would have nothing to
 * list. This sidecar is the substitute: one row per session Cody started,
 * enough to render the list (title, cwd, timestamps) and to resume the turn
 * (the engine-native id).
 *
 * It lives in the instance data dir next to cody-accounts/cody-engine.json —
 * never under the active engine's own directory, because the index must
 * survive switching engines. Same durability rules as the other Cody stores:
 * atomic temp+rename, 0600, mtime-keyed read cache.
 *
 * Rows are Cody's bookkeeping only: deleting one leaves the engine's native
 * session files untouched (Cody does not own their format).
 */

export interface EngineSessionRow {
  /** Engine id that owns the session ("claude", "codex"). */
  engine: string;
  /** The engine's own session identity: claude session uuid / codex thread id. */
  engineSessionId: string;
  /** First prompt of the session, truncated — the sidebar label. */
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

/** A row plus the Cody session id it is keyed by. */
export interface EngineSessionEntry extends EngineSessionRow {
  sessionId: string;
}

export interface EngineSessionsFile {
  version: 1;
  sessions: Record<string, EngineSessionRow>;
}

/** Longest session title kept in the index (first prompt, truncated). */
export const ENGINE_SESSION_TITLE_MAX = 60;

const EMPTY_FILE: EngineSessionsFile = { version: 1, sessions: {} };

let cache: { file: EngineSessionsFile; mtimeMs: number } | null = null;

export function getEngineSessionsPath(): string {
  return path.join(getAgentDir(), "cody-engine-sessions.json");
}

function asRow(value: unknown): EngineSessionRow | null {
  if (!isRecord(value)) return null;
  const engine = typeof value.engine === "string" ? value.engine : "";
  if (!engine) return null;
  return {
    engine,
    engineSessionId: typeof value.engineSessionId === "string" ? value.engineSessionId : "",
    title: typeof value.title === "string" ? value.title : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

/** Read the index. A missing or corrupt file reads as empty — a broken sidecar
 * must never take the server down, it only costs the session list. */
export function readEngineSessions(): EngineSessionsFile {
  const file = getEngineSessionsPath();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache = null;
    return EMPTY_FILE;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.file;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const sessions: Record<string, EngineSessionRow> = {};
    if (isRecord(parsed) && isRecord(parsed.sessions)) {
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        const row = asRow(value);
        if (sessionId && row) sessions[sessionId] = row;
      }
    }
    const result: EngineSessionsFile = { version: 1, sessions };
    cache = { file: result, mtimeMs };
    return result;
  } catch {
    return EMPTY_FILE;
  }
}

function writeEngineSessions(file: EngineSessionsFile): void {
  const target = getEngineSessionsPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  cache = null;
}

export function getEngineSession(sessionId: string): EngineSessionRow | null {
  if (!sessionId) return null;
  return readEngineSessions().sessions[sessionId] ?? null;
}

/**
 * Create or update one row. `createdAt` is stamped once and never rewritten;
 * `updatedAt` is stamped on every call, so this doubles as the "session had
 * activity" touch at the end of a turn.
 */
export function upsertEngineSession(
  sessionId: string,
  patch: Partial<Omit<EngineSessionRow, "engine">> & { engine: string },
): EngineSessionRow {
  if (!sessionId) throw new Error("upsertEngineSession requires a session id");
  const file = readEngineSessions();
  const now = new Date().toISOString();
  const existing = file.sessions[sessionId];
  const row: EngineSessionRow = {
    engine: patch.engine,
    engineSessionId: patch.engineSessionId ?? existing?.engineSessionId ?? "",
    title: patch.title ?? existing?.title ?? "",
    cwd: patch.cwd ?? existing?.cwd ?? "",
    createdAt: existing?.createdAt || patch.createdAt || now,
    updatedAt: patch.updatedAt ?? now,
  };
  writeEngineSessions({ version: 1, sessions: { ...file.sessions, [sessionId]: row } });
  return row;
}

/**
 * Re-key a row after the engine revealed its own identity (Codex only learns
 * its thread id from the first `thread.started` frame, so the session starts
 * under a locally minted id and is renamed once). A no-op when the old row is
 * gone; never clobbers an existing row under the new id.
 */
export function renameEngineSession(oldSessionId: string, newSessionId: string): EngineSessionRow | null {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return null;
  const file = readEngineSessions();
  const row = file.sessions[oldSessionId];
  if (!row) return null;
  const sessions = { ...file.sessions };
  delete sessions[oldSessionId];
  sessions[newSessionId] = { ...sessions[newSessionId], ...row };
  writeEngineSessions({ version: 1, sessions });
  return sessions[newSessionId];
}

/** Drop a row (session deleted in the UI). Engine-native files are untouched. */
export function removeEngineSession(sessionId: string): boolean {
  const file = readEngineSessions();
  if (!(sessionId in file.sessions)) return false;
  const sessions = { ...file.sessions };
  delete sessions[sessionId];
  writeEngineSessions({ version: 1, sessions });
  return true;
}

/** Rows for one engine (or all engines), newest activity first. */
export function listEngineSessions(engine?: string): EngineSessionEntry[] {
  const { sessions } = readEngineSessions();
  const entries: EngineSessionEntry[] = [];
  for (const [sessionId, row] of Object.entries(sessions)) {
    if (engine && row.engine !== engine) continue;
    entries.push({ sessionId, ...row });
  }
  return entries.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

/** First prompt → session title: single line, trimmed, ellipsized. */
export function engineSessionTitle(prompt: string, max = ENGINE_SESSION_TITLE_MAX): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Test hook — the index is mtime-cached and tests swap the agent dir. */
export function clearEngineSessionsCache(): void {
  cache = null;
}
