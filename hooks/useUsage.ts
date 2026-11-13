"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageWake } from "@/hooks/usePageWake";
import { mergeUsageRead } from "@/lib/usage/client-merge";
import type { UsageSnapshot } from "@/lib/usage/types";
import type { ResetCreditOutcome, ResetCreditsSnapshot } from "@/lib/harness/reset-credits";
import { STORAGE_KEYS } from "@/lib/storage-keys";

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
 *
 * `enabled: false` makes the hook inert — no fetch, no timer, no snapshot.
 * The route answers `{available: false, reason}` for an engine that reports no
 * plan quota, which is a value rather than an error; the meter hides on it, so
 * polling every 90 seconds for a widget nobody will ever see is pure noise.
 * Passing `false` before the active engine is known and `true` after is the
 * normal case: the effect re-runs on the flip.
 *
 * `sessionId` scopes the read to one conversation: the answer then also says
 * which account that conversation's latest reply was served by
 * (`snapshot.sessionAccounts`). Switching conversations drops the previous
 * one's answer at once and re-reads, so it can never label another chat.
 */
export function useUsage(enabled = true, sessionId: string | null = null): UseUsageResult {
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
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

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

    const session = sessionRef.current;
    fetch(session ? `/api/usage?session=${encodeURIComponent(session)}` : "/api/usage", { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as UsageSnapshot | null;
        if (!mountedRef.current || controller.signal.aborted) return;
        // The route itself fails soft (always 200), so a non-ok status or an
        // unparsable body means something even more fundamental (a proxy
        // error page, a restarting server). Leave the previous snapshot on
        // screen either way, but record that this read did not land: the UI
        // must not turn a transport failure into a claim about the engine.
        if (response.ok && body) {
          // A read that raced a conversation switch describes the old one.
          // And a poll that comes back "no data" never erases a good reading
          // already on screen: it marks that one stale (mergeUsageRead).
          const next = session === sessionRef.current ? body : { ...body, sessionAccounts: undefined };
          setSnapshot((current) => mergeUsageRead(current, next));
          setFailed(false);
        } else {
          // A failed poll still moves the clock: the reading on screen keeps
          // ageing, so it is marked out of date once it is old enough rather
          // than standing as "current" until a poll finally lands.
          setSnapshot((current) => mergeUsageRead(current, null));
          setFailed(true);
        }
      })
      .catch(() => {
        // An abort is our own doing (unmount, or a refresh superseding this
        // read), not a failure worth reporting; anything else is.
        if (!mountedRef.current || controller.signal.aborted) return;
        setSnapshot((current) => mergeUsageRead(current, null));
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

  // The page woke up (screen on again, tab back, network back). A read that was
  // out when the device slept may never answer, and while one counts as in
  // flight every poll is skipped — so a hung read would freeze the meter until
  // a reload. Let it go and read again now (the timer restarts with the answer).
  usePageWake(() => {
    inFlightRef.current = false;
    refresh();
  }, enabled);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return;
    // The account-in-use answer belongs to the conversation that asked.
    setSnapshot((current) => (current?.sessionAccounts ? { ...current, sessionAccounts: undefined } : current));
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
    // load/scheduleNext are read through refs/stable callbacks; `enabled` and
    // the conversation are the only reasons this effect re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId]);

  // Disabled reports a settled "nothing to say", never "still checking": a
  // caller that renders on `loading` must not spin forever on a hook that
  // will never fetch.
  return enabled ? { snapshot, loading, failed, refresh } : { snapshot: null, loading: false, failed: false, refresh };
}
export type { ResetCredit, ResetCreditAccount, ResetCreditOutcome, ResetCreditsSnapshot } from "@/lib/harness/reset-credits";
/** `refresh(true)` is the user asking again: the server then checks the
 *  provider live (at most once a minute). Every other read — the timer, focus,
 *  opening the popover — is served from the server's shared cache. */
export interface UseResetCreditsResult { snapshot: ResetCreditsSnapshot | null; loading: boolean; failed: boolean; redeeming: boolean; refresh: (force?: boolean) => void; redeem: (accountId: string, creditId: string) => Promise<ResetCreditOutcome>; }
function resetBalanceStorageKey(observerId: string, accountId: string): string { return STORAGE_KEYS.resetCreditBalancePrefix + ":" + observerId + ":" + accountId; }
function observeResetCreditBalances(snapshot: ResetCreditsSnapshot): void {
  if (typeof window === "undefined" || !snapshot.available || !snapshot.observerId) return;
  for (const account of snapshot.accounts) {
    if (account.error) continue;
    const key = resetBalanceStorageKey(snapshot.observerId, account.id);
    try {
      const previousRaw = window.localStorage.getItem(key); const previous = previousRaw === null ? null : Number(previousRaw);
      if (previous !== null && Number.isSafeInteger(previous) && account.availableCount > previous) window.dispatchEvent(new CustomEvent("cody:reset-credit-balance-increased", { detail: { accountId: account.id, label: account.label, delta: account.availableCount - previous } }));
      window.localStorage.setItem(key, String(account.availableCount));
    } catch { /* Storage can be disabled; missing baseline stays silent. */ }
  }
}
export function useResetCredits(enabled = true): UseResetCreditsResult {
  const [snapshot, setSnapshot] = useState<ResetCreditsSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled); const [failed, setFailed] = useState(false); const [redeeming, setRedeeming] = useState(false); const [refreshVersion, setRefreshVersion] = useState(0);
  const redeemingRef = useRef(false);
  const forceNextRef = useRef(false);
  const refresh = useCallback((force = false) => {
    if (force) forceNextRef.current = true;
    setRefreshVersion((version) => version + 1);
  }, []);
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let cancelled = false;
    let loadInFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (loadInFlight) return;
      loadInFlight = true;
      setLoading(true);
      try {
        const force = forceNextRef.current;
        forceNextRef.current = false;
        const response = await fetch(force ? "/api/usage/reset-credits?refresh=1" : "/api/usage/reset-credits", { cache: "no-store" });
        const value: unknown = await response.json();
        if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reset-credit read failed.");
        const next = value as ResetCreditsSnapshot;
        if (!cancelled) { observeResetCreditBalances(next); setSnapshot(next); setFailed(false); }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        loadInFlight = false;
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, isPageActive() ? USAGE_ACTIVE_INTERVAL_MS : USAGE_BACKGROUND_INTERVAL_MS);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, refreshVersion]);
  const redeem = useCallback(async (accountId: string, creditId: string): Promise<ResetCreditOutcome> => {
    if (redeemingRef.current) return { outcome: "error", accountId, creditId, code: "in_flight" };
    redeemingRef.current = true; setRedeeming(true);
    try {
      const response = await fetch("/api/usage/reset-credits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId, creditId, confirmed: true, idempotencyKey: crypto.randomUUID() }) }); const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { outcome: "error", accountId, creditId, code: "http_" + response.status };
      return value as ResetCreditOutcome;
    } catch { return { outcome: "error", accountId, creditId, code: "http_0", message: "The redemption result is inconclusive; refresh before trying again." }; }
    finally { redeemingRef.current = false; setRedeeming(false); refresh(); }
  }, [refresh]);
  // Coming back (tab visible, window focused, network back, device woke): read
  // again now. A new effect run drops a read the sleep left hanging.
  usePageWake(() => refresh(), enabled);
  return { snapshot, loading, failed, redeeming, refresh, redeem };
}
