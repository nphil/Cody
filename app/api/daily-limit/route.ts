import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { InvalidDailyLimitError, readDailyLimitState, updateDailyLimit } from "@/lib/daily-limit/store";
import { effectiveTimeZone, zoneForMessage } from "@/lib/time-zone-prefs";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * `GET /api/daily-limit?timeZone=<IANA zone>` — today's state for the person
 * asking: whether the limit is on, its length, what has been used on every
 * device together, and what is left. `timeZone` is the asking browser's zone;
 * the day is the local date in the zone the person chose in Preferences, else
 * that one, else where they were last seen (lib/time-zone-prefs.ts). Reading
 * never writes, so a poll cannot move the account's remembered device.
 */
export function GET(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  const zone = effectiveTimeZone(actor.user, new URL(request.url).searchParams.get("timeZone")).zone;
  return NextResponse.json(readDailyLimitState(actor.user, zone), noStore);
}

/**
 * `PUT /api/daily-limit` — change the setting, or answer the "time's up" notice.
 * Body, any of:
 *  - `enabled: boolean`        switch the limit on or off (off by default)
 *  - `limitMinutes: number`    the daily length, a whole number from 5 to 1440
 *  - `addMinutes: number`      add this many minutes to TODAY's limit only
 *  - `dismissNotice: true`     "Done for today": hide today's notice at this limit
 *  - `timeZone: string`        the asking browser's zone, as in GET
 * Answers the new state. Nothing here ever blocks a chat or stops a run.
 */
export async function PUT(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const zone = zoneForMessage(actor.user, isRecord(body) ? body.timeZone : undefined);
  try {
    return NextResponse.json(updateDailyLimit(actor.user, body, zone), noStore);
  } catch (error) {
    if (error instanceof InvalidDailyLimitError) return jsonError(error.message, 400, error.code);
    throw error;
  }
}
