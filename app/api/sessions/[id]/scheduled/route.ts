import { NextResponse } from "next/server";
import { jsonError } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MAX_SCHEDULED_BODY_BYTES, NO_STORE, requireScheduledChat, scheduledErrorResponse } from "@/lib/scheduled/access";
import { createScheduled, listScheduled } from "@/lib/scheduled/service";
import { SCHEDULED_LIMITS, type ScheduledListResponse } from "@/lib/scheduled/types";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/**
 * A browser always sends an instant with an offset (`toISOString()`), so no zone
 * is ever needed to read one; a time WITHOUT an offset is refused here rather
 * than guessed at.
 */
const BROWSER_TIME = { zone: "UTC", requireOffset: true } as const;

// GET /api/sessions/[id]/scheduled — what is waiting to be sent into this chat
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = await requireScheduledChat(id, request);
  if ("response" in chat) return chat.response;
  const body: ScheduledListResponse = { items: listScheduled(id), limits: SCHEDULED_LIMITS };
  return NextResponse.json(body, { headers: NO_STORE });
}

// POST /api/sessions/[id]/scheduled — schedule a message: { message, at } or { message, whenQuotaResets: true, model? }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = await requireScheduledChat(id, request);
  if ("response" in chat) return chat.response;
  try {
    const body: unknown = await parseJsonWithinLimit(request, MAX_SCHEDULED_BODY_BYTES);
    if (!isRecord(body)) return jsonError("Send a JSON object.", 400, "invalid_body");
    const item = await createScheduled(
      id,
      { message: body.message, at: body.at, whenQuotaResets: body.whenQuotaResets, model: body.model },
      BROWSER_TIME,
      { source: "user", user: chat.user },
    );
    return NextResponse.json({ item }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return scheduledErrorResponse(error);
  }
}
