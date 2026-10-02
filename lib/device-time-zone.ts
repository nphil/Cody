import { detectDeviceTimeZone } from "./time-zone";

/**
 * The zone of the browser making a request, as a body field to spread in:
 * `{ timeZone: "Asia/Tokyo" }`, or `{}` when this browser cannot name its
 * zone (the server then falls back along lib/time-zone.ts's precedence).
 *
 * Read on EVERY call and never cached. A tablet changes zones while its tab
 * stays open, and a send the outbox retries minutes later goes out from
 * wherever the person is by then — the zone that applies is the one at the
 * moment of the request.
 */
export function deviceTimeZoneField(): { timeZone?: string } {
  const timeZone = detectDeviceTimeZone();
  return timeZone ? { timeZone } : {};
}
