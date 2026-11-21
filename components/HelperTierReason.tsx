"use client";

import { Scale } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TierNote } from "@/lib/helper-tier";

/**
 * The one calm line saying why a helper runs on an expensive tier: the reason
 * the parent gave in the assignment, or "no reason given" in a muted warning
 * colour. Shared by the roster chip (one line, ellipsis) and the top of the
 * helper window (may wrap). Renders nothing for a cheap helper.
 */
export function HelperTierReason({ note, wrap = false }: { note: TierNote | null; wrap?: boolean }) {
  const { t } = useI18n();
  if (!note) return null;
  const missing = note.kind === "missing";
  const text = missing ? t("helperTier.noReason") : t("helperTier.why", { reason: note.reason });
  return (
    <span
      data-helper-tier={note.kind}
      title={text}
      style={{
        display: "flex",
        alignItems: wrap ? "flex-start" : "center",
        gap: 4,
        minWidth: 0,
        width: "100%",
        fontSize: 10.5,
        lineHeight: 1.4,
        textAlign: "left",
        color: missing ? "color-mix(in srgb, var(--status-warning) 82%, var(--text-dim))" : "var(--text-dim)",
      }}
    >
      <Scale size={11} strokeWidth={1.8} aria-hidden style={{ flexShrink: 0, marginTop: wrap ? 2 : 0 }} />
      <span style={wrap ? { minWidth: 0, overflowWrap: "anywhere" } : { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {text}
      </span>
    </span>
  );
}
