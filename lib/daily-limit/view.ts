/**
 * How the daily limit LOOKS, decided once for every surface: the ring, its
 * popover, the "time's up" notice and the Settings card all call `deriveView`,
 * so the colour, the fill and the words never disagree about the same moment.
 * Pure, browser-safe, no React.
 */
import { WARNING_SECONDS, type DailyLimitState } from "./state";

/** The colour family, as the design tokens name it. */
export type LimitTone = "accent" | "warning" | "error";

/**
 *  - `normal`   — more than 15 minutes left.
 *  - `warning`  — 15 minutes or less.
 *  - `reached`  — the limit is spent, less than a minute over.
 *  - `over`     — a minute or more past it (the quiet state for the rest of the day).
 */
export type LimitPhase = "normal" | "warning" | "reached" | "over";

export interface DailyLimitView {
  phase: LimitPhase;
  tone: LimitTone;
  /** How full the ring is, 0 (nothing used) to 1 (the limit, or past it). */
  level: number;
  usedSeconds: number;
  limitSeconds: number;
  /** Seconds left; zero once the limit is reached. */
  leftSeconds: number;
  /** Seconds past the limit; zero until it is reached. */
  overSeconds: number;
  /** Seconds added today with "Add 15 minutes". */
  extraSeconds: number;
  /** The "you've reached today's limit" notice is due. */
  noticeDue: boolean;
}

/** `null` while the state is unknown or the limit is off: no surface at all. */
export function deriveView(state: DailyLimitState | null): DailyLimitView | null {
  if (!state || !state.enabled) return null;
  const left = Math.max(0, state.remainingSeconds);
  const over = Math.max(0, -state.remainingSeconds);
  const phase: LimitPhase = state.remainingSeconds > WARNING_SECONDS
    ? "normal"
    : state.remainingSeconds > 0
      ? "warning"
      : over < 60
        ? "reached"
        : "over";
  return {
    phase,
    tone: phase === "normal" ? "accent" : phase === "warning" ? "warning" : "error",
    level: Math.min(1, Math.max(0, state.usedSeconds / state.limitSeconds)),
    usedSeconds: state.usedSeconds,
    limitSeconds: state.limitSeconds,
    leftSeconds: left,
    overSeconds: over,
    extraSeconds: state.extraSeconds,
    noticeDue: state.noticeDue,
  };
}

/** The design token a tone is drawn in. */
export const TONE_COLOR: Record<LimitTone, string> = {
  accent: "var(--accent)",
  warning: "var(--status-warning)",
  error: "var(--status-error)",
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * "1h 12m", "2h", "45m", "<1m". `ceil` is for what is LEFT (59 seconds left is
 * "1m left", never "0m left" while time remains); `floor` for what has been
 * USED or gone OVER (a person is not told they used a minute they did not).
 */
export function formatDuration(seconds: number, round: "floor" | "ceil", t: Translate): string {
  const total = Math.max(0, seconds);
  const minutes = round === "ceil" ? Math.ceil(total / 60) : Math.floor(total / 60);
  if (minutes <= 0) return total <= 0 ? t("dailyLimit.durationM", { m: 0 }) : t("dailyLimit.durationLessThanMinute");
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t("dailyLimit.durationM", { m });
  return m === 0 ? t("dailyLimit.durationH", { h }) : t("dailyLimit.durationHM", { h, m });
}

/** The ring's tooltip and screen-reader name: the time left, or that it is gone. */
export function ringLabel(view: DailyLimitView, t: Translate): string {
  if (view.phase === "reached") return t("dailyLimit.ringReached");
  if (view.phase === "over") return t("dailyLimit.ringOver", { time: formatDuration(view.overSeconds, "floor", t) });
  return t("dailyLimit.ringLeft", { time: formatDuration(view.leftSeconds, "ceil", t) });
}
