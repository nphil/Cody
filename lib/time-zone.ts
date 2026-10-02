/**
 * Time zones, in one engine-neutral place that the browser, the server and the
 * tests all share. Pure: no I/O, no Cody imports, only `Intl`.
 *
 * Where a zone comes from (first one that is set and valid wins):
 *  1. `explicit` — the zone the person CHOSE in Settings → Preferences.
 *  2. `device`   — the zone of the browser that sent THIS message, read fresh
 *                  at send time (a tablet changes zones while its tab stays
 *                  open).
 *  3. `lastSeen` — the account's last-seen device zone, the fallback for a
 *                  message that carries none (API calls, scheduled jobs,
 *                  sidebar one-shots, a child started with nobody typing).
 *  4. `server`   — the server's own `TZ`, then the system zone.
 *  5. UTC.
 *
 * A zone is always an IANA name ("America/New_York"), never a bare offset:
 * the same string becomes the `TZ` of an engine child, where an offset would
 * mean something different (POSIX reads "+05:00" as a zone *name*).
 */

export const FALLBACK_TIME_ZONE = "UTC";

/**
 * `customType` of the one hidden line the agent is given before each prompt
 * ("Current local time: …", written by lib/omp/extensions/cody-local-time.ts).
 * It is for the model, never the person reading the chat, so the transcript
 * drops it on every path. The extension runs under omp, not under Cody's
 * bundler, so it repeats this literal; lib/time-zone.test.mjs pins the two
 * together.
 */
export const LOCAL_TIME_CUSTOM_TYPE = "cody-local-time";

/** Agent commands that carry the person's words, and so the zone of the
 * browser they were typed in. Every other command (get_state, set_model, abort,
 * …) says nothing about where the user is. Shared by the browser that attaches
 * the zone and the routes that read it. */
const MESSAGE_COMMAND_TYPES: Record<string, true> = { prompt: true, steer: true, follow_up: true, abort_and_prompt: true };

export function isMessageCommandType(type: unknown): boolean {
  return typeof type === "string" && MESSAGE_COMMAND_TYPES[type] === true;
}

/** Area/Location[/Sub] plus single words (UTC) and the legacy names (EST5EDT,
 * Etc/GMT+5). Anything that is not a plain word-and-slash name — a path, an
 * offset, shell syntax — never reaches `Intl` and never becomes a `TZ`. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const MAX_ZONE_LENGTH = 64;

/**
 * The canonical IANA name for `value`, or null when this runtime does not know
 * it. "asia/tokyo" comes back "Asia/Tokyo", so two spellings of one zone
 * compare equal and the stored value is always the one `Intl` itself reports.
 */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^:/, "");
  if (trimmed.length === 0 || trimmed.length > MAX_ZONE_LENGTH || !ZONE_SHAPE.test(trimmed)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The zone this runtime is running in right now — the browser's, in a
 * browser; the server's own, on the server. Null only when `Intl` cannot say. */
export function detectDeviceTimeZone(): string | null {
  try {
    return normalizeTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** The server's zone: its `TZ`, else the system zone `Intl` resolves, else UTC. */
export function serverTimeZone(env: Record<string, string | undefined> = process.env): string {
  return normalizeTimeZone(env.TZ) ?? detectDeviceTimeZone() ?? FALLBACK_TIME_ZONE;
}

export type TimeZoneSource = "explicit" | "device" | "last-seen" | "server" | "utc";

export interface TimeZoneLayers {
  explicit?: unknown;
  device?: unknown;
  lastSeen?: unknown;
  server?: unknown;
}

export interface ResolvedTimeZone {
  zone: string;
  source: TimeZoneSource;
}

/** The precedence above. A layer that is absent OR not a zone this runtime
 * knows is skipped, never trusted: a corrupt stored value or a garbage header
 * cannot turn into a `TZ`. */
export function resolveTimeZone(layers: TimeZoneLayers): ResolvedTimeZone {
  const ordered: Array<[TimeZoneSource, unknown]> = [
    ["explicit", layers.explicit],
    ["device", layers.device],
    ["last-seen", layers.lastSeen],
    ["server", layers.server],
  ];
  for (const [source, candidate] of ordered) {
    const zone = normalizeTimeZone(candidate);
    if (zone) return { zone, source };
  }
  return { zone: FALLBACK_TIME_ZONE, source: "utc" };
}

/** Every zone this runtime can name, for a picker. `Intl.supportedValuesOf`
 * leaves "UTC" out, so it is added; a runtime without it gets a short list
 * rather than an empty picker. */
export function listTimeZones(): string[] {
  let zones: string[] = [];
  try {
    // Older runtimes lack it; the typed lib says it always exists.
    if (typeof Intl.supportedValuesOf === "function") zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  if (zones.length === 0) {
    zones = [
      "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago",
      "America/New_York", "America/Sao_Paulo", "Atlantic/Reykjavik", "Europe/London", "Europe/Paris",
      "Europe/Athens", "Africa/Cairo", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok",
      "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
    ];
  }
  const all = new Set(zones);
  all.add(FALLBACK_TIME_ZONE);
  return [...all].sort((a, b) => a.localeCompare(b));
}

// ----------------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------------

type Instant = Date | number | string;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string, shape: "numeric" | "long" | "name"): Intl.DateTimeFormat {
  const key = `${shape}|${zone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const base: Intl.DateTimeFormatOptions = { timeZone: zone, hourCycle: "h23" };
    formatter = new Intl.DateTimeFormat("en-US", shape === "numeric"
      ? { ...base, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : shape === "long"
        ? { ...base, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : { ...base, timeZoneName: "short" });
    formatters.set(key, formatter);
  }
  return formatter;
}

function toDate(input: Instant): Date | null {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

function partsOf(date: Date, zone: string, shape: "numeric" | "long"): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone, shape).formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

/** The zone's offset from UTC at `date`, in minutes (east is positive).
 * Derived from the wall-clock parts rather than a formatter option, so it
 * agrees in every runtime that can name the zone at all. */
export function utcOffsetMinutes(date: Date, zone: string): number {
  const p = partsOf(date, zone, "numeric");
  const wallAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((wallAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** "UTC-04:00", "UTC+05:30", "UTC+00:00". */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The zone's own short name ("EDT", "GMT", "UTC") when it has a real
 * abbreviation, else null. `Intl` answers a bare "GMT+9" for zones without
 * one, which says less than the numeric offset it duplicates. */
export function zoneAbbreviation(date: Date, zone: string): string | null {
  const name = formatterFor(zone, "name").formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  return name && /^[A-Z]{2,5}$/.test(name) ? name : null;
}

/**
 * A timestamp as a person in `zone` reads it, with the zone spelled out:
 * "2026-10-01 19:31 EDT", or "2026-10-02 08:31 UTC+09:00" where the zone has
 * no abbreviation. The offset is always stated one way or the other, so a
 * model never has to guess whether a bare time was UTC. Anything that is not a
 * valid instant is returned as given — a tool must not turn a field it
 * could not parse into a blank.
 */
export function formatLocalTime(input: Instant, zone: string): string {
  const date = toDate(input);
  const known = normalizeTimeZone(zone);
  if (!date || !known) return typeof input === "string" ? input : String(input);
  const p = partsOf(date, known, "numeric");
  const label = zoneAbbreviation(date, known) ?? formatUtcOffset(utcOffsetMinutes(date, known));
  return `${p.year}-${p.month}-${p.day} ${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute} ${label}`;
}

/**
 * The line a model is told about "now":
 * "Friday 2 October 2026, 14:58 EDT (America/New_York, UTC-04:00)".
 * Names the weekday and spells the month, so no reader has to decide whether
 * 02/10 is February or October.
 */
export function describeLocalNow(now: Instant, zone: string): string {
  const date = toDate(now) ?? new Date();
  const known = normalizeTimeZone(zone) ?? FALLBACK_TIME_ZONE;
  const p = partsOf(date, known, "long");
  const abbreviation = zoneAbbreviation(date, known);
  const clock = `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}`;
  const offset = formatUtcOffset(utcOffsetMinutes(date, known));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${clock}${abbreviation ? ` ${abbreviation}` : ""} (${known}, ${offset})`;
}
