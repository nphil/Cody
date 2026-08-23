import { engineScopedKey, STORAGE_KEYS } from "./storage-keys";
import type { SessionInfo } from "./types";

/**
 * "Which session was I last in, in this workspace" — per ENGINE.
 *
 * The value is a map of workspace path → session id, and a session id belongs
 * to the engine that minted it: omp's ids are absent from pi's transcripts and
 * meaningless to an ACP engine that owns its own storage. Kept under one key
 * for every engine, a switch left the map pointing at sessions that no longer
 * resolve, so restoring a workspace silently did nothing.
 *
 * Every entry point therefore takes the engine id first, and answers as if
 * nothing were stored when it is unknown (`/api/info` still in flight): a
 * best-effort convenience must never guess with another engine's data.
 */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readEntries(storage: StorageLike, storageKey: string): Record<string, string> {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, id]) => typeof id === "string" && id.length > 0)) as Record<string, string>;
  } catch {
    return {};
  }
}

export function workspaceKeyOf(session: Pick<SessionInfo, "cwd" | "projectRoot">): string {
  return session.projectRoot ?? session.cwd;
}

export function getLastOpenSession(engineId: string | null, workspace: string, storage: StorageLike | null = browserStorage()): string | null {
  const storageKey = engineScopedKey(STORAGE_KEYS.lastOpenByProject, engineId);
  if (!storage || !storageKey) return null;
  return readEntries(storage, storageKey)[workspace] ?? null;
}

export function setLastOpenSession(engineId: string | null, workspace: string, sessionId: string, storage: StorageLike | null = browserStorage()): void {
  const storageKey = engineScopedKey(STORAGE_KEYS.lastOpenByProject, engineId);
  if (!storage || !storageKey) return;
  try {
    const entries = readEntries(storage, storageKey);
    entries[workspace] = sessionId;
    storage.setItem(storageKey, JSON.stringify(entries));
  } catch {
    // Workspace restoration is a best-effort convenience.
  }
}

export function clearLastOpenSession(engineId: string | null, workspace: string, storage: StorageLike | null = browserStorage()): void {
  const storageKey = engineScopedKey(STORAGE_KEYS.lastOpenByProject, engineId);
  if (!storage || !storageKey) return;
  try {
    const entries = readEntries(storage, storageKey);
    if (!(workspace in entries)) return;
    delete entries[workspace];
    if (Object.keys(entries).length === 0) storage.removeItem(storageKey);
    else storage.setItem(storageKey, JSON.stringify(entries));
  } catch {
    // Workspace restoration is a best-effort convenience.
  }
}
