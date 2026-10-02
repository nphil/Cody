import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import type { UserRecord } from "@/lib/auth/users";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { normalizeTimeZone, resolveTimeZone, serverTimeZone } from "@/lib/time-zone";
import { InvalidTimeZoneError, noteDeviceTimeZone, readTimeZonePrefs, setExplicitTimeZone } from "@/lib/time-zone-prefs";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;

/**
 * What the Preferences row and the page-load capture both need, in one shape:
 * `zone` is the zone a message with NO device zone of its own would use right
 * now (chosen > last seen > the server), `explicit` the person's own choice or
 * null for Automatic, `deviceZone` the last browser seen for them.
 */
function stateFor(user: UserRecord | null) {
  const prefs = readTimeZonePrefs(user);
  const server = serverTimeZone();
  const resolved = resolveTimeZone({ explicit: prefs.explicit, lastSeen: prefs.deviceZone, server });
  return { zone: resolved.zone, source: resolved.source, explicit: prefs.explicit, deviceZone: prefs.deviceZone, serverZone: server };
}

const noStore = { headers: { "Cache-Control": "no-store" } };

export function GET(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  return NextResponse.json(stateFor(actor.user), noStore);
}

/**
 * Body: `{ timeZone?: string | null, deviceTimeZone?: string }`.
 *  - `timeZone` is the person's own choice; `null` returns to Automatic. A
 *    name this server does not know is a 400 — it would become an engine's TZ.
 *  - `deviceTimeZone` is the browser's zone, sent on page load and whenever it
 *    changes. A bad value is ignored, never an error: the page reports it
 *    unasked, and a bad hint must not look like a failure to the person.
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
  if (!isRecord(body) || (body.timeZone === undefined && body.deviceTimeZone === undefined)) {
    return jsonError("Nothing to update", 400, "invalid_body");
  }
  if (body.timeZone !== undefined && body.timeZone !== null && normalizeTimeZone(body.timeZone) === null) {
    return jsonError("That is not a time zone this server knows", 400, "invalid_time_zone");
  }

  try {
    if (body.timeZone !== undefined) setExplicitTimeZone(actor.user, body.timeZone === null ? null : String(body.timeZone));
    if (body.deviceTimeZone !== undefined) noteDeviceTimeZone(actor.user, body.deviceTimeZone);
  } catch (error) {
    if (error instanceof InvalidTimeZoneError) return jsonError(error.message, 400, error.code);
    throw error;
  }
  return NextResponse.json(stateFor(actor.user), noStore);
}
