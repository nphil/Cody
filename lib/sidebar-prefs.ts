/**
 * Sidebar view preferences kept in this browser: the running-only filter, the
 * "show more" lists, the Explorer section, collapsed fork branches and, on
 * desktop, whether the sidebar itself is docked open.
 *
 * They are a property of the person at this browser, so they live in
 * localStorage (keys in lib/storage-keys) and survive a reload. Before this
 * they sat in component state and every reload reset them, which on a phone or
 * tablet — where the OS drops a page whenever it needs the memory — meant
 * re-applying the same filter each time the device woke.
 *
 * Search text is deliberately NOT here. A query is what you are looking for
 * right now; restoring it would hide sessions behind a search box that starts
 * closed. The list view (Recent / Projects) predates this module and keeps its
 * own key (lib/project-ordering parses it).
 *
 * The parsing is pure, so a hand-edited or half-written value can never crash
 * a render: anything unreadable falls back to the default. The store keeps a
 * write-through copy, which gives `useSyncExternalStore` a snapshot whose
 * identity holds between reads, and lets a browser that refuses storage
 * (private mode, quota) still toggle for the life of the page.
 */

/** Most ids one stored set keeps. Adding past it drops the oldest, so a set
 *  that is never pruned (forks of long-deleted sessions) cannot grow forever. */
export const MAX_STORED_IDS = 200;
/** An id longer than this is not a session id or a project path of ours. */
const MAX_ID_LENGTH = 4096;

/** The shared empty set: the default for every id set, never mutated. */
export const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export type PrefStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** "true"/"false" as written by `serializeFlag`; anything else is the default. */
export function parseStoredFlag(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

export function serializeFlag(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * A JSON array of non-empty strings, oldest first. Entries of any other type
 * are skipped rather than failing the whole set, duplicates collapse, and only
 * the newest `max` survive.
 */
export function parseStoredIdSet(raw: string | null | undefined, max = MAX_STORED_IDS): ReadonlySet<string> {
  if (!raw) return EMPTY_ID_SET;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_ID_SET;
  }
  if (!Array.isArray(parsed)) return EMPTY_ID_SET;
  const ids = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ID_LENGTH) continue;
    // Re-adding moves an id to the newest end, matching `withIdMembership`.
    ids.delete(entry);
    ids.add(entry);
  }
  if (ids.size === 0) return EMPTY_ID_SET;
  return ids.size > max ? new Set([...ids].slice(ids.size - max)) : ids;
}

/** The stored form of a set, or null for an empty one (the key is removed). */
export function serializeIdSet(ids: ReadonlySet<string>): string | null {
  return ids.size === 0 ? null : JSON.stringify([...ids]);
}

/**
 * `ids` with `id` present or absent. Returns `ids` itself when nothing
 * changes, so callers can skip the write and the re-render. Adding past `max`
 * evicts the oldest entry.
 */
export function withIdMembership(ids: ReadonlySet<string>, id: string, present: boolean, max = MAX_STORED_IDS): ReadonlySet<string> {
  if (present) {
    if (ids.has(id) || id.length === 0 || id.length > MAX_ID_LENGTH) return ids;
    const next = new Set(ids);
    next.add(id);
    return next.size > max ? new Set([...next].slice(next.size - max)) : next;
  }
  if (!ids.has(id)) return ids;
  if (ids.size === 1) return EMPTY_ID_SET;
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/** Slot for a set that has no storage key yet (the engine id is still unknown). */
const MEMORY_ONLY = "\0memory-only";

export interface PrefStore {
  getFlag(key: string, fallback: boolean): boolean;
  setFlag(key: string, value: boolean): void;
  /** `null` is a set that lives for this page only. */
  getIdSet(key: string | null): ReadonlySet<string>;
  setIdMember(key: string | null, id: string, present: boolean): void;
  subscribe(key: string | null, listener: () => void): () => void;
}

/**
 * Preferences over one storage area. A value is read from storage the first
 * time it is asked for and held from then on; a write updates the held value,
 * writes through (best effort), and tells that key's subscribers. Another
 * tab's write is not picked up until reload — the same as component state
 * would behave, and the last writer wins in storage.
 */
export function createPrefStore(getStorage: () => PrefStorage | null): PrefStore {
  const flags = new Map<string, boolean>();
  const idSets = new Map<string, ReadonlySet<string>>();
  const listeners = new Map<string, Set<() => void>>();

  const read = (key: string): string | null => {
    try {
      return getStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string | null): void => {
    try {
      const storage = getStorage();
      if (!storage) return;
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // Quota or a privacy mode: the held value still applies to this page.
    }
  };
  const notify = (slot: string): void => {
    for (const listener of [...(listeners.get(slot) ?? [])]) listener();
  };

  const store: PrefStore = {
    getFlag(key, fallback) {
      const held = flags.get(key);
      if (held !== undefined) return held;
      const value = parseStoredFlag(read(key), fallback);
      flags.set(key, value);
      return value;
    },
    setFlag(key, value) {
      const changed = flags.get(key) !== value;
      flags.set(key, value);
      write(key, serializeFlag(value));
      if (changed) notify(key);
    },
    getIdSet(key) {
      const slot = key ?? MEMORY_ONLY;
      const held = idSets.get(slot);
      if (held !== undefined) return held;
      const loaded = key === null ? EMPTY_ID_SET : parseStoredIdSet(read(key));
      idSets.set(slot, loaded);
      return loaded;
    },
    setIdMember(key, id, present) {
      const slot = key ?? MEMORY_ONLY;
      const current = store.getIdSet(key);
      const next = withIdMembership(current, id, present);
      if (next === current) return;
      idSets.set(slot, next);
      if (key !== null) write(key, serializeIdSet(next));
      notify(slot);
    },
    subscribe(key, listener) {
      const slot = key ?? MEMORY_ONLY;
      let set = listeners.get(slot);
      if (set === undefined) {
        set = new Set();
        listeners.set(slot, set);
      }
      set.add(listener);
      return () => {
        listeners.get(slot)?.delete(listener);
      };
    },
  };
  return store;
}

function browserStorage(): PrefStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage blocked by the browser: preferences hold for this page only.
    return null;
  }
}

/** The sidebar's preferences in this browser. */
export const sidebarPrefs: PrefStore = createPrefStore(browserStorage);
