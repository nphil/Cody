"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui/Select";
import { useI18n } from "@/lib/i18n";
import { isDayLabel, todayIn } from "@/lib/statistics/days";
import type { Metric } from "@/lib/statistics/sunburst";
import { GROUP_BY_ORDER, type GroupBy, type PeriodInfo, type RangePreset } from "@/lib/statistics/types";
import { Segmented } from "./Segmented";
import type { PeriodSpec } from "./statistics-query";

type PeriodChoice = RangePreset | "custom";

const PERIOD_CHOICES: readonly PeriodChoice[] = ["today", "7d", "30d", "90d", "custom"];
const PERIOD_KEYS: Record<PeriodChoice, string> = {
  today: "statistics.period.today",
  "7d": "statistics.period.7d",
  "30d": "statistics.period.30d",
  "90d": "statistics.period.90d",
  custom: "statistics.period.custom",
};
const METRICS: readonly Metric[] = ["cost", "tokens"];
const METRIC_KEYS: Record<Metric, string> = { cost: "statistics.metric.cost", tokens: "statistics.metric.tokens" };
const GROUP_BY_KEYS: Record<GroupBy, string> = {
  provider: "statistics.groupBy.provider",
  project: "statistics.groupBy.project",
  model: "statistics.groupBy.model",
  worker: "statistics.groupBy.worker",
};

/** The days the custom fields may take: the first day with data and today, both in the zone days are counted in. */
export interface DateBounds {
  min: string | null;
  max: string;
}

export interface ControlsBarProps {
  period: PeriodSpec;
  onPeriod: (period: PeriodSpec) => void;
  metric: Metric;
  onMetric: (metric: Metric) => void;
  groupBy: GroupBy;
  onGroupBy: (groupBy: GroupBy) => void;
  /** The period on screen right now: choosing "Custom" starts from it, so nothing jumps. */
  shown: PeriodInfo | null;
  /** Null until the first answer says which zone "today" is in. */
  bounds: DateBounds | null;
}

interface CustomRangeProps {
  from: string;
  to: string;
  bounds: DateBounds | null;
  onChange: (from: string, to: string) => void;
}

/**
 * The two date fields of a custom period. They show what is being typed, which
 * can run ahead of the period: a date only becomes the period once it is a whole
 * day inside the allowed span (typing a year passes through 0002, 0020, 0202 on
 * the way to 2026, and none of those may reach the server).
 */
function CustomRange({ from, to, bounds, onChange }: CustomRangeProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ from, to });
  // A period chosen elsewhere (the timeline, "Back to ...") replaces whatever is typed.
  useEffect(() => setDraft({ from, to }), [from, to]);

  const allowed = (day: string) => isDayLabel(day) && !(bounds?.min && day < bounds.min) && !(bounds && day > bounds.max);

  const edit = (field: "from" | "to", value: string) => {
    const next = field === "from" ? { from: value, to: draft.to } : { from: draft.from, to: value };
    if (allowed(next.from) && allowed(next.to)) {
      // A range cannot run backwards: the end that was not touched follows the one that was.
      if (next.from > next.to) {
        next.from = value;
        next.to = value;
      }
      setDraft(next);
      onChange(next.from, next.to);
    } else {
      setDraft(next);
    }
  };

  return (
    <div className="stats-ctl-range">
      <label className="stats-ctl-date">
        <span className="stats-ctl-label">{t("statistics.page.from")}</span>
        <input
          type="date"
          className="stats-ctl-input ui-focus-ring"
          value={draft.from}
          min={bounds?.min ?? undefined}
          max={bounds?.max}
          onChange={(event) => edit("from", event.target.value)}
        />
      </label>
      <label className="stats-ctl-date">
        <span className="stats-ctl-label">{t("statistics.page.to")}</span>
        <input
          type="date"
          className="stats-ctl-input ui-focus-ring"
          value={draft.to}
          min={bounds?.min ?? undefined}
          max={bounds?.max}
          onChange={(event) => edit("to", event.target.value)}
        />
      </label>
    </div>
  );
}

/** Period, custom dates, Cost/Tokens and the ring order: everything that changes what the page shows. */
export function ControlsBar({ period, onPeriod, metric, onMetric, groupBy, onGroupBy, shown, bounds }: ControlsBarProps) {
  const { t } = useI18n();

  const choosePeriod = (choice: PeriodChoice) => {
    if (choice !== "custom") {
      onPeriod({ kind: "preset", preset: choice });
    } else if (period.kind !== "custom") {
      const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now());
      onPeriod({ kind: "custom", from: shown?.from ?? today, to: shown?.to ?? today });
    }
  };

  return (
    <div className="stats-ctl">
      <div className="stats-ctl-period">
        <Segmented
          value={period.kind === "custom" ? "custom" : period.preset}
          onChange={choosePeriod}
          options={PERIOD_CHOICES.map((choice) => ({ value: choice, label: t(PERIOD_KEYS[choice]) }))}
          aria-label={t("statistics.period.label")}
        />
      </div>
      {period.kind === "custom" && (
        <CustomRange from={period.from} to={period.to} bounds={bounds} onChange={(from, to) => onPeriod({ kind: "custom", from, to })} />
      )}
      <div className="stats-ctl-metric">
        <Segmented
          value={metric}
          onChange={onMetric}
          options={METRICS.map((choice) => ({ value: choice, label: t(METRIC_KEYS[choice]) }))}
          aria-label={t("statistics.page.metricLabel")}
        />
      </div>
      <div className="stats-ctl-group">
        <span className="stats-ctl-label" aria-hidden="true">
          {t("statistics.groupBy.label")}
        </span>
        <div className="stats-ctl-select">
          <Select
            value={groupBy}
            onChange={onGroupBy}
            options={GROUP_BY_ORDER.map((choice) => ({ value: choice, label: t(GROUP_BY_KEYS[choice]) }))}
            aria-label={t("statistics.groupBy.label")}
          />
        </div>
      </div>
    </div>
  );
}
