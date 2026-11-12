"use client";

import { CalendarDays, CircleHelp, Cog, Crown, Network, PiggyBank, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  formatDay,
  formatShare,
  formatTokens,
  formatUsd,
  nodeLabel,
  periodWhen,
  type Translate,
  type TranslatePlural,
} from "@/lib/statistics/present";
import type { Dim, Insight, InsightValue, PeriodInfo } from "@/lib/statistics/types";

export interface InsightsProps {
  insights: Insight[];
  period: PeriodInfo;
}

/** The server lists findings most-worth-reading first; past this many the list stops being a glance. */
const MAX_INSIGHTS = 5;

const ICONS: Record<Insight["id"], LucideIcon> = {
  subagentShare: Network,
  cacheSaved: PiggyBank,
  topSpender: Crown,
  priciestDay: CalendarDays,
  backgroundShare: Cog,
  unpriced: CircleHelp,
};

const DIMS: Record<string, true> = { provider: true, model: true, project: true, chat: true, worker: true };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CSS = `
.stats-insights { margin: 0; padding: 0; list-style: none; font-variant-numeric: tabular-nums; }
.stats-insights-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; padding: 5px 0; font-size: 14px; line-height: 21px; color: var(--text); overflow-wrap: anywhere; }
.stats-insights-row svg { margin-top: 3px; color: var(--text-muted); }
`;

interface Voice {
  locale: string;
  t: Translate;
  tn: TranslatePlural;
  /** "this week", "in the last 30 days": where a sentence says which stretch of time it talks about. */
  when: string;
}

function numberOf(values: InsightValue, name: string): number {
  const value = values[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textOf(values: InsightValue, name: string): string {
  const value = values[name];
  return value === undefined ? "" : String(value);
}

/**
 * The server sends numbers, the page words them, so every language reads natively.
 * A cost share of zero means nothing was priced, which is not the same as a free
 * share, so those findings fall back to a tokens-only sentence instead of "0%".
 */
function sentenceOf(insight: Insight, voice: Voice): string | null {
  const { locale, t, tn, when } = voice;
  const { values } = insight;
  switch (insight.id) {
    case "subagentShare": {
      const tokenShare = formatShare(numberOf(values, "tokenShare"), locale);
      const costShare = numberOf(values, "costShare");
      return costShare > 0
        ? t("statistics.insight.subagentShare", { tokenShare, costShare: formatShare(costShare, locale), when })
        : t("statistics.insight.subagentShareTokens", { tokenShare, when });
    }
    case "cacheSaved":
      return t("statistics.insight.cacheSaved", { amount: formatUsd(numberOf(values, "amount"), locale), when });
    case "topSpender": {
      const dim = textOf(values, "dim");
      const key = textOf(values, "key");
      const label = textOf(values, "label");
      const name = Object.hasOwn(DIMS, dim) ? nodeLabel({ dim: dim as Dim, key, label, other: false }, t) : label || key;
      const tokenShare = formatShare(numberOf(values, "tokenShare"), locale);
      const costShare = numberOf(values, "costShare");
      return costShare > 0
        ? t("statistics.insight.topSpender", { name, costShare: formatShare(costShare, locale), tokenShare, when })
        : t("statistics.insight.topSpenderTokens", { name, tokenShare, when });
    }
    case "backgroundShare": {
      const tokenShare = formatShare(numberOf(values, "tokenShare"), locale);
      const cost = numberOf(values, "cost");
      return cost > 0
        ? t("statistics.insight.backgroundShare", { tokenShare, cost: formatUsd(cost, locale), when })
        : t("statistics.insight.backgroundShareTokens", { tokenShare, when });
    }
    case "priciestDay": {
      const day = textOf(values, "day");
      if (!DAY_PATTERN.test(day)) return null;
      const date = formatDay(day, locale, true);
      const cost = numberOf(values, "cost");
      return cost > 0
        ? t("statistics.insight.priciestDay", { day: date, cost: formatUsd(cost, locale), when })
        : t("statistics.insight.priciestDayTokens", { day: date, tokens: formatTokens(numberOf(values, "tokens"), locale), when });
    }
    case "unpriced":
      return tn("statistics.insight.unpriced", numberOf(values, "models"), { tokens: formatTokens(numberOf(values, "tokens"), locale) });
    default:
      return null;
  }
}

/** A few plain sentences about the period. Renders nothing when the server had nothing worth saying. */
export function Insights({ insights, period }: InsightsProps) {
  const { locale, t, tn } = useI18n();
  const voice: Voice = { locale, t, tn, when: periodWhen(period, t) };
  const rows: { id: Insight["id"]; text: string }[] = [];
  for (const insight of insights) {
    const text = sentenceOf(insight, voice);
    if (text !== null) rows.push({ id: insight.id, text });
    if (rows.length === MAX_INSIGHTS) break;
  }
  if (rows.length === 0) return null;

  return (
    <section className="stats-insights-root" aria-label={t("statistics.insight.label")}>
      <style>{CSS}</style>
      <ul className="stats-insights">
        {rows.map(({ id, text }) => {
          const Icon = ICONS[id];
          return (
            <li key={id} className="stats-insights-row">
              <Icon size={16} aria-hidden="true" />
              <span>{text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
