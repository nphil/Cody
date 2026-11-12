"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, type MouseEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { cacheHitRate, formatShare, nodeLabel, shareOf } from "@/lib/statistics/present";
import { childPaint, nodeValue, paintCss, pathId, rankChildren, resolveFocus, type Metric } from "@/lib/statistics/sunburst";
import { OTHER_KEY, type Dim, type StatNode } from "@/lib/statistics/types";
import { BillingBadge, CostText, DASH, NodeMark, TokenText } from "./parts";

type Path = readonly string[];

export interface StatsTableProps {
  tree: StatNode;
  path: Path;
  metric: Metric;
  selected: Path | null;
  hovered: Path | null;
  onHover: (path: string[] | null) => void;
  /** A row with something drawable below it zooms the circle into it. */
  onZoom: (path: string[]) => void;
  /** A row with nothing below it (or any row, on a phone) becomes the selected node. */
  onSelect: (path: string[] | null) => void;
  tapSelects: boolean;
}

/** The five token-split figures: columns of their own on a phone, one line under the row's name everywhere else. */
type SplitId = "input" | "output" | "cacheRead" | "cacheWrite" | "cacheHit";

interface Column {
  id: "cost" | "tokens" | "share" | SplitId;
  /** Pixels on a phone, where the table scrolls sideways. The name column has none: it takes whatever the figures leave. */
  width: number;
  label: string;
  /** The metric this column shows, so the one the page is sorted by reads as the lead. */
  lead?: Metric;
  /** One of the five token-split columns (see SplitId). */
  split?: true;
}

/** The figure columns, in the order their cells are drawn. */
const COLUMNS: readonly Column[] = [
  { id: "cost", width: 112, label: "statistics.estCost", lead: "cost" },
  { id: "tokens", width: 88, label: "statistics.tokens.total", lead: "tokens" },
  { id: "share", width: 136, label: "statistics.share" },
  { id: "input", width: 84, label: "statistics.tokens.input", split: true },
  { id: "output", width: 84, label: "statistics.tokens.output", split: true },
  { id: "cacheRead", width: 100, label: "statistics.tokens.cacheRead", split: true },
  { id: "cacheWrite", width: 100, label: "statistics.tokens.cacheWrite", split: true },
  { id: "cacheHit", width: 92, label: "statistics.tokens.cacheHit", split: true },
];
const FIGURES_WIDTH = COLUMNS.reduce((sum, column) => sum + column.width, 0);
const SPLIT_COLUMNS = COLUMNS.filter((column): column is Column & { id: SplitId } => column.split === true);
/** The columns left once the split ones fold away: the name and the figures that are not split. */
const LEAN_SPAN = 1 + COLUMNS.length - SPLIT_COLUMNS.length;
const COLUMN_WIDTHS = COLUMNS.map((column) => `.stats-table-grid col[data-col="${column.id}"] { width: ${column.width}px; }`).join("\n");

/** What the first column is called: the thing the rows are. */
const NAME_HEADER: Record<Dim, string> = {
  provider: "statistics.table.provider",
  model: "statistics.table.model",
  project: "statistics.table.project",
  chat: "statistics.table.chat",
  worker: "statistics.table.worker",
};

/**
 * Two layouts from one markup. On a phone (up to 640px, the app's mobile
 * breakpoint) every column stays and the table scrolls sideways, its first
 * column sticky so a row keeps its name while the figures scroll under it; its
 * divider is a plain 1px line, never a shadow. Anywhere wider it never scrolls
 * sideways: the five token-split columns fold into one muted line under each row
 * (a second table row, shown only there) and only the name, cost, tokens and
 * share stay columns. Every cell paints an opaque background (the row's own,
 * through --stats-table-bg), or the figures would show through the pinned column.
 */
const CSS = `
.stats-table { container-type: inline-size; min-width: 0; font-variant-numeric: tabular-nums; }
.stats-table-scroller {
  --stats-table-name: 232px;
  max-height: min(72vh, 620px);
  overflow: auto;
  overscroll-behavior-x: contain;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-panel);
}
@container (max-width: 640px) { .stats-table-scroller { --stats-table-name: 156px; } }
@container (max-width: 420px) { .stats-table-scroller { --stats-table-name: 132px; } }
.stats-table-grid {
  width: 100%;
  min-width: calc(var(--stats-table-name) + ${FIGURES_WIDTH}px);
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
  line-height: 18px;
}
${COLUMN_WIDTHS}
.stats-table-grid th,
.stats-table-grid td {
  height: 36px;
  padding: 0 10px;
  overflow: hidden;
  white-space: nowrap;
  vertical-align: middle;
  text-align: right;
  font-weight: 400;
  color: var(--text);
  background: var(--stats-table-bg, var(--bg-panel));
  border-bottom: 1px solid var(--border);
  transition: background-color var(--dur-fast) var(--ease-out-warm);
}
.stats-table-grid thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 40px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 15px;
}
.stats-table-grid thead th[data-lead="true"] { color: var(--text); font-weight: 600; }
.stats-table-grid .stats-table-name { position: sticky; left: 0; z-index: 1; text-align: left; font-weight: 500; border-right: 1px solid var(--border); }
.stats-table-grid thead .stats-table-name { z-index: 3; }
.stats-table-grid tbody:last-of-type .stats-table-main > * { border-bottom: 0; }
.stats-table-grid tfoot th,
.stats-table-grid tfoot td { position: sticky; bottom: 0; z-index: 2; border-top: 1px solid var(--border); border-bottom: 0; font-weight: 600; }
.stats-table-grid tfoot .stats-table-name { z-index: 3; }
.stats-table-row { --stats-table-bg: var(--bg-panel); cursor: pointer; }
.stats-table-row[data-hovered="true"] { --stats-table-bg: var(--bg-hover); }
.stats-table-row[data-selected="true"] { --stats-table-bg: var(--bg-selected); }
.stats-table-num { color: var(--text-muted); }
.stats-table-num[data-lead="true"] { color: var(--text); font-weight: 600; }
.stats-table-row[data-selected="true"] .stats-table-num { color: var(--text); }
.stats-table-total .stats-table-num { color: var(--text); }
.stats-table-namebox { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; min-width: 0; }
.stats-table-press {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: inherit;
}
.stats-table-swatch { flex: none; width: 10px; height: 10px; margin-right: 2px; border-radius: 3px; }
.stats-table-mark { flex: none; display: inline-flex; width: 16px; height: 16px; }
.stats-table-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-table-chev { flex: none; color: var(--text-muted); }
.stats-table-share { color: var(--text); }
.stats-table-sharebox { display: flex; align-items: center; gap: 8px; }
.stats-table-bar { flex: 1 1 auto; min-width: 20px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--text-muted) 18%, transparent); }
.stats-table-bar > span { display: block; height: 100%; border-radius: inherit; }
.stats-table-pct { flex: none; width: 44px; text-align: right; }
.stats-table-note,
.stats-table-empty { margin: 8px 2px 0; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-table-empty { margin: 0; padding: 14px 2px; font-size: 13px; }
.stats-table-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.stats-table-sub { display: none; }
.stats-table-split { display: flex; flex-wrap: wrap; gap: 0 16px; margin: 0; }
.stats-table-split > div { display: inline-flex; gap: 5px; white-space: nowrap; }
.stats-table-split dt { color: var(--text-muted); }
.stats-table-split dd { margin: 0; color: var(--text); }
@media (pointer: coarse) {
  .stats-table-grid th, .stats-table-grid td { height: 44px; }
  .stats-table-press { min-height: 40px; }
}
@media (min-width: 641px) {
  .stats-table-scroller { max-height: none; }
  .stats-table-grid { min-width: 0; }
  .stats-table-grid [data-split] { display: none; }
  .stats-table-grid col[data-col="cost"] { width: 92px; }
  .stats-table-grid col[data-col="tokens"] { width: 76px; }
  .stats-table-grid col[data-col="share"] { width: 132px; }
  .stats-table-grid .stats-table-name { border-right: 0; }
  .stats-table-grid tfoot th,
  .stats-table-grid tfoot td { position: static; }
  .stats-table-grid .stats-table-main > * { height: 32px; padding-top: 0; padding-bottom: 0; border-bottom: 0; }
  .stats-table-sub { display: table-row; }
  .stats-table-grid .stats-table-sub > * {
    height: auto;
    padding: 0 10px 8px 28px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    font-weight: 400;
    line-height: 18px;
    text-align: left;
    white-space: normal;
  }
  .stats-table-grid tbody:last-of-type .stats-table-sub > *,
  .stats-table-grid tfoot .stats-table-sub > * { border-bottom: 0; }
  .stats-table-grid tfoot .stats-table-sub > * { border-top: 0; }
  @container (max-width: 560px) {
    .stats-table-grid col[data-col="cost"] { width: 80px; }
    .stats-table-grid col[data-col="tokens"] { width: 68px; }
    .stats-table-grid col[data-col="share"] { width: 96px; }
    .stats-table-split { gap: 0 14px; }
  }
  @container (max-width: 440px) {
    .stats-table-grid col[data-col="cost"] { width: 76px; }
    .stats-table-grid col[data-col="tokens"] { width: 64px; }
    .stats-table-grid col[data-col="share"] { width: 56px; }
    .stats-table-bar { display: none; }
    .stats-table-sharebox { justify-content: flex-end; }
    .stats-table-pct { width: auto; }
    .stats-table-split { gap: 0 12px; }
  }
}
@media (min-width: 641px) and (pointer: coarse) {
  .stats-table-grid .stats-table-main > * { height: 40px; }
}
`;

interface FigureCellsProps {
  node: StatNode;
  metric: Metric;
  /** The node's share of the focus under the metric (0 draws a dash); null leaves the cell empty, as on the total row. */
  share: number | null;
  /** The node's colour, for the share bar. */
  paint: string;
}

/** One of the five token-split figures of a node: a count, or for the hit rate a share. */
function SplitFigure({ node, id }: { node: StatNode; id: SplitId }) {
  const { locale } = useI18n();
  if (id === "cacheHit") {
    const hit = cacheHitRate(node);
    return <>{hit === null ? DASH : formatShare(hit, locale)}</>;
  }
  return <TokenText value={node[id]} />;
}

/** The figure cells of one row. The cost goes through the honest path, so no unpriced row ever reads $0. */
function FigureCells({ node, metric, share, paint }: FigureCellsProps) {
  const { locale } = useI18n();
  return (
    <>
      <td className="stats-table-num" data-lead={metric === "cost" ? "true" : undefined}>
        <CostText node={node} />
      </td>
      <td className="stats-table-num" data-lead={metric === "tokens" ? "true" : undefined}>
        <TokenText value={node.tokens} />
      </td>
      <td className="stats-table-share">
        {share !== null && share > 0 && (
          <span className="stats-table-sharebox">
            <span className="stats-table-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, share * 100)}%`, background: paint }} />
            </span>
            <span className="stats-table-pct">{formatShare(share, locale)}</span>
          </span>
        )}
        {share === 0 && DASH}
      </td>
      {SPLIT_COLUMNS.map((column) => (
        <td key={column.id} className="stats-table-num" data-split="true">
          <SplitFigure node={node} id={column.id} />
        </td>
      ))}
    </>
  );
}

/** The token split of one row as a line of its own: the layouts wider than a phone have no room for five more columns. */
function SplitLine({ node }: { node: StatNode }) {
  const { t } = useI18n();
  return (
    <tr className="stats-table-sub">
      <td colSpan={LEAN_SPAN}>
        <dl className="stats-table-split">
          {SPLIT_COLUMNS.map((column) => (
            <div key={column.id}>
              <dt>{t(column.label)}</dt>
              <dd>
                <SplitFigure node={node} id={column.id} />
              </dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  );
}

/** The ring below the focus as a table: the same rows, order and colours as the chart, with every figure the chart cannot fit. */
export function StatsTable({ tree, path, metric, selected, hovered, onHover, onZoom, onSelect, tapSelects }: StatsTableProps) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const focus = resolveFocus(tree, path);
  const focusNode = focus.node;
  const focusId = pathId(focus.path);

  // Each row remembers its place in the server's order: that index, not the ranked one, decides its colour.
  const order = new Map((focusNode.children ?? []).map((child, index) => [child, index] as const));
  const ranked = rankChildren(focusNode, metric).map((node) => ({ node, index: order.get(node) ?? 0 }));

  // A new list starts at its top, whatever the old one had scrolled to.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [focusId]);

  const selectedId = selected ? pathId(selected) : null;
  const focusTotal = nodeValue(focusNode, metric);
  const hasUnpriced = metric === "cost" && ranked.some(({ node }) => node.cost <= 0 && node.tokens > 0);
  const first = ranked[0]?.node.dim;
  const nameHeader = first === undefined || first === "root" ? "statistics.table.name" : NAME_HEADER[first];

  const press = (event: MouseEvent, rowPath: string[], drillable: boolean) => {
    if (tapSelects || !drillable) {
      onSelect(rowPath);
      return;
    }
    onZoom(rowPath);
    // The pressed row is about to be replaced by its children. A keyboard press (a click with no count) would lose its place with it, so the table itself takes the focus.
    if (event.detail === 0) scroller.current?.focus({ preventScroll: true });
  };

  if (ranked.length === 0) {
    return (
      <div className="stats-table">
        <style>{CSS}</style>
        <p className="stats-table-empty">{t(focus.path.length === 0 ? "statistics.table.empty" : "statistics.table.leaf")}</p>
      </div>
    );
  }

  return (
    <div className="stats-table">
      <style>{CSS}</style>
      <div ref={scroller} className="stats-table-scroller ui-focus-ring" role="region" tabIndex={0} aria-label={t("statistics.table.region")}>
        <table className="stats-table-grid">
          <caption className="stats-table-sr">
            {t("statistics.table.caption", {
              scope: focus.path.length === 0 ? t("statistics.table.allUsage") : nodeLabel(focusNode, t),
              order: t(metric === "cost" ? "statistics.table.byCost" : "statistics.table.byTokens"),
            })}
          </caption>
          <colgroup>
            <col />
            {COLUMNS.map((column) => (
              <col key={column.id} data-col={column.id} data-split={column.split ? "true" : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="stats-table-name">
                {t(nameHeader)}
              </th>
              {COLUMNS.map((column) => {
                const lead = column.lead === metric;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    data-lead={lead ? "true" : undefined}
                    data-split={column.split ? "true" : undefined}
                    aria-sort={lead ? "descending" : undefined}
                    title={t(column.label)}
                  >
                    {t(column.label)}
                  </th>
                );
              })}
            </tr>
          </thead>
          {ranked.map(({ node, index }) => {
            const rowPath = [...focus.path, node.key];
            // Drawable means the chart would draw something below it: only then does a press zoom.
            const drillable = node.children?.some((child) => nodeValue(child, metric) > 0) ?? false;
            // The cursor is on this row, or on an arc inside it: that arc's whole branch lights its row.
            const lit = hovered !== null && hovered.length >= rowPath.length && rowPath.every((key, at) => hovered[at] === key);
            const label = nodeLabel(node, t);
            const paint = paintCss(childPaint(tree, focus.path, index, node.key === OTHER_KEY || Boolean(node.other)));
            const isSelected = selectedId !== null && pathId(rowPath) === selectedId;
            // One body per row, so the name line and its token-split line light, press and hover as one.
            return (
              <tbody
                key={node.key}
                className="stats-table-row"
                data-selected={isSelected ? "true" : undefined}
                data-hovered={lit ? "true" : undefined}
                onClick={(event) => press(event, rowPath, drillable)}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") onHover(rowPath);
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType !== "touch") onHover(null);
                }}
              >
                <tr className="stats-table-main">
                  <th scope="row" className="stats-table-name">
                    <div className="stats-table-namebox">
                      <button
                        type="button"
                        className="stats-table-press ui-focus-ring"
                        title={node.detail || label}
                        aria-current={isSelected ? "true" : undefined}
                        onFocus={() => onHover(rowPath)}
                        onBlur={() => onHover(null)}
                      >
                        <span className="stats-table-swatch" style={{ background: paint }} aria-hidden="true" />
                        {(node.dim === "provider" || node.dim === "model") && (
                          <span className="stats-table-mark">
                            <NodeMark node={node} size={16} />
                          </span>
                        )}
                        <span className="stats-table-label">{label}</span>
                        {!tapSelects && drillable && <ChevronRight size={14} aria-hidden="true" className="stats-table-chev" />}
                      </button>
                      {node.dim === "provider" && node.billing !== undefined && <BillingBadge kind={node.billing} />}
                    </div>
                  </th>
                  <FigureCells node={node} metric={metric} share={shareOf(nodeValue(node, metric), focusTotal)} paint={paint} />
                </tr>
                <SplitLine node={node} />
              </tbody>
            );
          })}
          <tfoot>
            <tr className="stats-table-total stats-table-main">
              <th scope="row" className="stats-table-name">
                {t("statistics.table.total")}
              </th>
              <FigureCells node={focusNode} metric={metric} share={null} paint="" />
            </tr>
            <SplitLine node={focusNode} />
          </tfoot>
        </table>
      </div>
      {hasUnpriced && <p className="stats-table-note">{t("statistics.table.unpricedNote")}</p>}
    </div>
  );
}
