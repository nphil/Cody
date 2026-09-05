"use client";

import { createContext, isValidElement, useContext, useEffect, useRef, type ReactNode } from "react";

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

/** Marks settings that only configure the harness's terminal UI. A good part of
 * a coding agent's schema is TUI chrome, and toggling one of those here does
 * nothing visible in the browser. The row still belongs in the panel, because
 * the same config file drives the CLI, but it must say so. Cody's curated
 * panels and the schema-driven one share this wording, so a terminal-only
 * setting reads the same whichever surface shows it. */
export const TERMINAL_ONLY_BADGE = "Terminal only";
export const READ_ONLY_BADGE = "Read-only";
/** Marks a setting whose control exists but cannot take effect right now
 * because of STATE — a role assigned to a hidden model, a provider with no
 * key — never because of a capability the engine lacks (those rows hide).
 * Always paired with a reason sentence so the user knows what would unlock it. */
export const UNAVAILABLE_BADGE = "Unavailable";

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

export function NativeSetting({ label, description, scope, badge, unavailable, searchId, control, switchControl, children }: {
  label: string;
  description?: string;
  /** Where the value lives when it is not the harness's own config file. The
   * common case carries no chip: badging the majority is noise. */
  scope?: "Cody only" | "Workspace";
  /** Free-form chip for a caveat about this specific setting. */
  badge?: string;
  /** Why this setting cannot take effect right now. Renders the UNAVAILABLE
   * badge, the reason under the description, and dims the control — the row
   * stays visible so the user can see what would unlock it. */
  unavailable?: string;
  /** Overrides the label-derived search id, so two panels can carry the same
   * label without the search highlight landing on both. */
  searchId?: string;
  /** Renders below the label instead of beside it — for wide inputs. */
  control?: ReactNode;
  /** States explicitly that `children` renders a boolean toggle, for callers
   * whose control is wrapped in another component (SchemaControl, etc.) so
   * the `children.type === ToggleSwitch` check below cannot see through it.
   * Undefined falls back to that structural check, so a caller passing
   * `<ToggleSwitch>` directly still gets the label wrap without setting this. */
  switchControl?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const highlightId = useContext(SettingsHighlightContext);
  const id = searchId ?? slugify(label);
  const highlighted = highlightId !== null && highlightId === id;

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  // A toggle's card is its target: wrapping the whole card in a <label>
  // makes the description text and the empty space around the 36px switch
  // activate it, which is the difference between a tappable row and a
  // fiddly one on a phone. A lone ToggleSwitch qualifies structurally; a
  // wrapped one (SchemaControl, etc.) must say so via `switchControl`, since
  // the element type check cannot see through the wrapper. A <label> around
  // a select or text input would steal their focus semantics, so neither
  // path fires for those.
  const isSwitch = switchControl ?? (isValidElement(children) && children.type === ToggleSwitch);
  const Root: "label" | "div" = isSwitch ? "label" : "div";

  return (
    <Root
      ref={(element: HTMLElement | null) => { ref.current = element; }}
      data-search-id={id}
      aria-disabled={unavailable ? true : undefined}
      style={{
        minWidth: 0,
        padding: "12px 14px",
        // Longhands, not the `border` shorthand: the colour flips with the
        // highlight, and React warns when a longhand and its shorthand fight
        // across renders.
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: highlighted ? "var(--accent)" : "var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: isSwitch && !unavailable ? "pointer" : undefined,
        transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)",
        boxShadow: highlighted ? "0 0 0 2px var(--accent)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{label}</span>
          {scope && <span style={chipStyle}>{scope}</span>}
          {badge && <span style={chipStyle}>{badge}</span>}
          {unavailable && <span style={{ ...chipStyle, color: "var(--status-warning)" }} title={unavailable}>{UNAVAILABLE_BADGE}</span>}
        </div>
        {children !== undefined && (
          <span style={{ flexShrink: 0, ...(unavailable ? { opacity: 0.5, pointerEvents: "none" } : {}) }}>{children}</span>
        )}
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{description}</span>
      {unavailable && <span style={{ color: "var(--status-warning)", fontSize: 11, lineHeight: 1.45 }}>{unavailable}</span>}
      {unavailable ? <div style={{ opacity: 0.5, pointerEvents: "none" }}>{control}</div> : control}
    </Root>
  );
}
