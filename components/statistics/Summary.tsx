"use client";

import { TrendingDown, TrendingUp, TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  compareLabel,
  costFigure,
  costText,
  deltaOf,
  formatCount,
  formatDelta,
  formatShare,
  formatTokens,
  formatUsd,
  type Translate,
} from "@/lib/statistics/present";
import type { PeriodTotals, StatisticsResponse } from "@/lib/statistics/types";

export interface SummaryProps {
  /** Null until the first answer arrives: a skeleton with the same shape shows instead. */
  data: StatisticsResponse | null;
  /** A newer answer is on its way; the figures on screen stay, a little dimmed. */
  loading: boolean;
}

/** Spend up by half or more against the period before gets a warning mark. Smaller moves are told plainly, never as good or bad news. */
const SPEND_ALERT_RATIO = 0.5;
/** Under half a cent a difference is rounding, not a second kind of money. */
const CENT_EPSILON = 0.005;

/** Bar widths (px) of the skeleton's label, figure and detail line, one row per cell. */
const SKELETON_CELLS: readonly (readonly [number, number, number])[] = [
  [68, 116, 156],
  [52, 88, 124],
  [44, 56, 132],
];

const CSS = `
.stats-summary { container-type: inline-size; width: 100%; font-variant-numeric: tabular-nums; }
.stats-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-panel);
  transition: opacity var(--dur-med) var(--ease-out-warm);
}
.stats-summary[data-busy="true"] .stats-summary-grid { opacity: 0.6; }
.stats-summary-cell { min-width: 0; min-height: 96px; padding: 14px 18px 16px; }
.stats-summary-cell + .stats-summary-cell { border-left: 1px solid var(--border); }
@container (max-width: 559px) {
  .stats-summary-grid { grid-template-columns: minmax(0, 1fr); }
  .stats-summary-cell { min-height: 0; }
  .stats-summary-cell + .stats-summary-cell { border-left: 0; border-top: 1px solid var(--border); }
}
.stats-summary dt { margin: 0; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-summary dd { margin: 0; }
.stats-summary-figure { font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); overflow-wrap: anywhere; }
.stats-summary-figure[data-text="true"] { font-size: 18px; }
.stats-summary-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; font-size: 12px; line-height: 18px; color: var(--text-muted); overflow-wrap: anywhere; }
.stats-summary-change { font-weight: 600; color: var(--text); }
.stats-summary-alert { color: var(--status-warning); }
.stats-summary-warn { display: flex; align-items: flex-start; gap: 6px; margin-top: 6px; font-size: 12px; line-height: 16px; color: var(--text); overflow-wrap: anywhere; }
.stats-summary-warn svg { flex: none; margin-top: 1px; color: var(--status-warning); }
.stats-summary-sk { display: block; border-radius: 6px; }
.stats-summary-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
`;

interface DeltaLineProps {
  current: number;
  previous: number;
  versus: string;
  /** Spend is the one figure whose steep rise earns a warning mark. */
  spend?: boolean;
}

/** "+18% vs last week". Nothing at all when neither period had anything to compare. */
function DeltaLine({ current, previous, versus, spend = false }: DeltaLineProps) {
  const { locale, t } = useI18n();
  const delta = deltaOf(current, previous);
  const text = formatDelta(delta, locale, t);
  if (text === null) return null;
  const Icon = delta.kind === "up" ? TrendingUp : delta.kind === "down" ? TrendingDown : null;
  const alarming = spend && delta.kind === "up" && delta.ratio >= SPEND_ALERT_RATIO;
  return (
    <dd className="stats-summary-meta">
      {Icon && <Icon size={14} aria-hidden="true" className={alarming ? "stats-summary-alert" : undefined} />}
      <span className="stats-summary-change">{text}</span>
      <span>{versus}</span>
    </dd>
  );
}

/** The one honest sentence about what the cost figure is: real money, a plan estimate, or both. Null when nothing was priced. */
function costBasis(totals: PeriodTotals, locale: string, t: Translate): string | null {
  if (!(totals.cost > 0)) return null;
  const payg = Math.min(totals.paygCost, totals.cost);
  if (payg <= 0) return t("statistics.summary.planEstimate");
  const rest = totals.cost - payg;
  if (rest < CENT_EPSILON) return t("statistics.summary.realMoney");
  return t("statistics.summary.mixed", { payg: formatUsd(payg, locale), rest: formatUsd(rest, locale) });
}

export function Summary({ data, loading }: SummaryProps) {
  const { locale, t, tn } = useI18n();

  if (data === null) {
    return (
      <section className="stats-summary" aria-busy="true">
        <style>{CSS}</style>
        <span className="stats-summary-sr" role="status">
          {t("statistics.summary.loading")}
        </span>
        <div className="stats-summary-grid" aria-hidden="true">
          {SKELETON_CELLS.map(([label, figure, detail]) => (
            <div key={label} className="stats-summary-cell">
              <span className="skeleton stats-summary-sk" style={{ width: label, height: 12, margin: "3px 0" }} />
              <span className="skeleton stats-summary-sk" style={{ width: figure, height: 26, margin: "3px 0" }} />
              <span className="skeleton stats-summary-sk" style={{ width: detail, height: 12, margin: "3px 0" }} />
              <span className="skeleton stats-summary-sk" style={{ width: detail - 28, height: 12, margin: "3px 0" }} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const { totals, previousTotals, period } = data;
  const versus = compareLabel(period, tn, t);
  const figure = costFigure(totals);
  const basis = costBasis(totals, locale, t);
  const unpricedModels = data.unpricedModels.join(", ");
  const hitRate = totals.cacheHitRate;

  return (
    <section className="stats-summary" aria-label={t("statistics.summary.label")} aria-busy={loading} data-busy={loading ? "true" : undefined}>
      <style>{CSS}</style>
      <dl className="stats-summary-grid">
        <div className="stats-summary-cell">
          <dt>{t("statistics.estCost")}</dt>
          <dd className="stats-summary-figure" data-text={figure.kind === "priced" || figure.kind === "partial" ? undefined : "true"}>
            {costText(figure, locale, t)}
          </dd>
          <DeltaLine current={totals.cost} previous={previousTotals.cost} versus={versus} spend />
          {basis !== null && <dd className="stats-summary-meta">{basis}</dd>}
          {totals.unpricedTokens > 0 && (
            <dd className="stats-summary-warn" title={unpricedModels || undefined}>
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                {tn("statistics.summary.unpriced", totals.unpricedTokens, { amount: formatTokens(totals.unpricedTokens, locale) })}
                {unpricedModels !== "" && <span className="stats-summary-sr"> ({unpricedModels})</span>}
              </span>
            </dd>
          )}
        </div>
        <div className="stats-summary-cell">
          <dt>{t("statistics.tokens.total")}</dt>
          <dd className="stats-summary-figure" title={formatCount(totals.tokens, locale)}>
            {formatTokens(totals.tokens, locale)}
          </dd>
          <DeltaLine current={totals.tokens} previous={previousTotals.tokens} versus={versus} />
          {hitRate !== null && (
            <dd className="stats-summary-meta" title={t("statistics.summary.cacheHitHint")}>
              {t("statistics.summary.cacheHit", { rate: formatShare(hitRate, locale) })}
            </dd>
          )}
        </div>
        <div className="stats-summary-cell">
          <dt>{t("statistics.summary.chats")}</dt>
          <dd className="stats-summary-figure">{formatCount(totals.chats, locale)}</dd>
          <DeltaLine current={totals.chats} previous={previousTotals.chats} versus={versus} />
          <dd className="stats-summary-meta">{tn("statistics.messages", totals.messages)}</dd>
        </div>
      </dl>
    </section>
  );
}
