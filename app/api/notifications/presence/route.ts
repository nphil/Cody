import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { recordPresence } from "@/lib/notifications/presence";
import { recipientKeyFor } from "@/lib/notifications/store";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;
const MAX_SESSION_ID_LENGTH = 200;

/**
 * `POST {sessionId: string | null}` — which chat this person is looking at, or
 * null for none (the tab was hidden or closed). The browser reports it when the
 * visible chat changes, when the tab is hidden, every 30 s while it is visible
 * and — through `navigator.sendBeacon` — when the page is hidden for good. While
 * a report is under 75 s old, notifications for that chat are not sent to this
 * person (when they asked for that). The body's content type is not checked: a
 * beacon sends whatever it was given.
 */
export async function POST(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  if (!isRecord(body) || !("sessionId" in body)) return jsonError("sessionId is required", 400, "invalid_body");
  const { sessionId } = body;
  if (sessionId !== null && (typeof sessionId !== "string" || sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH)) {
    return jsonError("sessionId must be a chat id or null", 400, "invalid_session");
  }
  recordPresence(recipientKeyFor(actor.user), sessionId);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
