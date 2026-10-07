"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Target } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatCompactNumber } from "@/lib/format";
import {
  formatGoalDuration, goalControls, goalElapsedSeconds, goalTokenFraction, isAccountingStatus,
  type GoalStatus, type GoalView,
} from "@/lib/goal-state";

/** A second tap within this window confirms Drop; otherwise the button disarms. */
const DROP_CONFIRM_WINDOW_MS = 4000;

const STATUS_KEYS: Record<GoalStatus, string> = {
  active: "goal.status.active",
  paused: "goal.status.paused",
  "budget-limited": "goal.status.budgetLimited",
  complete: "goal.status.complete",
  dropped: "goal.status.complete",
};

const HINT_KEYS: Partial<Record<GoalStatus, string>> = {
  paused: "goal.hint.paused",
  "budget-limited": "goal.hint.budgetLimited",
  complete: "goal.hint.complete",
};

export interface GoalAutoContinueControl {
  enabled: boolean;
  pending: boolean;
  onChange: (on: boolean) => void;
}

/** The web-hosted goal an engine without goal mode falls back to: a note, not engine state. */
export interface FallbackGoal {
  objective: string;
  startedAt: number;
}

const BUTTON_STYLE = {
  minHeight: 34,
  padding: "6px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
  touchAction: "manipulation",
} as const;

/** Drop ends the goal for good, so the first tap only arms it. */
function DropButton({ onDrop, disabled }: { onDrop: () => void; disabled: boolean }) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="ui-focus-ring"
      disabled={disabled}
      data-goal-action="drop"
      data-armed={armed || undefined}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timer.current = window.setTimeout(() => setArmed(false), DROP_CONFIRM_WINDOW_MS);
          return;
        }
        window.clearTimeout(timer.current);
        setArmed(false);
        onDrop();
      }}
      style={{
        ...BUTTON_STYLE,
        color: "var(--status-error)",
        background: armed ? "color-mix(in srgb, var(--status-error) 14%, transparent)" : BUTTON_STYLE.background,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {armed ? t("goal.dropConfirm") : t("goal.drop")}
    </button>
  );
}

/**
 * The session's goal, pinned above the composer with the todo plan and the
 * subagent roster. Native (`goal`): the engine's own goal, with its live token
 * and time use, Pause / Resume / Drop, and the "Keep working automatically"
 * switch. Fallback (`fallback`): the note an engine without goal mode leaves.
 * An active goal starts collapsed (its header shows what matters); a paused,
 * budget-limited or finished one opens itself, because it is waiting on you.
 */
export function GoalPanel({ goal, fallback = null, busy = null, onOp, onDismiss, autoContinue = null, engineName }: {
  goal: GoalView | null;
  fallback?: FallbackGoal | null;
  /** The operation in flight, if any: its buttons wait. */
  busy?: "pause" | "resume" | "drop" | null;
  onOp?: (op: "pause" | "resume" | "drop") => void;
  onDismiss?: () => void;
  autoContinue?: GoalAutoContinueControl | null;
  /** The engine's short name, for the note a fallback goal shows. */
  engineName?: string;
}) {
  const { t, locale } = useI18n();
  const status: GoalStatus = goal?.state.goal.status ?? "active";
  const [collapsed, setCollapsed] = useState(status === "active");
  useEffect(() => { setCollapsed(status === "active"); }, [status]);

  const ticking = goal ? goal.state.enabled && isAccountingStatus(status) : fallback !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [ticking]);

  const engineGoal = goal?.state.goal ?? null;
  const objective = engineGoal?.objective ?? fallback?.objective;
  if (objective === undefined) return null;

  const elapsed = formatGoalDuration(engineGoal && goal ? goalElapsedSeconds(goal, now) : Math.max(0, (now - (fallback?.startedAt ?? now)) / 1000));
  const controls = engineGoal ? goalControls(status) : { pause: false, resume: false, drop: false, dismiss: true };
  const fraction = engineGoal ? goalTokenFraction(engineGoal) : null;
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const format = (n: number) => n.toLocaleString(locale);
  const statusLabel = t(STATUS_KEYS[status]);
  const hintKey = engineGoal ? HINT_KEYS[status] : "goal.hint.webOnly";
  const hint = hintKey ? t(hintKey, { name: engineName ?? "" }) : null;
  const waiting = busy !== null;
  const barColor = status === "budget-limited" || (percent ?? 0) >= 90 ? "var(--status-warning)" : "var(--accent)";

  return (
    <section
      aria-label={t("goal.panel")}
      data-testid="goal-panel"
      data-goal-status={engineGoal ? status : "note"}
      className="overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)", width: "100%" }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={t("goal.summary", { status: statusLabel, objective })}
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
        className={`ui-focus-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted ${collapsed ? "" : "border-b border-border"}`}
        style={{ background: "none" }}
      >
        <Target size={14} strokeWidth={1.8} aria-hidden style={{ flexShrink: 0, color: status === "active" ? "var(--accent)" : undefined }} />
        <strong className="shrink-0 font-medium text-text">{t("goal.panel")}</strong>
        <span className="shrink-0" style={{ color: status === "budget-limited" ? "var(--status-warning)" : status === "active" ? "var(--accent)" : "var(--text-dim)" }}>{statusLabel}</span>
        <span className="min-w-0 flex-1 truncate">{objective}</span>
        {engineGoal && (
          <span className="hidden shrink-0 tabular-nums sm:inline">{t("goal.tokensShort", { count: formatCompactNumber(engineGoal.tokensUsed) })}</span>
        )}
        <span className="shrink-0 tabular-nums">{elapsed}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-2 px-3 py-2.5 text-xs">
          <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 120, overflowY: "auto", color: "var(--text)" }}>{objective}</p>
          {engineGoal && (
            <div className="flex flex-col gap-1.5 text-text-muted">
              <div className="flex items-baseline justify-between gap-3">
                <span>{t("goal.tokens")}</span>
                <span className="tabular-nums text-text" data-goal-tokens>
                  {engineGoal.tokenBudget !== undefined
                    ? t("goal.tokensOfBudget", { used: format(engineGoal.tokensUsed), budget: format(engineGoal.tokenBudget) })
                    : format(engineGoal.tokensUsed)}
                </span>
              </div>
              {percent !== null && (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label={t("goal.budgetBar", { percent })}
                  style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}
                >
                  <div style={{ width: `${percent}%`, height: "100%", background: barColor, transition: "width var(--dur-med) var(--ease-out-warm)" }} />
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <span>{t("goal.time")}</span>
                <span className="tabular-nums text-text">{elapsed}</span>
              </div>
            </div>
          )}
          {hint && <p style={{ margin: 0, color: "var(--text-muted)" }}>{hint}</p>}
          {(controls.pause || controls.resume || controls.drop || controls.dismiss) && (
            <div className="flex flex-wrap gap-2">
              {controls.pause && onOp && (
                <button type="button" className="ui-focus-ring" data-goal-action="pause" disabled={waiting} onClick={() => onOp("pause")} style={{ ...BUTTON_STYLE, opacity: waiting ? 0.6 : 1 }}>
                  {busy === "pause" && <Loader2 size={12} aria-hidden className="icon-spin" style={{ marginRight: 6, verticalAlign: "-2px" }} />}
                  {t("goal.pause")}
                </button>
              )}
              {controls.resume && onOp && (
                <button type="button" className="ui-focus-ring" data-goal-action="resume" disabled={waiting} onClick={() => onOp("resume")} style={{ ...BUTTON_STYLE, opacity: waiting ? 0.6 : 1 }}>
                  {busy === "resume" && <Loader2 size={12} aria-hidden className="icon-spin" style={{ marginRight: 6, verticalAlign: "-2px" }} />}
                  {t("goal.resume")}
                </button>
              )}
              {controls.drop && onOp && <DropButton disabled={waiting} onDrop={() => onOp("drop")} />}
              {controls.dismiss && onDismiss && (
                <button type="button" className="ui-focus-ring" data-goal-action="dismiss" onClick={onDismiss} style={BUTTON_STYLE}>
                  {t("goal.dismiss")}
                </button>
              )}
            </div>
          )}
          {autoContinue && engineGoal && status !== "complete" && (
            <div className="flex items-start gap-2.5" style={{ paddingTop: 2 }}>
              <button
                type="button"
                role="switch"
                aria-checked={autoContinue.enabled}
                aria-label={t("goal.autoContinue")}
                data-goal-auto-continue={autoContinue.enabled ? "on" : "off"}
                disabled={autoContinue.pending}
                onClick={() => autoContinue.onChange(!autoContinue.enabled)}
                className="ui-focus-ring"
                style={{
                  flexShrink: 0, position: "relative", width: 36, height: 20, marginTop: 1,
                  border: "none", borderRadius: 10, padding: 0, cursor: autoContinue.pending ? "wait" : "pointer",
                  background: autoContinue.enabled ? "var(--accent)" : "var(--border-strong, var(--border))",
                  opacity: autoContinue.pending ? 0.6 : 1, touchAction: "manipulation",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    position: "absolute", top: 2, left: autoContinue.enabled ? 18 : 2, width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg)", transition: "left var(--dur-fast) var(--ease-out-warm)",
                  }}
                />
              </button>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-text">{t("goal.autoContinue")}</span>
                <span className="text-text-muted">{autoContinue.enabled ? t("goal.autoContinueOnHint") : t("goal.autoContinueOffHint")}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
