/**
 * One "the page woke up" signal for every surface that holds server state.
 *
 * A page left open on a phone or tablet is frozen by the OS the moment the
 * screen goes off: timers stop, and the sockets under every EventSource are
 * closed or silently dropped while the browser still reports them OPEN. The
 * sidebar's running badges, the open chat, the quota ring and the rest then
 * show whatever was true when the device went to sleep, and nothing tells them
 * to look again — each surface had its own half-set of visibility/focus
 * listeners, or none. This module is the single place that notices the page
 * is back and says so once; each surface re-reads its own data and reconnects
 * its own streams when told.
 *
 * What counts as "back" (the detector, below, is pure and takes the browser
 * signals as input so the rules are testable with a fake clock):
 *
 *  - the tab becoming visible again, or the window regaining focus, after it
 *    had been away (hidden, offline, frozen) for at least `WAKE_MIN_AWAY_MS`.
 *    A tab flicker, or focus moving into an iframe of the same page, is not a
 *    wake: nothing can have gone stale in a few seconds, and a refetch round
 *    every time the terminal pane is clicked would be pure noise;
 *  - `pageshow` with `persisted` (restored from the back/forward cache);
 *  - the network coming back (`online`) or a Page Lifecycle `resume`;
 *  - the wall clock jumping: a 5 s timer that finds more than 30 s gone by
 *    means the device slept with the page visible (lid closed, tablet
 *    standing on a charger) and no visibility event will ever say so.
 *
 * Several of these usually land together (visible + focus + pageshow + online),
 * so they are coalesced: ONE `WakeEvent` is emitted a short moment after the
 * first of them. That moment is also what gives the radio time to reassociate
 * before every surface fires its request.
 */

export type WakeReason = "visible" | "focus" | "pageshow" | "online" | "resume" | "clock";

export interface WakeEvent {
  /** What woke the page. When several signals landed together, the strongest. */
  reason: WakeReason;
  /** Date.now() at emission. */
  at: number;
  /** How long the page had been away (hidden, offline, frozen or asleep), in ms; 0 when unknown. */
  awayMs: number;
}

/** The raw browser signals the detector is fed. */
export type WakeSignal =
  | { type: "hidden" }
  | { type: "visible" }
  | { type: "focus" }
  | { type: "pageshow"; persisted: boolean }
  | { type: "online" }
  | { type: "offline" }
  | { type: "resume" }
  | { type: "tick" };

/** Coalescing window: from the first wake signal to the one emission. */
export const WAKE_DEBOUNCE_MS = 800;
/** Shortest absence that counts for visible/focus; anything shorter is a flicker. */
export const WAKE_MIN_AWAY_MS = 5_000;
/** Cadence of the clock-jump check. A local timer: no network. */
export const WAKE_TICK_MS = 5_000;
/** A tick this much later than scheduled means the device slept. */
export const WAKE_CLOCK_JUMP_MS = 30_000;

/** Which reason names a coalesced burst: the one that says the most about how far the page was gone. */
const REASON_RANK: Record<WakeReason, number> = { focus: 0, visible: 1, online: 2, resume: 3, pageshow: 4, clock: 5 };

export interface WakeDetectorOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Whether the page is hidden right now. */
  hidden?: boolean;
  debounceMs?: number;
  minAwayMs?: number;
  tickMs?: number;
  clockJumpMs?: number;
}

export interface WakeDetector {
  /** Feed one browser signal. */
  signal: (signal: WakeSignal) => void;
  subscribe: (listener: (event: WakeEvent) => void) => () => void;
  listenerCount: () => number;
  dispose: () => void;
}

export function createWakeDetector(options: WakeDetectorOptions): WakeDetector {
  const { now, setTimer, clearTimer } = options;
  const debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
  const minAwayMs = options.minAwayMs ?? WAKE_MIN_AWAY_MS;
  const tickMs = options.tickMs ?? WAKE_TICK_MS;
  const clockJumpMs = options.clockJumpMs ?? WAKE_CLOCK_JUMP_MS;

  const listeners = new Set<(event: WakeEvent) => void>();
  let hidden = options.hidden === true;
  // Start of the current absence (hidden, offline, frozen); null while present.
  let awaySince: number | null = hidden ? now() : null;
  let lastTickAt = now();
  let pending: { reason: WakeReason; awayMs: number } | null = null;
  let timer: unknown = null;

  const cancelPending = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
  };

  const emit = () => {
    timer = null;
    const burst = pending;
    pending = null;
    // Hidden again before the window closed (a tab flicker that started a
    // wake): nobody is looking, and the next time they do, that is a wake of
    // its own — the absence is still on the books.
    if (burst === null || hidden) return;
    const at = now();
    const awayMs = Math.max(burst.awayMs, awaySince === null ? 0 : at - awaySince);
    awaySince = null;
    lastTickAt = at;
    const event: WakeEvent = { reason: burst.reason, at, awayMs };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One surface failing to refresh must not keep the others from it.
        console.error("[page-wake] a listener failed", error);
      }
    }
  };

  const candidate = (reason: WakeReason, awayMs: number) => {
    if (pending !== null) {
      if (REASON_RANK[reason] > REASON_RANK[pending.reason]) pending.reason = reason;
      pending.awayMs = Math.max(pending.awayMs, awayMs);
      return;
    }
    pending = { reason, awayMs };
    timer = setTimer(emit, debounceMs);
  };

  const absentFor = (): number => (awaySince === null ? 0 : now() - awaySince);

  const signal = (input: WakeSignal) => {
    switch (input.type) {
      case "hidden":
        hidden = true;
        awaySince ??= now();
        // A wake that was still coalescing is moot while nobody is looking.
        cancelPending();
        return;
      case "offline":
        awaySince ??= now();
        return;
      case "visible":
        hidden = false;
        // Timers were throttled while hidden: the drift clock restarts here.
        lastTickAt = now();
        if (awaySince === null) return;
        if (absentFor() >= minAwayMs) candidate("visible", absentFor());
        else awaySince = null;
        return;
      case "focus":
        // Focus alone proves nothing (it also moves into an iframe of this
        // page). It counts only as the tail of an absence already on record.
        if (hidden || awaySince === null || absentFor() < minAwayMs) return;
        candidate("focus", absentFor());
        return;
      case "pageshow":
        if (!input.persisted) return;
        hidden = false;
        lastTickAt = now();
        candidate("pageshow", absentFor());
        return;
      case "online":
        candidate("online", absentFor());
        return;
      case "resume":
        hidden = false;
        lastTickAt = now();
        candidate("resume", absentFor());
        return;
      case "tick": {
        const at = now();
        const elapsed = at - lastTickAt;
        lastTickAt = at;
        // A hidden page's timers are throttled to once a minute or worse:
        // the gaps prove nothing, and the return to visible is its own signal.
        if (hidden) return;
        if (elapsed - tickMs >= clockJumpMs) candidate("clock", elapsed);
        return;
      }
    }
  };

  return {
    signal,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
    dispose() {
      cancelPending();
      listeners.clear();
    },
  };
}

/** The browser's event sources, as `createBrowserWakeSources` consumes them (injectable for tests). */
export interface WakeBrowser {
  window: Pick<Window, "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval">;
  document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

/** Wire the real browser events into a detector; returns the teardown. */
export function attachWakeSources(detector: WakeDetector, browser: WakeBrowser): () => void {
  const { window: win, document: doc } = browser;
  const onVisibility = () => detector.signal({ type: doc.visibilityState === "hidden" ? "hidden" : "visible" });
  const onPageHide = () => detector.signal({ type: "hidden" });
  const onPageShow = (event: Event) => detector.signal({ type: "pageshow", persisted: (event as PageTransitionEvent).persisted === true });
  const onFocus = () => detector.signal({ type: "focus" });
  const onOnline = () => detector.signal({ type: "online" });
  const onOffline = () => detector.signal({ type: "offline" });
  // Page Lifecycle events (Chromium): the page is frozen after hidden and thawed by resume.
  const onFreeze = () => detector.signal({ type: "hidden" });
  const onResume = () => detector.signal({ type: "resume" });

  doc.addEventListener("visibilitychange", onVisibility);
  doc.addEventListener("freeze", onFreeze);
  doc.addEventListener("resume", onResume);
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("pageshow", onPageShow);
  win.addEventListener("focus", onFocus);
  win.addEventListener("online", onOnline);
  win.addEventListener("offline", onOffline);
  const tick = win.setInterval(() => detector.signal({ type: "tick" }), WAKE_TICK_MS);

  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    doc.removeEventListener("freeze", onFreeze);
    doc.removeEventListener("resume", onResume);
    win.removeEventListener("pagehide", onPageHide);
    win.removeEventListener("pageshow", onPageShow);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("online", onOnline);
    win.removeEventListener("offline", onOffline);
    win.clearInterval(tick);
  };
}

let shared: { detector: WakeDetector; detach: () => void } | null = null;

/**
 * Be told when the page woke up. One detector and one set of DOM listeners
 * serve every subscriber; they are installed with the first and removed with
 * the last, so a page with nobody subscribed carries none. A no-op on the
 * server.
 */
export function subscribePageWake(listener: (event: WakeEvent) => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (shared === null) {
    const detector = createWakeDetector({
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      hidden: document.visibilityState === "hidden",
    });
    shared = { detector, detach: attachWakeSources(detector, { window, document }) };
  }
  const current = shared;
  const unsubscribe = current.detector.subscribe(listener);
  return () => {
    unsubscribe();
    if (shared === current && current.detector.listenerCount() === 0) {
      current.detach();
      current.detector.dispose();
      shared = null;
    }
  };
}
