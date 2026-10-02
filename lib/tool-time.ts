/**
 * How a host tool writes a time the model will read. Every tool takes the
 * session's IANA zone through its context; this is the one place that turns it
 * into text, so no tool prints a bare UTC string and none re-implements the
 * fallback.
 */

import { formatLocalTime, normalizeTimeZone, serverTimeZone } from "./time-zone";

/** The zone a tool should write in: `zone` when it names a real zone, else the
 * server's own — never raw UTC unless that IS the server's zone. */
export function toolTimeZone(zone: string | null | undefined): string {
  return normalizeTimeZone(zone) ?? serverTimeZone();
}

/** "2026-10-01 19:31 EDT" for an instant (Date, epoch ms or ISO string). An
 * unparseable value is returned as given. */
export function formatToolTime(instant: Date | number | string, zone: string | null | undefined): string {
  return formatLocalTime(instant, toolTimeZone(zone));
}
