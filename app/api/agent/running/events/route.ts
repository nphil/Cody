import { getHarness } from "@/lib/harness";
import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Also carries refresh hints when a live session's file metadata
// changes, so the sidebar can show a newly-started session immediately.
//
// Every frame names the active engine, because an engine switch is
// instance-wide but only the browser that clicked Switch reloads. A second
// surface — the tablet on the couch, a phone over Tailscale, another tab —
// went on rendering the PREVIOUS engine's model roles, settings tabs and chat
// affordances indefinitely, while its sidebar quietly swapped to the new
// engine's sessions underneath. Nothing else the client holds is re-read after
// boot: capabilities are fetched once and memoized.
//
// This stream is the one live connection every loaded page already holds, so
// it is the cheapest place to say so. The heartbeat carries it too, which is
// what bounds the staleness of an otherwise idle tab to one heartbeat.
/** Never let a failure to read the selection tear down the stream: a frame
 * with no engine is simply one the client cannot act on. */
function activeEngineId(): string | null {
  try {
    return getHarness().id;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the subscriber.
  let streamCleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions(({ ids, refreshSessionList }) => {
        try {
          encode({
            type: "running",
            engine: activeEngineId(),
            runningSessionIds: ids,
            ...(refreshSessionList ? { refreshSessionList: true } : {}),
          });
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", engine: activeEngineId(), runningSessionIds: getRunningRpcSessionIds() });

      // Heartbeat to keep the connection alive through proxies/timeouts. A
      // data frame rather than the usual `:` comment so it can carry the
      // active engine: a tab with no session activity would otherwise never
      // hear that the engine changed. The client ignores frame types it does
      // not know, so this stays backward-compatible with an older page still
      // holding the stream open across a deploy.
      const heartbeat = setInterval(() => {
        try {
          encode({ type: "heartbeat", engine: activeEngineId() });
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      streamCleanup = cleanup;

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
