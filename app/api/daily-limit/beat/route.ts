import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { parseBeat } from "@/lib/daily-limit/state";
import { recordBeat } from "@/lib/daily-limit/store";
import { zoneForMessage } from "@/lib/time-zone-prefs";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;

/**
 * `POST /api/daily-limit/beat {activeSeconds, endedSecondsAgo?, timeZone?}` —
 * one finished stretch of ACTIVE use, reported by a page that is visible,
 * focused and being used (lib/daily-limit/active-time.ts decides what counts).
 * `activeSeconds` is how long, `endedSecondsAgo` how long before this request
 * that stretch ended (0 while the person is active right now). The server puts
 * it on its own clock and merges it into the person's ledger, so a second tab
 * or device reporting the same seconds adds nothing.
 *
 * Capped at 90 s per beat. Answers today's state, so the page shows the total
 * of every device. The body's content type is not checked: a page that is
 * closing sends this with `navigator.sendBeacon`, which sends whatever it is given.
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
  const beat = parseBeat(body);
  if (!beat) return jsonError("activeSeconds must be a positive number", 400, "invalid_beat");
  const zone = zoneForMessage(actor.user, isRecord(body) ? body.timeZone : undefined);
  return NextResponse.json(recordBeat(actor.user, beat, zone), { headers: { "Cache-Control": "no-store" } });
}
