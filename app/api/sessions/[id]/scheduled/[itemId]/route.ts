import { NextResponse } from "next/server";
import { jsonError } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MAX_SCHEDULED_BODY_BYTES, NO_STORE, requireScheduledChat, scheduledErrorResponse } from "@/lib/scheduled/access";
import { cancelScheduled, updateScheduled } from "@/lib/scheduled/service";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** As for creating: an instant with an offset, never a time to be guessed at. */
const BROWSER_TIME = { zone: "UTC", requireOffset: true } as const;

type Params = { params: Promise<{ id: string; itemId: string }> };

// PATCH /api/sessions/[id]/scheduled/[itemId] — change the text and/or the time; a failed message becomes pending again
export async function PATCH(request: Request, { params }: Params) {
  const { id, itemId } = await params;
  const chat = await requireScheduledChat(id, request);
  if ("response" in chat) return chat.response;
  try {
    const body: unknown = await parseJsonWithinLimit(request, MAX_SCHEDULED_BODY_BYTES);
    if (!isRecord(body) || (body.message === undefined && body.at === undefined && body.whenQuotaResets === undefined)) {
      return jsonError("Send a new message and/or a new time.", 400, "invalid_body");
    }
    const item = await updateScheduled(
      id,
      itemId,
      { message: body.message, at: body.at, whenQuotaResets: body.whenQuotaResets, model: body.model },
      BROWSER_TIME,
    );
    return NextResponse.json({ item }, { headers: NO_STORE });
  } catch (error) {
    return scheduledErrorResponse(error);
  }
}

// DELETE /api/sessions/[id]/scheduled/[itemId] — cancel it
export async function DELETE(request: Request, { params }: Params) {
  const { id, itemId } = await params;
  const chat = await requireScheduledChat(id, request);
  if ("response" in chat) return chat.response;
  try {
    cancelScheduled(id, itemId);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return scheduledErrorResponse(error);
  }
}
