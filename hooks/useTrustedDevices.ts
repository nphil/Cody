"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { pageTrustBook } from "@/lib/devices/trust-client";
import type { TrustedDevice } from "@/lib/devices/trust";

/** The part of the page's trust book Settings uses: it can read the list and remove from it, and nothing more. */
export interface TrustedDevicesSource {
  list(): readonly TrustedDevice[];
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  forget(key: string): Promise<void>;
  readonly loadError: string | null;
}

const NO_DEVICES: readonly TrustedDevice[] = [];

export interface TrustedDevicesState {
  /** The devices this account remembers, newest first. Keeps its identity until the list changes. */
  devices: readonly TrustedDevice[];
  /** Why the last read of the server's list failed; null when it worked. */
  loadError: string | null;
  /** True once the list has been read (or the read failed): until then an empty list proves nothing. */
  loaded: boolean;
  /** Withdraw trust for one device. Rejects with the server's reason when it refuses. */
  forget: (key: string) => Promise<void>;
}

/**
 * The devices the person has told Cody to let the agent control without asking
 * again, from the page's one trust book (lib/devices/trust-client.ts). Reads
 * the server's list again each time it mounts, so a device forgotten on
 * another browser is gone here too. There is deliberately no way to add a
 * device: trust is only given from the prompt in the chat.
 *
 * `source` and `initiallyLoaded` are the seam a test renders through; the
 * page passes neither. Without a browser there is no list to read, so a
 * server render always paints the empty, still-loading state.
 */
export function useTrustedDevices(source?: TrustedDevicesSource, initiallyLoaded = false): TrustedDevicesState {
  const book: TrustedDevicesSource = source ?? pageTrustBook();
  const [loaded, setLoaded] = useState(initiallyLoaded);
  const subscribe = useCallback((listener: () => void) => book.subscribe(listener), [book]);
  const devices = useSyncExternalStore(subscribe, () => book.list(), source ? () => book.list() : () => NO_DEVICES);
  const loadError = useSyncExternalStore(subscribe, () => book.loadError, source ? () => book.loadError : () => null);

  useEffect(() => {
    let current = true;
    void book.refresh().then(() => { if (current) setLoaded(true); });
    return () => { current = false; };
  }, [book]);

  const forget = useCallback((key: string) => book.forget(key), [book]);
  return { devices, loadError, loaded, forget };
}
