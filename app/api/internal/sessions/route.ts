import { NextResponse } from "next/server";
import { getSessionOwner } from "@/lib/auth/session-owners";
import { findUserById, hasAnyUser, type UserRecord } from "@/lib/auth/users";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { getLiveSessionPhases, getRunningRpcSessionIds, getSessionTimeZone } from "@/lib/rpc-manager";
import { SESSION_AWARENESS_TOOLS, type SessionToolContext } from "@/lib/session-tools";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_INTERNAL_SESSIONS_BODY_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function invalidResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * Who is asking, in SessionToolContext terms — the same formula
 * rpc-manager.ts's own sessionToolContext() falls back to for a session with
 * no request-authenticated user behind it, which every ACP engine is: the
 * owners sidecar stores a user id, not a UserRecord, so a deleted account
 * leaves a stamp that no longer resolves to anyone, indistinguishable from a
 * session that was never claimed. That only means "hide the rest of this
 * account's history" when some other account exists to hide it from; on an
 * instance with zero accounts there is nothing to restrict against, so the
 * caller is treated as the administrator, exactly as when auth is off
 * entirely.
 */
function resolveCaller(sessionId: string): { user: UserRecord | null; restrictToUnowned: boolean } {
  const ownerId = getSessionOwner(sessionId);
  const user = ownerId === null ? null : findUserById(ownerId);
  return { user, restrictToUnowned: user === null && hasAnyUser() };
}

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
    body = await parseJsonWithinLimit(request, MAX_INTERNAL_SESSIONS_BODY_BYTES);
  } catch {
    return invalidResponse("Invalid session request body");
  }
  if (!isRecord(body) || typeof body.sessionId !== "string" || !body.sessionId) {
    return invalidResponse("sessionId is required");
  }
  if (body.sessionId !== capability.sid) {
    return invalidResponse("Session does not match the session capability", 403);
  }
  if (typeof body.tool !== "string" || !body.tool) {
    return invalidResponse("tool is required");
  }
  const toolName = body.tool;
  const tool = SESSION_AWARENESS_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return invalidResponse("Unknown session tool");
  }
  const toolArgs: Record<string, unknown> = isRecord(body.arguments) ? body.arguments : {};

  // defaultSessionId and the caller's identity both come from the verified
  // token, never from the request body — a body can name any sessionId, but
  // it already had to match the capability above, so capability.sid is the
  // only value trusted past this point.
  const { user, restrictToUnowned } = resolveCaller(capability.sid);
  const context: SessionToolContext = {
    user,
    defaultSessionId: capability.sid,
    runningSessionIds: new Set(getRunningRpcSessionIds()),
    livePhases: getLiveSessionPhases(),
    restrictToUnowned,
    timeZone: getSessionTimeZone(capability.sid),
  };

  try {
    const text = await tool.handler(toolArgs, context);
    return NextResponse.json({ text }, { headers: NO_STORE });
  } catch (error) {
    // The handler contract promises plain text, never a throw, but the
    // catch stays anyway — the same defensive fallback todo/display use for
    // whatever the contract does not anticipate.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
