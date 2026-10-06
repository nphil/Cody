"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useI18n } from "@/lib/i18n";
import { createLongPress, type AnchorRect, type QuotaResetSource, type ScheduleBlock } from "@/lib/scheduled/ui";
import { ScheduleMenu, type ScheduleChoice } from "./ScheduleMenu";

/**
 * The composer's Send button: one pill, two zones. The main part is Send, as it
 * always was (a click, and Enter in the box, send at once). The slim ▾ zone
 * joined to its right edge opens the schedule menu, and so do a right-click and
 * a long press on the pill, so a touch screen reaches it without hunting for
 * the small target.
 *
 * The ▾ zone costs 22 px on a desktop pill and 24 px on the phone, where the
 * main part stays icon-only (lib/scheduled/ui.ts PHONE_COMPOSER holds the
 * phone row's arithmetic). The pill only replaces Send; while a turn is
 * running the composer shows Stop instead and nothing here is drawn.
 */

export interface SendPillProps {
  /** The phone layout: Send is an arrow only. */
  isMobile: boolean;
  /** There is something to send: the pill wears the accent. */
  ready: boolean;
  /** Send is off: nothing to send, or an attachment is still being prepared. */
  sendDisabled: boolean;
  /** Why the schedule rows are off, or null when they work. */
  block: ScheduleBlock | null;
  /** What the quota ring knows about this chat's own model. */
  quota: QuotaResetSource | null;
  onSend: () => void;
  onSchedule: (choice: ScheduleChoice) => void;
}

export function SendPill({ isMobile, ready, sendDisabled, block, quota, onSend, onSchedule }: SendPillProps) {
  const { t } = useI18n();
  const coarsePointer = useIsCoarsePointer();
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const zoneRef = useRef<HTMLButtonElement>(null);
  const open = anchor !== null;

  const openMenu = useCallback(() => {
    const rect = pillRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom });
  }, []);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setAnchor(null);
    if (returnFocus) zoneRef.current?.focus();
  }, []);

  const longPress = useMemo(() => createLongPress({ onLongPress: openMenu }), [openMenu]);
  useEffect(() => () => longPress.dispose(), [longPress]);

  // A press anywhere else closes the popover. The pill's own zones decide for themselves, so they are "inside".
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [open, closeMenu]);

  const onZoneKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    openMenu();
  };

  const edge = ready ? "color-mix(in srgb, var(--on-accent) 28%, transparent)" : "var(--border)";

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      <div
        ref={pillRef}
        className="send-pill"
        data-testid="send-pill"
        data-ready={ready ? "true" : "false"}
        onContextMenu={(event) => {
          // A right-click, and the long press Android turns into one: this menu instead of the browser's.
          event.preventDefault();
          openMenu();
        }}
        style={{
          display: "flex",
          alignItems: "stretch",
          height: isMobile ? 38 : 28,
          borderRadius: 8,
          overflow: "hidden",
          background: ready ? "var(--accent-strong)" : "var(--bg-panel)",
          color: ready ? "var(--on-accent)" : "var(--text-dim)",
          boxShadow: ready ? "var(--shadow-card)" : "none",
          transition: "background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
        }}
      >
        {/* aria-disabled, not disabled: a disabled button swallows the pointer events the long press listens to. */}
        <button
          type="button"
          className="send-pill__main"
          data-testid="send-button"
          aria-disabled={sendDisabled}
          // Arrow only on a phone; the word survives in the accessible name, and the arrow grows to stay legible in a 38px target.
          aria-label={isMobile ? t("chatInput.send") : undefined}
          onClick={() => {
            // The click a lifted finger makes after a long press belongs to the menu it opened, not to Send.
            if (longPress.consumeClick() || sendDisabled) return;
            onSend();
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") longPress.start(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => longPress.move(event.clientX, event.clientY)}
          onPointerUp={() => longPress.end()}
          onPointerCancel={() => longPress.end()}
          onPointerLeave={() => longPress.end()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: isMobile ? "center" : undefined,
            gap: 6,
            width: isMobile ? 38 : undefined,
            flexShrink: isMobile ? 0 : undefined,
            padding: isMobile ? 0 : "0 14px",
            background: "transparent",
            border: "none",
            color: "inherit",
            cursor: sendDisabled ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <svg width={isMobile ? 17 : 12} height={isMobile ? 17 : 12} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="2" y1="7" x2="11" y2="7" />
            <polyline points="7.5 3 12 7 7.5 11" />
          </svg>
          {!isMobile && t("chatInput.send")}
        </button>
        <button
          ref={zoneRef}
          type="button"
          className="send-pill__zone"
          data-testid="send-menu-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("schedule.menuLabel")}
          title={t("schedule.menuTitle")}
          onClick={() => (open ? closeMenu(false) : openMenu())}
          onKeyDown={onZoneKeyDown}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: isMobile ? 24 : 22,
            flexShrink: 0,
            padding: 0,
            background: open ? "color-mix(in srgb, currentColor 14%, transparent)" : "transparent",
            border: "none",
            borderLeft: `1px solid ${edge}`,
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <ChevronDown size={isMobile ? 14 : 12} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>
      {anchor && (
        <ScheduleMenu
          presentation={isMobile || coarsePointer ? "sheet" : "popover"}
          anchor={anchor}
          block={block}
          quota={quota}
          onSendNow={onSend}
          onSchedule={onSchedule}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
