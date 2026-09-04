"use client";

/**
 * The strip atop the catalog when the engine's registry has models the
 * user has never been shown (`/api/models/new`, the seen ledger). It names
 * the count and when the catalog was last looked at, filters the list down
 * to the new rows, and lets an administrator record the look ("Mark all as
 * seen") — the ledger is instance state, so a member cannot silence the
 * notice for everyone.
 */
import { Sparkles } from "lucide-react";

const buttonStyle = {
  padding: "5px 10px",
  minHeight: 30,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
};

function formatSeenAt(seenAt: string | null): string | null {
  if (!seenAt) return null;
  const date = new Date(seenAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function NewModelsNotice({ count, seenAt, isAdmin, showingNew, busy, onShowNew, onMarkSeen }: {
  count: number;
  seenAt: string | null;
  isAdmin: boolean;
  /** The New chip is already the active filter. */
  showingNew: boolean;
  busy: boolean;
  onShowNew: () => void;
  onMarkSeen: () => void;
}) {
  if (count === 0) return null;
  const since = formatSeenAt(seenAt);
  return (
    <div
      role="status"
      data-search-id="new-models"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "10px 12px",
        borderRadius: "var(--radius-card)",
        border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
        background: "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))",
      }}
    >
      <Sparkles size={15} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
      <span style={{ flex: "1 1 200px", minWidth: 0, fontSize: 12.5, color: "var(--text)", lineHeight: 1.45 }}>
        <strong>{count} new model{count === 1 ? "" : "s"}</strong>
        <span style={{ color: "var(--text-muted)" }}>{since ? ` since ${since}` : " since you last looked"}</span>
      </span>
      <span style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>
        {!showingNew && (
          <button type="button" onClick={onShowNew} style={buttonStyle}>Show new</button>
        )}
        {isAdmin && (
          <button type="button" onClick={onMarkSeen} disabled={busy} style={{ ...buttonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer" }}>Mark all as seen</button>
        )}
      </span>
    </div>
  );
}
