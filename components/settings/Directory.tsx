"use client";

/**
 * The list primitive every hub's directory renders through: Providers'
 * Connected / Discovered lists, Extensions' MCP servers, System's engine
 * roster. A row is one thing with a title, an optional subtitle and status,
 * an optional trailing slot, and either an `onOpen` (the whole row is a
 * button that pushes a detail view) or an `actions` slot of its own buttons.
 * Rows are at least 44px so they are targets on a phone without a second
 * layout.
 */
import { ChevronRight } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

export interface DirectoryStatus {
  tone: "ok" | "warn" | "muted" | "accent";
  text: string;
}

export interface DirectoryRow {
  id: string;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: DirectoryStatus;
  /** Right-aligned slot before the chevron: a count, a chip, a switch. */
  trailing?: ReactNode;
  /** Makes the row itself the control (chevron, Enter / Space). */
  onOpen?: () => void;
  /** Row-level buttons; use when the row has no single "open". */
  actions?: ReactNode;
}

export interface DirectorySection {
  id: string;
  title?: ReactNode;
  rows: readonly DirectoryRow[];
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
}

const TONE_COLOR: Record<DirectoryStatus["tone"], string> = {
  ok: "var(--status-success)",
  warn: "var(--status-warning)",
  muted: "var(--text-dim)",
  accent: "var(--accent)",
};

function RowBody({ row }: { row: DirectoryRow }) {
  return (
    <>
      {row.icon && <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, flexShrink: 0, color: "var(--text-muted)" }}>{row.icon}</span>}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</span>
        {(row.subtitle || row.status) && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {row.status && <span style={{ color: TONE_COLOR[row.status.tone], fontWeight: 500 }}>{row.status.text}</span>}
            {row.status && row.subtitle && <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span>}
            {row.subtitle && <span>{row.subtitle}</span>}
          </span>
        )}
      </span>
      {row.trailing && <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>{row.trailing}</span>}
    </>
  );
}

function onRowKey(event: KeyboardEvent<HTMLDivElement>, open: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    open();
  }
}

const rowBase = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minHeight: 44,
  padding: "8px 12px",
  background: "var(--bg-panel)",
  color: "var(--text)",
  textAlign: "left" as const,
  width: "100%",
  boxSizing: "border-box" as const,
} as const;

export function Directory({ sections, ariaLabel }: { sections: readonly DirectorySection[]; ariaLabel?: string }) {
  return (
    <div aria-label={ariaLabel} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      {sections.map((section) => (
        <section key={section.id} aria-label={typeof section.title === "string" ? section.title : undefined} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          {section.title && <h4 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>{section.title}</h4>}
          {section.rows.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "10px 12px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)" }}>{section.empty ?? "Nothing here yet."}</div>
          ) : (
            <div role="list" style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
              {section.rows.map((row, index) => {
                const divider = index > 0 ? { borderTop: "1px solid var(--border)" } : {};
                if (row.onOpen) {
                  return (
                    <div
                      key={row.id}
                      role="listitem"
                      tabIndex={0}
                      className="settings-directory-row ui-focus-ring"
                      data-directory-row={row.id}
                      onClick={row.onOpen}
                      onKeyDown={(event) => onRowKey(event, row.onOpen!)}
                      style={{ ...rowBase, ...divider, cursor: "pointer" }}
                    >
                      <RowBody row={row} />
                      <ChevronRight size={14} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
                    </div>
                  );
                }
                return (
                  <div key={row.id} role="listitem" data-directory-row={row.id} style={{ ...rowBase, ...divider }}>
                    <RowBody row={row} />
                    {row.actions && <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>{row.actions}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
