"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createBeatController, type ActivityReport } from "@/lib/daily-limit/active-time";
import type { DailyLimitState } from "@/lib/daily-limit/state";
import { deriveView, type DailyLimitView } from "@/lib/daily-limit/view";
import { deviceTimeZoneField } from "@/lib/device-time-zone";

/**
 * The browser half of the daily time limit (the rules are in
 * `lib/daily-limit/`, the server half in `app/api/daily-limit`).
 *
 * ONE store per page, read by every surface — the composer's ring, its
 * popover, the "time's up" notice and the Settings card — so they cannot
 * disagree, and ONE counter per page (`useDailyLimitTracker`, mounted once in
 * AppShell) so a second component can never double the beats.
 *
 * The answer is the server's, never computed here: each beat's response is
 * today's total across every tab and device, which is what the ring shows. A
 * page that is not being used asks for nothing; it catches up when it is
 * picked up again.
 */

const ROUTE = "/api/daily-limit";
const BEAT_ROUTE = "/api/daily-limit/beat";

/** A pointer fires up to ~120 times a second; the counter needs a few. */
const INPUT_THROTTLE_MS = 250;
/** A passive refresh (focus, visible, a new day) never repeats faster than this. */
const REFRESH_MIN_GAP_MS = 5_000;

interface Snapshot {
  /** The newest answer, or null before the first one (and after none could be had). */
  state: DailyLimitState | null;
  /** The first answer, or the first failure, has arrived. */
  loaded: boolean;
  /** Why the last read failed; the previous state keeps showing. */
  error: string | null;
}

interface Store {
  snapshot: Snapshot;
  listeners: Set<() => void>;
  refreshing: Promise<void> | null;
  lastRefreshAt: number;
  /** The page is going away for good: its last report goes as a beacon. */
  leaving: boolean;
}

declare global {
  var __codyDailyLimit: Store | undefined;
}

const EMPTY: Snapshot = { state: null, loaded: false, error: null };

// On globalThis so a Fast Refresh module swap cannot leave two stores — and two
// sets of subscribers — behind.
const store: Store = (globalThis.__codyDailyLimit ??= {
  snapshot: EMPTY,
  listeners: new Set(),
  refreshing: null,
  lastRefreshAt: 0,
  leaving: false,
});

function publish(next: Partial<Snapshot>): void {
  store.snapshot = { ...store.snapshot, ...next };
  for (const listener of store.listeners) listener();
}

/** Keep an answer only if it is not older than the one on screen: replies to
 * overlapping requests can land out of order. */
function accept(state: DailyLimitState): void {
  const current = store.snapshot.state;
  if (current && state.serverNow < current.serverNow) return;
  publish({ state, loaded: true, error: null });
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

const getSnapshot = (): Snapshot => store.snapshot;
const getServerSnapshot = (): Snapshot => EMPTY;

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ask the server for today's state. Several callers at once share one request. */
export function refreshDailyLimit(): Promise<void> {
  if (store.refreshing) return store.refreshing;
  store.lastRefreshAt = Date.now();
  const zone = deviceTimeZoneField().timeZone;
  store.refreshing = fetch(zone ? `${ROUTE}?timeZone=${encodeURIComponent(zone)}` : ROUTE, { cache: "no-store" })
    .then(async (response) => {
      const body = await readBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      accept(body as unknown as DailyLimitState);
    })
    .catch((error: unknown) => publish({ loaded: true, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      store.refreshing = null;
    });
  return store.refreshing;
}

/** A refresh nobody asked for (the page was picked up, a new day began). */
function refreshSoon(): void {
  if (Date.now() - store.lastRefreshAt >= REFRESH_MIN_GAP_MS) void refreshDailyLimit();
}

/** Save a change and show the server's answer. Rejects with the server's own words. */
async function change(patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(ROUTE, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...patch, ...deviceTimeZoneField() }),
  });
  const body = await readBody(response);
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  accept(body as unknown as DailyLimitState);
}

/** Switch the limit on or off. Off by default; off hides every timer surface. */
export function setDailyLimitEnabled(enabled: boolean): Promise<void> {
  return change({ enabled });
}

/** The daily length, in whole minutes. */
export function setDailyLimitMinutes(limitMinutes: number): Promise<void> {
  return change({ limitMinutes });
}

/** "Add 15 minutes": more time for TODAY only. */
export function addDailyLimitTime(addMinutes: number): Promise<void> {
  return change({ addMinutes });
}

/** "Done for today": the notice is acknowledged at this limit. */
export function dismissDailyLimitNotice(): Promise<void> {
  return change({ dismissNotice: true });
}

export interface DailyLimitSnapshot {
  state: DailyLimitState | null;
  /** How the limit looks right now; null while it is off or unknown — draw nothing. */
  view: DailyLimitView | null;
  loaded: boolean;
  error: string | null;
}

/** The shared state, for any component. Never starts a request or a timer. */
export function useDailyLimit(): DailyLimitSnapshot {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const view = useMemo(() => deriveView(snapshot.state), [snapshot.state]);
  return { state: snapshot.state, view, loaded: snapshot.loaded, error: snapshot.error };
}

// ----------------------------------------------------------------------------
// Counting
// ----------------------------------------------------------------------------

function postBeat(report: ActivityReport, final: boolean): void {
  const body = JSON.stringify({ ...report, ...deviceTimeZoneField() });
  // A beacon survives a page that is closing or hidden; the page that merely
  // lost focus is still here to read the answer, so it sends a plain request.
  if (final && (store.leaving || document.visibilityState === "hidden") && typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(BEAT_ROUTE, new Blob([body], { type: "application/json" }))) return;
    } catch {
      // Fall through to the keepalive request.
    }
  }
  void fetch(BEAT_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
    .then((response) => (response.ok ? readBody(response) : null))
    .then((state) => {
      if (state) accept(state as unknown as DailyLimitState);
    })
    .catch(() => {
      // A beat that did not land is a few seconds not counted; the next one carries on.
    });
}

/**
 * Count active time on this page until the returned function is called.
 *
 * Input that counts is what a person does: a key, a pointer press, a pointer
 * that actually MOVED, the wheel, a touch, or a text selection. A `scroll`
 * event is deliberately NOT one — it is also what the chat's own auto-scroll
 * fires every time an agent streams a word, and an agent working in a tab
 * nobody is touching must never count. Scrolling by hand is already covered by
 * the wheel, touch, keys and pointer that cause it. For the same reason a
 * "move" with the pointer where it already was (the browser repeats the last
 * position when content scrolls under a parked mouse) and an event a script
 * dispatched (`isTrusted` false) are ignored.
 */
function startCounting(): () => void {
  const controller = createBeatController({
    now: Date.now,
    every: (ms, fn) => {
      const id = window.setInterval(fn, ms);
      return () => window.clearInterval(id);
    },
    send: postBeat,
  });
  let lastInputAt = 0;
  let lastX = Number.NaN;
  let lastY = Number.NaN;

  const present = () => document.visibilityState === "visible" && document.hasFocus();
  const syncPresence = () => controller.setPresent(present());
  const onInput = () => {
    const at = Date.now();
    if (at - lastInputAt < INPUT_THROTTLE_MS) return;
    lastInputAt = at;
    controller.input();
    // First touch after midnight: take the new day's numbers.
    const state = store.snapshot.state;
    if (state && at >= state.dayEndsAt) refreshSoon();
  };
  const onTrusted = (event: Event) => {
    if (event.isTrusted) onInput();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!event.isTrusted || (event.clientX === lastX && event.clientY === lastY)) return;
    lastX = event.clientX;
    lastY = event.clientY;
    onInput();
  };
  const onSelectionChange = () => {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) onInput();
  };
  const onPageHide = () => {
    store.leaving = true;
    controller.setPresent(false);
  };
  const onPageShow = () => {
    store.leaving = false;
    syncPresence();
  };

  const listen = { capture: true, passive: true } as const;
  document.addEventListener("keydown", onTrusted, listen);
  document.addEventListener("pointerdown", onTrusted, listen);
  document.addEventListener("pointermove", onPointerMove, listen);
  document.addEventListener("wheel", onTrusted, listen);
  document.addEventListener("touchstart", onTrusted, listen);
  document.addEventListener("touchmove", onTrusted, listen);
  document.addEventListener("selectionchange", onSelectionChange, listen);
  document.addEventListener("visibilitychange", syncPresence);
  window.addEventListener("focus", syncPresence);
  window.addEventListener("blur", syncPresence);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  syncPresence();

  return () => {
    document.removeEventListener("keydown", onTrusted, listen);
    document.removeEventListener("pointerdown", onTrusted, listen);
    document.removeEventListener("pointermove", onPointerMove, listen);
    document.removeEventListener("wheel", onTrusted, listen);
    document.removeEventListener("touchstart", onTrusted, listen);
    document.removeEventListener("touchmove", onTrusted, listen);
    document.removeEventListener("selectionchange", onSelectionChange, listen);
    document.removeEventListener("visibilitychange", syncPresence);
    window.removeEventListener("focus", syncPresence);
    window.removeEventListener("blur", syncPresence);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    controller.dispose();
  };
}

/**
 * Loads the daily limit and, while it is ON, counts this page's active time.
 * Mount it once inside the signed-in shell (AppShell).
 *
 *  - The state is read once, then again whenever the page is picked up (focus,
 *    visible, back online) — what other devices counted while this one sat.
 *  - Nothing is attached while the limit is off: no listeners, no timer, no
 *    request. Turning it on (here or on another device, noticed at the next
 *    pickup) starts counting; turning it off stops at once.
 *  - The heartbeat timer exists only while a stretch of activity can still be
 *    reported (`createBeatController`), so a hidden or idle tab owns none.
 */
export function useDailyLimitTracker(): void {
  const enabled = useSyncExternalStore(subscribe, () => store.snapshot.state?.enabled === true, () => false);

  useEffect(() => {
    void refreshDailyLimit();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshSoon();
    };
    window.addEventListener("focus", refreshSoon);
    window.addEventListener("online", refreshSoon);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshSoon);
      window.removeEventListener("online", refreshSoon);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => (enabled ? startCounting() : undefined), [enabled]);
}
