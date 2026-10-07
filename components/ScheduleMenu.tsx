"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Clock, Gauge, SendHorizontal } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { providerBrand } from "@/lib/provider-brand";
import { SCHEDULED_LIMITS } from "@/lib/scheduled/types";
import {
  SCHEDULE_BLOCK_KEYS,
  checkPickedTime,
  nextMenuIndex,
  pickBounds,
  placeScheduleMenu,
  quotaRowModel,
  resolveChipAt,
  scheduleChipLabel,
  scheduleChips,
  type AnchorRect,
  type QuotaResetSource,
  type ScheduleBlock,
  type ScheduleChip,
} from "@/lib/scheduled/ui";
import { formatResetTime } from "@/lib/format";

/**
 * The menu behind the Send pill's ▾: Send now, When quota resets, and Send at…
 * with its quick times. A popover above the pill on a mouse; a bottom sheet
 * with taller rows on a touch screen.
 *
 * Choosing a row does everything at once (there is no confirm step) except
 * "Pick…", whose native date-time field needs an explicit Schedule. A row that
 * cannot work right now stays on screen, switched off, with the reason.
 */

export type MenuPresentation = "popover" | "sheet";

/** What the person chose to schedule: a moment, or the chat's model's next quota reset. */
export type ScheduleChoice = { kind: "at"; at: number } | { kind: "quota" };

/** Row and chip heights, in px: 40/48 for rows (the brief), chips a little shorter than the rows around them. */
const ROW_MIN_HEIGHT: Record<MenuPresentation, number> = { popover: 40, sheet: 48 };
const CHIP_MIN_HEIGHT: Record<MenuPresentation, number> = { popover: 32, sheet: 44 };
const PICK_PROBLEM_KEYS = { empty: "schedule.pickEmpty", past: "schedule.pickPast", far: "schedule.pickFar" } as const;

export interface ScheduleMenuBodyProps {
  presentation: MenuPresentation;
  /** The moment the menu opened: the chips and the quota line are computed from it and stay put while it is open. */
  now: number;
  /** Why scheduling is off, or null. */
  block: ScheduleBlock | null;
  /** What the quota ring knows about this chat's own model; null when it knows nothing. */
  quota: QuotaResetSource | null;
  picking: boolean;
  pickValue: string;
  pickProblem: "empty" | "past" | "far" | null;
  onPickValueChange: (value: string) => void;
  onSendNow: () => void;
  onQuota: () => void;
  onChip: (chip: ScheduleChip) => void;
  onTogglePick: () => void;
  onConfirmPick: () => void;
}

function MenuRow({ icon, title, hint, disabled, testId, trailing, presentation, onClick }: {
  icon: ReactNode;
  title: string;
  hint?: string;
  disabled: boolean;
  testId: string;
  trailing?: ReactNode;
  presentation: MenuPresentation;
  onClick: () => void;
}) {
  const sheet = presentation === "sheet";
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    minHeight: ROW_MIN_HEIGHT[presentation],
    padding: sheet ? "8px 12px" : "6px 10px",
    background: "transparent",
    border: "none",
    borderRadius: "var(--radius-control)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: sheet ? 14 : 13,
    textAlign: "left",
  };
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={disabled ? undefined : "dropdown-item"}
      style={style}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, color: disabled ? "var(--text-dim)" : "var(--text-muted)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span>{title}</span>
        {hint && <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.35 }}>{hint}</span>}
      </span>
      {trailing}
    </button>
  );
}

/**
 * The rows themselves, with no state of their own: everything that changes is
 * a prop, so the same markup renders in a test, in the popover and in the sheet.
 */
export function ScheduleMenuBody({
  presentation, now, block, quota, picking, pickValue, pickProblem,
  onPickValueChange, onSendNow, onQuota, onChip, onTogglePick, onConfirmPick,
}: ScheduleMenuBodyProps) {
  const { t, locale } = useI18n();
  const sendAtId = useId();
  const pickId = useId();
  const sheet = presentation === "sheet";
  const chips = useMemo(() => scheduleChips(now), [now]);
  const bounds = useMemo(() => pickBounds(now), [now]);
  const quotaRow = quotaRowModel(quota, {
    now,
    t,
    brandName: (provider) => providerBrand(provider)?.name ?? provider,
    formatTime: (iso) => formatResetTime(iso, locale, now),
  });
  // Nothing to send now only when the composer is empty or still preparing; the other reasons are about scheduling alone.
  const sendNowOff = block === "preparing" || block === "empty";
  const scheduleOff = block !== null;
  const chipStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    minHeight: CHIP_MIN_HEIGHT[presentation],
    padding: "0 12px",
    border: "1px solid var(--border)",
    borderRadius: 999,
    background: "transparent",
    color: scheduleOff ? "var(--text-dim)" : "var(--text)",
    opacity: scheduleOff ? 0.6 : 1,
    cursor: scheduleOff ? "not-allowed" : "pointer",
    fontSize: sheet ? 13 : 12,
    whiteSpace: "nowrap",
  };

  return (
    <>
      <MenuRow
        icon={<SendHorizontal size={sheet ? 18 : 16} strokeWidth={2} />}
        title={t("schedule.sendNow")}
        disabled={sendNowOff}
        testId="schedule-send-now"
        presentation={presentation}
        onClick={onSendNow}
        trailing={sheet ? undefined : (
          <kbd style={{ flexShrink: 0, padding: "0 5px", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "inherit", fontSize: 11, color: "var(--text-dim)" }}>Enter</kbd>
        )}
      />
      <div role="separator" style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />
      {block !== null && (
        <div role="status" data-testid="schedule-reason" style={{ padding: "6px 12px 8px", fontSize: 12, lineHeight: 1.4, color: "var(--text-muted)" }}>
          {t(SCHEDULE_BLOCK_KEYS[block])}
        </div>
      )}
      <MenuRow
        icon={<Gauge size={sheet ? 18 : 16} strokeWidth={2} />}
        title={t("schedule.quotaTitle")}
        hint={quotaRow.available ? quotaRow.line : t(quotaRow.reasonKey)}
        disabled={scheduleOff || !quotaRow.available}
        testId="schedule-quota"
        presentation={presentation}
        onClick={onQuota}
      />
      <div role="group" aria-labelledby={sendAtId}>
        <div
          id={sendAtId}
          style={{ display: "flex", alignItems: "center", gap: 10, minHeight: ROW_MIN_HEIGHT[presentation] - 8, padding: sheet ? "4px 12px 0" : "2px 10px 0", fontSize: sheet ? 14 : 13, color: scheduleOff ? "var(--text-dim)" : "var(--text)" }}
        >
          <span aria-hidden="true" style={{ display: "inline-flex", color: "var(--text-muted)" }}><Clock size={sheet ? 18 : 16} strokeWidth={2} /></span>
          {t("schedule.sendAt")}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: sheet ? "6px 12px 10px" : "4px 10px 8px" }}>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={scheduleOff}
              onClick={() => onChip(chip)}
              data-testid={`schedule-chip-${chip.id}`}
              className={scheduleOff ? undefined : "dropdown-item"}
              style={chipStyle}
            >
              {scheduleChipLabel(chip, locale, t)}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={scheduleOff}
            aria-expanded={picking}
            aria-controls={pickId}
            onClick={onTogglePick}
            data-testid="schedule-chip-pick"
            data-selected={picking || undefined}
            className={scheduleOff ? undefined : "dropdown-item"}
            style={chipStyle}
          >
            {t("schedule.chipPick")}
          </button>
        </div>
        {picking && !scheduleOff && (
          <div id={pickId} style={{ display: "flex", flexDirection: "column", gap: 6, padding: sheet ? "0 12px 10px" : "0 10px 8px" }}>
            <label htmlFor={`${pickId}-field`} style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("schedule.pickLabel")}</label>
            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              <input
                id={`${pickId}-field`}
                type="datetime-local"
                data-testid="schedule-pick-input"
                value={pickValue}
                min={bounds.min}
                max={bounds.max}
                onChange={(event) => onPickValueChange(event.target.value)}
                aria-invalid={pickProblem !== null}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: CHIP_MIN_HEIGHT[presentation],
                  padding: "0 8px",
                  background: "var(--bg)",
                  border: `1px solid ${pickProblem ? "var(--status-error)" : "var(--border)"}`,
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  // 16px keeps iOS from zooming the page when the field is focused.
                  fontSize: sheet ? 16 : 12,
                  colorScheme: "inherit",
                }}
              />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={onConfirmPick}
                data-testid="schedule-pick-confirm"
                style={{
                  flexShrink: 0,
                  minHeight: CHIP_MIN_HEIGHT[presentation],
                  padding: "0 14px",
                  background: "var(--accent-strong)",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  color: "var(--on-accent)",
                  cursor: "pointer",
                  fontSize: sheet ? 13 : 12,
                  fontWeight: 600,
                }}
              >
                {t("schedule.pickConfirm")}
              </button>
            </div>
            {pickProblem && (
              <div role="alert" data-testid="schedule-pick-problem" style={{ fontSize: 11, color: "var(--status-error)" }}>
                {t(PICK_PROBLEM_KEYS[pickProblem], { days: SCHEDULED_LIMITS.maxDays })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export interface ScheduleMenuProps {
  presentation: MenuPresentation;
  /** The Send pill's rectangle: the popover sits above it, right edges aligned. */
  anchor: AnchorRect;
  block: ScheduleBlock | null;
  quota: QuotaResetSource | null;
  onSendNow: () => void;
  onSchedule: (choice: ScheduleChoice) => void;
  /** `returnFocus`: put focus back on the ▾ button (a keyboard close, or a choice made). */
  onClose: (returnFocus: boolean) => void;
}

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight };
}

/**
 * Opens on mount and owns what is open-only: focus, Escape, arrow keys, the
 * "Pick…" field and where the popover sits. Outside clicks are the Send pill's
 * to handle (it knows which clicks are its own).
 */
export function ScheduleMenu({ presentation, anchor, block, quota, onSendNow, onSchedule, onClose }: ScheduleMenuProps) {
  const { t } = useI18n();
  const [now] = useState(() => Date.now());
  const [picking, setPicking] = useState(false);
  const [pickValue, setPickValue] = useState(() => pickBounds(now).initial);
  const [pickProblem, setPickProblem] = useState<"empty" | "past" | "far" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sheet = presentation === "sheet";
  const placement = useMemo(() => placeScheduleMenu(anchor, viewportSize()), [anchor]);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Fixed to the viewport, so a resize (a rotated phone, a shrunk window) would leave it where the pill no longer is.
  useEffect(() => {
    const close = () => onClose(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [onClose]);

  /** Close, then do what was chosen: the menu never lingers over the thing it just changed. */
  const choose = useCallback((action: () => void) => {
    onClose(true);
    action();
  }, [onClose]);

  const togglePick = useCallback(() => {
    setPickProblem(null);
    setPicking((open) => !open);
  }, []);

  // Opening the field also opens the system's own date and time picker where there is one (a phone), so "Pick…" is one tap, not two.
  useEffect(() => {
    if (!picking) return;
    const field = menuRef.current?.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    if (!field) return;
    field.focus({ preventScroll: true });
    try {
      field.showPicker?.();
    } catch {
      // Not allowed without a fresh gesture, or not supported: the field itself still works.
    }
  }, [picking]);

  const confirmPick = useCallback(() => {
    const check = checkPickedTime(pickValue, Date.now());
    if (!check.ok) {
      setPickProblem(check.problem);
      return;
    }
    choose(() => onSchedule({ kind: "at", at: check.at }));
  }, [pickValue, choose, onSchedule]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.target instanceof HTMLInputElement) {
      // The date field keeps its own arrows; Enter inside it is "Schedule".
      if (event.key === "Enter") {
        event.preventDefault();
        confirmPick();
      }
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onClose(true);
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const next = nextMenuIndex(items.indexOf(document.activeElement as HTMLElement), event.key, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const body = (
    <ScheduleMenuBody
      presentation={presentation}
      now={now}
      block={block}
      quota={quota}
      picking={picking}
      pickValue={pickValue}
      pickProblem={pickProblem}
      onPickValueChange={(value) => {
        setPickValue(value);
        setPickProblem(null);
      }}
      onSendNow={() => choose(onSendNow)}
      onQuota={() => choose(() => onSchedule({ kind: "quota" }))}
      onChip={(chip) => choose(() => onSchedule({ kind: "at", at: resolveChipAt(chip, Date.now()) }))}
      onTogglePick={togglePick}
      onConfirmPick={confirmPick}
    />
  );

  if (sheet) {
    return (
      <div data-testid="schedule-sheet" style={{ position: "fixed", inset: 0, zIndex: 500 }}>
        <div
          aria-hidden="true"
          onPointerDown={() => onClose(false)}
          style={{ position: "absolute", inset: 0, background: "var(--overlay-backdrop)" }}
        />
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label={t("schedule.menuLabel")}
          data-testid="schedule-menu"
          data-presentation="sheet"
          className="schedule-sheet"
          onKeyDown={onKeyDown}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            maxHeight: "85dvh",
            overflowY: "auto",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
            borderRadius: "var(--radius-modal) var(--radius-modal) 0 0",
            boxShadow: "var(--shadow-modal)",
            padding: "8px max(10px, var(--safe-right)) calc(14px + var(--safe-bottom)) max(10px, var(--safe-left))",
            outline: "none",
          }}
        >
          <div aria-hidden="true" style={{ width: 36, height: 4, borderRadius: 4, background: "var(--border)", margin: "2px auto 8px" }} />
          {body}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={t("schedule.menuLabel")}
      data-testid="schedule-menu"
      data-presentation="popover"
      className="dropdown-surface"
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        left: placement.left,
        bottom: placement.bottom,
        width: placement.width,
        // Grows upward: the status-bar inset is its ceiling.
        maxHeight: `max(120px, calc(${placement.maxHeight}px - var(--safe-top)))`,
        overflowY: "auto",
        zIndex: 500,
        padding: 6,
        transformOrigin: "bottom right",
        outline: "none",
      }}
    >
      {body}
    </div>
  );
}
