// Client-side coalescing of `message_update` SSE frames.
//
// omp emits message_update per token batch (often far above display rate) and
// every frame carries the FULL accumulated partial message, so dispatching each
// one re-renders the whole streaming bubble. Only the latest pending update is
// worth showing; buffer it and flush at animation-frame rate.
//
// Tool executions use the same full-snapshot contract: keep the latest
// `tool_execution_update` per toolCallId so concurrent tools do not overwrite
// one another and chatty tools do not cause an uncontrolled render per event.
//
// Ordering contract:
// - Any non-update event type flushes the pending updates synchronously BEFORE
//   it is dispatched, so no state is applied out of order.
// - `message_end` carries the complete message and therefore supersedes
//   (drops) any pending partial message update. It does not drop pending tool
//   updates because the tool may still be running after its assistant call is
//   committed.

export type CoalescableEvent = { type: string; [key: string]: unknown };

/** Schedules `flush` and returns a cancel function. */
export type FlushScheduler = (flush: () => void) => () => void;

export interface MessageUpdateCoalescer {
  push(event: CoalescableEvent): void;
  /** Drop any pending update and cancel the scheduled flush (stream replaced or unmounted). */
  reset(): void;
}

// requestAnimationFrame matches display rate but stalls in hidden tabs, so
// fall back to a trailing 50ms timer there (and outside the browser).
function defaultScheduler(flush: () => void): () => void {
  if (
    typeof document !== "undefined"
    && !document.hidden
    && typeof requestAnimationFrame === "function"
  ) {
    const id = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(flush, 50);
  return () => clearTimeout(id);
}

export function createMessageUpdateCoalescer(
  dispatch: (event: CoalescableEvent) => void,
  schedule: FlushScheduler = defaultScheduler,
): MessageUpdateCoalescer {
  let pending: CoalescableEvent | null = null;
  // Map insertion order keeps concurrent tools dispatching in the order they
  // first reported progress, while later frames replace only their own entry.
  const pendingToolUpdates = new Map<string, CoalescableEvent>();
  let cancelScheduled: (() => void) | null = null;

  const cancel = () => {
    if (cancelScheduled) {
      cancelScheduled();
      cancelScheduled = null;
    }
  };

  const flush = () => {
    cancelScheduled = null;
    const event = pending;
    const toolEvents = [...pendingToolUpdates.values()];
    pending = null;
    pendingToolUpdates.clear();
    if (event) dispatch(event);
    for (const toolEvent of toolEvents) dispatch(toolEvent);
  };

  const scheduleFlush = () => {
    if (!cancelScheduled) cancelScheduled = schedule(flush);
  };

  return {
    push(event: CoalescableEvent) {
      if (event.type === "message_update") {
        pending = event;
        scheduleFlush();
        return;
      }
      if (event.type === "tool_execution_update") {
        // An event without an id cannot be safely coalesced; dispatch it now
        // rather than allowing one anonymous tool to replace another.
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
        if (!toolCallId) {
          flush();
          dispatch(event);
          return;
        }
        pendingToolUpdates.set(toolCallId, event);
        scheduleFlush();
        return;
      }
      if (event.type === "message_end") {
        // The complete message supersedes only the pending message update.
        // A tool update belongs to the tool the message announced and remains
        // valid until that tool emits its own end/result.
        pending = null;
        if (pendingToolUpdates.size === 0) cancel();
      } else if (pending || pendingToolUpdates.size > 0) {
        cancel();
        const buffered = pending;
        const toolEvents = [...pendingToolUpdates.values()];
        pending = null;
        pendingToolUpdates.clear();
        if (buffered) dispatch(buffered);
        for (const toolEvent of toolEvents) dispatch(toolEvent);
      }
      dispatch(event);
    },
    reset() {
      pending = null;
      pendingToolUpdates.clear();
      cancel();
    },
  };
}
