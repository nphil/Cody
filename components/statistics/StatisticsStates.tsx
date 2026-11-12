"use client";

import { ChartPie, CircleAlert, SearchX, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { periodWhen } from "@/lib/statistics/present";
import type { IndexProgress, PeriodInfo } from "@/lib/statistics/types";
import type { PeriodSpec } from "./statistics-query";

/** Widths of the placeholder table rows, so the loading page already has the table's ragged edge. */
const SKELETON_ROW_WIDTHS = [92, 84, 76, 70, 62, 54];

/** The ranges offered when the chosen one is empty: longer ones only. */
const LONGER_PERIODS = [
  { preset: "30d", days: 30, labelKey: "statistics.period.30d" },
  { preset: "90d", days: 90, labelKey: "statistics.period.90d" },
] as const;

/** How far the indexer has read, as a bar. `slim` is the hairline under the page header. */
export function ProgressBar({ progress, label, slim }: { progress: IndexProgress; label: string; slim?: boolean }) {
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  return (
    <div
      className="stats-state-bar"
      data-slim={slim ? "true" : undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
    >
      <div className="stats-state-bar-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

interface StatePanelProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

/** The one layout for "nothing to show yet": a mark, what is going on, and what to do about it. */
function StatePanel({ icon, title, children, actions }: StatePanelProps) {
  return (
    <section className="stats-state">
      <div className="stats-state-icon">{icon}</div>
      <h2 className="stats-state-title display-serif">{title}</h2>
      {children}
      {actions && <div className="stats-state-actions">{actions}</div>}
    </section>
  );
}

/** The very first visit, while the transcripts are still being read for the first time. */
export function FirstRunPanel({ progress }: { progress: IndexProgress | null }) {
  const { t } = useI18n();
  const reading = progress ? t("statistics.state.reading", { done: progress.done, total: progress.total }) : t("statistics.state.updating");
  return (
    <StatePanel icon={<ChartPie size={22} aria-hidden="true" />} title={t("statistics.state.firstTitle")}>
      <p className="stats-state-text">{t("statistics.state.firstText")}</p>
      <div className="stats-state-progress" role="status">
        {progress && <ProgressBar progress={progress} label={reading} />}
        <span className="stats-state-progress-text">{reading}</span>
      </div>
    </StatePanel>
  );
}

interface EmptyPanelProps {
  period: PeriodInfo;
  /** Whether any usage exists at all, in any period. */
  hasData: boolean;
  onPeriod: (period: PeriodSpec) => void;
}

/** A period with no usage in it: says so, and offers the longer ranges that might have some. */
export function EmptyPanel({ period, hasData, onPeriod }: EmptyPanelProps) {
  const { t } = useI18n();
  if (!hasData) {
    return (
      <StatePanel icon={<SearchX size={22} aria-hidden="true" />} title={t("statistics.state.emptyNoDataTitle")}>
        <p className="stats-state-text">{t("statistics.state.emptyNoDataText")}</p>
      </StatePanel>
    );
  }
  const longer = LONGER_PERIODS.filter((option) => period.days < option.days);
  return (
    <StatePanel
      icon={<SearchX size={22} aria-hidden="true" />}
      title={t("statistics.state.emptyTitle")}
      actions={
        longer.length > 0
          ? longer.map((option) => (
              <button key={option.preset} type="button" className="stats-btn ui-focus-ring" onClick={() => onPeriod({ kind: "preset", preset: option.preset })}>
                {t("statistics.state.tryPeriod", { period: t(option.labelKey) })}
              </button>
            ))
          : undefined
      }
    >
      <p className="stats-state-text">{t("statistics.state.emptyText", { when: periodWhen(period, t) })}</p>
    </StatePanel>
  );
}

interface ProblemPanelProps {
  kind: "failed" | "range";
  onRetry: () => void;
  onReset: () => void;
}

/** The page has nothing to show because the request failed (try again) or the dates were refused (pick others). */
export function ProblemPanel({ kind, onRetry, onReset }: ProblemPanelProps) {
  const { t } = useI18n();
  if (kind === "range") {
    return (
      <StatePanel
        icon={<CircleAlert size={22} aria-hidden="true" />}
        title={t("statistics.state.rangeTitle")}
        actions={
          <button type="button" className="stats-btn ui-focus-ring" data-primary="true" onClick={onReset}>
            {t("statistics.state.reset")}
          </button>
        }
      >
        <p className="stats-state-text">{t("statistics.state.rangeText")}</p>
      </StatePanel>
    );
  }
  return (
    <StatePanel
      icon={<CircleAlert size={22} aria-hidden="true" />}
      title={t("statistics.state.errorTitle")}
      actions={
        <button type="button" className="stats-btn ui-focus-ring" data-primary="true" onClick={onRetry}>
          {t("statistics.state.retry")}
        </button>
      }
    >
      <p className="stats-state-text">{t("statistics.state.errorText")}</p>
    </StatePanel>
  );
}

/** A quiet line above the report: a warning about the data, or an error that left old numbers on screen. */
export function Notice({ tone, children, action }: { tone: "warning" | "error"; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div className="stats-state-notice" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} className="stats-state-notice-icon" aria-hidden="true" />
      <span className="stats-state-notice-text">{children}</span>
      {action}
    </div>
  );
}

/** What fills the page under the summary while the first answer is on its way. */
export function StatisticsSkeleton() {
  const { t } = useI18n();
  return (
    <div className="stats-state-skeleton" role="status" aria-busy="true">
      <span className="stats-sr">{t("statistics.state.loading")}</span>
      <div className="stats-state-skeleton-grid" aria-hidden="true">
        <div className="stats-state-skeleton-card">
          <div className="skeleton stats-state-skeleton-disc" />
        </div>
        <div className="stats-state-skeleton-card">
          {SKELETON_ROW_WIDTHS.map((width) => (
            <div key={width} className="skeleton stats-state-skeleton-row" style={{ width: `${width}%` }} />
          ))}
        </div>
      </div>
      <div className="skeleton stats-state-skeleton-timeline" aria-hidden="true" />
    </div>
  );
}
