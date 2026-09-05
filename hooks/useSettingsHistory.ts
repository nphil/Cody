"use client";

/**
 * Browser history for the phone Settings stack, so the platform back gesture
 * (and the hardware Back button on Android) walks the stack one level at a
 * time instead of leaving the app.
 *
 * The contract, in the shell's terms:
 *   - `depth` is the UI's own count: 0 closed, 1 the root list, 2 a hub,
 *     3+ every pushed level (a Drawer, an `openSub` node). The controller
 *     keeps exactly one history entry per level: `sync(depth)` pushes the
 *     missing entries after a drill-in and `go()`s back over the surplus
 *     after a Back / Close button.
 *   - a popstate that lands BELOW the stack's top is a back gesture: it
 *     hands the UI ONE `onPop()` (never more, however far the browser
 *     jumped) and lets the UI decide — the busy register or a dirty form
 *     may refuse. `requestSync` then runs the owner's sync again, which
 *     re-pushes whatever the UI kept: that is how "Cancel" on the leave
 *     dialog restores the entry.
 *   - entries carry a per-open token, so an entry left by a previous open
 *     or a reload (state survives reloads) is never mistaken for one of
 *     ours: they, like any foreign state, count as "below the stack".
 *   - a popstate that lands ON the top (a forward navigation after a back
 *     that closed nothing) or that the controller caused itself is ignored.
 *   - `dispose()` (the × button, or the shell unmounting) unwinds every
 *     entry in one `go(-depth)`; a close that a back gesture caused has
 *     nothing left to unwind.
 *
 * Phone only: the desktop dialog pushes nothing (spec §9).
 *
 * Two browser facts shape the code: `history.go(0)` reloads the page in
 * some engines, so every `go` here is guarded to a non-zero delta; and
 * Chromium resolves a `go(delta)` TARGET when it is called, not when the
 * traversal lands, so a `pushState` issued while one is in flight ends up
 * beside the entry being left and the traversal still lands where it was
 * aimed. `sync` therefore waits for an in-flight traversal before pushing.
 */
import { useEffect, useId, useReducer, useRef } from "react";

export const SETTINGS_HISTORY_MARK = "settings";

// Minted once per page load: `useId` alone repeats across reloads (same
// tree, same id), and an entry left in `history.state` by a previous load
// must never pass for one of this load's.
const PAGE_NONCE = Math.random().toString(36).slice(2);

export interface SettingsHistoryState {
  cody: typeof SETTINGS_HISTORY_MARK;
  depth: number;
  token: string;
}

/** The slice of `window.history` the controller touches; tests hand in a fake. */
export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
}

export interface SettingsHistoryController {
  /** Entries this controller currently has on the stack. */
  readonly depth: number;
  /** Bring the history in line with the UI's depth. Idempotent. */
  sync(depth: number): void;
  handlePopState(event: { state: unknown }): void;
  /** Unwind everything pushed. Safe to call twice. */
  dispose(): void;
}

export interface SettingsHistoryOptions {
  history: HistoryLike;
  /** A back gesture asks for one level to go; the UI lowers `depth` if it agrees. */
  onPop: () => void;
  /** Called after a gesture was handled so the owner re-renders and syncs. */
  requestSync?: () => void;
  /** Per-open identity of the entries; random when omitted. */
  token?: string;
}

function isOurs(state: unknown, token: string): state is SettingsHistoryState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Partial<SettingsHistoryState>;
  return candidate.cody === SETTINGS_HISTORY_MARK && candidate.token === token && typeof candidate.depth === "number";
}

export function createSettingsHistory({ history, onPop, requestSync, token = Math.random().toString(36).slice(2) }: SettingsHistoryOptions): SettingsHistoryController {
  let historyDepth = 0;
  // popstates the controller caused with `go()`; one per call, since a
  // traversal of several entries fires a single event.
  let suppressed = 0;
  // A depth asked for while a traversal was in flight; applied when it lands.
  let deferred: number | null = null;
  let disposed = false;

  const pushLevel = () => {
    historyDepth += 1;
    const state: SettingsHistoryState = { cody: SETTINGS_HISTORY_MARK, depth: historyDepth, token };
    try {
      history.pushState(state, "");
    } catch {
      // Safari rate-limits pushState; the stack just loses one entry of
      // back-gesture coverage until the next sync.
      historyDepth -= 1;
    }
  };

  const goBack = (delta: number) => {
    if (delta <= 0) return;
    suppressed += 1;
    history.go(-delta);
  };

  return {
    get depth() {
      return historyDepth;
    },
    sync(depth) {
      if (disposed) return;
      const target = Math.max(0, depth);
      if (suppressed > 0) {
        deferred = target;
        return;
      }
      while (historyDepth < target) {
        const before = historyDepth;
        pushLevel();
        if (historyDepth === before) break;
      }
      if (historyDepth > target) {
        const delta = historyDepth - target;
        historyDepth = target;
        goBack(delta);
      }
    },
    handlePopState(event) {
      if (disposed) return;
      if (suppressed > 0) {
        suppressed -= 1;
        if (suppressed === 0 && deferred !== null) {
          const target = deferred;
          deferred = null;
          this.sync(target);
        }
        return;
      }
      const landed = isOurs(event.state, token) ? event.state.depth : 0;
      if (landed >= historyDepth) return;
      historyDepth = landed;
      onPop();
      requestSync?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const delta = historyDepth;
      historyDepth = 0;
      if (delta > 0) history.go(-delta);
    },
  };
}

/**
 * Mount a history controller while `enabled` (the phone shell), keep it in
 * step with `depth` after every commit, and route back gestures to `onPop`.
 * The controller is torn down — unwinding its entries — when the owner
 * unmounts or `enabled` turns off.
 */
export function useSettingsHistory({ enabled, depth, onPop }: { enabled: boolean; depth: number; onPop: () => void }): void {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const controller = useRef<SettingsHistoryController | null>(null);
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;
  // A controller whose teardown is scheduled but has not run: the effect
  // below re-runs synchronously after its own cleanup under React's
  // development StrictMode (mount, simulated unmount, mount). Disposing at
  // once would queue a `go(-depth)` aimed at the base entry, the re-run
  // would push a fresh entry, and the traversal would still land on the
  // base — read as a back gesture, closing the dialog it just opened. So a
  // cleanup only SCHEDULES the dispose, and an immediate re-run adopts the
  // live controller instead of making a new one.
  const parked = useRef<{ instance: SettingsHistoryController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const token = `${PAGE_NONCE}:${useId()}`;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let instance: SettingsHistoryController;
    if (parked.current) {
      clearTimeout(parked.current.timer);
      instance = parked.current.instance;
      parked.current = null;
    } else {
      instance = createSettingsHistory({
        history: window.history,
        onPop: () => onPopRef.current(),
        requestSync: bump,
        token,
      });
    }
    const listener = (event: PopStateEvent) => instance.handlePopState(event);
    window.addEventListener("popstate", listener);
    controller.current = instance;
    return () => {
      window.removeEventListener("popstate", listener);
      controller.current = null;
      const timer = setTimeout(() => {
        parked.current = null;
        instance.dispose();
      }, 0);
      parked.current = { instance, timer };
    };
  }, [enabled, token]);

  // No dependency list on purpose: the depth can stay the same while the
  // history fell behind it (a refused pop), and only a post-commit check
  // catches that.
  useEffect(() => {
    controller.current?.sync(enabled ? depth : 0);
  });
}
