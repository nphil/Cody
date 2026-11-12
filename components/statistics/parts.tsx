"use client";

import { ModelIcon, ProviderIcon } from "@/components/ProviderIcon";
import { useI18n } from "@/lib/i18n";
import { BILLING_KEYS, costFigure, costText, formatCount, formatTokens } from "@/lib/statistics/present";
import type { BillingKind, StatNode } from "@/lib/statistics/types";

/** What a figure that does not exist (zero tokens, nothing ran) reads as. */
export const DASH = "\u2014";

/** The brand mark of a provider or model node. Every other kind of node, and the "Other" bucket, has none. */
export function NodeMark({ node, size = 16 }: { node: Pick<StatNode, "dim" | "key" | "provider" | "other">; size?: number }) {
  if (node.other) return null;
  if (node.dim === "provider") return <ProviderIcon provider={node.provider ?? node.key} size={size} />;
  if (node.dim === "model") return <ModelIcon provider={node.provider} modelId={node.key} size={size} />;
  return null;
}

/**
 * How a provider is paid for, in a few words. Real money (pay-as-you-go) is the
 * one that carries weight; plan estimates and unknown billing stay quiet, so a
 * glance down a table shows where actual charges can come from. The sentence
 * that explains it is the tooltip.
 */
export function BillingBadge({ kind }: { kind: BillingKind }) {
  const { t } = useI18n();
  const keys = BILLING_KEYS[kind];
  const real = kind === "payg";
  return (
    <span
      title={t(keys.note)}
      style={{
        flex: "none",
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 11,
        lineHeight: "16px",
        fontWeight: real ? 600 : 500,
        whiteSpace: "nowrap",
        color: real ? "var(--text)" : "var(--text-muted)",
        background: real ? "color-mix(in srgb, var(--accent) 16%, var(--bg-panel))" : "var(--bg-subtle)",
      }}
    >
      {t(keys.label)}
    </span>
  );
}

/** A token count in the locale's short form, the exact count in the tooltip, and a dash for none. */
export function TokenText({ value }: { value: number }) {
  const { locale } = useI18n();
  if (!(value > 0)) return <>{DASH}</>;
  return <span title={formatCount(value, locale)}>{formatTokens(value, locale)}</span>;
}

/**
 * A cost through the one honest path: "Price unknown" and "Local" are never
 * printed as $0, and a figure that is only a floor ("$4.20+") says so on hover.
 */
export function CostText({ node }: { node: Pick<StatNode, "cost" | "tokens" | "unpricedTokens"> }) {
  const { locale, t } = useI18n();
  const figure = costFigure(node);
  const text = costText(figure, locale, t);
  return figure.kind === "partial" ? <span title={t("statistics.detail.partialNote")}>{text}</span> : <>{text}</>;
}
