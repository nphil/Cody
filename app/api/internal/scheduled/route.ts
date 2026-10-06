import { NextResponse } from "next/server";
import { getSessionOwner } from "@/lib/auth/session-owners";
import { findUserById, hasAnyUser, type UserRecord } from "@/lib/auth/users";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { getSessionTimeZone } from "@/lib/rpc-manager";
import { SCHEDULE_TOOLS } from "@/lib/scheduled/tools";
import { SCHEDULED_LIMITS } from "@/lib/scheduled/types";
import type { SessionToolContext } from "@/lib/session-tools";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** The message itself (≤ 64 KB, up to 6 bytes per escaped character in JSON) plus the envelope. */
const MAX_INTERNAL_SCHEDULED_BODY_BYTES = SCHEDULED_LIMITS.maxMessageBytes * 6 + 4096;
const NO_STORE = { "Cache-Control": "no-store" };

function invalidResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * Who is asking, in SessionToolContext terms: the chat's owner (an ACP engine's
 * tool call has no request behind it). A chat with no recorded owner on an
 * instance that HAS accounts must not see every account's chats, so it is
 * limited to other unowned ones — exactly as /api/internal/sessions and the omp
 * host-tool path decide it.
 */
function resolveCaller(sessionId: string): { user: UserRecord | null; restrictToUnowned: boolean } {
  const ownerId = getSessionOwner(sessionId);
  const user = ownerId === null ? null : findUserById(ownerId);
  return { user, restrictToUnowned: user === null && hasAnyUser() };
}

// POST /api/internal/scheduled — the scheduling tools for engines reached over MCP (bin/cody-display-mcp.js)
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
    body = await parseJsonWithinLimit(request, MAX_INTERNAL_SCHEDULED_BODY_BYTES);
  } catch {
    return invalidResponse("Invalid scheduling request body");
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
  const tool = SCHEDULE_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return invalidResponse("Unknown scheduling tool");
  }
  const toolArgs: Record<string, unknown> = isRecord(body.arguments) ? body.arguments : {};

  // The chat and the caller's identity both come from the verified token, never
  // from the request body: a body can name any sessionId, but it already had to
  // match the capability above.
  const { user, restrictToUnowned } = resolveCaller(capability.sid);
  const context: SessionToolContext = {
    user,
    defaultSessionId: capability.sid,
    restrictToUnowned,
    timeZone: getSessionTimeZone(capability.sid),
  };

  try {
    const text = await tool.handler(toolArgs, context);
    return NextResponse.json({ text }, { headers: NO_STORE });
  } catch (error) {
    // The handler contract promises plain text, never a throw, but the catch
    // stays: the same defensive fallback the sessions and devices routes keep.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
