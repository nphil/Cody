/**
 * A server-sent-event stream that looks after itself.
 *
 * `new EventSource(url)` reconnects a connection that dropped, and that is all
 * it does. Two failures it never notices leave a page showing a frozen picture
 * of the server until somebody reloads it:
 *
 *  - a refusal (the reverse proxy's 502 while the server restarts, a 401)
 *    closes the stream for good. Nothing opens it again;
 *  - a socket the network dropped without a word — the phone slept, the Wi-Fi
 *    changed — still reads OPEN, and nothing will ever arrive on it.
 *
 * This opens the stream, opens it again slowly after a refusal, opens it again
 * when a stream that is meant to speak every so often has gone quiet, and opens
 * it again on request: a page that woke up calls `reopen()`, and the server
 * greets every new connection with a fresh snapshot.
 *
 * `useMachineMeters` carries the same two repairs for its own stream, tied to
 * the tab being visible. This one is for streams that stay open in the
 * background too.
 */

/** `EventSource.CLOSED`, spelled out: tests run without the DOM class. */
const READY_STATE_CLOSED = 2;

/** Waits after a refusal: quick at first, then slow enough not to hammer a server that is down. */
export const LIVE_STREAM_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];
/** How often a stream with a silence limit is checked. A local timer: no network. */
export const LIVE_STREAM_WATCHDOG_MS = 15_000;

export type LiveStreamSource = Pick<EventSource, "readyState" | "close" | "onmessage" | "onerror">;

/** The browser pieces the stream uses; tests pass their own. */
export interface LiveStreamEnvironment {
  open: (url: string) => LiveStreamSource;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface LiveStreamOptions {
  url: string;
  onMessage: (event: MessageEvent<string>) => void;
  /**
   * A stream that has delivered nothing for this long is dead, whatever its
   * readyState says: it is closed and opened again. Set it only for a stream
   * whose server sends a data frame at a steady beat (a `:` comment is not one:
   * the browser swallows it); leave it out for one that may stay quiet.
   */
  silenceLimitMs?: number;
  watchdogMs?: number;
  retryMs?: readonly number[];
  environment?: LiveStreamEnvironment;
}

export interface LiveStream {
  /** Close the connection and open a new one now, forgetting any backoff. */
  reopen: () => void;
  /** Close for good. */
  close: () => void;
}

function browserEnvironment(): LiveStreamEnvironment {
  return {
    open: (url) => new EventSource(url),
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
  };
}

export function openLiveStream(options: LiveStreamOptions): LiveStream {
  const env = options.environment ?? browserEnvironment();
  const retryMs = options.retryMs ?? LIVE_STREAM_RETRY_MS;
  const watchdogMs = options.watchdogMs ?? LIVE_STREAM_WATCHDOG_MS;
  const { silenceLimitMs } = options;

  let source: LiveStreamSource | null = null;
  let retryTimer: unknown = null;
  let watchdogTimer: unknown = null;
  let lastFrameAt = 0;
  let refusals = 0;
  let disposed = false;

  /** Drop the connection and any retry still waiting for it. */
  const release = () => {
    if (retryTimer !== null) {
      env.clearTimer(retryTimer);
      retryTimer = null;
    }
    const current = source;
    source = null;
    current?.close();
  };

  const open = () => {
    if (disposed || source !== null) return;
    const stream = env.open(options.url);
    source = stream;
    lastFrameAt = env.now();
    stream.onmessage = (event) => {
      // A connection this stream has since replaced says nothing about the new one.
      if (source !== stream) return;
      lastFrameAt = env.now();
      refusals = 0;
      options.onMessage(event);
    };
    stream.onerror = () => {
      // The browser retries a dropped connection by itself (readyState
      // CONNECTING). Only a refusal closes it for good — and is retried here.
      if (source !== stream || stream.readyState !== READY_STATE_CLOSED) return;
      release();
      retryTimer = env.setTimer(() => {
        retryTimer = null;
        open();
      }, retryMs[Math.min(refusals, retryMs.length - 1)]);
      refusals += 1;
    };
  };

  const watch = () => {
    watchdogTimer = env.setTimer(() => {
      watchdogTimer = null;
      if (disposed) return;
      // Only a connection that is meant to be up: one waiting out a refusal is
      // already on its own schedule.
      if (source !== null && silenceLimitMs !== undefined && env.now() - lastFrameAt > silenceLimitMs) {
        release();
        open();
      }
      watch();
    }, watchdogMs);
  };

  open();
  if (silenceLimitMs !== undefined) watch();

  return {
    reopen() {
      if (disposed) return;
      release();
      refusals = 0;
      open();
    },
    close() {
      disposed = true;
      release();
      if (watchdogTimer !== null) {
        env.clearTimer(watchdogTimer);
        watchdogTimer = null;
      }
    },
  };
}
