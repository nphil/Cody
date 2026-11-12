"use client";

import { ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { nodeLabel } from "@/lib/statistics/present";
import type { StatNode } from "@/lib/statistics/types";

export interface BreadcrumbProps {
  /** The nodes from the whole tree down to the one the circle is zoomed into (`resolveFocus(...).trail`). */
  trail: StatNode[];
  /** `depth` is how many keys of the path to keep: 0 zooms all the way out. */
  onNavigate: (depth: number) => void;
}

/** Where the circle is zoomed to, as a trail that doubles as the way back out. */
export function Breadcrumb({ trail, onNavigate }: BreadcrumbProps) {
  const { t } = useI18n();
  return (
    <nav className="stats-crumb" aria-label={t("statistics.page.breadcrumb")}>
      <ol className="stats-crumb-list">
        {trail.map((node, depth) => {
          const label = depth === 0 ? t("statistics.page.allUsage") : nodeLabel(node, t);
          const last = depth === trail.length - 1;
          return (
            <li key={`${depth}:${node.key}`} className="stats-crumb-item">
              {depth > 0 && <ChevronRight size={14} className="stats-crumb-sep" aria-hidden="true" />}
              {last ? (
                <span className="stats-crumb-current" aria-current="location" title={label}>
                  {label}
                </span>
              ) : (
                <button type="button" className="stats-crumb-link ui-focus-ring" title={label} onClick={() => onNavigate(depth)}>
                  {label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
