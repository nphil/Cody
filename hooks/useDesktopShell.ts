"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Minimal shape of the `window.__TAURI__` global the Tauri 2 desktop shell
 * injects as a webview init script when `app.withGlobalTauri` is set
 * (docs/windows.md "Window chrome (Discord/VSCode style, native)"). Only the
 * window-control surface Cody's titlebar needs is typed here — this is not
 * the full `@tauri-apps/api` surface, and that package is deliberately not a
 * dependency of the web app (withGlobalTauri exists precisely so it doesn't
 * need to be).
 */
interface TauriWindowHandle {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** No dedicated "maximize changed" event exists; it fires (repeatedly,
   * undebounced) during resize/move, so callers re-query isMaximized(). */
  onResized(handler: () => void): Promise<() => void>;
}

interface TauriGlobal {
  window: {
    getCurrentWindow(): TauriWindowHandle;
  };
}

declare global {
  interface Window {
    /** Present only inside the Tauri desktop shell's WebView2 (withGlobalTauri: true). Absent on web/Docker. */
    __TAURI__?: TauriGlobal;
  }
}

export interface DesktopShellControls {
  /** True only inside the Tauri desktop shell. SSR and first client paint are always false. */
  isDesktop: boolean;
  /** Live window maximize state; stays false outside the shell. */
  isMaximized: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

function hasTauriShell(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

function getServerSnapshot(): boolean {
  return false;
}

// window.__TAURI__ is injected once, before any page script runs (a WebView2
// AddScriptToExecuteOnDocumentCreated init script — see the Tauri research
// report §1c), and never appears or disappears afterwards. There is nothing
// to subscribe to; only the SSR-safe snapshot read matters, exactly like
// useIsMobile's shape.
function subscribe(): () => void {
  return () => {};
}

function getTauriWindow(): TauriWindowHandle | null {
  if (typeof window === "undefined") return null;
  const tauri = window.__TAURI__;
  if (!tauri || typeof tauri.window?.getCurrentWindow !== "function") return null;
  try {
    return tauri.window.getCurrentWindow();
  } catch {
    return null;
  }
}

/**
 * SSR-safe detection of, and control surface for, the Tauri desktop shell —
 * mirrors useIsMobile's useSyncExternalStore shape. The server and first
 * client paint always report `isDesktop: false` (so a plain web/Docker load,
 * where `window.__TAURI__` never exists, renders byte-identical pre- and
 * post-hydration), and only a real WebView2 host flips it to true once React
 * syncs to the live snapshot after mount.
 *
 * minimize/toggleMaximize/close feature-detect the shell themselves too, so
 * they safely no-op if ever invoked outside it.
 */
export function useDesktopShell(): DesktopShellControls {
  const isDesktop = useSyncExternalStore(subscribe, hasTauriShell, getServerSnapshot);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    const win = getTauriWindow();
    if (!win) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;

    const syncMaximized = () => {
      win
        .isMaximized()
        .then((value) => {
          if (!cancelled) setIsMaximized(value);
        })
        .catch(() => {
          // IPC not ready yet, or the permission is missing — leave the last-known state.
        });
    };

    syncMaximized();

    // onResized fires continuously during a drag-resize and each tick is an
    // async IPC round-trip — debounce the isMaximized() re-query (trailing
    // ~100ms) instead of querying on every tick.
    win
      .onResized(() => {
        if (debounceHandle) clearTimeout(debounceHandle);
        debounceHandle = setTimeout(syncMaximized, 100);
      })
      .then((unlistenFn) => {
        if (cancelled) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      })
      .catch(() => {
        // core:event:allow-listen missing — the glyph just won't live-update.
      });

    return () => {
      cancelled = true;
      if (debounceHandle) clearTimeout(debounceHandle);
      if (unlisten) unlisten();
    };
  }, [isDesktop]);

  const minimize = useCallback(() => {
    void getTauriWindow()?.minimize().catch(() => {});
  }, []);

  const toggleMaximize = useCallback(() => {
    void getTauriWindow()?.toggleMaximize().catch(() => {});
  }, []);

  const close = useCallback(() => {
    void getTauriWindow()?.close().catch(() => {});
  }, []);

  return { isDesktop, isMaximized, minimize, toggleMaximize, close };
}
