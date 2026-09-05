"use client";

/**
 * The sub-navigation inside a hub (Extensions: MCP | Skills | Plugins;
 * Models: Catalog | Assignments): a `role="tablist"` of `role="tab"`
 * buttons under the `settings-subtab-<id>` / `settings-subpanel-<id>` DOM
 * contract the audit scripts and deep links read. Arrow keys move between
 * segments (Home/End jump), the selected one is the only tab stop.
 *
 * Desktop: fit-content, 30px. Phone (inside the shell, `isMobile`): full
 * width, and the shell's coarse-pointer CSS lifts every button to 44px, so
 * no per-component override lives here.
 */
import { useContext, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ShellContext } from "./shell-context";

export interface SegmentedOption {
  id: string;
  label: ReactNode;
  /** A count or dot beside the label ("2 new", "1 invalid"). */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  /** Accessible name of the group: "Extension kinds". */
  label: string;
  value: string;
  options: readonly SegmentedOption[];
  onChange: (id: string) => void;
  /** Button ids are `${idPrefix}-${option.id}`; defaults to the sub-view contract. */
  idPrefix?: string;
  /** `aria-controls` targets are `${panelIdPrefix}-${option.id}`. */
  panelIdPrefix?: string;
  /** Stretch to the container; defaults to the shell's `isMobile`. */
  fullWidth?: boolean;
  style?: CSSProperties;
}

export function SegmentedControl({ label, value, options, onChange, idPrefix = "settings-subtab", panelIdPrefix = "settings-subpanel", fullWidth, style }: SegmentedControlProps) {
  const shell = useContext(ShellContext);
  const stretch = fullWidth ?? shell?.isMobile ?? false;
  const enabled = options.filter((option) => !option.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, option: SegmentedOption) => {
    const index = enabled.indexOf(option);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = enabled.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = enabled[next] ?? enabled[index];
    if (!target || target.id === value) return;
    onChange(target.id);
    document.getElementById(`${idPrefix}-${target.id}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className="settings-segmented"
      style={{
        display: "flex",
        gap: 2,
        padding: 3,
        background: "var(--bg-subtle)",
        borderRadius: "var(--radius-control)",
        width: stretch ? "100%" : "fit-content",
        maxWidth: "100%",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            id={`${idPrefix}-${option.id}`}
            aria-selected={selected}
            aria-controls={`${panelIdPrefix}-${option.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => { if (!selected) onChange(option.id); }}
            onKeyDown={(event) => onKeyDown(event, option)}
            className="settings-segment ui-focus-ring"
            style={{
              flex: stretch ? 1 : undefined,
              minWidth: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "5px 14px",
              minHeight: 30,
              border: "none",
              borderRadius: "calc(var(--radius-control) - 2px)",
              background: selected ? "var(--bg-panel)" : "transparent",
              color: selected ? "var(--text)" : "var(--text-muted)",
              fontWeight: selected ? 600 : 500,
              fontSize: 12,
              cursor: option.disabled ? "not-allowed" : "pointer",
              opacity: option.disabled ? 0.5 : 1,
              boxShadow: selected ? "var(--shadow-card)" : "none",
              whiteSpace: "nowrap",
              touchAction: "manipulation",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{option.label}</span>
            {option.badge !== undefined && option.badge !== null && (
              <span style={{ fontSize: 10, padding: "0 5px", borderRadius: 8, background: "var(--bg-subtle)", color: "var(--accent)", fontWeight: 600 }}>{option.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
