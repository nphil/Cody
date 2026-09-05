import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@/lib/omp/paths";
import { isRecord } from "@/lib/type-guards";

/**
 * Which models are hidden or pinned, and by whom.
 *
 * Three scopes, one file. An ADMINISTRATOR hides a model for the whole
 * instance (`engines.<id>.hidden`) — on omp that hide is `enabledModels` in
 * omp's own config.yml and never lands here, on every other engine this is
 * the only place an instance-wide hide can live. Any signed-in USER hides a
 * model for themselves or pins it to the top of the composer
 * (`users.<userId>.<engine>.{hidden,pinned}`). Visible for a user is
 * catalog − instance hidden − their hidden, and an instance hide beats a
 * pin: a member cannot pin their way past an administrator's curation.
 *
 * Keys are `provider/id` — omp's own dialect (`modelKey()` in
 * lib/model-allow-list.ts) — and on an ACP engine the session's model ids
 * in the same shape. Everything is keyed by engine because each engine has
 * its own catalog: a key hidden under omp means nothing under pi.
 *
 * Cody-level state, so it lives in the instance data dir via `getAgentDir()`
 * (like lib/model-catalog-seen.ts) and survives an engine switch. Writes are
 * atomic so a crash mid-write cannot leave a truncated file that would read
 * as "nothing hidden" and un-curate the whole instance.
 */

export const VISIBILITY_FILE = "cody-model-visibility.json";
const FILE_VERSION = 1;

/** Generous: the biggest real catalog seen is ~600 models; a list an order
 * of magnitude larger is still not an attack surface worth a bigger cap. */
export const MAX_VISIBILITY_KEYS = 20_000;

export interface UserVisibility {
  hidden: string[];
  pinned: string[];
}

interface VisibilityFile {
  version: number;
  engines: Record<string, { hidden: string[] }>;
  users: Record<string, Record<string, UserVisibility>>;
}

export function getVisibilityPath(): string {
  return path.join(getAgentDir(), VISIBILITY_FILE);
}

/** Deduplicated, sorted, non-empty strings only — the on-disk form. Sorted
 * so two writes of the same set produce byte-identical files. */
export function normalizeModelKeys(keys: readonly unknown[]): string[] {
  const set = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort();
}

function readFile(): VisibilityFile {
  const empty: VisibilityFile = { version: FILE_VERSION, engines: {}, users: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getVisibilityPath(), "utf8"));
  } catch {
    // Missing, unreadable or corrupt all mean the same thing: nothing is
    // hidden or pinned yet.
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  if (isRecord(parsed.engines)) {
    for (const [engineId, value] of Object.entries(parsed.engines)) {
      if (!engineId || !isRecord(value) || !Array.isArray(value.hidden)) continue;
      empty.engines[engineId] = { hidden: normalizeModelKeys(value.hidden) };
    }
  }
  if (isRecord(parsed.users)) {
    for (const [userId, engines] of Object.entries(parsed.users)) {
      if (!userId || !isRecord(engines)) continue;
      const perEngine: Record<string, UserVisibility> = {};
      for (const [engineId, value] of Object.entries(engines)) {
        if (!engineId || !isRecord(value)) continue;
        perEngine[engineId] = {
          hidden: Array.isArray(value.hidden) ? normalizeModelKeys(value.hidden) : [],
          pinned: Array.isArray(value.pinned) ? normalizeModelKeys(value.pinned) : [],
        };
      }
      if (Object.keys(perEngine).length > 0) empty.users[userId] = perEngine;
    }
  }
  return empty;
}

function writeFile(file: VisibilityFile): void {
  const target = getVisibilityPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** The instance-wide hidden list for an engine (an administrator's hide on
 * a non-omp engine). Always a fresh array. */
export function readInstanceHidden(engineId: string): string[] {
  return [...(readFile().engines[engineId]?.hidden ?? [])];
}

/** Replace the instance-wide hidden list for an engine. An empty list
 * removes the engine's entry so the file does not accumulate empties. */
export function writeInstanceHidden(engineId: string, hidden: readonly string[]): string[] {
  const file = readFile();
  const normalized = normalizeModelKeys(hidden);
  if (normalized.length === 0) delete file.engines[engineId];
  else file.engines[engineId] = { hidden: normalized };
  writeFile(file);
  return normalized;
}

/** One user's hidden and pinned lists for an engine. Fresh arrays. */
export function readUserVisibility(userId: string, engineId: string): UserVisibility {
  const entry = readFile().users[userId]?.[engineId];
  return { hidden: [...(entry?.hidden ?? [])], pinned: [...(entry?.pinned ?? [])] };
}

/** Replace one or both of a user's lists for an engine; an omitted list is
 * left as it was. Empty lists on both sides remove the entry. */
export function writeUserVisibility(
  userId: string,
  engineId: string,
  patch: { hidden?: readonly string[]; pinned?: readonly string[] },
): UserVisibility {
  const file = readFile();
  const current = file.users[userId]?.[engineId] ?? { hidden: [], pinned: [] };
  const next: UserVisibility = {
    hidden: patch.hidden !== undefined ? normalizeModelKeys(patch.hidden) : current.hidden,
    pinned: patch.pinned !== undefined ? normalizeModelKeys(patch.pinned) : current.pinned,
  };
  const perEngine = file.users[userId] ?? {};
  if (next.hidden.length === 0 && next.pinned.length === 0) delete perEngine[engineId];
  else perEngine[engineId] = next;
  if (Object.keys(perEngine).length === 0) delete file.users[userId];
  else file.users[userId] = perEngine;
  writeFile(file);
  return { hidden: [...next.hidden], pinned: [...next.pinned] };
}

/** Forget a user entirely — for account deletion, so a deleted account's
 * pins do not linger against a reused id. */
export function deleteUserVisibility(userId: string): void {
  const file = readFile();
  if (!(userId in file.users)) return;
  delete file.users[userId];
  writeFile(file);
}

export type ModelVisibilityState = "visible" | "instanceHidden" | "myHidden";

/**
 * The pure rule every surface applies: an instance hide wins over a personal
 * hide, and a personal hide wins over a pin. `pinned` is reported as false
 * for a hidden model so no list can render a pinned row the user cannot
 * pick — the pin itself is kept in the file for when the model is unhidden.
 */
export function resolveModelVisibility(
  key: string,
  lists: { instanceHidden: ReadonlySet<string>; hidden: ReadonlySet<string>; pinned: ReadonlySet<string> },
): { state: ModelVisibilityState; pinned: boolean } {
  if (lists.instanceHidden.has(key)) return { state: "instanceHidden", pinned: false };
  if (lists.hidden.has(key)) return { state: "myHidden", pinned: false };
  return { state: "visible", pinned: lists.pinned.has(key) };
}
