"use client";

import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { addDailyLimitTime, dismissDailyLimitNotice, useDailyLimit } from "@/hooks/useDailyLimit";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { EXTEND_MINUTES, type DailyLimitState } from "@/lib/daily-limit/state";
import { deriveView, formatDuration, TONE_COLOR, type DailyLimitView } from "@/lib/daily-limit/view";
import { useI18n } from "@/lib/i18n";
import { LimitGlyph } from "./DailyLimitRing";

/**
 * The "time's up" moment, once: a slim full-width bar above the composer, in
 * the same family as the Tasks, Agents and Scheduled bars. It says the limit is
 * reached and offers two answers — "Add 15 minutes" (more time for today only)
 * and "Done for today" (understood; it does not come back at this limit). It is
 * calm on purpose: nothing is blocked, a run in progress is never stopped, and
 * the quiet "12m over" state lives on in the ring for the rest of the day.
 *
 * Whether it shows is the server's call (`noticeDue`, per person and per
 * limit), so answering it on the tablet clears it on the PC too.
 */
export function DailyLimitNoticeBar({ view, busy = null, touch = false, onAdd, onDone }: {
  view: DailyLimitView;
  /** The answer being saved; its button waits and the other one too. */
  busy?: "add" | "done" | null;
  /** A finger: taller targets. */
  touch?: boolean;
  onAdd: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const color = TONE_COLOR[view.tone];
  const height = touch ? 44 : 32;
  const button = {
    flex: "1 1 auto",
    minHeight: height,
    padding: "0 14px",
    borderRadius: "var(--radius-control)",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    cursor: busy ? "wait" : "pointer",
    opacity: busy ? 0.6 : 1,
  } as const;
  return (
    <section
      role="status"
      data-testid="daily-limit-notice"
      aria-label={t("dailyLimit.ringReached")}
      style={{
        width: "100%",
        marginBottom: 6,
        padding: "10px 12px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px 12px",
        border: `1px solid color-mix(in srgb, ${color} 38%, var(--border))`,
        borderRadius: "var(--radius-card)",
        background: `color-mix(in srgb, ${color} 5%, var(--bg-panel))`,
      }}
    >
      <span style={{ display: "flex", flexShrink: 0, color }}>
        <LimitGlyph size={24} level={view.level} />
      </span>
      <span style={{ flex: "1 1 180px", minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <strong style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {t("dailyLimit.noticeTitle", { limit: formatDuration(view.limitSeconds, "floor", t) })}
        </strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("dailyLimit.noticeBody")}</span>
      </span>
      <span style={{ flex: "0 1 auto", display: "flex", gap: 8, minWidth: 0, width: touch ? "100%" : undefined }}>
        <button
          type="button"
          data-testid="daily-limit-notice-add"
          disabled={busy !== null}
          onClick={onAdd}
          className="ui-focus-ring"
          style={{ ...button, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
        >
          {t("dailyLimit.addMinutes", { minutes: EXTEND_MINUTES })}
        </button>
        <button
          type="button"
          data-testid="daily-limit-notice-done"
          disabled={busy !== null}
          onClick={onDone}
          className="ui-focus-ring"
          style={{ ...button, border: "1px solid transparent", background: "var(--accent-strong)", color: "var(--on-accent)" }}
        >
          {t("dailyLimit.doneForToday")}
        </button>
      </span>
    </section>
  );
}

/** The notice, wired to the shared state. Draws nothing unless it is due.
 * `initial` is the static-render seam, as on the ring. */
export function DailyLimitNotice({ initial = null }: { initial?: DailyLimitState | null }) {
  const { t } = useI18n();
  const touch = useIsCoarsePointer();
  const { state, view: shared } = useDailyLimit();
  const view = state ? shared : deriveView(initial);
  const [busy, setBusy] = useState<"add" | "done" | null>(null);
  if (!view || !view.noticeDue) return null;

  const answer = (which: "add" | "done", save: () => Promise<void>) => {
    setBusy(which);
    save()
      .catch(() => toast.error(t("dailyLimit.saveFailed")))
      .finally(() => setBusy(null));
  };
  return (
    <DailyLimitNoticeBar
      view={view}
      busy={busy}
      touch={touch}
      onAdd={() => answer("add", () => addDailyLimitTime(EXTEND_MINUTES))}
      onDone={() => answer("done", dismissDailyLimitNotice)}
    />
  );
}
