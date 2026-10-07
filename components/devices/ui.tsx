"use client";

/**
 * The few building blocks the Devices panel is made of. Everything reads
 * Cody's existing tokens (--bg, --bg-panel, --border, --accent, --radius-*,
 * --status-*); nothing here introduces a colour or a radius of its own.
 *
 * Every control is at least TOUCH px tall and wide: the panel is used from an
 * Android tablet with a finger, and the same sizes are used with a mouse so
 * the layout does not change between the two.
 */

import { TriangleAlert } from "lucide-react";
import { useId, type CSSProperties, type InputHTMLAttributes, type ReactNode, type Ref } from "react";

export const TOUCH = 44;

export type Tone = "normal" | "primary" | "danger" | "warning" | "quiet";

const toneStyle: Record<Tone, CSSProperties> = {
  normal: { background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)" },
  primary: { background: "var(--accent)", color: "var(--on-accent)", border: "1px solid var(--accent)" },
  danger: { background: "var(--bg-panel)", color: "var(--status-error)", border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))" },
  warning: { background: "var(--bg-panel)", color: "var(--status-warning)", border: "1px solid color-mix(in srgb, var(--status-warning) 60%, var(--border))" },
  // No outline until it is touched: for a row's second action, which must stay a full-size target without a box around every one.
  quiet: { background: "transparent", color: "var(--text-muted)", border: "1px solid transparent" },
};

export function Button({ children, onClick, tone = "normal", icon, disabled = false, type = "button", full = false, ariaLabel, title, pressed, expanded, haspopup, controls, popoverTarget, autoFocus, id, buttonRef, style }: {
  children?: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  icon?: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  full?: boolean;
  ariaLabel?: string;
  title?: string;
  pressed?: boolean;
  /** The button opens and closes something it names with `controls`. */
  expanded?: boolean;
  haspopup?: "menu" | "dialog";
  controls?: string;
  /** The id of a `popover` element this button opens and closes by itself: the browser does the toggling. */
  popoverTarget?: string;
  /** Takes focus when it appears: for the safe choice of a confirmation. */
  autoFocus?: boolean;
  id?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  style?: CSSProperties;
}) {
  return (
    <button
      ref={buttonRef}
      id={id}
      type={type}
      className={`ui-focus-ring dv-btn dv-btn--${tone}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={haspopup}
      aria-controls={controls}
      popoverTarget={popoverTarget}
      autoFocus={autoFocus}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        boxSizing: "border-box",
        minHeight: TOUCH,
        minWidth: TOUCH,
        padding: "6px 14px",
        width: full ? "100%" : undefined,
        borderRadius: "var(--radius-control)",
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.25,
        textAlign: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        ...toneStyle[tone],
        ...style,
      }}
    >
      {icon && <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>}
      {children !== undefined && children !== null && <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>}
    </button>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: TOUCH,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 16,
};

/** A label above one control, with an optional line of plain-language help. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{label}</label>
      {children(id)}
      {hint && <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{hint}</span>}
    </div>
  );
}

export function TextField({ label, hint, mono = false, ...input }: { label: ReactNode; hint?: ReactNode; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <input id={id} className="ui-focus-ring" autoCapitalize="off" autoCorrect="off" spellCheck={false} {...input} style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : undefined, ...input.style }} />}
    </Field>
  );
}

/** A few mutually exclusive choices drawn as big buttons: easier to hit and easier to read than a drop-down. */
export function Segmented<V extends string>({ label, value, options, onChange }: {
  label: string;
  value: V;
  options: readonly { value: V; label: ReactNode }[];
  onChange: (value: V) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className="ui-focus-ring dv-btn"
            onClick={() => onChange(option.value)}
            style={{
              flex: "1 1 auto",
              minHeight: TOUCH,
              minWidth: TOUCH,
              padding: "6px 12px",
              borderRadius: "var(--radius-control)",
              border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
              background: selected ? "var(--bg-selected)" : "var(--bg-panel)",
              color: "var(--text)",
              fontSize: 13,
              fontWeight: selected ? 700 : 500,
              cursor: "pointer",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const noticeColor: Record<"info" | "warning" | "error", string> = {
  info: "var(--text-muted)",
  warning: "var(--status-warning)",
  error: "var(--status-error)",
};

export function Notice({ tone = "info", children, role, icon }: { tone?: "info" | "warning" | "error"; children: ReactNode; role?: "alert" | "status" | "note"; icon?: ReactNode }) {
  return (
    <div
      role={role}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        borderRadius: "var(--radius-control)",
        border: tone === "info" ? "1px solid var(--border)" : `1px solid color-mix(in srgb, ${noticeColor[tone]} 55%, var(--border))`,
        background: "var(--bg-panel)",
        color: noticeColor[tone],
        fontSize: 12,
        lineHeight: 1.45,
        overflowWrap: "anywhere",
      }}
    >
      {tone !== "info" && <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, marginTop: 1 }}>{icon ?? <TriangleAlert size={14} strokeWidth={2.2} />}</span>}
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

export function Chip({ children, tone = "neutral", icon }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "accent"; icon?: ReactNode }) {
  const color = tone === "good" ? "var(--status-success)" : tone === "warn" ? "var(--status-warning)" : tone === "accent" ? "var(--accent)" : "var(--text-muted)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: "100%",
        padding: "2px 9px",
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${color} 45%, var(--border))`,
        background: "var(--bg)",
        color,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.5,
      }}
    >
      {icon && <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>}
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </span>
  );
}

export const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  boxShadow: "var(--shadow-card)",
  minWidth: 0,
};

export const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

/** A native disclosure, so open/closed state, keyboard and screen-reader behaviour come from the browser. */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="dv-disclosure" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
      <summary
        className="ui-focus-ring"
        style={{ display: "flex", alignItems: "center", minHeight: TOUCH, padding: "0 12px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--text)", listStyle: "none" }}
      >
        {summary}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 12px 12px" }}>{children}</div>
    </details>
  );
}

/**
 * A thin, truthful bar: `fraction` is 0..1 of something that is really measured. Never drawn for work whose size is not
 * known: a bar that is not measuring anything is decoration. The label is what a screen reader hears.
 */
export function ProgressLine({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="dv-progress">
      <div className="dv-progress__fill" style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  );
}
