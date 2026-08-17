import { jsonError, requireAdmin } from "@/lib/auth/http";
import { getInstallSnapshot, subscribeInstall } from "@/lib/harness/install";

export const dynamic = "force-dynamic";

// GET /api/engines/install/events?id=claude — SSE stream of one engine's
// install progress: a snapshot frame (status + everything npm printed so
// far), then live log chunks, then a done frame. The stream closes itself
// once the install settles, and closes immediately when nothing is running —
// the snapshot already says how the last install ended. POST
// ../install remains the way to start an install; this route only watches.
export async function GET(req: Request) {
  const resolved = requireAdmin(req);
  if ("response" in resolved) return resolved.response;

  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return jsonError("Missing engine id", 400);

  // Hoisted so cancel() (half-open disconnects that never fire the abort
  // signal) can release the heartbeat and the subscription.
  let streamCleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      let unsubscribe: () => void = () => {};
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      streamCleanup = cleanup;

      // Subscribe BEFORE the snapshot so a chunk (or the done frame) cannot
      // slip through the gap; a duplicated log line is harmless, a missed
      // done frame would hang the client.
      unsubscribe = subscribeInstall(id, (event) => {
        try {
          encode(event);
        } catch {
          // controller already closed
        }
        if (event.type === "done") cleanup();
      });

      const snapshot = getInstallSnapshot(id);
      try {
        encode({ type: "snapshot", ...snapshot });
      } catch {
        // controller already closed
      }
      if (snapshot.status !== "running") {
        cleanup();
        return;
      }

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) cleanup();
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
