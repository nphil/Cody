/**
 * The Statistics index as one live service per server process.
 *
 * This is the only place the indexer meets the real install: it owns the store,
 * decides when a pass runs, and lets a request wait a moment for one without ever
 * holding the page up. Passes run in the background of the request that
 * started them; a request that cannot wait gets what is on file and an
 * "updating" flag, and asks again.
 *
 * Nothing here throws. A failing pass leaves the index as it was and is tried
 * again on a later request.
 */

import { serverTimeZone } from "../time-zone";
import { runIndexPass } from "./indexer";
import { statisticsDir, transcriptRoots } from "./paths";
import { StatsStore } from "./store";
import type { IndexProgress } from "./types";

/** A pass is started by an ordinary request once the last one is older than this. */
export const STALE_AFTER_MS = 10 * 60_000;
/** An explicit refresh cannot start a pass more often than this. */
export const REFRESH_GAP_MS = 20_000;
/** How long a request waits for a running pass before answering with what is on file. */
export const DEFAULT_WAIT_MS = 300;

interface ServiceState {
  store: StatsStore | null;
  running: Promise<void> | null;
  /** When the last pass in this process ended (ms), or 0. */
  finishedAt: number;
  progress: IndexProgress;
  lastError: string | null;
}

/** What a caller needs to know about the index besides its rows. */
export interface IndexStatus {
  /** A pass is running right now. */
  updating: boolean;
  /** When the last pass finished (ms), or null before the first one. */
  indexedAt: number | null;
  /** How far the running pass is; null when none is. */
  progress: IndexProgress | null;
  /** Why the last pass or save failed, if it did. */
  error: string | null;
}

export interface FreshStore {
  store: StatsStore;
  status: IndexStatus;
}

export interface FreshOptions {
  /** Start a pass even though the data is recent (still rate limited by REFRESH_GAP_MS). */
  refresh?: boolean;
  /** Longest wait for a running pass, in ms. */
  waitMs?: number;
  now?: number;
}

const scope = globalThis as typeof globalThis & { __codyStatistics?: ServiceState };

function serviceState(): ServiceState {
  return (scope.__codyStatistics ??= { store: null, running: null, finishedAt: 0, progress: { done: 0, total: 0 }, lastError: null });
}

function openStore(state: ServiceState): StatsStore {
  return (state.store ??= StatsStore.open(statisticsDir(), serverTimeZone()));
}

async function runPass(state: ServiceState, store: StatsStore): Promise<void> {
  const roots = transcriptRoots();
  state.progress = { done: 0, total: 0 };
  try {
    await runIndexPass(store, {
      sessionRoots: roots.sessions,
      sidebarRoots: roots.sidebar,
      logsDir: store.dir,
      now: Date.now(),
      progress: state.progress,
    });
    state.lastError = store.lastSaveError;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    state.finishedAt = Date.now();
  }
}

function wanted(state: ServiceState, store: StatsStore, now: number, refresh: boolean): boolean {
  if (state.running) return false;
  const last = Math.max(store.indexedAt ?? 0, state.finishedAt);
  if (last === 0) return true;
  return refresh ? now - last > REFRESH_GAP_MS : now - last > STALE_AFTER_MS;
}

function statusOf(state: ServiceState, store: StatsStore): IndexStatus {
  const updating = state.running !== null;
  return {
    updating,
    indexedAt: store.indexedAt,
    progress: updating ? { ...state.progress } : null,
    error: state.lastError,
  };
}

/**
 * The index, with a pass started when one is due and given up to `waitMs` to
 * finish. A first-ever pass over a big install takes longer than that, so the
 * caller gets the partly filled index and `updating: true`.
 */
export async function freshStore(options: FreshOptions = {}): Promise<FreshStore> {
  const state = serviceState();
  const now = options.now ?? Date.now();
  const store = openStore(state);
  if (wanted(state, store, now, options.refresh === true)) {
    state.running = runPass(state, store).finally(() => {
      state.running = null;
    });
  }
  const running = state.running;
  if (running) {
    const timer = Promise.withResolvers<void>();
    const handle = setTimeout(timer.resolve, options.waitMs ?? DEFAULT_WAIT_MS);
    try {
      await Promise.race([running, timer.promise]);
    } finally {
      clearTimeout(handle);
    }
  }
  return { store, status: statusOf(state, store) };
}
