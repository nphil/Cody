"use client";

/**
 * Warm-paper UI primitives on top of @base-ui/react.
 * Theming contract: CSS variables from globals.css (--bg, --accent, --radius-*,
 * --shadow-*, --dur-*, --ease-out-warm). No hardcoded colors here.
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { X } from "lucide-react";
import type React from "react";

/* ---------------------------------- Dialog --------------------------------- */

export function Dialog({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BaseDialog.Root>
  );
}

export function DialogContent({ children, className, style, ariaLabel, onClose }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  /**
   * When provided, renders a visible close button (lucide X) pinned to the
   * dialog surface's top-right corner — a touch-friendly close affordance
   * for callers that have no device-independent Esc key and no close/cancel
   * control of their own. Skip this prop when the dialog already renders
   * its own close/cancel control; the button is absolutely positioned
   * inside BaseDialog.Popup (already a `position: fixed` containing block)
   * so it never scrolls away, but callers whose content can grow past
   * `maxHeight` should keep managing their own internal scroll region (as
   * the existing dialogs already do) rather than relying on this popup's
   * own overflow, so the button doesn't get carried off with scrolled
   * content. Callers should give their title element a little right
   * padding/margin (~36px) so long titles don't run under the button.
   */
  onClose?: () => void;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        style={{
          position: "fixed", inset: 0,
          background: "var(--overlay-backdrop)",
          backdropFilter: "blur(2px)",
          zIndex: 1000,
        }}
      />
      <BaseDialog.Popup
        aria-label={ariaLabel}
        className={className}
        style={{
          position: "fixed", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          // Entrance animation must include the centering transform in its
          // keyframes: an animation overrides the inline transform for its
          // whole (fill: both) lifetime.
          animation: "dialog-pop-in var(--dur-med) var(--ease-out-warm) both",
           zIndex: 1001,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-modal)",
          boxShadow: "var(--shadow-modal)",
          padding: 20,
          maxWidth: "min(92vw, 560px)",
          maxHeight: "85dvh",
          overflow: "auto",
          ...style,
        }}
      >
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ui-focus-ring"
            style={{
              position: "absolute", top: 8, right: 8, zIndex: 1,
              width: 32, height: 32, minWidth: 32, minHeight: 32,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: "var(--radius-control)",
              color: "var(--text-dim)",
              cursor: "pointer",
              touchAction: "manipulation",
              transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <BaseDialog.Title className="display-serif" style={{ fontSize: 20, margin: "0 0 12px", ...style }}>
      {children}
    </BaseDialog.Title>
  );
}

export const DialogClose = BaseDialog.Close;

/* ---------------------------------- Tooltip -------------------------------- */

export function Tooltip({ content, children, side = "top" }: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <BaseTooltip.Provider delay={350} closeDelay={0}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={6} style={{ zIndex: 120 }}>
            <BaseTooltip.Popup
              style={{
                background: "var(--bg-panel)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                boxShadow: "var(--shadow-pop)",
                padding: "4px 9px",
                fontSize: 12,
                lineHeight: 1.4,
                maxWidth: 260,
              }}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}

/* -------------------------------- Collapsible ------------------------------- */

export function Collapsible({ open, onOpenChange, defaultOpen, children }: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <BaseCollapsible.Root open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen}>
      {children}
    </BaseCollapsible.Root>
  );
}

export const CollapsibleTrigger = BaseCollapsible.Trigger;

export function CollapsiblePanel({ children, style }: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <BaseCollapsible.Panel style={style}>
      {children}
    </BaseCollapsible.Panel>
  );
}
