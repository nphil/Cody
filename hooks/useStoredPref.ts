"use client";

import { useCallback, useSyncExternalStore } from "react";
import { EMPTY_ID_SET, sidebarPrefs } from "@/lib/sidebar-prefs";

/**
 * A true/false preference that outlives a reload (lib/sidebar-prefs).
 *
 * The server and the hydrating render show `fallback`; the stored choice takes
 * over right after, so the first client paint always matches the server's HTML.
 * The setter accepts a value or an updater, like `useState`'s.
 */
export function useStoredFlag(key: string, fallback: boolean): readonly [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const subscribe = useCallback((listener: () => void) => sidebarPrefs.subscribe(key, listener), [key]);
  const value = useSyncExternalStore(
    subscribe,
    () => sidebarPrefs.getFlag(key, fallback),
    () => fallback,
  );
  const set = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    sidebarPrefs.setFlag(key, typeof next === "function" ? next(sidebarPrefs.getFlag(key, fallback)) : next);
  }, [key, fallback]);
  return [value, set];
}

/**
 * A set of ids (project paths, session ids) that outlives a reload. A `null`
 * key — the engine id the key is scoped by has not arrived yet — keeps the set
 * for this page only. The same set instance is returned until it changes.
 */
export function useStoredIdSet(key: string | null): readonly [ReadonlySet<string>, (id: string, present: boolean) => void] {
  const subscribe = useCallback((listener: () => void) => sidebarPrefs.subscribe(key, listener), [key]);
  const ids = useSyncExternalStore(
    subscribe,
    () => sidebarPrefs.getIdSet(key),
    () => EMPTY_ID_SET,
  );
  const setMember = useCallback((id: string, present: boolean) => sidebarPrefs.setIdMember(key, id, present), [key]);
  return [ids, setMember];
}
