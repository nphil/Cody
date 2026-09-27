import { NextResponse } from "next/server";
import { createCheckpoint } from "@/lib/checkpoints";
import { readSessionHeader, isSidebarSessionPath } from "@/lib/session-reader";
import { agentCommandErrorResponse, getStateBounded, resolveEngineSessionOr404, resolveSessionPathOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, resolveSpawnCwd } from "@/lib/rpc-manager";
import type { EngineSession } from "@/lib/harness/types";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";

import { getHarness } from "@/lib/harness";

/** The browser never sends a prompt over PROMPT_FRAME_BUDGET_BYTES (900 KiB,
 * lib/image-compress.ts — images are compressed to fit it), so a legal body
 * is under 1 MiB; 4 MiB leaves headroom for that budget to grow without
 * letting an authenticated client buffer arbitrary JSON into the process. */
const MAX_AGENT_COMMAND_REQUEST_BYTES = 4 * 1024 * 1024;

/** Cody's own failures carry a stable code the client can localize; omp's
 * errors stay opaque English text. */
function commandErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof RpcCommandError) {
    return NextResponse.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
  }
  // WebRpcError (this wrapper's own failures) and EngineCommandError (ACP
  // engines' "unsupported"/"session_busy"/"session_dead" and friends) share
  // one retryable-status mapping with every other agent route, so 409/503
  // mean the same thing everywhere (lib/api-utils.ts).
  return agentCommandErrorResponse(error);
}

// POST /api/agent/[id] - Send a command to an existing session
/** A workspace snapshot before a prompt: the agent is about to edit files,
 * and this is what makes "restore to before that message" possible. Failure
 * is deliberately silent — a missing checkpoint must never block a send. A
 * STEER into a running turn takes none: it exists to interrupt, the workspace
 * is mid-edit (no clean restore point), and it must not wait on a full
 * workspace scan first. */
async function checkpointBeforePrompt(cwd: string, body: { type?: unknown; message?: unknown }): Promise<void> {
  if (body.type !== "prompt") return;
  const message = typeof body.message === "string" ? body.message : "";
  await createCheckpoint(cwd, message || "Prompt");
}

/** Commands whose settlement may legitimately outlast a browser's patience:
 * an in-flight turn queuing a message, or omp's own image-preprocessing delay
 * before a steer/follow-up/queued-prompt acks (local://send-contract.md).
 * Bounding the WAIT here — never the command itself, and never by recycling
 * the child — lets the route answer 202 pending instead of blocking the
 * request indefinitely: the send keeps running on the wrapper, and its
 * clientMessageId dedupe turns a client retry into a rejoin, never a second
 * send to omp. Every other command type keeps blocking until it settles — a
 * bash run or a compaction has no "pending" answer that means anything. */
const ACK_BOUNDED_COMMANDS: Record<string, true> = { prompt: true, steer: true, follow_up: true };
const ACK_WAIT_TIMEOUT_MS = 20_000;

async function sendWithAckBound(session: EngineSession, body: Record<string, unknown>): Promise<NextResponse> {
  const type = typeof body.type === "string" ? body.type : "";
  if (!ACK_BOUNDED_COMMANDS[type]) {
    const result = await session.send(body);
    return NextResponse.json({ success: true, data: result });
  }
  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId : undefined;
  const resultPromise = session.send(body);
  // If the bound below wins the race, this route returns before the send
  // settles; keep its eventual rejection from becoming an unhandled one.
  resultPromise.catch(() => {});
  const TIMED_OUT = Symbol("ack_wait_timeout");
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ACK_WAIT_TIMEOUT_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([resultPromise, timeout]);
  if (outcome === TIMED_OUT) {
    return NextResponse.json({ success: true, pending: true, clientMessageId }, { status: 202 });
  }
  return NextResponse.json({ success: true, data: outcome });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await parseJsonWithinLimit<{ type?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    if (typeof body.type !== "string" || !body.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const midRunSteer = existing.isRunning() && body.streamingBehavior === "steer";
      if (!midRunSteer) await checkpointBeforePrompt(existing.cwd, body);
      return await sendWithAckBound(existing, body);
    }

    // Non-omp engines own their transcripts; the session is known by its index
    // row (cwd included), never by a file Cody can resolve.
    if (getHarness().createSession) {
      const engine = resolveEngineSessionOr404(id, req);
      if ("response" in engine) return engine.response;
      const engineCwd = resolveSpawnCwd(engine.row.cwd);
      const { session } = await startRpcSession(id, "", engineCwd, undefined, false, id);
      await checkpointBeforePrompt(engineCwd, body);
      return await sendWithAckBound(session, body);
    }

    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    const kind = isSidebarSessionPath(filePath) ? "sidebar" as const : undefined;

    const cwd = resolveSpawnCwd(readSessionHeader(filePath)?.cwd);

    const { session } = await startRpcSession(id, filePath, cwd, undefined, false, undefined, undefined, kind);
    await checkpointBeforePrompt(cwd, body);
    return await sendWithAckBound(session, body);
  } catch (error) {
    return commandErrorResponse(error);
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const clientMessageIds = new URL(req.url).searchParams.getAll("clientMessageId");
    if (clientMessageIds.length > 0) {
      const session = getRpcSession(id) as (EngineSession & {
        getDeliveryLedger?: (ids: string[]) => Array<{ clientMessageId: string; status: string; [key: string]: unknown }>;
      }) | null;
      const deliveries = session?.getDeliveryLedger
        ? session.getDeliveryLedger(clientMessageIds)
        : clientMessageIds.map((clientMessageId) => ({ clientMessageId, status: "unknown" }));
      return NextResponse.json({ deliveries });
    }

    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    return NextResponse.json(await getStateBounded(session));
  } catch (error) {
    return commandErrorResponse(error);
  }
}
