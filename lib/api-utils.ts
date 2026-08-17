import { NextResponse } from "next/server";
import { resolveSessionPath } from "./session-reader";
import { getRequestUser } from "./auth/guard";
import { canAccessSession } from "./auth/session-owners";
import { getHarness } from "./harness";
import { getEngineSession, type EngineSessionRow } from "./harness/engine-sessions";

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
