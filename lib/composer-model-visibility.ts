import { engineScopedKey, STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";

/**
 * The composer's model picker reads three per-engine lists from the browser:
 * which models this user hides, which they pinned to the top, and which they
 * picked most recently. The first two are a MIRROR of the account's lists
 * under /api/models/visibility — the server is the truth across browsers,
 * the mirror is what lets the picker paint on the first frame and what an
 * open instance (no accounts, so no server-side user) keeps on its own
 * ("Saved in this browser"). Recents are browser-only by design.
 *
 * Keys are `provider/id`, the same dialect as omp's `enabledModels` and the
 * visibility route; the picker's older `provider:modelId` allowlist is
 * converted once by `migrateComposerAllowlist` and never written again.
 *
 * Every store is keyed per engine (`engineScopedKey`): a hidden list built
 * against omp's catalog would hide nothing on pi and pin nothing that
 * exists. Same-window listeners hear `composerVisibilityChange` and
 * `recentModelsChange`; other tabs hear the browser's own `storage` event.
 */

export const RECENT_MODELS_LIMIT = 5;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ComposerVisibility {
  /** Models THIS user hid — the account's own list. */
  hidden: Set<string>;
  /** Models an administrator hid for everyone (non-omp engines; omp's
   * instance hide never reaches the browser because /api/models already
   * excludes it). */
  instanceHidden: Set<string>;
  pinned: Set<string>;
  /** Newest first, at most RECENT_MODELS_LIMIT. */
  recent: string[];
}

interface HiddenMirror {
  mine: string[];
  instance: string[];
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function readJson(storage: StorageLike | null, key: string | null): unknown {
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string | null, value: unknown): void {
  if (!storage || !key) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // A blocked store (private mode, quota) costs one reload's worth of
    // pins; it must never break the composer.
  }
}

function dispatch(eventName: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(eventName));
}

/** The `provider/id` key of a model as the composer or the catalog holds it. */
export function modelVisibilityKey(model: { provider: string; id?: string; modelId?: string }): string {
  return `${model.provider}/${model.id ?? model.modelId ?? ""}`;
}

/** Read the hidden mirror. A bare array is the shape an early build wrote
 * (the user's own list only) and still reads. */
function readHiddenMirror(storage: StorageLike | null, engineId: string | null): HiddenMirror {
  const value = readJson(storage, engineScopedKey(STORAGE_KEYS.composerHiddenModels, engineId));
  if (Array.isArray(value)) return { mine: stringList(value), instance: [] };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return { mine: stringList(record.mine), instance: stringList(record.instance) };
  }
  return { mine: [], instance: [] };
}

export function readComposerVisibility(engineId: string | null, storage: StorageLike | null = browserStorage()): ComposerVisibility {
  const hidden = readHiddenMirror(storage, engineId);
  return {
    hidden: new Set(hidden.mine),
    instanceHidden: new Set(hidden.instance),
    pinned: new Set(stringList(readJson(storage, engineScopedKey(STORAGE_KEYS.composerPinnedModels, engineId)))),
    recent: stringList(readJson(storage, engineScopedKey(STORAGE_KEYS.recentModels, engineId))).slice(0, RECENT_MODELS_LIMIT),
  };
}

/**
 * Replace one or more of the mirrored lists and tell the composer. Used by
 * the Models hub after a successful PUT (and as the whole store on an open
 * instance), and by the sync that runs when the server's lists arrive.
 */
export function writeComposerVisibility(
  engineId: string | null,
  patch: { hidden?: Iterable<string>; instanceHidden?: Iterable<string>; pinned?: Iterable<string> },
  storage: StorageLike | null = browserStorage(),
): ComposerVisibility {
  if (!engineId) return readComposerVisibility(engineId, storage);
  if (patch.hidden !== undefined || patch.instanceHidden !== undefined) {
    const current = readHiddenMirror(storage, engineId);
    const next: HiddenMirror = {
      mine: patch.hidden !== undefined ? [...new Set(patch.hidden)].sort() : current.mine,
      instance: patch.instanceHidden !== undefined ? [...new Set(patch.instanceHidden)].sort() : current.instance,
    };
    writeJson(storage, engineScopedKey(STORAGE_KEYS.composerHiddenModels, engineId), next);
  }
  if (patch.pinned !== undefined) {
    writeJson(storage, engineScopedKey(STORAGE_KEYS.composerPinnedModels, engineId), [...new Set(patch.pinned)].sort());
  }
  dispatch(STORAGE_EVENTS.composerVisibilityChange);
  return readComposerVisibility(engineId, storage);
}

/** Mirror what /api/models/visibility answered. Only dispatches when
 * something actually changed, so the composer does not re-render on every
 * poll of an unchanged answer. */
export function mirrorServerVisibility(
  engineId: string | null,
  body: { hidden?: readonly string[]; instanceHidden?: readonly string[]; pinned?: readonly string[] },
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!engineId) return false;
  const current = readComposerVisibility(engineId, storage);
  const same = (a: Set<string>, b: readonly string[] | undefined) => b === undefined || (a.size === b.length && b.every((key) => a.has(key)));
  if (same(current.hidden, body.hidden) && same(current.instanceHidden, body.instanceHidden) && same(current.pinned, body.pinned)) return false;
  writeComposerVisibility(engineId, {
    ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
    ...(body.instanceHidden !== undefined ? { instanceHidden: body.instanceHidden } : {}),
    ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
  }, storage);
  return true;
}

/** Record a pick: newest first, deduplicated, capped at five. */
export function pushRecentModel(engineId: string | null, key: string, storage: StorageLike | null = browserStorage()): string[] {
  const storageKey = engineScopedKey(STORAGE_KEYS.recentModels, engineId);
  if (!storageKey || !key) return [];
  const current = stringList(readJson(storage, storageKey));
  const next = [key, ...current.filter((entry) => entry !== key)].slice(0, RECENT_MODELS_LIMIT);
  writeJson(storage, storageKey, next);
  dispatch(STORAGE_EVENTS.recentModelsChange);
  return next;
}

/** The retired allowlist stored `provider:modelId`; provider ids never
 * contain a colon, so the first one is the seam even when the model id has
 * its own (`openrouter:vendor/model:free`). */
export function convertLegacyAllowlistKey(entry: string): string | null {
  const colon = entry.indexOf(":");
  if (colon <= 0 || colon === entry.length - 1) return null;
  return `${entry.slice(0, colon)}/${entry.slice(colon + 1)}`;
}

export interface AllowlistMigration {
  migrated: boolean;
  /** The user's hidden list after the migration (unchanged when nothing migrated). */
  hidden: string[];
  /** Where the list was saved: the account, or only this browser (open
   * instance, or the server could not be reached). */
  savedTo: "account" | "browser" | null;
}

/**
 * Turn the retired composer ALLOWLIST (`cody:composer-models:<engine>`, the
 * models to show) into the account's HIDDEN list (the models not to show):
 * hidden = catalog − allowlist, unioned with whatever the account already
 * hides. Runs once per browser: the old key is deleted whether or not the
 * server took the write, so a later load never re-hides models the user has
 * since unhidden. An empty allowlist hid everything under the old rule,
 * which no one meant; it migrates as "nothing hidden".
 *
 * The write goes to /api/models/visibility; a 401 (signed out) or 409
 * (open instance with no accounts) keeps it in the browser mirror only.
 */
export async function migrateComposerAllowlist(
  engineId: string | null,
  catalogKeys: readonly string[],
  options: { storage?: StorageLike | null; fetchImpl?: typeof fetch; serverHidden?: readonly string[] } = {},
): Promise<AllowlistMigration> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const legacyKey = engineScopedKey(STORAGE_KEYS.composerModels, engineId);
  const current = readComposerVisibility(engineId, storage);
  const untouched: AllowlistMigration = { migrated: false, hidden: [...current.hidden], savedTo: null };
  if (!engineId || !legacyKey || !storage) return untouched;
  let raw: string | null;
  try {
    raw = storage.getItem(legacyKey);
  } catch {
    return untouched;
  }
  if (raw === null) return untouched;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  // The catalog has not arrived yet: nothing to diff against. Leave the key
  // for the load that has one.
  if (catalogKeys.length === 0) return untouched;
  const allow = new Set(stringList(parsed).map(convertLegacyAllowlistKey).filter((key): key is string => key !== null));
  const hiddenNow = new Set([...(options.serverHidden ?? []), ...current.hidden]);
  if (allow.size > 0) for (const key of catalogKeys) if (!allow.has(key)) hiddenNow.add(key);
  const hidden = [...hiddenNow].sort();

  let savedTo: AllowlistMigration["savedTo"] = "browser";
  const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (fetchImpl) {
    try {
      const response = await fetchImpl("/api/models/visibility", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      });
      if (response.ok) savedTo = "account";
    } catch {
      // Offline or a server that cannot answer: the browser keeps the list.
    }
  }
  writeComposerVisibility(engineId, { hidden }, storage);
  try {
    storage.removeItem(legacyKey);
  } catch {
    // A store that cannot delete will re-run the migration next load; the
    // union above makes that harmless.
  }
  return { migrated: true, hidden, savedTo };
}
