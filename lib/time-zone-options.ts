import { normalizeTimeZone } from "./time-zone";

/** The value of the "follow this device" option. A real choice, not a placeholder:
 *  it is what the person comes back to after pinning a zone. */
export const AUTOMATIC_TIME_ZONE = "";

export interface TimeZoneOption {
  value: string;
  label: string;
}

/**
 * The picker's rows and which one is selected.
 *
 *  - Automatic is first, and it is selected when no zone is pinned (`explicit`
 *    null).
 *  - A pinned zone selects the row that names the SAME zone, not merely the
 *    same string: the server stores the name its own runtime reports
 *    ("Asia/Calcutta"), which a browser may list under another ("Asia/Kolkata").
 *    Both sides are compared through this runtime's own canonical name, so the
 *    saved choice always shows as selected.
 *  - A pinned zone this browser does not list at all (one a newer or older
 *    server knows) gets its own row after Automatic, so the control still says
 *    what is saved instead of going blank.
 */
export function timeZoneOptions(input: {
  zones: readonly string[];
  explicit: string | null;
  automaticLabel: string;
}): { options: TimeZoneOption[]; value: string } {
  const { zones, explicit, automaticLabel } = input;
  const automatic: TimeZoneOption = { value: AUTOMATIC_TIME_ZONE, label: automaticLabel };
  const listed = zones.map((zone) => ({ value: zone, label: zone }));
  if (explicit === null) return { options: [automatic, ...listed], value: AUTOMATIC_TIME_ZONE };

  // The same string is the common case and costs nothing; only a differently
  // named zone pays for canonicalising every listed name.
  const canonical = normalizeTimeZone(explicit);
  const match = zones.includes(explicit)
    ? explicit
    : zones.find((zone) => canonical !== null && normalizeTimeZone(zone) === canonical);
  if (match !== undefined) return { options: [automatic, ...listed], value: match };
  return { options: [automatic, { value: explicit, label: explicit }, ...listed], value: explicit };
}
