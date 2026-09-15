/**
 * Serializes agent-state reconciliation polls.
 *
 * The hook can be triggered by an interval, visibility changes, reconnects,
 * online events, and todo updates at the same time. A slow response must not
 * allow those GET requests to race and apply stale state out of order.
 */
export interface ReconcileGuard {
  tryAcquire(): number | null;
  release(token: number): boolean;
  reset(): void;
}

export interface ReconcileGuardOptions {
  /** Release a permanently stalled request so the next trigger can retry. */
  timeoutMs?: number;
}

export function createReconcileGuard(options: ReconcileGuardOptions = {}): ReconcileGuard {
  const timeoutMs = options.timeoutMs;
  let inFlight = false;
  let ownerToken = 0;
  let generation = 0;
  let pendingWhileInFlight = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStallTimer = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  return {
    tryAcquire(): number | null {
      if (inFlight) {
        pendingWhileInFlight = true;
        return null;
      }
      inFlight = true;
      ownerToken = ++generation;
      pendingWhileInFlight = false;
      if (timeoutMs !== undefined) {
        clearStallTimer();
        const token = ownerToken;
        stallTimer = setTimeout(() => {
          stallTimer = null;
          if (inFlight && ownerToken === token) {
            inFlight = false;
            pendingWhileInFlight = false;
          }
        }, timeoutMs);
      }
      return ownerToken;
    },
    release(token: number): boolean {
      if (!inFlight || token !== ownerToken) return false;
      clearStallTimer();
      inFlight = false;
      if (!pendingWhileInFlight) return false;
      pendingWhileInFlight = false;
      return true;
    },
    reset(): void {
      clearStallTimer();
      inFlight = false;
      ownerToken = 0;
      pendingWhileInFlight = false;
      generation += 1;
    },
  };
}
