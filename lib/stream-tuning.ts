/**
 * Tunable parameters for how streamed assistant output animates: the JS
 * pacer that diffuses bursty SSE token batches into a steady reveal
 * (hooks/useSmoothStreamText), and the CSS motion around it (word fade,
 * block entrance, collapse growth).
 *
 * The PACING defaults are the "steady" profile: a deep elastic buffer that
 * absorbs real network cadence (bursts, stalls, flushes) so chat reads as a
 * continuous even trickle regardless of arrival rhythm, at the price of the
 * display running ~0.3–1s behind the model (see catchUpMs). The pacer's own
 * low-level DEFAULTS in useSmoothStreamText stay at the historical
 * low-latency constants — they describe the mechanism; THIS is the product.
 * The MOTION defaults emit NO CSS variables, deferring to the stylesheet's
 * --dur-med/--ease-out-warm. Overrides persist in localStorage
 * (STORAGE_KEYS.streamTuning) and apply live via subscribeStreamTuning; the
 * /dev/stream-tuner playground edits a draft through React context without
 * touching the store until the user saves.
 */

import { STORAGE_KEYS, STORAGE_EVENTS } from "./storage-keys";

export interface StreamTuning {
  /** Backlog decay time: each tick reveals backlog·dt/catchUpMs chars. */
  catchUpMs: number;
  /** Reveal floor per tick. */
  minRevealChars: number;
  /** Hard cap on display lag before snapping. */
  maxBacklogChars: number;
  /** Forward whitespace search so words pop whole. */
  wordLookaheadChars: number;
  /** When a block stops being the active tail (a tool call started below
   *  it), drain its remaining backlog at this catch-up rate instead of
   *  snapping. 0 = the historical instant snap. */
  drainCatchUpMs: number;
  /** Trailing animated window for plain-text (thinking) tails. */
  plainTailWindowChars: number;
  /** Pace the streaming tool-call input JSON and header preview instead of
   *  repainting them raw per network frame. */
  paceToolInput: boolean;
  /** Word fade-in duration (ms). Default follows --dur-med. */
  wordFadeMs: number;
  /** Blur-in distance for arriving words (px). 0 = pure fade. */
  wordBlurPx: number;
  /** Tool/thinking box entrance duration (ms). Default follows --dur-med. */
  blockEnterMs: number;
  /** Box entrance rise distance (px). */
  blockRisePx: number;
  /** Collapse-panel grow/shrink + content entrance duration (ms). */
  collapseMs: number;
  /** Easing for the streaming animations. "" = --ease-out-warm. */
  easing: string;
}

export const DEFAULT_STREAM_TUNING: StreamTuning = {
  // Deep buffer: a burst is ~95% absorbed over ~3× this constant, and the
  // display keeps playing banked text through inter-chunk gaps instead of
  // freezing and rushing. Raising it further mostly adds lag, not smoothness.
  catchUpMs: 300,
  // No speed floor: lets the trickle go arbitrarily gentle near catch-up.
  minRevealChars: 1,
  // Big flushes (a 2s stall dumping whole paragraphs) animate, never snap.
  maxBacklogChars: 6000,
  wordLookaheadChars: 24,
  // Superseded text glides out briskly when a tool call starts below it.
  drainCatchUpMs: 60,
  plainTailWindowChars: 160,
  // Tool-call input JSON and header previews ride the same buffer.
  paceToolInput: true,
  wordFadeMs: 220,
  wordBlurPx: 0,
  blockEnterMs: 220,
  blockRisePx: 7,
  collapseMs: 220,
  easing: "",
};

/** Slider bounds — also the clamp applied to anything read from storage. */
export const STREAM_TUNING_RANGES = {
  catchUpMs: { min: 20, max: 400, step: 5 },
  minRevealChars: { min: 1, max: 12, step: 1 },
  maxBacklogChars: { min: 200, max: 8000, step: 100 },
  wordLookaheadChars: { min: 0, max: 64, step: 2 },
  drainCatchUpMs: { min: 0, max: 200, step: 5 },
  plainTailWindowChars: { min: 40, max: 400, step: 10 },
  wordFadeMs: { min: 0, max: 800, step: 10 },
  wordBlurPx: { min: 0, max: 6, step: 0.5 },
  blockEnterMs: { min: 0, max: 800, step: 10 },
  blockRisePx: { min: 0, max: 24, step: 1 },
  collapseMs: { min: 0, max: 800, step: 10 },
} as const satisfies Partial<Record<keyof StreamTuning, { min: number; max: number; step: number }>>;

/** Values come from storage, so easing is an allowlist, not free text. */
export const STREAM_EASING_OPTIONS = [
  { value: "", label: "Warm ease-out (default)" },
  { value: "linear", label: "Linear" },
  { value: "ease", label: "Ease" },
  { value: "ease-in-out", label: "Ease in-out" },
  { value: "cubic-bezier(0.16, 1, 0.3, 1)", label: "Expo out (snappy)" },
  { value: "cubic-bezier(0.34, 1.56, 0.64, 1)", label: "Back out (spring)" },
] as const;

const EASING_VALUES: Record<string, true> = Object.fromEntries(STREAM_EASING_OPTIONS.map((o) => [o.value, true])) as Record<string, true>;

function clampNumber(raw: unknown, key: keyof typeof STREAM_TUNING_RANGES): number {
  const range = STREAM_TUNING_RANGES[key];
  const fallback = DEFAULT_STREAM_TUNING[key];
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

/** Coerce anything (parsed storage JSON, partial drafts) into a valid tuning. */
export function normalizeStreamTuning(raw: unknown): StreamTuning {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    catchUpMs: clampNumber(r.catchUpMs, "catchUpMs"),
    minRevealChars: Math.round(clampNumber(r.minRevealChars, "minRevealChars")),
    maxBacklogChars: Math.round(clampNumber(r.maxBacklogChars, "maxBacklogChars")),
    wordLookaheadChars: Math.round(clampNumber(r.wordLookaheadChars, "wordLookaheadChars")),
    drainCatchUpMs: clampNumber(r.drainCatchUpMs, "drainCatchUpMs"),
    plainTailWindowChars: Math.round(clampNumber(r.plainTailWindowChars, "plainTailWindowChars")),
    paceToolInput: typeof r.paceToolInput === "boolean" ? r.paceToolInput : DEFAULT_STREAM_TUNING.paceToolInput,
    wordFadeMs: clampNumber(r.wordFadeMs, "wordFadeMs"),
    wordBlurPx: clampNumber(r.wordBlurPx, "wordBlurPx"),
    blockEnterMs: clampNumber(r.blockEnterMs, "blockEnterMs"),
    blockRisePx: clampNumber(r.blockRisePx, "blockRisePx"),
    collapseMs: clampNumber(r.collapseMs, "collapseMs"),
    easing: typeof r.easing === "string" && EASING_VALUES[r.easing] ? r.easing : DEFAULT_STREAM_TUNING.easing,
  };
}

/**
 * CSS custom properties for the values that differ from the defaults. A
 * default tuning returns {} so the stylesheet's own `var(..., fallback)`
 * chain (which tracks the theme's --dur-med / --ease-out-warm) stays
 * authoritative.
 */
export function streamTuningCssVars(t: StreamTuning): Record<string, string> {
  const vars: Record<string, string> = {};
  const d = DEFAULT_STREAM_TUNING;
  if (t.wordFadeMs !== d.wordFadeMs) vars["--stream-word-dur"] = `${t.wordFadeMs}ms`;
  if (t.wordBlurPx !== d.wordBlurPx) vars["--stream-word-blur"] = `${t.wordBlurPx}px`;
  if (t.blockEnterMs !== d.blockEnterMs) vars["--chat-block-enter-dur"] = `${t.blockEnterMs}ms`;
  if (t.blockRisePx !== d.blockRisePx) vars["--chat-block-rise"] = `${t.blockRisePx}px`;
  if (t.collapseMs !== d.collapseMs) vars["--collapse-dur"] = `${t.collapseMs}ms`;
  if (t.easing !== d.easing) vars["--stream-anim-ease"] = t.easing;
  return vars;
}

export function isDefaultStreamTuning(t: StreamTuning): boolean {
  return (Object.keys(DEFAULT_STREAM_TUNING) as (keyof StreamTuning)[])
    .every((k) => t[k] === DEFAULT_STREAM_TUNING[k]);
}

// ── Persistence + live subscription (browser only; SSR sees defaults) ──────

let cached: StreamTuning | null = null;

function readStoredStreamTuning(): StreamTuning {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.streamTuning);
    if (raw === null) return DEFAULT_STREAM_TUNING;
    return normalizeStreamTuning(JSON.parse(raw));
  } catch {
    return DEFAULT_STREAM_TUNING;
  }
}

/** Cached-identity snapshot, safe for useSyncExternalStore. */
export function getStreamTuning(): StreamTuning {
  if (typeof window === "undefined") return DEFAULT_STREAM_TUNING;
  if (cached === null) cached = readStoredStreamTuning();
  return cached;
}

export function saveStreamTuning(t: StreamTuning): void {
  const normalized = normalizeStreamTuning(t);
  cached = normalized;
  try {
    if (isDefaultStreamTuning(normalized)) window.localStorage.removeItem(STORAGE_KEYS.streamTuning);
    else window.localStorage.setItem(STORAGE_KEYS.streamTuning, JSON.stringify(normalized));
  } catch {
    // Storage full/blocked: the in-memory value still applies this session.
  }
  window.dispatchEvent(new Event(STORAGE_EVENTS.streamTuningChange));
}

export function subscribeStreamTuning(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== STORAGE_KEYS.streamTuning) return;
    cached = null;
    onChange();
  };
  window.addEventListener(STORAGE_EVENTS.streamTuningChange, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(STORAGE_EVENTS.streamTuningChange, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
