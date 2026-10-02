// Loaded by omp itself (Bun), not by Cody's bundler: keep this file free of
// Cody imports so it resolves from any install location. The few helpers it
// shares with lib/time-zone.ts are repeated here on purpose, and
// lib/time-zone.test.mjs runs both on the same inputs so they cannot drift.

/** lib/time-zone.ts LOCAL_TIME_CUSTOM_TYPE. */
const LOCAL_TIME_CUSTOM_TYPE = "cody-local-time";
/** lib/rpc-manager.ts TIME_ZONE_REQUEST_TITLE: the question Cody answers itself. */
const ZONE_REQUEST_TITLE = "CODY_TIME_ZONE";
/** Cody answers from memory in a few milliseconds; this only bounds a host that
 *  never does, so a missing answer costs one prompt a short wait, not a hang. */
const ZONE_REPLY_TIMEOUT_MS = 3_000;

type Context = {
  mode?: string;
  agent?: { kind?: string };
  ui: {
    input(title: string, placeholder?: string, options?: { timeout?: number }): Promise<string | undefined>;
  };
  sessionManager: { getBranch(): unknown[] };
};

type HiddenMessage = {
  customType: string;
  content: string;
  display: false;
  details: { zone: string };
  attribution: "agent";
};

type OmpApi = {
  on(
    event: "before_agent_start",
    handler: (event: unknown, ctx: Context) => Promise<{ message: HiddenMessage } | undefined>,
  ): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** lib/time-zone.ts normalizeTimeZone. */
export function canonicalZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^:/, "");
  if (trimmed.length === 0 || trimmed.length > 64 || !ZONE_SHAPE.test(trimmed)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The zone this process runs in: what `date` reports unless the shell is told otherwise. */
function processZone(): string {
  return canonicalZone(new Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
}

function parts(date: Date, zone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const found: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", ...options }).formatToParts(date)) {
    found[part.type] = part.value;
  }
  return found;
}

/** lib/time-zone.ts describeLocalNow: "Friday 2 October 2026, 14:58 EDT (America/New_York, UTC-04:00)". */
export function describeLocalNow(date: Date, zoneName: string): string {
  const zone = canonicalZone(zoneName) ?? "UTC";
  const long = parts(date, zone, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const wall = parts(date, zone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const wallAsUtc = Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day), Number(wall.hour) % 24, Number(wall.minute), Number(wall.second));
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const abs = Math.abs(offsetMinutes);
  const offset = `UTC${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const shortName = parts(date, zone, { timeZoneName: "short" }).timeZoneName;
  const abbreviation = shortName && /^[A-Z]{2,5}$/.test(shortName) ? ` ${shortName}` : "";
  const clock = `${String(Number(long.hour) % 24).padStart(2, "0")}:${long.minute}`;
  return `${long.weekday} ${long.day} ${long.month} ${long.year}, ${clock}${abbreviation} (${zone}, ${offset})`;
}

/**
 * The zone of the message about to be read, and the zone the shell runs in.
 * Cody answers a question it intercepts by its title (the same channel the
 * refusal guard uses the other way round). No answer — an older Cody, a
 * terminal run — means the process's own zone for both, which is true there.
 */
async function askCody(ctx: Context): Promise<{ zone: string; shell: string } | null> {
  // The terminal UI would put the question in front of a person.
  if (ctx.mode === "tui") return null;
  try {
    const answer = await ctx.ui.input(`${ZONE_REQUEST_TITLE} ${JSON.stringify({ v: 1 })}`, undefined, { timeout: ZONE_REPLY_TIMEOUT_MS });
    if (typeof answer !== "string") return null;
    const parsed: unknown = JSON.parse(answer);
    if (!isRecord(parsed)) return null;
    const zone = canonicalZone(parsed.zone);
    const shell = canonicalZone(parsed.shell);
    return zone && shell ? { zone, shell } : null;
  } catch {
    return null;
  }
}

/** The zone the previous prompt of this conversation was told, read back from
 *  the hidden line it left in the transcript — so a restart of the child, a
 *  resumed session and a fork all still know. */
function previousZone(ctx: Context): string | null {
  let branch: unknown[];
  try {
    branch = ctx.sessionManager.getBranch();
  } catch {
    return null;
  }
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== LOCAL_TIME_CUSTOM_TYPE) continue;
    return isRecord(entry.details) ? canonicalZone(entry.details.zone) : null;
  }
  return null;
}

/** The one short line. Exported for lib/time-zone.test.mjs. */
export function localTimeLine(input: { now: Date; zone: string; shell: string; previous: string | null }): string {
  const { now, zone, shell, previous } = input;
  const lines: string[] = [];
  if (previous && previous !== zone) lines.push(`The user's device time zone changed: was ${previous}, now ${zone}.`);
  lines.push(`Current local time: ${describeLocalNow(now, zone)}. Use this time zone for any times you state to the user.`);
  if (shell !== zone) lines.push(`Shell commands (\`date\`) still report ${shell} until the next idle restart.`);
  return lines.join(" ");
}

export default function codyLocalTime(pi: OmpApi): void {
  // Before every prompt the model is about to read — a typed message and a
  // queued steer or follow-up alike. A hidden line, never a system-prompt
  // change: replacing the system prompt would break the provider's prompt
  // cache on every turn, while one short message at the tail leaves everything
  // before it cached.
  pi.on("before_agent_start", async (_event, ctx) => {
    // Subagents are briefed by the agent that spawns them, and a subagent's
    // transcript is rendered separately.
    if (ctx.agent?.kind !== "main") return undefined;
    const answer = await askCody(ctx);
    const shell = answer?.shell ?? processZone();
    const zone = answer?.zone ?? shell;
    return {
      message: {
        customType: LOCAL_TIME_CUSTOM_TYPE,
        content: localTimeLine({ now: new Date(), zone, shell, previous: previousZone(ctx) }),
        display: false,
        details: { zone },
        attribution: "agent",
      },
    };
  });
}
