import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { getRpcSession } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";
import { runOnWorker } from "@/lib/workers/tool";

export const dynamic = "force-dynamic";

/** A command, a few globs and a few paths: well under this. The cap only has to refuse a flood. */
const MAX_INTERNAL_WORKERS_BODY_BYTES = 256 * 1024;
/** A quiet job (a long compile) must not look like a dead connection to a proxy or the bridge. */
const HEARTBEAT_MS = 15_000;
const NO_STORE = { "Cache-Control": "no-store" };
const TOOL_NAME = "run_on_worker";

function invalidResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * POST /api/internal/workers — run_on_worker for engines reached over MCP (bin/cody-display-mcp.js).
 *
 * The answer is application/x-ndjson, one JSON object per line:
 *   {"type":"progress","text":"..."}   the first non-empty line of text is a one-line status
 *   {"type":"heartbeat"}               keeps the connection alive while nothing else is said; ignore it
 *   {"type":"result","text":"...","isError":false}   last line, then the stream closes
 * Anything refused before the job starts is a plain JSON {error} with a status code.
 */
export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  let capability = null;
  try {
    capability = verifyDisplayCapability(token);
  } catch {
    // The capability issuer is unavailable until Cody's internal secret exists.
  }
  if (!capability) {
    return NextResponse.json({ error: "Invalid session capability" }, { status: 401, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_INTERNAL_WORKERS_BODY_BYTES);
  } catch {
    return invalidResponse("Invalid worker request body");
  }
  if (!isRecord(body) || typeof body.sessionId !== "string" || !body.sessionId) {
    return invalidResponse("sessionId is required");
  }
  if (body.sessionId !== capability.sid) {
    return invalidResponse("Session does not match the session capability", 403);
  }
  if (body.tool !== TOOL_NAME) {
    return invalidResponse("Unknown worker tool");
  }

  // The chat comes from the verified token, never from the request body.
  const session = getRpcSession(capability.sid);
  if (!session) {
    return invalidResponse("Session not found", 404);
  }
  const { cwd } = session;
  const scratchDir = session.scratchDir ?? null;
  const sessionId = capability.sid;
  const toolArgs: Record<string, unknown> = isRecord(body.arguments) ? body.arguments : {};

  // Stopped when the bridge hangs up (the agent cancelled the call) as well as when the request itself aborts.
  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal]);
  const encoder = new TextEncoder();
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The reader is gone; the job is already being stopped through the signal.
        }
      };
      heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_MS);
      void runOnWorker(toolArgs, {
        cwd,
        sessionId,
        scratchDir,
        signal,
        onProgress: (text) => send({ type: "progress", text }),
      }).then(
        (result) => send({ type: "result", text: result.text, isError: result.isError }),
        // runOnWorker never rejects; this keeps the contract if that ever slips.
        (error) => send({ type: "result", text: error instanceof Error ? error.message : String(error), isError: true }),
      ).finally(() => {
        clearInterval(heartbeat);
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already cancelled.
        }
      });
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      stop.abort();
    },
  });

  return new Response(stream, {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // Tells nginx-style proxies not to hold the lines back.
      "X-Accel-Buffering": "no",
    },
  });
}
