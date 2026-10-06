"use client";

import { memo, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Bot, CalendarClock, ChevronDown, ChevronUp, Gauge, Loader2, RefreshCw, SendHorizontal, X } from "lucide-react";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useI18n } from "@/lib/i18n";
import type { ScheduledItemView } from "@/lib/scheduled/types";
import { describeScheduledItem, nextDueTransition, visibleScheduledRows } from "@/lib/scheduled/ui";

/**
 * The messages waiting to be sent, one row each, stacked above the input like
 * the send outbox's rows: what it says, when it goes, who scheduled it, and
 * Edit / Send now / Cancel. A message that could not be sent stays as a red
 * row with the reason and Retry instead, until the person decides.
 *
 * Every row is one line (the message is cut with an ellipsis, the time never
 * is); only a failed row grows a second line, for the reason, because that is
 * the one thing a person on a phone cannot hover to read.
 */

export interface ScheduledRowsProps {
  items: readonly ScheduledItemView[];
  /** Rows with a request of the person's own in flight: their buttons wait. */
  busy: ReadonlySet<string>;
  /** Nothing is stacked above these rows, so the first one carries the stack's rounded top corners. */
  roundTop: boolean;
  /** The phone layout: Send now and Cancel are icons. */
  isMobile: boolean;
  /** Take the message back into the input. */
  onEdit: (item: ScheduledItemView) => void;
  onSendNow: (item: ScheduledItemView) => void;
  onCancel: (item: ScheduledItemView) => void;
}

/**
 * "Now", kept true: the rows' words depend on whether a time has passed ("when
 * quota resets (11:40 PM)" turns into "checking quota…" at 11:40), and nothing
 * else re-renders them at that moment. One timer, for the next such moment.
 */
function useTransitionClock(items: readonly ScheduledItemView[]): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      const delay = nextDueTransition(items, current);
      if (delay !== null) timer = window.setTimeout(refresh, delay);
    };
    refresh();
    return () => window.clearTimeout(timer);
  }, [items]);
  return now;
}

function RowButton({ onClick, title, label, accent = false, disabled, touch, children }: {
  onClick: () => void;
  title: string;
  /** The accessible name when the button shows only an icon. */
  label?: string;
  accent?: boolean;
  disabled: boolean;
  /** A touch screen: a finger-sized target. */
  touch: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="scheduled-row__action"
      onClick={onClick}
      title={title}
      aria-label={label}
      disabled={disabled}
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        minWidth: touch ? 40 : undefined,
        minHeight: touch ? 44 : undefined,
        padding: touch ? "0 6px" : "3px 7px",
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: accent ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: 11,
        fontWeight: accent ? 600 : 400,
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {children}
    </button>
  );
}

/** Memoised: the composer re-renders on every keystroke and nothing here depends on the text being typed. */
export const ScheduledRows = memo(function ScheduledRows({ items, busy, roundTop, isMobile, onEdit, onSendNow, onCancel }: ScheduledRowsProps) {
  const { t, locale } = useI18n();
  const touch = useIsCoarsePointer();
  const now = useTransitionClock(items);
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const { shown, hidden } = visibleScheduledRows(items, expanded);
  // The toggle belongs to a list long enough to fold, whichever way it is showing now.
  const foldable = visibleScheduledRows(items, false).hidden > 0;

  return (
    <div data-testid="scheduled-rows">
      {shown.map((item, index) => {
        const row = describeScheduledItem(item, now, locale, t);
        const failed = row.state === "failed";
        const sending = row.state === "sending";
        const working = busy.has(item.id);
        const Icon = failed ? AlertTriangle : sending ? Loader2 : item.mode === "quota" ? Gauge : CalendarClock;
        const whenLabel = (
          <span
            data-testid="scheduled-row-when"
            style={{
              flexShrink: 0,
              maxWidth: isMobile ? undefined : "55%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 11,
              fontWeight: 600,
              color: failed ? "var(--status-error)" : "var(--text-muted)",
            }}
          >
            {failed ? t("chatInput.outboxFailed") : row.when}
          </span>
        );
        const agentMark = item.source === "agent" ? (
          <span
            data-testid="scheduled-row-agent"
            title={t("schedule.byAgentTitle")}
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--accent)" }}
          >
            <Bot size={11} strokeWidth={2} aria-hidden="true" />
            {t("schedule.byAgent")}
          </span>
        ) : null;
        const preview = (
          <span
            data-testid="scheduled-row-text"
            title={row.title}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text-muted)" }}
          >
            {row.preview}
          </span>
        );
        const note = row.note ? (
          <span
            data-testid="scheduled-row-note"
            style={{ fontSize: 11, lineHeight: 1.35, color: failed ? "var(--status-error)" : "var(--text-dim)", wordBreak: "break-word" }}
          >
            {row.note}
          </span>
        ) : null;
        return (
          <div
            key={item.id}
            data-testid="scheduled-row"
            data-scheduled-status={row.state}
            data-scheduled-mode={item.mode}
            data-scheduled-source={item.source}
            role={failed || sending ? "status" : "group"}
            aria-label={t("schedule.rowAria", { when: row.when })}
            style={{
              border: "1px solid var(--border)",
              borderBottom: "none",
              borderRadius: roundTop && index === 0 ? "var(--radius-card) var(--radius-card) 0 0" : 0,
              background: failed ? "color-mix(in srgb, var(--status-error) 6%, var(--bg-panel))" : "var(--bg-panel)",
              // On a touch screen the buttons ARE the row's height (44px targets), so the row adds none of its own.
              padding: touch ? "0 4px 0 12px" : "5px 8px 5px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <Icon
              size={11}
              strokeWidth={2.2}
              aria-hidden="true"
              style={{
                flexShrink: 0,
                color: failed ? "var(--status-error)" : "var(--text-dim)",
                animation: sending ? "spin 0.8s linear infinite" : undefined,
              }}
            />
            {isMobile ? (
              // A phone has no room for the time beside the text AND the buttons, so the text keeps the line and the time sits under it.
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1, padding: "4px 0" }}>
                {preview}
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                  {whenLabel}
                  {agentMark}
                </span>
                {note}
              </span>
            ) : (
              <>
                {whenLabel}
                {agentMark}
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  {preview}
                  {note}
                </span>
              </>
            )}
            {!sending && (
              <>
                {failed ? (
                  <RowButton onClick={() => onSendNow(item)} title={t("schedule.rowRetryTitle")} label={isMobile ? t("schedule.rowRetry") : undefined} accent disabled={working} touch={touch}>
                    <RefreshCw size={isMobile ? 14 : 10} strokeWidth={2.2} aria-hidden="true" />
                    {!isMobile && t("schedule.rowRetry")}
                  </RowButton>
                ) : null}
                <RowButton onClick={() => onEdit(item)} title={t("schedule.rowEditTitle")} disabled={working} touch={touch}>
                  {t("schedule.rowEdit")}
                </RowButton>
                {!failed && (
                  <RowButton onClick={() => onSendNow(item)} title={t("schedule.rowSendNowTitle")} label={isMobile ? t("schedule.rowSendNow") : undefined} accent disabled={working} touch={touch}>
                    {isMobile ? <SendHorizontal size={14} strokeWidth={2.2} aria-hidden="true" /> : t("schedule.rowSendNow")}
                  </RowButton>
                )}
                <RowButton onClick={() => onCancel(item)} title={t("schedule.rowCancelTitle")} label={isMobile ? t("schedule.rowCancel") : undefined} disabled={working} touch={touch}>
                  {isMobile ? <X size={14} strokeWidth={2.2} aria-hidden="true" /> : t("schedule.rowCancel")}
                </RowButton>
              </>
            )}
          </div>
        );
      })}
      {foldable && (
        <button
          type="button"
          data-testid="scheduled-rows-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            minHeight: touch ? 44 : undefined,
            padding: "4px 12px",
            border: "1px solid var(--border)",
            borderBottom: "none",
            borderRadius: 0,
            background: "var(--bg-panel)",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 11,
            textAlign: "left",
          }}
        >
          {expanded ? <ChevronUp size={11} strokeWidth={2.2} aria-hidden="true" /> : <ChevronDown size={11} strokeWidth={2.2} aria-hidden="true" />}
          {expanded ? t("schedule.showFewer") : t("schedule.showMore", { count: hidden })}
        </button>
      )}
    </div>
  );
});
