import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { getMachineStates, subscribeMachines } from "@/lib/machines/sampler";
import type { MachineStreamFrame } from "@/lib/machines/types";

/**
 * GET /api/machines/stream — live CPU and memory for every machine, as SSE.
 *
 * The first frame is the current state of every machine; a new one follows
 * whenever a reading lands (at most a few a second). Holding this open is what
 * makes the server sample at all: the sampler starts with the first viewer and
 * stops a minute after the last one leaves (`lib/machines/sampler.ts`), so a
 * closed browser costs nothing on any machine.
 *
 * A heartbeat every 10 s lets a page tell a quiet machine list from a dead
 * connection (the page reconnects after 30 s of silence). Frames carry
 * statuses and numbers only — never an address or ssh's own output.
 */

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 10_000;

export function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;

  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send = (frame: MachineStreamFrame) => {
    try {
      controllerRef?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    } catch {
      // the connection is already closed
    }
  };

  // Subscribe before the first frame so no reading can fall between the two.
  const unsubscribe = subscribeMachines((machines) => send({ type: "machines", machines, at: Date.now() }));
  if (!unsubscribe) return jsonError("Too many pages are watching the machines", 503, "too_many_viewers");

  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      send({ type: "machines", machines: getMachineStates(), at: Date.now() });
      heartbeat = setInterval(() => send({ type: "heartbeat", at: Date.now() }), HEARTBEAT_MS);
      request.signal.addEventListener("abort", cleanup);
      if (request.signal.aborted) cleanup();
    },
    cancel: cleanup,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
