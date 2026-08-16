"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

/**
 * Shared building blocks for the settings dialog. Cody's curated panels and the
 * schema-driven OMP panel both render through these, so a setting looks and
 * behaves the same whether Cody hand-wrote its control or read it out of OMP's
 * schema.
 */

export const nativeSelectStyle = {
  minHeight: 32,
  padding: "4px 28px 4px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
  appearance: "none" as const,
  WebkitAppearance: "none" as const,
  MozAppearance: "none" as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat" as const,
  backgroundPosition: "right 8px center" as const,
  outline: "none",
  colorScheme: "dark light",
} as const;

export const nativeOptionStyle = {
  background: "var(--bg-panel)",
  color: "var(--text)",
} as const;

export const nativeInputStyle = {
  minHeight: 32,
  padding: "4px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
} as const;

export const chipStyle = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  fontWeight: 500,
} as const;

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The search result the dialog wants scrolled to and outlined, or null. */
export const SettingsHighlightContext = createContext<string | null>(null);

export function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        background: checked ? "var(--accent)" : "var(--border)",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background var(--dur-fast)",
        padding: 2,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#fff",
          transform: checked ? "translateX(16px)" : "translateX(0px)",
          transition: "transform var(--dur-fast)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

export function NativeSetting({ label, description, scope, badge, searchId, control, children }: {
  label: string;
  description: string;
  /** Where the value lives when it is not the harness's own config file. The
   * common case carries no chip: badging the majority is noise. */
  scope?: "Cody only" | "Workspace";
  /** Free-form chip for a caveat about this specific setting. */
  badge?: string;
  /** Overrides the label-derived search id, so two panels can carry the same
   * label without the search highlight landing on both. */
  searchId?: string;
  /** Renders below the label instead of beside it — for wide inputs. */
  control?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const highlightId = useContext(SettingsHighlightContext);
  const id = searchId ?? slugify(label);
  const highlighted = highlightId !== null && highlightId === id;

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  return (
    <div
      ref={ref}
      data-search-id={id}
      style={{
        minWidth: 0,
        padding: "12px 14px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)",
        ...(highlighted ? { borderColor: "var(--accent)", boxShadow: "0 0 0 2px var(--accent)" } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{label}</span>
          {scope && <span style={chipStyle}>{scope}</span>}
          {badge && <span style={chipStyle}>{badge}</span>}
        </div>
        {children !== undefined && <span style={{ flexShrink: 0 }}>{children}</span>}
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{description}</span>
      {control}
    </div>
  );
}
