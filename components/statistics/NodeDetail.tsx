"use client";

import { ZoomIn } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { BILLING_KEYS, cacheHitRate, costFigure, formatCount, formatShare, nodeLabel, shareOf } from "@/lib/statistics/present";
import { nodeValue, type Metric } from "@/lib/statistics/sunburst";
import type { StatNode } from "@/lib/statistics/types";
import { BillingBadge, CostText, DASH, NodeMark, TokenText } from "./parts";

export interface NodeDetailProps {
  node: StatNode;
  /** The node the circle is zoomed into: the whole that `node`'s share is taken of. */
  focusNode: StatNode;
  metric: Metric;
  canZoom: boolean;
  onZoom: () => void;
}

/** No chrome of its own: it is the body of the phone sheet and sits in a card on wide screens, and both bring their own frame. */
const CSS = `
.stats-detail { display: flex; flex-direction: column; gap: 14px; min-width: 0; font-variant-numeric: tabular-nums; }
.stats-detail-head { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.stats-detail-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.stats-detail-title svg { flex: none; }
.stats-detail-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--text-muted); overflow-wrap: anywhere; }
.stats-detail-path { font-family: var(--font-mono); }
.stats-detail-lead { display: flex; flex-direction: column; gap: 2px; }
.stats-detail-value { margin: 0; font-size: 28px; line-height: 36px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); overflow-wrap: anywhere; }
.stats-detail-value[data-text="true"] { font-size: 20px; line-height: 28px; }
.stats-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin: 0; padding-top: 14px; border-top: 1px solid var(--border); }
.stats-detail-grid dt { margin: 0; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-detail-grid dd { margin: 0; font-size: 15px; line-height: 22px; font-weight: 500; color: var(--text); overflow-wrap: anywhere; }
.stats-detail-zoom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 18px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--accent-strong);
  color: var(--on-accent);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out-warm);
}
.stats-detail-zoom:hover { background: var(--accent-hover); }
.stats-detail-zoom:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
`;

/** One node of the ring tree in words and figures: what it is, how it is billed, what it cost and how its tokens split. */
export function NodeDetail({ node, focusNode, metric, canZoom, onZoom }: NodeDetailProps) {
  const { locale, t } = useI18n();
  const label = node.dim === "root" ? t("statistics.table.allUsage") : nodeLabel(node, t);
  const figure = costFigure(node);
  const hit = cacheHitRate(node);
  const value = nodeValue(node, metric);
  const focusValue = nodeValue(focusNode, metric);
  // A share only means something for a node inside the focus; a selection left outside it after a zoom has none.
  const share = node !== focusNode && node.dim !== "root" && value > 0 && value <= focusValue ? shareOf(value, focusValue) : null;
  const billing = node.dim === "provider" ? node.billing : undefined;

  return (
    <div className="stats-detail">
      <style>{CSS}</style>
      <div className="stats-detail-head">
        <h3 className="stats-detail-title">
          <NodeMark node={node} size={18} />
          <span>{label}</span>
        </h3>
        {billing !== undefined && (
          <>
            <BillingBadge kind={billing} />
            <p className="stats-detail-note">{t(BILLING_KEYS[billing].note)}</p>
          </>
        )}
        {node.detail && node.detail !== label && <p className="stats-detail-note stats-detail-path">{node.detail}</p>}
      </div>

      <div className="stats-detail-lead">
        <p className="stats-detail-value" data-text={metric === "cost" && figure.kind !== "priced" && figure.kind !== "partial" ? "true" : undefined}>
          {metric === "cost" ? <CostText node={node} /> : <TokenText value={node.tokens} />}
        </p>
        {share !== null && (
          <p className="stats-detail-note">
            {focusNode.dim === "root"
              ? t("statistics.detail.shareOfAll", { share: formatShare(share, locale) })
              : t("statistics.detail.shareOf", { share: formatShare(share, locale), name: nodeLabel(focusNode, t) })}
          </p>
        )}
        {figure.kind === "partial" && <p className="stats-detail-note">{t("statistics.detail.partialNote")}</p>}
      </div>

      <dl className="stats-detail-grid">
        <div>
          <dt>{t("statistics.estCost")}</dt>
          <dd>
            <CostText node={node} />
          </dd>
        </div>
        <div>
          <dt>{t("statistics.tokens.total")}</dt>
          <dd>
            <TokenText value={node.tokens} />
          </dd>
        </div>
        <div>
          <dt>{t("statistics.tokens.input")}</dt>
          <dd>
            <TokenText value={node.input} />
          </dd>
        </div>
        <div>
          <dt>{t("statistics.tokens.output")}</dt>
          <dd>
            <TokenText value={node.output} />
          </dd>
        </div>
        <div>
          <dt>{t("statistics.tokens.cacheRead")}</dt>
          <dd>
            <TokenText value={node.cacheRead} />
          </dd>
        </div>
        <div>
          <dt>{t("statistics.tokens.cacheWrite")}</dt>
          <dd>
            <TokenText value={node.cacheWrite} />
          </dd>
        </div>
        <div>
          <dt>{t("statistics.tokens.cacheHit")}</dt>
          <dd>{hit === null ? DASH : formatShare(hit, locale)}</dd>
        </div>
        <div>
          <dt>{t("statistics.detail.messages")}</dt>
          <dd>{formatCount(node.messages, locale)}</dd>
        </div>
      </dl>

      {canZoom && (
        <button type="button" className="stats-detail-zoom" onClick={onZoom}>
          <ZoomIn size={16} aria-hidden="true" />
          {t("statistics.detail.zoomIn")}
        </button>
      )}
    </div>
  );
}
