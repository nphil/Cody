"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useDailyLimit, addDailyLimitTime } from "@/hooks/useDailyLimit";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { DAILY_LIMIT_SETTINGS_ID, EXTEND_MINUTES, type DailyLimitState } from "@/lib/daily-limit/state";
import { deriveView, formatDuration, ringLabel, TONE_COLOR, type DailyLimitView } from "@/lib/daily-limit/view";
import { useI18n } from "@/lib/i18n";
import { useSettingsOpener } from "./settings/shell-context";

/**
 * The composer's daily-limit indicator: ONE circle, no text beside it. Its
 * inside fills like liquid, from the bottom up, as the day's active time is
 * used (empty = nothing used, full = the limit); the thin outer ring is its
 * outline. It is drawn in the accent, turns to the warning colour for the last
 * 15 minutes and to the error colour once the limit is spent. Hover, or a screen
 * reader, gives the time left; a click opens the popover with the real numbers.
 *
 * The circle's diameter IS the Send/Stop pill's height (28px on a desktop, 38px
 * on a phone), so it sits in the controls row as one more box of the same size
 * — `phoneBudget()` (lib/scheduled/ui.ts) counts it as such. Nothing here ever
 * blocks a send or stops a run.
 */

/** The ring's box: the Send/Stop pill's height. */
export const RING_SIZE = { desktop: 28, phone: 38 } as const;

/**
 * The circle itself. `level` 0..1 is how full the inside is; colour is
 * `currentColor`, so the caller sets the tone on the element around it. The fill
 * is a full-size block clipped to the inner circle and slid up or down with a
 * CSS transform — a transform animates everywhere an attribute does not, and
 * the global `prefers-reduced-motion` rule in globals.css (which zeroes every
 * transition) makes the level change jump for anyone who asked for less motion.
 */
export function LimitGlyph({ size, level }: { size: number; level: number }) {
  const clipId = `daily-limit-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const stroke = Math.max(1.25, size / 20);
  const center = size / 2;
  const gap = Math.max(1.5, size / 14);
  const innerRadius = center - stroke - gap;
  const span = innerRadius * 2;
  const offset = (1 - Math.min(1, Math.max(0, level))) * span;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <clipPath id={clipId}>
          <circle cx={center} cy={center} r={innerRadius} />
        </clipPath>
      </defs>
      <circle cx={center} cy={center} r={center - stroke / 2} fill="none" stroke="currentColor" strokeWidth={stroke} />
      <circle cx={center} cy={center} r={innerRadius} fill="currentColor" fillOpacity="0.1" />
      <g clipPath={`url(#${clipId})`}>
        <rect
          data-testid="daily-limit-liquid"
          x={center - innerRadius}
          y={center - innerRadius}
          width={span}
          height={span}
          fill="currentColor"
          style={{ transform: `translateY(${offset}px)`, transition: "transform var(--dur-slow) var(--ease-out-warm)" }}
        />
      </g>
    </svg>
  );
}

/** The big number and the words under it, for the popover. */
function headline(view: DailyLimitView, t: (key: string, vars?: Record<string, string | number>) => string): { big: string; caption: string } {
  if (view.phase === "over") return { big: formatDuration(view.overSeconds, "floor", t), caption: t("dailyLimit.captionOver") };
  if (view.phase === "reached") return { big: formatDuration(0, "floor", t), caption: t("dailyLimit.captionReached") };
  return { big: formatDuration(view.leftSeconds, "ceil", t), caption: t("dailyLimit.captionLeft") };
}

const POPOVER_WIDTH = 288;

/**
 * The popover behind the circle: the time left in big numbers, what has been
 * used today, the limit, "Add 15 minutes" once it is spent, and the way to the
 * setting. Exported so a static render can show it open, which the ring's own
 * state never is.
 */
export function DailyLimitPopover({ view, anchorTop = null, anchorRight = null, adding = false, touch = false, onAdd, onOpenSettings }: {
  view: DailyLimitView;
  /** The ring's rect, to detach the popover to the viewport (as the quota popover does). */
  anchorTop?: number | null;
  anchorRight?: number | null;
  adding?: boolean;
  /** A finger: taller targets. */
  touch?: boolean;
  onAdd: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const color = TONE_COLOR[view.tone];
  const { big, caption } = headline(view, t);
  const spent = view.phase === "reached" || view.phase === "over";
  const width = `min(${POPOVER_WIDTH}px, calc(100vw - 24px))`;
  const anchor = anchorTop != null && anchorRight != null ? { top: anchorTop, right: anchorRight } : null;
  return (
    <div
      role="dialog"
      aria-label={t("dailyLimit.popoverTitle")}
      data-testid="daily-limit-popover"
      tabIndex={-1}
      className="dropdown-surface"
      style={anchor ? {
        position: "fixed",
        bottom: (window.visualViewport?.height ?? window.innerHeight) - anchor.top + 6,
        left: `clamp(8px, ${anchor.right - POPOVER_WIDTH}px, calc(100% - ${POPOVER_WIDTH + 8}px))`,
        zIndex: 500,
        width,
        outline: "none",
      } : { position: "absolute", right: 0, bottom: "calc(100% + 8px)", zIndex: 120, width, outline: "none" }}
    >
      <div style={{ padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color }}>
          <LimitGlyph size={16} level={view.level} />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)" }}>{t("dailyLimit.popoverTitle")}</span>
        </div>
        <div
          data-testid="daily-limit-big"
          style={{ marginTop: 10, fontSize: 34, fontWeight: 700, lineHeight: 1.1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", color }}
        >
          {big}
        </div>
        <div style={{ marginTop: 2, fontSize: 12, color: "var(--text-muted)" }}>{caption}</div>
        <div aria-hidden="true" style={{ marginTop: 12, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
          <div style={{ width: `${Math.round(view.level * 100)}%`, height: "100%", borderRadius: 3, background: color, transition: "width var(--dur-slow) var(--ease-out-warm)" }} />
        </div>
        <dl style={{ margin: "12px 0 0", display: "grid", gridTemplateColumns: "1fr auto", rowGap: 6, columnGap: 12, fontSize: 12.5 }}>
          <dt style={{ color: "var(--text-muted)" }}>{t("dailyLimit.usedToday")}</dt>
          <dd style={{ margin: 0, fontWeight: 600, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{formatDuration(view.usedSeconds, "floor", t)}</dd>
          <dt style={{ color: "var(--text-muted)" }}>{t("dailyLimit.limitRow")}</dt>
          <dd style={{ margin: 0, fontWeight: 600, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{formatDuration(view.limitSeconds, "floor", t)}</dd>
          {view.extraSeconds > 0 && (
            <dd style={{ margin: 0, gridColumn: "1 / -1", fontSize: 11, color: "var(--text-dim)" }}>
              {t("dailyLimit.addedToday", { time: formatDuration(view.extraSeconds, "floor", t) })}
            </dd>
          )}
        </dl>
        {spent && (
          <button
            type="button"
            data-testid="daily-limit-add"
            disabled={adding}
            onClick={onAdd}
            className="ui-focus-ring"
            style={{
              marginTop: 12, width: "100%", minHeight: touch ? 44 : 32, padding: "0 12px",
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
              background: "var(--bg)", color: "var(--text)", fontSize: 12.5, fontWeight: 600,
              cursor: adding ? "wait" : "pointer", opacity: adding ? 0.6 : 1,
            }}
          >
            {t("dailyLimit.addMinutes", { minutes: EXTEND_MINUTES })}
          </button>
        )}
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: 11, lineHeight: 1.45, color: "var(--text-dim)" }}>
          {t("dailyLimit.activeOnly")}
        </div>
        <button
          type="button"
          data-testid="daily-limit-settings-link"
          onClick={onOpenSettings}
          className="ui-focus-ring"
          style={{
            marginTop: 4, display: "inline-flex", alignItems: "center", gap: 4, minHeight: touch ? 44 : 28, padding: 0,
            border: "none", background: "transparent", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >
          {t("dailyLimit.openSettings")}
          <ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/**
 * The circle in the composer's controls row. Draws nothing while the limit is
 * off or not yet known. `initial` paints a state before the shared store has
 * answered — the seam a static render uses, and never passed by the app.
 */
export function DailyLimitRing({ isMobile, initial = null }: { isMobile: boolean; initial?: DailyLimitState | null }) {
  const { t } = useI18n();
  const touch = useIsCoarsePointer();
  const openSettings = useSettingsOpener();
  const { state, view: shared } = useDailyLimit();
  const view = state ? shared : deriveView(initial);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverOpen = open && view !== null;

  useEffect(() => {
    if (!popoverOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [popoverOpen]);

  const add = useCallback(() => {
    setAdding(true);
    addDailyLimitTime(EXTEND_MINUTES)
      .catch(() => toast.error(t("dailyLimit.saveFailed")))
      .finally(() => setAdding(false));
  }, [t]);

  if (!view) return null;
  const size = isMobile ? RING_SIZE.phone : RING_SIZE.desktop;
  const label = ringLabel(view, t);
  return (
    <div ref={rootRef} style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        data-testid="daily-limit-ring"
        data-phase={view.phase}
        data-level={view.level.toFixed(3)}
        title={label}
        aria-label={label}
        aria-expanded={popoverOpen}
        aria-haspopup="dialog"
        className="ui-focus-ring"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ top: rect.top, right: rect.right });
          setOpen((current) => !current);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "block", width: size, height: size, padding: 0, border: "none", borderRadius: "50%",
          color: TONE_COLOR[view.tone], cursor: "pointer",
          background: popoverOpen || (hovered && !touch) ? "color-mix(in srgb, currentColor 10%, transparent)" : "none",
          transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-med) var(--ease-out-warm)",
        }}
      >
        <LimitGlyph size={size} level={view.level} />
      </button>
      {popoverOpen && (
        <DailyLimitPopover
          view={view}
          anchorTop={anchor?.top ?? null}
          anchorRight={anchor?.right ?? null}
          adding={adding}
          touch={touch}
          onAdd={add}
          onOpenSettings={() => {
            setOpen(false);
            openSettings("general", { highlight: DAILY_LIMIT_SETTINGS_ID });
          }}
        />
      )}
    </div>
  );
}
