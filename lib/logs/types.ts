/**
 * Shapes for the app-log ring (lib/logs/ring.ts) and the CDP capture that
 * fills it (lib/logs/capture.ts).
 *
 * "App logs" are the console and network failures of the app the USER is
 * building, observed from the Chromium Cody itself renders for the preview —
 * not Cody's own server logs.
 */

/**
 * Severity, worst first. The array order IS the filter order: a `level` query
 * keeps everything at that index or lower (see LEVEL_RANK in ./ring).
 */
export const APP_LOG_LEVELS = ["error", "warning", "info", "debug"] as const;

export type AppLogLevel = (typeof APP_LOG_LEVELS)[number];

/**
 * Which CDP domain produced the entry. Kept in the digest because the model
 * needs to tell a thrown exception from a 404 from a deprecation warning
 * without reading the text.
 */
export type AppLogSource = "console" | "exception" | "network" | "browser";

export interface AppLogEntry {
  /** Monotonic per session; stable across reads for as long as the entry lives. */
  id: number;
  level: AppLogLevel;
  source: AppLogSource;
  /** Message, already clipped (stack traces to MAX_STACK_FRAMES frames). */
  text: string;
  /** Request or script URL when the event carried one, else "". */
  url: string;
  /** Occurrences collapsed into this entry by dedupe; 1 for a one-off. */
  count: number;
  firstSeen: number;
  lastSeen: number;
}

/** One observed event, before dedupe. `at` defaults to now. */
export interface AppLogInput {
  level: AppLogLevel;
  source: AppLogSource;
  text: string;
  url?: string;
  at?: number;
}

export interface AppLogQuery {
  /** Minimum severity: "warning" keeps warnings and errors. Default: everything. */
  level?: AppLogLevel;
  /** Epoch ms; entries whose LAST occurrence is older are dropped. */
  since?: number;
  /** Case-insensitive regex (falls back to substring) over text and URL. */
  grep?: string;
  /** Newest N matches. */
  limit?: number;
}

export interface AppLogDigest {
  /** Matches, newest-last, already limited. */
  entries: AppLogEntry[];
  /** Distinct entries the ring holds for this session, before filtering. */
  held: number;
  /** Matches before `limit` was applied. */
  matched: number;
  /** Among the matches. */
  errors: number;
  warnings: number;
  /** Occurrences ever recorded for this session, deduped repeats included. */
  events: number;
  /** Distinct entries the caps evicted. */
  dropped: number;
  /** Text+URL bytes currently held. */
  bytes: number;
}
