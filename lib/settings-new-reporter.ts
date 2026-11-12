/**
 * The Settings dialog's side of the "New" badge on engine settings, minus
 * React: what to tell the server (lib/settings-seen.ts, app/api/settings-seen)
 * and when a chip counts as seen.
 *
 * Browser-safe and free of module state. Every effect (the POST, timers, the
 * IntersectionObserver, page visibility) is injected, so the rules are tested
 * in node (lib/settings-new-reporter.test.mjs) and the hook that wires them
 * to React (hooks/useSettingsNewKeys.ts) stays thin.
 */
import { MAX_OPEN_ID_CHARS, MAX_REPORT_KEYS } from "./settings-new-keys";

export const SETTINGS_SEEN_ROUTE = "/api/settings-seen";

/** Seen reports are batched: the first one arms this timer and every chip
 * that shows up before it fires rides in the same POST. */
export const SEEN_BATCH_MS = 1000;

/** A chip counts as seen once at least this much of it is on screen ... */
export const SEEN_MIN_RATIO = 0.5;
/** ... for this long, in a visible page. A scroll past it does not count. */
export const SEEN_DWELL_MS = 600;

/** What GET and POST /api/settings-seen answer, as the dialog reads it. */
export interface NewKeysAnswer {
  engineId: string;
  /** The engine version, when it could be read. */
  version: string | null;
  /** The keys still badged for this person, as of this open. */
  keys: string[];
  /** The engine version that brought each key (null when unknown). */
  since: Record<string, string | null>;
}

/** The answer body, or null for anything that is not one (an error body, a proxy page). */
export function parseNewKeysAnswer(body: unknown): NewKeysAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const { engine, newKeys, since } = body as { engine?: unknown; newKeys?: unknown; since?: unknown };
  if (typeof engine !== "object" || engine === null) return null;
  const { id, version } = engine as { id?: unknown; version?: unknown };
  if (typeof id !== "string" || !id || !Array.isArray(newKeys)) return null;
  const sinceByKey: Record<string, string | null> = {};
  if (typeof since === "object" && since !== null && !Array.isArray(since)) {
    for (const [key, introduced] of Object.entries(since)) {
      if (typeof introduced === "string" || introduced === null) sinceByKey[key] = introduced;
    }
  }
  return {
    engineId: id,
    version: typeof version === "string" ? version : null,
    keys: newKeys.filter((key): key is string => typeof key === "string" && key.length > 0),
    since: sinceByKey,
  };
}

/** A random id for one Settings open: the server counts a key at most once per id. */
export function newOpenId(): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return id.slice(0, MAX_OPEN_ID_CHARS);
}

export interface SeenReport {
  openId: string;
  seen?: string[];
  changed?: string[];
}

export interface SeenReporterEnv {
  /** Send one report; resolves whether the server took it. Never rejects. */
  send(report: SeenReport, options: { keepalive: boolean }): Promise<boolean>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface SeenReporter {
  /** A chip for `key` was on screen. Counted once per reporter, however often it is called. */
  seen(key: string): void;
  /** `key`'s value was changed. Goes out at once, not with the next batch. */
  changed(key: string): void;
  /** Send everything that waits now. */
  flush(options?: { keepalive?: boolean }): void;
  /** The dialog is closing: send what waits (it must outlive the page) and stop. */
  dispose(): void;
}

/**
 * Collects what one Settings open has seen and changed and tells the server.
 *
 * Each key is sent once per open: a repeat is ignored here, and the server
 * ignores a repeated `openId` for the same key too, so a retry after a lost
 * answer cannot count twice. A POST that fails puts its keys back; they go out
 * with the next one (or when the dialog closes) instead of being retried in a
 * loop against a server that is down.
 */
export function createSeenReporter(openId: string, env: SeenReporterEnv): SeenReporter {
  const pendingSeen = new Set<string>();
  const pendingChanged = new Set<string>();
  // Sent, or in flight: never queued a second time while true.
  const takenSeen = new Set<string>();
  const takenChanged = new Set<string>();
  let timer: unknown = null;
  let disposed = false;

  const disarm = () => {
    if (timer === null) return;
    env.clearTimer(timer);
    timer = null;
  };

  const send = (seen: string[], changed: string[], keepalive: boolean) => {
    const report: SeenReport = { openId };
    if (seen.length > 0) report.seen = seen;
    if (changed.length > 0) report.changed = changed;
    void env.send(report, { keepalive }).then((ok) => {
      if (ok) return;
      for (const key of seen) { takenSeen.delete(key); pendingSeen.add(key); }
      for (const key of changed) { takenChanged.delete(key); pendingChanged.add(key); }
    });
  };

  const flush = (options?: { keepalive?: boolean }) => {
    disarm();
    if (pendingSeen.size === 0 && pendingChanged.size === 0) return;
    const seen = [...pendingSeen];
    const changed = [...pendingChanged];
    pendingSeen.clear();
    pendingChanged.clear();
    for (const key of seen) takenSeen.add(key);
    for (const key of changed) takenChanged.add(key);
    // One report holds at most MAX_REPORT_KEYS of each list; a dialog never
    // gets near that, but a longer list is split rather than refused.
    for (let from = 0; from < Math.max(seen.length, changed.length); from += MAX_REPORT_KEYS) {
      send(seen.slice(from, from + MAX_REPORT_KEYS), changed.slice(from, from + MAX_REPORT_KEYS), options?.keepalive === true);
    }
  };

  return {
    seen(key) {
      if (disposed || !key || takenSeen.has(key) || takenChanged.has(key) || pendingSeen.has(key) || pendingChanged.has(key)) return;
      pendingSeen.add(key);
      if (timer === null) {
        timer = env.setTimer(() => { timer = null; flush(); }, SEEN_BATCH_MS);
      }
    },
    changed(key) {
      if (disposed || !key || takenChanged.has(key) || pendingChanged.has(key)) return;
      pendingSeen.delete(key);
      pendingChanged.add(key);
      flush();
    },
    flush,
    dispose() {
      if (disposed) return;
      flush({ keepalive: true });
      disposed = true;
    },
  };
}

/** The minimal shape of an IntersectionObserverEntry the dwell logic reads. */
export interface SeenObserverEntry {
  isIntersecting: boolean;
  intersectionRatio: number;
}

export interface SeenObserverEnv {
  /** Null when the browser cannot observe visibility: nothing then counts as seen. */
  createObserver(
    onEntries: (entries: readonly SeenObserverEntry[]) => void,
    options: { threshold: number[] },
  ): { observe(target: unknown): void; disconnect(): void } | null;
  /** True while the page is shown (document.visibilityState). */
  pageVisible(): boolean;
  /** Calls `listener` when the page is hidden or shown; returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The environment of a real page; the one `observeSeen` uses unless told otherwise. */
export function browserSeenEnv(): SeenObserverEnv {
  return {
    createObserver: (onEntries, options) => {
      if (typeof IntersectionObserver === "undefined") return null;
      return new IntersectionObserver((entries) => onEntries(entries), options);
    },
    pageVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as number),
  };
}

/**
 * Calls `onSeen` once when `target` has been on screen long enough to count as
 * seen: at least `SEEN_MIN_RATIO` of it visible for `SEEN_DWELL_MS`, in a page
 * that is shown. Scrolling it away or hiding the page before the dwell ends
 * starts the wait over. An element that is not rendered (a hub kept mounted
 * under display:none) never intersects, so it never counts. Returns the stop
 * function; calling it before the dwell ends means `onSeen` never fires.
 */
export function observeSeen(target: unknown, onSeen: () => void, env: SeenObserverEnv = browserSeenEnv()): () => void {
  let onScreen = false;
  let timer: unknown = null;
  let finished = false;

  const disarm = () => {
    if (timer === null) return;
    env.clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    if (finished || timer !== null || !onScreen || !env.pageVisible()) return;
    timer = env.setTimer(() => {
      timer = null;
      if (finished || !onScreen || !env.pageVisible()) return;
      stop();
      onSeen();
    }, SEEN_DWELL_MS);
  };

  const observer = env.createObserver((entries) => {
    // Entries are ordered oldest first; the last one is where the element is now.
    const latest = entries[entries.length - 1];
    if (!latest) return;
    onScreen = latest.isIntersecting && latest.intersectionRatio >= SEEN_MIN_RATIO;
    if (onScreen) arm();
    else disarm();
  }, { threshold: [0, SEEN_MIN_RATIO, 1] });
  if (!observer) return () => {};

  const stopWatchingPage = env.onVisibilityChange(() => {
    if (env.pageVisible()) arm();
    else disarm();
  });
  function stop() {
    finished = true;
    disarm();
    observer?.disconnect();
    stopWatchingPage();
  }
  observer.observe(target);
  return stop;
}
