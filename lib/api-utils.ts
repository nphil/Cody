import { NextResponse } from "next/server";
import { resolveSessionPath } from "./session-reader";
import { getRequestUser } from "./auth/guard";
import { canAccessSession } from "./auth/session-owners";

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

/** Uniform JSON error body used by most API routes. */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  return NextResponse.json({ error: String(error) }, { status });
}
