"use client";

import { useI18n } from "@/lib/i18n";
import { formatTokens } from "@/lib/statistics/present";
import { nodeValue, type Metric, type SunburstFocus } from "@/lib/statistics/sunburst";
import type { Dim, StatNode } from "@/lib/statistics/types";
import { Breadcrumb } from "./Breadcrumb";
import { Sunburst } from "./Sunburst";

const DIM_KEYS: Record<Dim, string> = {
  provider: "statistics.dim.provider",
  model: "statistics.dim.model",
  project: "statistics.dim.project",
  chat: "statistics.dim.chat",
  worker: "statistics.dim.worker",
};

export interface ChartSectionProps {
  tree: StatNode;
  /** The zoom focus, already cut back to what the tree still has. */
  focus: SunburstFocus;
  /** The ring order of `tree` (StatisticsResponse.dims). */
  dims: Dim[];
  metric: Metric;
  selected: string[] | null;
  hovered: string[] | null;
  onHover: (path: string[] | null) => void;
  onZoom: (path: string[]) => void;
  onSelect: (path: string[] | null) => void;
  tapSelects: boolean;
  onShowTokens: () => void;
}

/**
 * The circle with the trail that leads out of it, and the two honest remarks
 * that belong to it: what the rings mean from here inwards, and how much of
 * what is drawn left out unpriced tokens.
 */
export function ChartSection({ tree, focus, dims, metric, selected, hovered, onHover, onZoom, onSelect, tapSelects, onShowTokens }: ChartSectionProps) {
  const { locale, t } = useI18n();
  const value = nodeValue(focus.node, metric);
  const rings = dims
    .slice(focus.path.length)
    .map((dim) => t(DIM_KEYS[dim]))
    .join(" › ");
  // Only a drawn cost can have a part missing from it; a chart with no cost at all says so instead.
  const unpriced = metric === "cost" && value > 0 ? focus.node.unpricedTokens : 0;
  const onlyUnpriced = metric === "cost" && value <= 0 && focus.node.tokens > 0;

  return (
    <div className="stats-chart">
      <Breadcrumb trail={focus.trail} onNavigate={(depth) => onZoom(focus.path.slice(0, depth))} />
      {value > 0 ? (
        <Sunburst
          tree={tree}
          path={focus.path}
          metric={metric}
          selected={selected}
          hovered={hovered}
          onHover={onHover}
          onZoom={onZoom}
          onSelect={onSelect}
          tapSelects={tapSelects}
        />
      ) : (
        <div className="stats-chart-empty">
          <p className="stats-chart-empty-title display-serif">{onlyUnpriced ? t("statistics.page.chartEmptyPricedTitle") : t("statistics.page.chartEmptyTitle")}</p>
          <p className="stats-chart-empty-text">{onlyUnpriced ? t("statistics.page.chartEmptyPricedText") : t("statistics.page.chartEmptyText")}</p>
          {onlyUnpriced && (
            <button type="button" className="stats-btn ui-focus-ring" onClick={onShowTokens}>
              {t("statistics.page.showTokens")}
            </button>
          )}
        </div>
      )}
      {rings !== "" && <p className="stats-chart-rings">{t("statistics.page.ringOrder", { order: rings })}</p>}
      {unpriced > 0 && (
        <p className="stats-chart-note">
          <span>{t("statistics.page.unpricedNote", { tokens: formatTokens(unpriced, locale) })}</span>
          <button type="button" className="stats-btn ui-focus-ring" data-quiet="true" onClick={onShowTokens}>
            {t("statistics.page.showTokens")}
          </button>
        </p>
      )}
    </div>
  );
}
