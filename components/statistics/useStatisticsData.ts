"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageWake } from "@/hooks/usePageWake";
import type { GroupBy, StatisticsResponse } from "@/lib/statistics/types";
import { statisticsApiQuery, type PeriodSpec } from "./statistics-query";

/** While the server is still reading transcripts, ask again this often until it says it is done. */
const POLL_MS = 2500;

/** `range`: the server refused the dates. `failed`: it could not be reached or answered with an error. */
export type StatisticsFailure = "range" | "failed";

export interface StatisticsFeed {
  /** The latest answer. It stays on screen while the next one loads, so a period switch never blanks the page. */
  data: StatisticsResponse | null;
  /** A request for the chosen period is in flight (the first one, a new period, a refresh or a retry). */
  loading: boolean;
  failure: StatisticsFailure | null;
  /** Ask the server to read the transcripts again now. */
  refresh: () => void;
  /** Ask again after a failure. */
  retry: () => void;
}

/**
 * Reads /api/statistics for a period and ring order. Changing either aborts the
 * request in flight, so a slow answer for an old choice can never overwrite the
 * new one. While `updating` is true the answer is a snapshot of a half-built
 * index, so the hook keeps asking until the server settles.
 */
export function useStatisticsData(period: PeriodSpec, groupBy: GroupBy): StatisticsFeed {
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [failure, setFailure] = useState<StatisticsFailure | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by refresh() and retry() to run the request effect again with the same period.
  const [attempt, setAttempt] = useState(0);
  const refreshNext = useRef(false);
  const query = statisticsApiQuery(period, groupBy);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;

    const load = async (refresh: boolean) => {
      try {
        const response = await fetch(`/api/statistics?${query}${refresh ? "&refresh=1" : ""}`, { signal: controller.signal, cache: "no-store" });
        if (response.status === 401) {
          // The session ended while the page was open: sign in again and come back here.
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
          if (controller.signal.aborted) return;
          setFailure(body?.code === "invalid_range" ? "range" : "failed");
          setLoading(false);
          return;
        }
        const next = (await response.json()) as StatisticsResponse;
        if (controller.signal.aborted) return;
        setData(next);
        setFailure(null);
        setLoading(false);
        if (next.updating) timer = window.setTimeout(() => void load(false), POLL_MS);
      } catch {
        // An abort is the effect cleaning up after a newer request; anything else is a real failure.
        if (controller.signal.aborted) return;
        setFailure("failed");
        setLoading(false);
      }
    };

    const refresh = refreshNext.current;
    refreshNext.current = false;
    setLoading(true);
    setFailure(null);
    void load(refresh);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, attempt]);

  const refresh = useCallback(() => {
    refreshNext.current = true;
    setAttempt((count) => count + 1);
  }, []);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  // The page woke up after sitting open (a sleeping phone, a tab left behind):
  // the figures on screen are old and a read that was out may never answer, so
  // read again — the effect drops the old request. Not `refresh()`: an ordinary
  // read already starts a new pass when the server's index is over ten minutes
  // old, and a wake must not force a re-scan on top of that.
  usePageWake(retry);

  return { data, loading, failure, refresh, retry };
}
