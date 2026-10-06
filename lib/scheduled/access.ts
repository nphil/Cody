import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "../auth/http";
import { canAccessSession } from "../auth/session-owners";
import type { UserRecord } from "../auth/users";
import { RequestBodyTooLargeError } from "../bounded-form-data";
import { getHarness } from "../harness";
import { getEngineSession } from "../harness/engine-sessions";
import { getRpcSession } from "../rpc-manager";
import { isSidebarSessionPath, resolveSessionPath } from "../session-reader";
import { ScheduledError } from "./errors";
import { SCHEDULED_LIMITS } from "./types";

/**
 * What every scheduled-message route does first: decide whether the caller may
 * use this chat at all, and answer the failures in one voice.
 *
 * A chat the caller may not see answers exactly like one that does not exist
 * (the same 404), so an id leaks nothing. A sidebar chat is a side panel, not
 * work: nothing can be scheduled into it.
 */

/** A request body is the message (≤ 64 KB of UTF-8, up to 6 bytes per escaped character in JSON) plus a few fields. */
export const MAX_SCHEDULED_BODY_BYTES = SCHEDULED_LIMITS.maxMessageBytes * 6 + 4096;

export const NO_STORE = { "Cache-Control": "no-store" };

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function chatExists(sessionId: string): Promise<boolean> {
  if (getRpcSession(sessionId)?.isAlive()) return true;
  const harness = getHarness();
  // A turn-based engine owns its transcript: the chat is known by its index row.
  if (harness.createSession) return getEngineSession(sessionId)?.engine === harness.id;
  const filePath = await resolveSessionPath(sessionId);
  return filePath !== null && !isSidebarSessionPath(filePath);
}

export async function requireScheduledChat(
  sessionId: string,
  request: Request,
): Promise<{ user: UserRecord | null } | { response: NextResponse }> {
  // The proxy already gates /api, but these routes can put words into a running agent: they check who is asking themselves.
  const who = requireUserOrOpenInstance(request);
  if ("response" in who) return who;
  const { user } = who;
  if (!SESSION_ID.test(sessionId) || !canAccessSession(sessionId, user) || !(await chatExists(sessionId))) {
    return { response: jsonError("Session not found", 404, "session_not_found") };
  }
  return { user };
}

/** A failure as the response the composer words in the person's language. */
export function scheduledErrorResponse(error: unknown): NextResponse {
  if (error instanceof ScheduledError) return jsonError(error.message, error.status, error.code);
  if (error instanceof RequestBodyTooLargeError) return jsonError("That message is too large to schedule.", 413, "message_too_long");
  if (error instanceof SyntaxError) return jsonError("Invalid JSON request body", 400, "invalid_json");
  return jsonError(error instanceof Error ? error.message : String(error), 500, "internal_error");
}
