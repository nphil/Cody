/**
 * The decisions that keep a chat turn from wedging when the engine under it
 * dies.
 *
 * A container restart (or an engine crash) kills the agent process mid-turn.
 * The browser still believes a turn is in flight, its EventSource reconnects,
 * and `app/api/agent/[id]/events` answers by RESUMING the session — with a
 * fresh, idle child that inherited nothing. No `agent_end` will ever arrive for
 * the dead turn, so a client that only waits for one waits forever.
 *
 * These helpers are the client's three answers to that, kept pure (no React, no
 * EventSource) so they can be reasoned about and tested on their own:
 *
 *  1. `shouldClearLostTurn` — reconcile the client's belief against the run
 *     state the server stamps on every `connected` frame.
 *  2. `evaluateStreamHealth` — a watchdog so a stream that is not delivering
 *     stops being rendered as a healthy "Waiting for model…".
 *  3. `reconnectDelayMs` / `shouldGiveUpReconnecting` — bounded, backed-off
 *     manual reconnects instead of a fixed-interval retry loop that can hammer
 *     a 404 forever.
 */

/** `EventSource.OPEN`, spelled out: this module never touches the DOM. */
export const EVENT_SOURCE_OPEN = 1;

/** First manual reconnect delay after a fatal stream error. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
/** Ceiling for the doubling backoff — a slow retry is still a retry. */
export const RECONNECT_MAX_DELAY_MS = 15_000;
/** Consecutive-failure budget before the UI stops retrying and asks the user. */
export const RECONNECT_GIVE_UP_MS = 120_000;
/** How long a stream may be unhealthy before the UI admits it is degraded. */
export const STREAM_DEGRADED_AFTER_MS = 20_000;

/**
 * Delay before manual reconnect attempt `attempt` (0-based): 1s, 2s, 4s, 8s,
 * then capped at 15s. The old fixed 1s loop could 404-hammer a session that is
 * never coming back.
 */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt));
  // 2 ** step reaches Infinity long before it matters; the cap still holds.
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** step, RECONNECT_MAX_DELAY_MS);
}

/**
 * True once the current *consecutive* failure streak has lasted longer than the
 * budget. `failingSince` is the timestamp of the first failure in the streak and
 * is cleared the moment any connection succeeds, so a stream that flaps but
 * recovers never gives up.
 */
export function shouldGiveUpReconnecting(failingSince: number | null, now: number): boolean {
  if (failingSince === null) return false;
  return now - failingSince >= RECONNECT_GIVE_UP_MS;
}

/**
 * Should the client drop a turn it believes is running, because the server just
 * told it nothing is?
 *
 * The `connected` frame carries `running` — the engine's actual run state at
 * (re)connect time. `running: false` while the client is waiting means the turn
 * died with the old process: clear the waiting state and tell the user. A frame
 * WITHOUT the field comes from a server that predates this contract; never
 * guess from its absence, or an older server would cancel live turns.
 *
 * `believedRunning` must mean "a turn the SERVER already acknowledged is in
 * flight". An optimistic, not-yet-sent prompt does not qualify: the client
 * opens the stream BEFORE posting the prompt, so that connection's `connected`
 * frame honestly reports an idle engine and clearing on it would cancel every
 * send.
 */
export function shouldClearLostTurn(believedRunning: boolean, frame: unknown): boolean {
  if (!believedRunning) return false;
  if (typeof frame !== "object" || frame === null) return false;
  return (frame as { running?: unknown }).running === false;
}

export interface StreamHealthInput {
  /** Does the client currently believe a turn is in flight? */
  agentRunning: boolean;
  /** `EventSource.readyState`, or null when there is no stream object at all. */
  readyState: number | null;
  /** Frames of ANY type delivered by the CURRENT connection (reset per connect). */
  framesSeen: number;
  /** Start of the current unhealthy stretch; null while healthy. Carried over. */
  unhealthySince: number | null;
  now: number;
}

export interface StreamHealth {
  /** Feed back into the next evaluation. */
  unhealthySince: number | null;
  /** Unhealthy for longer than the grace, with a turn believed in flight. */
  degraded: boolean;
}

/**
 * Watchdog verdict for the event stream.
 *
 * Healthy means: the connection is OPEN *and* it has delivered at least one
 * frame. The second half matters and the first is not enough — a half-open
 * connection can sit in OPEN forever. It is also deliberately not "a frame
 * arrived recently": an open stream is silent for as long as a tool call takes,
 * and the server's 30s heartbeat is an SSE comment that `onmessage` never sees,
 * so a recency rule would flag healthy long-running turns. The server sends
 * `connected` immediately, so any real connection clears this within a tick.
 */
export function evaluateStreamHealth(input: StreamHealthInput): StreamHealth {
  const healthy = input.readyState === EVENT_SOURCE_OPEN && input.framesSeen > 0;
  if (healthy) return { unhealthySince: null, degraded: false };
  const since = input.unhealthySince ?? input.now;
  return {
    unhealthySince: since,
    degraded: input.agentRunning && input.now - since >= STREAM_DEGRADED_AFTER_MS,
  };
}
