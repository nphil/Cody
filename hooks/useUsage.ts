"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "@/lib/usage/types";

// Demand-driven cadence: 90s while someone might actually be looking at the
// usage meter, backed off to 5 minutes once the tab is hidden or unfocused.
// A container nobody is looking at still polls (slowly) rather than going
// fully silent, so a reopened tab isn't stuck on a stale snapshot.
//
// The active cadence deliberately outlives the server cache's TTL
// (USAGE_CACHE_TTL_MS, 60s). Polling *at* the TTL means every poll lands on an
// entry that just expired, so stale-while-revalidate fires on every other tick
// and the footer flickers "may be out of date" forever while showing last
// minute's numbers. Waiting past the TTL means the poll finds either a fresh
// entry or a genuinely absent one — SWR then only covers real staleness.
export const USAGE_ACTIVE_INTERVAL_MS = 90_000;
export const USAGE_BACKGROUND_INTERVAL_MS = 5 * 60_000;

function isPageActive(): boolean {
  if (typeof document === "undefined") return false;
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return document.visibilityState === "visible" && focused;
}

export interface UseUsageResult {
  snapshot: UsageSnapshot | null;
  /** True until the first response settles, and again while a poll is out. */
  loading: boolean;
  /** True when the last attempt failed to produce a snapshot (transport error,
   * proxy error page, unparsable body). Distinct from "the engine answered and
   * reported no limits" — that is a successful read, and lives in `snapshot`. */
  failed: boolean;
  refresh: () => void;
}

/**
 * Client state for the plan-quota usage meter (GET /api/usage). Fetches on
 * mount, then keeps polling on a demand-driven interval — 90s while the
 * document is visible and focused, backing off to 5 minutes otherwise — and
 * skips a poll outright when the previous request is still in flight.
 * SSR-safe: no window/document access during render, mirroring useIsMobile /
 * useDesktopShell's mount-only-then-sync shape. A failed fetch never throws
 * into render — it just leaves the previous snapshot in place and raises
 * `failed`, so the UI can say "not read" instead of speaking for the engine.
 */
export function useUsage(): UseUsageResult {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  // Starts true: before the first response there is nothing to report, and
  // `loading: false` there would read as a settled "no quota" answer.
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the latest `load` so the visibility/focus listeners (registered
  // once, on mount) and the self-rescheduling timer always call the current
  // closure instead of a stale one.
  const loadRef = useRef<() => void>(() => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    clearTimer();
    if (!mountedRef.current) return;
    const delay = isPageActive() ? USAGE_ACTIVE_INTERVAL_MS : USAGE_BACKGROUND_INTERVAL_MS;
    timerRef.current = setTimeout(() => loadRef.current(), delay);
  }, [clearTimer]);

  const load = useCallback(() => {
    if (inFlightRef.current) {
      // Already fetching — skip this poll entirely (no request, no state
      // churn) rather than piling a second one on top of it.
      scheduleNext();
      return;
    }
    inFlightRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    fetch("/api/usage", { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as UsageSnapshot | null;
        if (!mountedRef.current || controller.signal.aborted) return;
        // The route itself fails soft (always 200), so a non-ok status or an
        // unparsable body means something even more fundamental (a proxy
        // error page, a restarting server). Leave the previous snapshot on
        // screen either way, but record that this read did not land: the UI
        // must not turn a transport failure into a claim about the engine.
        if (response.ok && body) {
          setSnapshot(body);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        // An abort is our own doing (unmount, or a refresh superseding this
        // read), not a failure worth reporting; anything else is.
        if (!mountedRef.current || controller.signal.aborted) return;
        setFailed(true);
      })
      .finally(() => {
        // Only the current request owns the shared flags: a superseded read
        // landing late must not clear the in-flight marker of the one that
        // replaced it.
        if (abortRef.current === controller) inFlightRef.current = false;
        if (!mountedRef.current || abortRef.current !== controller) return;
        setLoading(false);
        scheduleNext();
      });
  }, [scheduleNext]);

  loadRef.current = load;

  const refresh = useCallback(() => {
    clearTimer();
    loadRef.current();
  }, [clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    loadRef.current();

    // Coming back into view/focus reschedules the pending timer at whatever
    // cadence now applies (60s active / 5min background) instead of leaving
    // a reopened tab waiting out a background-length timer it no longer
    // qualifies for.
    const onActivityChange = () => scheduleNext();
    document.addEventListener("visibilitychange", onActivityChange);
    window.addEventListener("focus", onActivityChange);
    window.addEventListener("blur", onActivityChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onActivityChange);
      window.removeEventListener("focus", onActivityChange);
      window.removeEventListener("blur", onActivityChange);
      clearTimer();
      abortRef.current?.abort();
      abortRef.current = null;
      // The aborted request will never clear this itself now that it is no
      // longer the current one, and StrictMode's immediate remount would
      // otherwise see a permanently "in flight" read and skip its own fetch —
      // leaving dev with no usage data until the next poll.
      inFlightRef.current = false;
    };
    // Mount-only: load/scheduleNext are read through refs/stable callbacks so
    // this effect never needs to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { snapshot, loading, failed, refresh };
}
