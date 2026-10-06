import { NextResponse } from "next/server";
import { NO_STORE, requireScheduledChat, scheduledErrorResponse } from "@/lib/scheduled/access";
import { findItem } from "@/lib/scheduled/store";
import { sendScheduledNow, viewOf } from "@/lib/scheduled/service";
import type { ScheduledSendNowResponse } from "@/lib/scheduled/types";

export const dynamic = "force-dynamic";

/** The same patience as the composer's own send: past this the answer is "still going", and the row says so. */
const SEND_NOW_WAIT_MS = 20_000;

// POST /api/sessions/[id]/scheduled/[itemId]/send-now — send it now (for a failed message, this is Retry)
export async function POST(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params;
  const chat = await requireScheduledChat(id, request);
  if ("response" in chat) return chat.response;
  try {
    const sending = sendScheduledNow(id, itemId);
    // If the bound below wins the race, nobody awaits this again; keep a late failure from becoming an unhandled rejection.
    sending.catch(() => {});
    const pending = Symbol("still_sending");
    const timeout = new Promise<typeof pending>((resolve) => {
      const timer = setTimeout(() => resolve(pending), SEND_NOW_WAIT_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([sending, timeout]);
    if (outcome === pending) {
      const item = findItem(itemId);
      const body: ScheduledSendNowResponse = { ok: true, delivered: false, ...(item ? { item: viewOf(item) } : {}) };
      return NextResponse.json(body, { status: 202, headers: NO_STORE });
    }
    const body: ScheduledSendNowResponse = { ok: true, ...outcome };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return scheduledErrorResponse(error);
  }
}
