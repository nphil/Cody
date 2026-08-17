import { authorizeDisplaySession } from "@/lib/display/access";
import { subscribeDisplayRequests } from "@/lib/display/bus";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await authorizeDisplaySession(request, id))) return new Response("Session not found", { status: 404 });

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { closed = true; }
      };
      const unsubscribe = subscribeDisplayRequests(id, send);
      const heartbeat = setInterval(() => {
        if (!closed) try { controller.enqueue(encoder.encode(":\n\n")); } catch { closed = true; }
      }, 30_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener("abort", cleanup);
      if (request.signal.aborted) cleanup();
    },
    cancel() { cleanup?.(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
