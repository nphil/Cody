import { normalizeTimeZone, utcOffsetMinutes } from "../time-zone";

/**
 * Reading a time a person or an agent wrote down, and saying how far away it is.
 *
 * An agent writes "2026-10-06T09:00" because that is what it was told the local
 * time looks like. That has no offset, so it is read in the zone the agent was
 * told about (the chat's current zone), never in the server's — a container
 * with no `TZ` runs in UTC, and "9 AM" read there is the wrong 9 AM. The
 * browser always sends an instant with an offset (`toISOString()`), which needs
 * no zone at all.
 */

export type ParsedInstant = { ok: true; at: number; hadOffset: boolean } | { ok: false };

/**
 * YYYY-MM-DD, then `T` or a space, then HH:MM[:SS[.fff]], then optionally Z or
 * ±HH[:MM]. A bare date is not a time: "tomorrow" has no single instant.
 */
const INSTANT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** The wall-clock fields as the UTC instant they would be if the zone were UTC. */
function wallAsUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, millis: number): number | null {
  const at = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(at);
  // Date.UTC rolls an impossible date over (Feb 30 → Mar 2); a person who wrote one made a mistake worth refusing.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return at;
}

/**
 * The instant at which `zone`'s clocks read `wall` (given as if UTC). Two passes
 * settle the offset across a daylight-saving change. A time inside the spring
 * gap does not exist; it reads as the later instant (02:30 becomes 03:30), the
 * way a calendar shows it. A time that happens twice in the autumn is the first.
 */
function zonedWallToInstant(wall: number, zone: string): number {
  const first = wall - utcOffsetMinutes(new Date(wall), zone) * 60_000;
  const second = wall - utcOffsetMinutes(new Date(first), zone) * 60_000;
  if (first === second) return first;
  const back = (instant: number) => utcOffsetMinutes(new Date(instant), zone) * 60_000 + instant;
  if (back(second) === wall) return second;
  return Math.max(first, second);
}

function offsetMinutesOf(text: string): number | null {
  if (/^z$/i.test(text)) return 0;
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 14 || minutes > 59) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Read `input` as an instant. With an offset (`Z`, `+02:00`) it is exact; with
 * none it is the wall clock of `zone`. `{ ok: false }` for anything else,
 * including impossible dates and hours.
 */
export function parseInstant(input: string, zone: string): ParsedInstant {
  const match = INSTANT_SHAPE.exec(input.trim());
  if (!match) return { ok: false };
  const [, y, mo, d, h, mi, s, fraction, offsetText] = match;
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (hour > 23 || minute > 59 || second > 59) return { ok: false };
  const millis = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
  const wall = wallAsUtc(Number(y), Number(mo), Number(d), hour, minute, second, millis);
  if (wall === null) return { ok: false };
  if (offsetText !== undefined) {
    const offset = offsetMinutesOf(offsetText);
    return offset === null ? { ok: false } : { ok: true, at: wall - offset * 60_000, hadOffset: true };
  }
  const known = normalizeTimeZone(zone);
  return known ? { ok: true, at: zonedWallToInstant(wall, known), hadOffset: false } : { ok: false };
}

/** "in 45 min", "in 3 h 12 min", "in 2 days 4 h" — how far off `at` is from `now`; "now" inside a minute. */
export function describeDelay(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `in ${hours} h` : `in ${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `in ${days} day${days === 1 ? "" : "s"}` : `in ${days} day${days === 1 ? "" : "s"} ${hours % 24} h`;
}
