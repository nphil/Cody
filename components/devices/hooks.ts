"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The time, for a view whose words change with it ("about 3 min left", "Starting soon"). It re-reads every `intervalMs`
 * while `active` or until `until` (a job that has just finished is shown as running a few seconds longer), and also at
 * the earliest of `wakeAt` that is still ahead (the moment a command that was held back becomes worth showing), so nothing
 * waits for the next event to notice that time has passed. Every comparison is against the time this hook last read, so a
 * render never reads the clock itself.
 */
export function useNow(options: { active: boolean; until?: number; wakeAt?: readonly number[]; intervalMs?: number }): number {
  const { active, until, wakeAt = [], intervalMs = 1_000 } = options;
  const [now, setNow] = useState(() => Date.now());
  const ticking = active || (until !== undefined && now < until);
  const next = wakeAt.reduce<number | undefined>((earliest, time) => (time > now && (earliest === undefined || time < earliest) ? time : earliest), undefined);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [ticking, intervalMs]);
  useEffect(() => {
    if (next === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 25);
    return () => window.clearTimeout(timer);
  }, [next]);
  return now;
}

/** Whole seconds left until `timestamp`, ticking while mounted. */
export function useSecondsUntil(timestamp: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [timestamp]);
  return Math.max(0, Math.ceil((timestamp - now) / 1000));
}

// ---- failures the person has seen -------------------------------------------------------------------------------------

const EMPTY: ReadonlySet<string> = new Set();
const seen = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Marks these operations' failures as seen. Kept for the page's lifetime, per session, so a remounted panel does not raise them again. */
export function acknowledge(sessionId: string, keys: readonly string[]): void {
  const next = new Set(seen.get(sessionId) ?? EMPTY);
  for (const key of keys) next.add(key);
  seen.set(sessionId, next);
  for (const listener of listeners) listener();
}

/** The operation ids whose failure the person has acknowledged in this session, and the way to acknowledge more. */
export function useAcknowledged(sessionId: string | null): { acknowledged: ReadonlySet<string>; acknowledge: (keys: readonly string[]) => void } {
  const acknowledged = useSyncExternalStore(subscribe, () => (sessionId ? seen.get(sessionId) ?? EMPTY : EMPTY), () => EMPTY);
  return { acknowledged, acknowledge: (keys) => { if (sessionId) acknowledge(sessionId, keys); } };
}
