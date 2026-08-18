import { resolveDisplaySessionId } from "../display/bus";
import type { AppLogDigest, AppLogEntry, AppLogInput, AppLogLevel, AppLogQuery } from "./types";

/**
 * Bounded per-session ring for the previewed app's console and network
 * failures, shaped after lib/display/bus.ts: one `globalThis`-keyed state so a
 * dev-server hot reload re-evaluating this module cannot leave two rings
 * behind, one filling and one being read.
 *
 * The whole design risk here is unbounded growth. A React render loop emits
 * thousands of IDENTICAL lines a second and a chatty dev server can emit
 * thousands of distinct ones, so three independent bounds hold at once:
 *
 *   - dedupe, which turns the render loop into ONE entry with a count;
 *   - MAX_ENTRIES, which bounds distinct lines;
 *   - MAX_BYTES, which bounds their total size, because 300 stack traces are
 *     not the same weight as 300 "hi".
 *
 * Eviction is oldest-LAST-SEEN first, not oldest-first: a line that is still
 * firing must not be discarded as if it were history. The Map does that for
 * free — a repeat is deleted and re-inserted, so iteration order is ascending
 * `lastSeen` and the victim is always `keys().next()`.
 */

/** Distinct entries held per session. */
export const MAX_ENTRIES = 300;
/** Text+URL bytes held per session. */
export const MAX_BYTES = 128 * 1024;
/**
 * Per-entry message ceiling. Also the reason eviction always terminates: a
 * single entry (message + URL, worst case 4 bytes per char) cannot approach
 * MAX_BYTES, so the ring can never be emptied trying to satisfy it.
 */
export const MAX_TEXT_CHARS = 1_200;
export const MAX_URL_CHARS = 256;
/** Stack frames kept per entry. Enough to name the callsite, not a firehose. */
export const MAX_STACK_FRAMES = 4;
/** Sessions remembered; the oldest is dropped whole. */
export const MAX_SESSIONS = 64;
/** Ceilings on a `read_app_logs` query. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/**
 * Ceiling on ONE rendered digest. The ring's own caps bound memory; this bounds
 * the model's context, which is the scarcer resource — a `limit: 200` read of
 * fat minified errors would otherwise be a quarter-megabyte of tool result.
 */
export const MAX_DIGEST_BYTES = 16 * 1024;
/** Per-line clip inside a digest only; the ring keeps the full text. */
const MAX_DIGEST_LINE_CHARS = 400;
/** A model-supplied `grep` is compiled; keep the pattern itself small. */
const MAX_PATTERN_CHARS = 200;

/**
 * The gap this subsystem does NOT close, stated wherever the model can see it.
 * Capture rides Cody's own preview Chromium (the streamed rung). When the
 * preview resolves to the DIRECT rung the app runs inside a real cross-origin
 * iframe in the user's browser, and that console belongs to the user's browser,
 * not to us — nothing reaches this ring from there.
 */
export const APP_LOG_SHADOW_NOTE =
  "Only the preview Chromium Cody renders server-side is captured. When the preview is showing the app in a real iframe in the user's own browser (the direct rung), that console is invisible here — ask the user what the console says, or re-check with preview_screenshot.";

const LEVEL_RANK: Record<AppLogLevel, number> = { error: 0, warning: 1, info: 2, debug: 3 };

interface StoredEntry {
  entry: AppLogEntry;
  /** `count` at the last read_app_logs. The delta is exactly what the notice reports. */
  readCount: number;
}

interface SessionLogs {
  /** Dedupe key -> entry, iterating oldest-last-seen first. */
  entries: Map<string, StoredEntry>;
  bytes: number;
  events: number;
  dropped: number;
  nextId: number;
}

interface AppLogState {
  sessions: Map<string, SessionLogs>;
}

declare global {
  var __codyAppLogs: AppLogState | undefined;
}

function state(): AppLogState {
  return globalThis.__codyAppLogs ??= { sessions: new Map() };
}

/**
 * Session logs are keyed by the same authoritative id the display bus uses, so
 * an engine rekey (aliasDisplaySession) keeps writes and reads on the same
 * bucket. Entries recorded BEFORE an alias stay under the old key and age out
 * with it; a rekey reloads the page anyway, so those lines describe a process
 * that no longer exists.
 */
function sessionLogs(sessionId: string, create: boolean): SessionLogs | null {
  const id = resolveDisplaySessionId(sessionId);
  const sessions = state().sessions;
  const existing = sessions.get(id);
  if (existing) return existing;
  if (!create) return null;
  const logs: SessionLogs = { entries: new Map(), bytes: 0, events: 0, dropped: 0, nextId: 0 };
  sessions.set(id, logs);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  return logs;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sizeOf(entry: AppLogEntry): number {
  return Buffer.byteLength(entry.text) + Buffer.byteLength(entry.url);
}

function evict(logs: SessionLogs): void {
  while (logs.entries.size > MAX_ENTRIES || logs.bytes > MAX_BYTES) {
    const oldest = logs.entries.keys().next();
    // Unreachable while one entry cannot exceed either cap on its own; keeping
    // the guard means a future cap change degrades into "keep one" instead of
    // spinning forever.
    if (oldest.done === true) break;
    const victim = logs.entries.get(oldest.value);
    logs.entries.delete(oldest.value);
    if (victim) logs.bytes -= sizeOf(victim.entry);
    logs.dropped += 1;
  }
}

/** Record one observed event. Never throws: capture must not break a preview. */
export function recordAppLog(sessionId: string, input: AppLogInput): void {
  const text = clip(input.text.replace(/\s+$/u, ""), MAX_TEXT_CHARS);
  if (!text) return;
  const url = clip(input.url ?? "", MAX_URL_CHARS);
  const at = input.at ?? Date.now();
  const logs = sessionLogs(sessionId, true);
  if (!logs) return;
  logs.events += 1;
  const key = `${input.level}\u0000${input.source}\u0000${url}\u0000${text}`;
  const existing = logs.entries.get(key);
  if (existing) {
    existing.entry.count += 1;
    existing.entry.lastSeen = at;
    // Re-insert to keep iteration ascending by lastSeen (see the eviction note
    // at the top). Costs two Map ops on the hot repeat path and buys O(1)
    // eviction of the genuinely stalest line.
    logs.entries.delete(key);
    logs.entries.set(key, existing);
    return;
  }
  const entry: AppLogEntry = {
    id: logs.nextId += 1,
    level: input.level,
    source: input.source,
    text,
    url,
    count: 1,
    firstSeen: at,
    lastSeen: at,
  };
  logs.entries.set(key, { entry, readCount: 0 });
  logs.bytes += sizeOf(entry);
  evict(logs);
}

/**
 * Marks everything currently held as seen by the model. Called by the
 * read_app_logs tool only — a UI panel reading the same ring must NOT clear the
 * model's notice.
 */
export function markAppLogsRead(sessionId: string): void {
  const logs = sessionLogs(sessionId, false);
  if (!logs) return;
  for (const stored of logs.entries.values()) stored.readCount = stored.entry.count;
}

/**
 * One line, or null when there is nothing new. Appended to other tool results
 * so the model learns that its app started throwing WITHOUT any log content
 * entering the context: the notice is the only thing that arrives unasked.
 *
 * Under-reports rather than over-reports: an error entry evicted before the
 * model read it takes its unread delta with it, and `dropped` in the digest is
 * where that shows up.
 */
export function appLogNotice(sessionId: string): string | null {
  const logs = sessionLogs(sessionId, false);
  if (!logs) return null;
  let entries = 0;
  let events = 0;
  for (const stored of logs.entries.values()) {
    if (stored.entry.level !== "error") continue;
    const fresh = stored.entry.count - stored.readCount;
    if (fresh <= 0) continue;
    entries += 1;
    events += fresh;
  }
  if (entries === 0) return null;
  const repeats = events > entries ? ` (${events} occurrences)` : "";
  return `${entries} new app error${entries === 1 ? "" : "s"}${repeats} in the previewed page since your last action — call read_app_logs to see them.`;
}

/**
 * "90s" / "5m" / "2h" / "1d", an ISO timestamp, or epoch ms. Returns null for
 * anything unparseable, which reads as "no lower bound" rather than an error:
 * a malformed `since` must not cost the model its logs.
 */
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;
const DURATION_SCALE: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSince(value: unknown, now = Date.now()): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const duration = DURATION.exec(raw);
  if (duration) return now - Number(duration[1]) * DURATION_SCALE[duration[2].toLowerCase()];
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A `grep` that fails to compile degrades to a substring search instead of
 * erroring — the model asked to filter, not to be corrected.
 */
function matcher(pattern: string): (entry: AppLogEntry) => boolean {
  const raw = pattern.slice(0, MAX_PATTERN_CHARS);
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(raw, "i");
  } catch {
    regex = null;
  }
  if (regex) {
    const compiled = regex;
    return (entry) => compiled.test(entry.text) || (entry.url !== "" && compiled.test(entry.url));
  }
  const needle = raw.toLowerCase();
  return (entry) => entry.text.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle);
}

const EMPTY_DIGEST: AppLogDigest = { entries: [], held: 0, matched: 0, errors: 0, warnings: 0, events: 0, dropped: 0, bytes: 0 };

export function readAppLogs(sessionId: string, query: AppLogQuery = {}): AppLogDigest {
  const logs = sessionLogs(sessionId, false);
  if (!logs) return { ...EMPTY_DIGEST };
  const floor = query.level ? LEVEL_RANK[query.level] : LEVEL_RANK.debug;
  const since = query.since ?? null;
  const test = query.grep ? matcher(query.grep) : null;
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.round(query.limit as number))) : DEFAULT_LIMIT;
  const matches: AppLogEntry[] = [];
  let errors = 0;
  let warnings = 0;
  for (const stored of logs.entries.values()) {
    const entry = stored.entry;
    if (LEVEL_RANK[entry.level] > floor) continue;
    if (since !== null && entry.lastSeen < since) continue;
    if (test && !test(entry)) continue;
    matches.push(entry);
    if (entry.level === "error") errors += 1;
    else if (entry.level === "warning") warnings += 1;
  }
  return {
    // Iteration was ascending lastSeen, so the tail IS the newest matches and
    // the digest reads oldest-first, newest-last — the order a transcript is
    // read in.
    entries: matches.slice(-limit),
    held: logs.entries.size,
    matched: matches.length,
    errors,
    warnings,
    events: logs.events,
    dropped: logs.dropped,
    bytes: logs.bytes,
  };
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Compact text digest. One line per distinct entry with its repeat count —
 * never the raw stream — plus up to MAX_STACK_FRAMES indented stack frames that
 * were already clipped at capture time.
 */
export function formatAppLogDigest(digest: AppLogDigest, query: AppLogQuery = {}): string {
  const filters: string[] = [];
  if (query.level) filters.push(`level>=${query.level}`);
  if (query.since !== undefined) filters.push(`since ${clock(query.since)}`);
  if (query.grep) filters.push(`grep /${query.grep}/i`);
  const scope = filters.length > 0 ? ` [${filters.join(", ")}]` : "";
  if (digest.held === 0) {
    return `No app logs captured for this session${scope}. Cody captures the previewed app's console the moment a preview renders — call open_preview first. ${APP_LOG_SHADOW_NOTE}`;
  }
  if (digest.matched === 0) {
    return `No app log entries match${scope}. The ring holds ${digest.held} entr${digest.held === 1 ? "y" : "ies"} from ${digest.events} event${digest.events === 1 ? "" : "s"}; widen the filter or drop it.`;
  }
  // The ring is bounded, but a bounded ring can still render an unbounded-
  // feeling wall of text: 200 entries x 1.2 KB is a quarter-megabyte of model
  // context for one tool call. Render newest-first against a byte budget and
  // reverse, so the digest degrades by losing the OLDEST matches — the ones
  // the model is least likely to be chasing — and says how many it lost.
  const groups: string[][] = [];
  let budget = MAX_DIGEST_BYTES;
  let omitted = 0;
  for (let index = digest.entries.length - 1; index >= 0; index -= 1) {
    const entry = digest.entries[index];
    const [head, ...stack] = entry.text.split("\n");
    const repeat = entry.count > 1 ? ` x${entry.count} since ${clock(entry.firstSeen)}` : "";
    const where = entry.url !== "" ? `  ${entry.url}` : "";
    const group = [
      clip(`${clock(entry.lastSeen)} ${entry.level} ${entry.source}${repeat}: ${head}${where}`, MAX_DIGEST_LINE_CHARS),
      ...stack.map((frame) => clip(`    ${frame.trim()}`, MAX_DIGEST_LINE_CHARS)),
    ];
    const cost = group.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    // Always render at least the newest match, however fat it is.
    if (cost > budget && groups.length > 0) { omitted = index + 1; break; }
    budget -= cost;
    groups.push(group);
  }
  groups.reverse();
  const shown = digest.entries.length - omitted;
  const window = shown < digest.matched ? `, showing the newest ${shown}` : "";
  const dropped = digest.dropped > 0 ? `; ${digest.dropped} older entr${digest.dropped === 1 ? "y" : "ies"} evicted by the ring cap` : "";
  const lines = [
    `${digest.matched} entr${digest.matched === 1 ? "y" : "ies"} match${scope}${window}`
    + ` — ${digest.errors} error${digest.errors === 1 ? "" : "s"}, ${digest.warnings} warning${digest.warnings === 1 ? "" : "s"}`
    + `, deduped from ${digest.events} event${digest.events === 1 ? "" : "s"}`
    + ` (ring: ${digest.held}/${MAX_ENTRIES} entries, ${kb(digest.bytes)}/${kb(MAX_BYTES)}${dropped}). Oldest first.`,
  ];
  for (const group of groups) for (const line of group) lines.push(line);
  return lines.join("\n");
}

/** Test hook — the ring outlives any single provider on purpose. */
export function resetAppLogsForTests(): void {
  globalThis.__codyAppLogs = undefined;
}
