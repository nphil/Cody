/**
 * Keeping a chat's list of scheduled messages true on screen — without polling.
 *
 * A framework-free controller (the React hook is a thin wrapper), so every
 * rule below has a test that needs neither a DOM nor React. The page learns of
 * a change only by asking, so it asks at the moments something can have
 * changed: when the chat opens, when the tab comes back, when the network
 * returns, when a run ends (an agent may have scheduled something during it),
 * after one of the person's own changes, and at the one time the next pending
 * message becomes due (`planScheduledRefresh`). While a message is on its way
 * or overdue it asks again a few more times, backing off, then stops until
 * the next of those moments. A hidden tab arms nothing.
 *
 * Browser-safe: no Node imports, no DOM access except through `isVisible`.
 */
import { listScheduled } from "./client";
import { planScheduledRefresh } from "./ui";
import { SCHEDULED_LIMITS } from "./types";
import type { ScheduledItemView, ScheduledListResponse } from "./types";

export interface ScheduledSyncState {
  /** The chat these rows belong to; null before a chat exists. */
  sessionId: string | null;
  /** Soonest first. */
  items: readonly ScheduledItemView[];
  limits: typeof SCHEDULED_LIMITS;
  /** The server has answered for this chat at least once. */
  loaded: boolean;
  /** The latest read failed (offline, a restart): the rows shown are the last ones known. */
  failed: boolean;
}

export interface ScheduledSyncOptions {
  onChange: (state: ScheduledSyncState) => void;
  /** Test seam; defaults to the client's own request. */
  list?: (sessionId: string, options: { signal: AbortSignal }) => Promise<ScheduledListResponse>;
  isVisible?: () => boolean;
  now?: () => number;
}

export interface ScheduledSync {
  getState(): ScheduledSyncState;
  /** Follow another chat (or none): drops the previous chat's rows at once and reads the new one. */
  setSession(sessionId: string | null): void;
  /** Read now. Reads asked for while one is out are folded into ONE more read after it. */
  refresh(): void;
  /** The tab became visible (read) or hidden (stop waiting). */
  visibilityChanged(): void;
  /** A change the person just made came back from the server: show it without another read. */
  upsert(item: ScheduledItemView): void;
  remove(itemId: string): void;
  dispose(): void;
}

const EMPTY: ScheduledSyncState = { sessionId: null, items: [], limits: SCHEDULED_LIMITS, loaded: false, failed: false };

function byDue(a: ScheduledItemView, b: ScheduledItemView): number {
  return Date.parse(a.at) - Date.parse(b.at) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** Whether two answers would draw the same rows: a follow-up read that found nothing new must not re-render the composer. */
function sameItems(a: readonly ScheduledItemView[], b: readonly ScheduledItemView[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return item.id === other.id && item.at === other.at && item.status === other.status
      && item.message === other.message && item.error === other.error && item.mode === other.mode
      && item.quota?.label === other.quota?.label;
  });
}

export function createScheduledSync(options: ScheduledSyncOptions): ScheduledSync {
  const list = options.list ?? ((sessionId, { signal }) => listScheduled(sessionId, { signal }));
  const isVisible = options.isVisible ?? (() => true);
  const now = options.now ?? Date.now;

  let state = EMPTY;
  let inFlight: AbortController | null = null;
  let readAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let followUps = 0;
  let disposed = false;

  const publish = (next: ScheduledSyncState) => {
    state = next;
    options.onChange(state);
  };

  const stopWaiting = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const arm = () => {
    stopWaiting();
    if (disposed || state.sessionId === null) return;
    const plan = planScheduledRefresh({ items: state.items, now: now(), visible: isVisible(), followUps });
    if (plan.kind === "none") return;
    timer = setTimeout(() => {
      timer = undefined;
      followUps = plan.kind === "follow-up" ? followUps + 1 : 0;
      void read();
    }, plan.delayMs);
  };

  async function read(): Promise<void> {
    const sessionId = state.sessionId;
    if (disposed || sessionId === null) return;
    if (inFlight) {
      readAgain = true;
      return;
    }
    const mine = new AbortController();
    inFlight = mine;
    try {
      const answer = await list(sessionId, { signal: mine.signal });
      if (!mine.signal.aborted) {
        const items = [...answer.items].sort(byDue);
        publish(state.loaded && !state.failed && sameItems(state.items, items)
          ? state
          : { sessionId, items, limits: answer.limits, loaded: true, failed: false });
      }
    } catch {
      if (!mine.signal.aborted && !state.failed) publish({ ...state, failed: true });
    } finally {
      if (inFlight === mine) inFlight = null;
    }
    // Superseded by a chat change (its own read is under way) or by dispose: nothing more to do for this one.
    if (mine.signal.aborted || disposed) return;
    if (readAgain) {
      readAgain = false;
      void read();
      return;
    }
    arm();
  }

  const refresh = () => {
    followUps = 0;
    void read();
  };

  return {
    getState: () => state,
    setSession(sessionId) {
      if (disposed || sessionId === state.sessionId) return;
      inFlight?.abort();
      inFlight = null;
      readAgain = false;
      followUps = 0;
      stopWaiting();
      publish({ ...EMPTY, sessionId });
      void read();
    },
    refresh,
    visibilityChanged() {
      if (isVisible()) refresh();
      else stopWaiting();
    },
    upsert(item) {
      if (disposed || item.sessionId !== state.sessionId) return;
      const items = [...state.items.filter((existing) => existing.id !== item.id), item].sort(byDue);
      followUps = 0;
      publish({ ...state, items });
      arm();
    },
    remove(itemId) {
      if (disposed || !state.items.some((item) => item.id === itemId)) return;
      publish({ ...state, items: state.items.filter((item) => item.id !== itemId) });
      arm();
    },
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      stopWaiting();
    },
  };
}
