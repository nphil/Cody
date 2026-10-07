import { NextResponse } from "next/server";
import { resolveSessionPath } from "./session-reader";
import { getRequestUser } from "./auth/guard";
import { canAccessSession } from "./auth/session-owners";
import { getHarness } from "./harness";
import { getEngineSession, type EngineSessionRow } from "./harness/engine-sessions";
import type { EngineSession } from "./harness/types";
import { EngineCommandError } from "./harness/errors";
import { WebRpcError } from "./rpc-manager";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to its file path, or a 404 JSON response. Replaces the
 * repeated `resolveSessionPath(id)` + "Session not found" guard across routes.
 * Also the per-session ownership gate: a session owned by a different account
 * answers the same 404 as one that does not exist, so the id leaks nothing. */
export async function resolveSessionPathOr404(
  id: string,
  request: Request,
): Promise<{ filePath: string } | { response: NextResponse }> {
  const filePath = await resolveSessionPath(id);
  if (!filePath || !canAccessSession(id, getRequestUser(request))) {
    return { response: NextResponse.json(SESSION_NOT_FOUND, { status: 404 }) };
  }
  return { filePath };
}

/**
 * The non-omp counterpart of resolveSessionPathOr404: a session owned by a
 * turn-based engine has no file on disk, only a row in the engine session
 * index (lib/harness/engine-sessions). Same 404 semantics, same ownership
 * gate — another account's session is indistinguishable from a missing one.
 */
export function resolveEngineSessionOr404(
  id: string,
  request: Request,
): { row: EngineSessionRow } | { response: NextResponse } {
  const row = getEngineSession(id);
  // A row belonging to a DIFFERENT engine is not addressable: only the engine
  // that created a session can resume it, and letting the id through would
  // hand an old claude session to codex (or the reverse) after a switch. The
  // row survives untouched, so switching back restores the session.
  if (!row || row.engine !== getHarness().id || !canAccessSession(id, getRequestUser(request))) {
    return { response: NextResponse.json(SESSION_NOT_FOUND, { status: 404 }) };
  }
  return { row };
}

/** Uniform JSON error body used by most API routes. */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  return NextResponse.json({ error: String(error) }, { status });
}

/**
 * Error codes that mean "the caller should try again shortly", not "this
 * request is wrong": a restart in progress, or a race where the live child
 * exited between a route's own liveness check and the actual send. Every
 * error class that carries a stable `code` here (WebRpcError for the
 * rpc-dialect wrapper, EngineCommandError for ACP engines) maps through this
 * ONE table, so a client's retry classifier sees a single contract
 * regardless of which engine raised it. `session_dead` reuses the ACP
 * engines' own "child gone" code (lib/harness/acp-session.ts) instead of
 * minting a second one for the identical condition.
 */
const RETRYABLE_COMMAND_STATUS: Record<string, number> = {
  session_restarting: 409,
  session_dead: 503,
};

/**
 * Map a failed `EngineSession.send()` — or a wrapper-level throw before it
 * ever reaches omp — onto an HTTP response. Shared by every agent route that
 * sends a command; a route's own request-body failures (oversized/invalid
 * JSON) and omp's raw `RpcCommandError` are each route's own concern (the
 * latter is checked before falling back to this, keeping routes that never
 * otherwise touch `lib/omp/*` from acquiring that import).
 */
export function agentCommandErrorResponse(error: unknown): NextResponse {
  if (error instanceof EngineCommandError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: RETRYABLE_COMMAND_STATUS[error.code] ?? 400 });
  }
  if (error instanceof WebRpcError) {
    return NextResponse.json(
      { error: error.message, code: error.code, ...(error.details ?? {}) },
      { status: RETRYABLE_COMMAND_STATUS[error.code] ?? 400 },
    );
  }
  return apiErrorResponse(error);
}

const GET_STATE_WAIT_TIMEOUT_MS = 3_000;

export interface BoundedAgentState {
  running: boolean;
  state: unknown;
  stale?: true;
}

/**
 * `get_state` on a live rpc-dialect session is a real round trip through
 * omp's serial command queue (rpc-mode.ts): a slow bash run or long prompt
 * ahead of it delays the ack indefinitely (local://send-contract.md). A GET
 * route reading status must never inherit that wait — race it against a
 * short bound and, on timeout, answer the session's own cached last-known
 * state (once it has captured one) overlaid with whatever live flags it can
 * report without a round trip, marked `stale`. Never rejects on the timeout
 * path: a slow child is information, not a failure — the caller always gets
 * a 200-shaped payload to return as-is.
 */
export async function getStateBounded(session: EngineSession): Promise<BoundedAgentState> {
  const statePromise = session.send({ type: "get_state" });
  // If the timeout below wins the race, nobody ever awaits this promise
  // again; keep its eventual settlement from becoming an unhandled rejection.
  statePromise.catch(() => {});
  const TIMED_OUT = Symbol("get_state_wait_timeout");
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), GET_STATE_WAIT_TIMEOUT_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([statePromise, timeout]);
  if (outcome !== TIMED_OUT) return { running: true, state: outcome };

  const cachedRaw = session.lastKnownState?.() ?? null;
  const cached = cachedRaw && typeof cachedRaw === "object" ? (cachedRaw as Record<string, unknown>) : null;
  const live = session.livePhase?.();
  const state = cached
    ? {
        ...cached,
        ...(live
          ? {
              isStreaming: live.streaming,
              isPromptRunning: live.promptRunning,
              isBashRunning: live.bashRunning,
              isCompacting: live.compacting,
            }
          : {}),
      }
    : null;
  return { running: true, state, stale: true };
}
