/**
 * Distill preferences: how much of an assistant reply the user wants to read,
 * and whether a collapsed thinking box carries a one-line summary of what the
 * model is doing.
 *
 * Both are properties of the human in this browser, not of the instance or of
 * any engine, so they live in localStorage beside the other transcript
 * preferences. The MODEL that writes the summaries is instance-wide state and
 * lives server-side (`cody-distill.json`, Settings › Models › Assignments);
 * nothing here knows or cares which model that is.
 *
 * Pure normalizer and cached snapshot: a pure normalizer (so a hand-edited or
 * half-written value can never crash a render), a cached snapshot safe for
 * useSyncExternalStore, and a same-window change event so a toggle in the
 * settings dialog repaints the transcript behind it without a reload.
 */

import { STORAGE_EVENTS, STORAGE_KEYS } from "./storage-keys";

/** How much of the reply survives distillation. `off` distils nothing. */
export const DISTILL_REPLY_MODES = ["off", "low", "medium", "high"] as const;

export type DistillReplyMode = (typeof DISTILL_REPLY_MODES)[number];
/** The three modes that are an actual verbosity, i.e. everything but `off`. */
export type DistillVerbosity = Exclude<DistillReplyMode, "off">;

export interface DistillPreferences {
  /** Verbosity of the distilled reply that replaces a finished bubble. */
  replies: DistillReplyMode;
  /** Summarize a thinking block while it is collapsed. */
  thinking: boolean;
  /** Everyday language instead of developer shorthand: names the goal for a
   *  thinking summary rather than a code identifier, and explains jargon
   *  instead of assuming it for a reply. Applies to whichever of the two
   *  above is already on; it starts nothing by itself. */
  plainLanguage: boolean;
}

export const DEFAULT_DISTILL_PREFERENCES: DistillPreferences = {
  replies: "off",
  thinking: false,
  plainLanguage: false,
};

/** Values come from storage, so the mode is an allowlist, not free text. */
const REPLY_MODE_VALUES: Record<string, true> = Object.fromEntries(DISTILL_REPLY_MODES.map((mode) => [mode, true])) as Record<string, true>;

/** Coerce anything (parsed storage JSON, a partial draft) into valid prefs. */
export function normalizeDistillPreferences(raw: unknown): DistillPreferences {
  if (typeof raw !== "object" || raw === null) return DEFAULT_DISTILL_PREFERENCES;
  const source = raw as Partial<Record<keyof DistillPreferences, unknown>>;
  const replies = typeof source.replies === "string" && REPLY_MODE_VALUES[source.replies] === true
    ? source.replies as DistillReplyMode
    : DEFAULT_DISTILL_PREFERENCES.replies;
  return {
    replies,
    thinking: typeof source.thinking === "boolean" ? source.thinking : DEFAULT_DISTILL_PREFERENCES.thinking,
    plainLanguage: typeof source.plainLanguage === "boolean" ? source.plainLanguage : DEFAULT_DISTILL_PREFERENCES.plainLanguage,
  };
}

export function isDefaultDistillPreferences(prefs: DistillPreferences): boolean {
  return prefs.replies === DEFAULT_DISTILL_PREFERENCES.replies
    && prefs.thinking === DEFAULT_DISTILL_PREFERENCES.thinking
    && prefs.plainLanguage === DEFAULT_DISTILL_PREFERENCES.plainLanguage;
}

// ── Persistence + live subscription (browser only; SSR sees defaults) ──────

let cached: DistillPreferences | null = null;

function readStored(): DistillPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.distill);
    if (raw === null) return DEFAULT_DISTILL_PREFERENCES;
    return normalizeDistillPreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_DISTILL_PREFERENCES;
  }
}

/** Cached-identity snapshot, safe for useSyncExternalStore. */
export function getDistillPreferences(): DistillPreferences {
  if (typeof window === "undefined") return DEFAULT_DISTILL_PREFERENCES;
  if (cached === null) cached = readStored();
  return cached;
}

export function saveDistillPreferences(prefs: DistillPreferences): void {
  const normalized = normalizeDistillPreferences(prefs);
  cached = normalized;
  try {
    if (isDefaultDistillPreferences(normalized)) window.localStorage.removeItem(STORAGE_KEYS.distill);
    else window.localStorage.setItem(STORAGE_KEYS.distill, JSON.stringify(normalized));
  } catch {
    // Storage full/blocked: the in-memory value still applies this session.
  }
  window.dispatchEvent(new Event(STORAGE_EVENTS.distillChange));
}

export function subscribeDistillPreferences(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== STORAGE_KEYS.distill) return;
    cached = null;
    onChange();
  };
  window.addEventListener(STORAGE_EVENTS.distillChange, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(STORAGE_EVENTS.distillChange, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
