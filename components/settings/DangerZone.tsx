"use client";

/**
 * The red-bordered block at the foot of a hub for the actions that destroy
 * something: delete this account, uninstall an engine, restart every
 * session, remove a provider. One per hub, always last, so a destructive
 * control is never next to a routine one. Each row's `action` is the
 * caller's button; it opens a ConfirmDialog that names the object and the
 * consequence before anything happens.
 */
import type { ReactNode } from "react";

export interface DangerZoneRow {
  title: ReactNode;
  description?: ReactNode;
  action: ReactNode;
}

export function DangerZone({ rows, title = "Danger zone" }: { rows: readonly DangerZoneRow[]; title?: ReactNode }) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      style={{
        border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))",
        borderRadius: "var(--radius-card)",
        background: "color-mix(in srgb, var(--status-error) 4%, var(--bg-panel))",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <h4 style={{ margin: 0, padding: "10px 14px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--status-error)", borderBottom: "1px solid color-mix(in srgb, var(--status-error) 35%, var(--border))" }}>
        {title}
      </h4>
      {rows.map((row, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            flexWrap: "wrap",
            borderTop: index > 0 ? "1px solid color-mix(in srgb, var(--status-error) 25%, var(--border))" : undefined,
          }}
        >
          <div style={{ flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{row.title}</span>
            {row.description && <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{row.description}</span>}
          </div>
          <div style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>{row.action}</div>
        </div>
      ))}
    </section>
  );
}
