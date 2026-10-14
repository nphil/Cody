"use client";

import { memo, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Bot, CalendarClock, ChevronDown, Gauge, Hourglass, Loader2, Pencil, RefreshCw, SendHorizontal, X } from "lucide-react";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useI18n } from "@/lib/i18n";
import type { ScheduledItemView } from "@/lib/scheduled/types";
import { describeScheduledItem, nextDueTransition, summarizeScheduled } from "@/lib/scheduled/ui";

/**
 * Every message waiting to be sent, as ONE slim bar above the composer — the
 * same family as the Tasks and Agents bars (ComposerPanels): full width, icon ·
 * title · detail · chevron, collapsed until opened. Collapsed it says how many
 * are scheduled and when the next one goes ("2 scheduled · next 9:30 PM"); a
 * message that could not be sent turns it red ("1 failed to send") but never
 * opens it by itself.
 *
 * Opened, it is a short list (it scrolls past a few rows), one line per
 * message: when, who scheduled it, the text, and Edit / Send now / Cancel — or
 * Retry / Edit / Cancel on a failed one — as icon buttons that name themselves
 * on hover and to a screen reader. A failed row grows a second line for the
 * reason, because that is the one thing a person on a phone cannot hover to read.
 */

export interface ScheduledBarProps {
  items: readonly ScheduledItemView[];
  /** Rows with a request of the person's own in flight: their buttons wait. */
  busy: ReadonlySet<string>;
  /** The phone layout: the time sits over the text instead of beside it. */
  isMobile: boolean;
  /** Take the message back into the input. */
  onEdit: (item: ScheduledItemView) => void;
  onSendNow: (item: ScheduledItemView) => void;
  onCancel: (item: ScheduledItemView) => void;
  /** Start open (the bar starts collapsed). */
  defaultExpanded?: boolean;
}

/**
 * "Now", kept true: the words depend on whether a time has passed ("when quota
 * resets (11:40 PM)" turns into "checking quota…" at 11:40), and nothing else
 * re-renders them at that moment. One timer, for the next such moment.
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

/** A finger-sized icon button on a touch screen (38px), a compact one with a mouse. */
function IconAction({ onClick, title, label, accent = false, disabled, touch, children }: {
  onClick: () => void;
  title: string;
  label: string;
  accent?: boolean;
  disabled: boolean;
  touch: boolean;
  children: ReactNode;
}) {
  const size = touch ? 38 : 26;
  return (
    <button
      type="button"
      className="scheduled-row__action ui-focus-ring"
      onClick={onClick}
      title={title}
      aria-label={label}
      disabled={disabled}
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        padding: 0,
        border: "none",
        borderRadius: "var(--radius-control)",
        background: "transparent",
        color: accent ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {children}
    </button>
  );
}

function ScheduledListRow({ item, now, working, touch, isMobile, onEdit, onSendNow, onCancel }: {
  item: ScheduledItemView;
  now: number;
  working: boolean;
  touch: boolean;
  isMobile: boolean;
  onEdit: (item: ScheduledItemView) => void;
  onSendNow: (item: ScheduledItemView) => void;
  onCancel: (item: ScheduledItemView) => void;
}) {
  const { t, locale } = useI18n();
  const row = describeScheduledItem(item, now, locale, t);
  const failed = row.state === "failed";
  const sending = row.state === "sending";
  // In the chat's queue behind a reply that may run for hours: nothing is spinning, and — as for a send in flight — it can no longer be edited or cancelled here.
  const waiting = row.state === "waiting";
  const Icon = failed ? AlertTriangle : sending ? Loader2 : waiting ? Hourglass : item.mode === "quota" ? Gauge : CalendarClock;
  const whenLabel = (
    <span
      data-testid="scheduled-row-when"
      title={row.when}
      style={{
        flexShrink: isMobile ? 1 : 0,
        minWidth: 0,
        maxWidth: isMobile ? undefined : "42%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: 11.5,
        fontWeight: 600,
        color: failed ? "var(--status-error)" : "var(--text-muted)",
      }}
    >
      {failed ? t("chatInput.outboxFailed") : row.whenShort}
    </span>
  );
  const agentMark = item.source === "agent" ? (
    <span
      data-testid="scheduled-row-agent"
      title={t("schedule.byAgentTitle")}
      style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--accent)", whiteSpace: "nowrap" }}
    >
      <Bot size={11} strokeWidth={2} aria-hidden="true" />
      {t("schedule.byAgent")}
    </span>
  ) : null;
  const preview = (
    <span
      data-testid="scheduled-row-text"
      title={row.title}
      style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}
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
  const iconSize = touch ? 16 : 13;
  return (
    <div
      data-testid="scheduled-row"
      data-scheduled-status={row.state}
      data-scheduled-mode={item.mode}
      data-scheduled-source={item.source}
      role={failed || sending || waiting ? "status" : "group"}
      aria-label={t("schedule.rowAria", { when: row.when })}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        minHeight: touch ? 44 : 32,
        padding: touch ? "0 4px 0 12px" : "2px 6px 2px 12px",
        borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        background: failed ? "color-mix(in srgb, var(--status-error) 6%, transparent)" : undefined,
      }}
    >
      <Icon
        size={12}
        strokeWidth={2.2}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          color: failed ? "var(--status-error)" : "var(--text-dim)",
          animation: sending ? "spin 0.8s linear infinite" : undefined,
        }}
      />
      {isMobile ? (
        // A phone has no room for the time beside the text AND three buttons, so the text keeps the line and the time sits over it.
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1, padding: "4px 0" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
            {whenLabel}
            {agentMark}
          </span>
          {preview}
          {note}
        </span>
      ) : (
        <>
          {whenLabel}
          {agentMark}
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: note ? "3px 0" : 0 }}>
            {preview}
            {note}
          </span>
        </>
      )}
      {!sending && !waiting && (
        <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}>
          {failed ? (
            <IconAction onClick={() => onSendNow(item)} title={t("schedule.rowRetryTitle")} label={t("schedule.rowRetry")} accent disabled={working} touch={touch}>
              <RefreshCw size={iconSize} strokeWidth={2.2} aria-hidden="true" />
            </IconAction>
          ) : null}
          <IconAction onClick={() => onEdit(item)} title={t("schedule.rowEditTitle")} label={t("schedule.rowEdit")} disabled={working} touch={touch}>
            <Pencil size={iconSize} strokeWidth={2.2} aria-hidden="true" />
          </IconAction>
          {!failed && (
            <IconAction onClick={() => onSendNow(item)} title={t("schedule.rowSendNowTitle")} label={t("schedule.rowSendNow")} accent disabled={working} touch={touch}>
              <SendHorizontal size={iconSize} strokeWidth={2.2} aria-hidden="true" />
            </IconAction>
          )}
          <IconAction onClick={() => onCancel(item)} title={t("schedule.rowCancelTitle")} label={t("schedule.rowCancel")} disabled={working} touch={touch}>
            <X size={iconSize} strokeWidth={2.2} aria-hidden="true" />
          </IconAction>
        </span>
      )}
    </div>
  );
}

/** Memoised: the composer re-renders on every keystroke and nothing here depends on the text being typed. */
export const ScheduledBar = memo(function ScheduledBar({ items, busy, isMobile, onEdit, onSendNow, onCancel, defaultExpanded = false }: ScheduledBarProps) {
  const { t, locale } = useI18n();
  const touch = useIsCoarsePointer();
  const now = useTransitionClock(items);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  const summary = summarizeScheduled(items, now, locale, t);
  if (!summary) return null;

  const failed = summary.failedCount > 0;
  const HeaderIcon = failed ? AlertTriangle : CalendarClock;

  return (
    <section
      data-testid="scheduled-bar"
      data-scheduled-failed={failed ? "true" : undefined}
      aria-label={t("schedule.barAria")}
      className="overflow-hidden border bg-bg-subtle"
      style={{
        borderRadius: "var(--radius-card)",
        width: "100%",
        marginBottom: 6,
        borderColor: failed ? "color-mix(in srgb, var(--status-error) 45%, var(--border))" : "var(--border)",
      }}
    >
      <button
        type="button"
        data-testid="scheduled-bar-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded((open) => !open)}
        title={expanded ? t("chatWindow.collapsePanel") : t("chatWindow.expandPanel")}
        className="ui-focus-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted"
        style={{ background: "none", minHeight: touch ? 44 : undefined, color: failed ? "var(--status-error)" : undefined }}
      >
        <HeaderIcon size={14} strokeWidth={1.8} aria-hidden />
        <strong className="shrink-0 font-medium" style={{ color: failed ? "var(--status-error)" : "var(--text)" }}>{summary.title}</strong>
        <span
          data-testid="scheduled-bar-detail"
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ color: "var(--text-dim)" }}
        >
          {summary.detail}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </button>
      {expanded && (
        <div id={listId} data-testid="scheduled-list" style={{ maxHeight: "min(34vh, 264px)", overflowY: "auto", overscrollBehavior: "contain" }}>
          {items.map((item) => (
            <ScheduledListRow
              key={item.id}
              item={item}
              now={now}
              working={busy.has(item.id)}
              touch={touch}
              isMobile={isMobile}
              onEdit={onEdit}
              onSendNow={onSendNow}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}
    </section>
  );
});
