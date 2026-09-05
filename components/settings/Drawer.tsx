"use client";

/**
 * The one way a panel opens a nested view. Three presentations, chosen by
 * the caller for desktop and overridden by the shell on a phone:
 *
 *   - "side" (desktop): a 420px drawer on the right edge INSIDE the settings
 *     dialog (portaled into the shell root), with a scrim over the pane. Not
 *     a second Dialog: base-ui would stack a second portal, backdrop and
 *     focus trap, and Escape would tear both down.
 *   - "push": the same as "side" on desktop; on a phone both become a pushed
 *     full-screen level with a 44px "Back" and "Close" in a 48px header,
 *     registered with the shell so a busy check or a history pop can find it.
 *   - "dialog": a centred Dialog on every width, for ConfirmDialog-like use.
 *
 * Every presentation traps focus, closes on Escape, restores focus on close,
 * and asks before discarding when `dirty`.
 */
import { ArrowLeft, X } from "lucide-react";
import { useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { ShellContext } from "./shell-context";

export type DrawerPresentation = "dialog" | "side" | "push";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `container` while `active`; focus the first control on
 * activation and hand focus back to where it came from afterwards. Exported
 * so any other modal phone-stack surface (MobileStack's `openSub` levels)
 * gets the same trap instead of a second implementation. */
export function useFocusTrap(container: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = container.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = root.querySelector<HTMLElement>('[data-drawer-autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root).focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [container, active]);

  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const root = container.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === document.activeElement);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const firstEl = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === firstEl) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && document.activeElement === lastEl) {
      event.preventDefault();
      firstEl.focus();
    }
  }, [container]);
}

const headerButton = {
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  borderRadius: "var(--radius-control)",
  touchAction: "manipulation" as const,
  flexShrink: 0,
};

export function Drawer({ open, title, presentation = "side", onClose, dirty = false, width = 420, children, footer, ariaLabel }: {
  open: boolean;
  title: ReactNode;
  presentation?: DrawerPresentation;
  onClose: () => void;
  /** Ask before closing: the drawer holds a form with unsaved edits. */
  dirty?: boolean;
  /** Desktop side-drawer width; never wider than the pane. */
  width?: number;
  children: ReactNode;
  /** Pinned below the scrolling body: Save / Cancel. */
  footer?: ReactNode;
  ariaLabel?: string;
}) {
  const shell = useContext(ShellContext);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmBusyLeave, setConfirmBusyLeave] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  // Whatever the shell's busy register holds (a login SSE, an install
  // stream) must not be cut off any more easily from this drawer's own
  // Back/×/Escape/scrim than from the shell's own pops — those already
  // confirm through `requestPop`/`requestClose`, and this is the same guard.
  const proceedClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [dirty, onClose]);
  const requestClose = useCallback(() => {
    if (shell?.busy.isBusy()) {
      setConfirmBusyLeave(true);
      return;
    }
    proceedClose();
  }, [shell, proceedClose]);
  const onTrapKey = useFocusTrap(panelRef, open && presentation !== "dialog");

  // The phone stack tracks depth for the busy check and the history; the
  // level itself renders here so its children stay in this React tree. The
  // level's Back reads the LATEST close handler through a ref: registering
  // once per open, not once per render, so a caller passing an inline
  // `onClose` does not re-register the level (and re-push history) on
  // every render.
  const usesLevel = presentation !== "dialog" && Boolean(shell?.isMobile);
  const openSub = shell?.openSub;
  const closeSub = shell?.closeSub;
  const levelTitle = typeof title === "string" ? title : "";
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!open || !usesLevel || !openSub || !closeSub) return;
    const id = openSub(null, levelTitle, { onBack: () => requestCloseRef.current() });
    return () => closeSub(id);
  }, [open, usesLevel, openSub, closeSub, levelTitle]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Stop here: the settings Dialog underneath also listens for Escape,
      // and one key press must close one layer.
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      requestClose();
      return;
    }
    onTrapKey(event);
  };

  const discardGuard = (
    <ConfirmDialog
      open={confirmDiscard}
      onOpenChange={setConfirmDiscard}
      title="Discard changes?"
      description="This view has edits that have not been saved. Closing it now throws them away."
      confirmLabel="Discard"
      danger
      onConfirm={() => {
        setConfirmDiscard(false);
        onClose();
      }}
    />
  );

  // Same copy as SettingsShell's own busy guard, so a login SSE reads the
  // same warning whether the cut-off comes from a shell pop or this drawer's
  // own Back/×/Escape/scrim.
  const busyReasons = shell?.busy.reasons() ?? [];
  const signingIn = busyReasons.some((reason) => /sign[- ]?in|log[- ]?in/i.test(reason));
  const busyLeaveGuard = (
    <ConfirmDialog
      open={confirmBusyLeave}
      onOpenChange={(next) => { if (!next) setConfirmBusyLeave(false); }}
      title={signingIn ? "Leave while sign-in is in progress?" : "Leave while work is in progress?"}
      description={`${busyReasons.join(", ") || "Something"} is still running. Closing this now interrupts it.`}
      confirmLabel="Leave"
      cancelLabel="Stay"
      danger
      onConfirm={() => {
        setConfirmBusyLeave(false);
        proceedClose();
      }}
    />
  );

  if (presentation === "dialog") {
    return (
      <>
        <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
          <DialogContent className="ui-dialog" ariaLabel={ariaLabel ?? (typeof title === "string" ? title : undefined)} onClose={requestClose} style={{ width: 520, maxWidth: "min(92vw, 520px)", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden", maxHeight: "85dvh" }}>
            <div style={{ padding: "16px 48px 10px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <DialogTitle style={{ fontSize: 16, margin: 0 }}>{title}</DialogTitle>
            </div>
            <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
            {footer && <div style={{ padding: "10px 20px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0 }}>{footer}</div>}
          </DialogContent>
        </Dialog>
        {discardGuard}
        {busyLeaveGuard}
      </>
    );
  }

  if (!open) return null;

  const host = shell?.portalTarget ?? (typeof document !== "undefined" ? document.body : null);
  if (!host) return null;

  if (usesLevel) {
    return (
      <>
        {createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="settings-mobile-level"
            style={{ position: "absolute", inset: 0, zIndex: 30, background: "var(--bg)", display: "flex", flexDirection: "column", outline: "none" }}
          >
            <header style={{ display: "flex", alignItems: "center", gap: 2, height: 48, minHeight: 48, padding: "0 2px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
              <button type="button" onClick={requestClose} aria-label="Back" className="ui-focus-ring" style={headerButton}>
                <ArrowLeft size={18} aria-hidden="true" />
              </button>
              <div id={titleId} style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
              {/* Parity with every non-Drawer level: × leaves Settings
                  entirely (the shell's own busy-guarded requestClose), not a
                  second Back. Only the ‹ above steps back into this drawer's
                  own dirty-discard guard. */}
              <button type="button" onClick={() => (shell ? shell.callbacks.onClose() : requestClose())} aria-label="Close settings" className="ui-focus-ring" style={headerButton}>
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: 16, paddingBottom: "max(16px, env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
            {footer && <div style={{ padding: "10px 16px", paddingBottom: "max(10px, env(safe-area-inset-bottom))", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0, background: "var(--bg-panel)" }}>{footer}</div>}
          </div>,
          host,
        )}
        {discardGuard}
        {busyLeaveGuard}
      </>
    );
  }

  return (
    <>
      {createPortal(
        <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", justifyContent: "flex-end" }}>
          <div
            aria-hidden="true"
            onClick={requestClose}
            style={{ position: "absolute", inset: 0, background: "var(--overlay-backdrop)", animation: "ui-fade-in var(--dur-fast) var(--ease-out-warm) both" }}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="settings-drawer-panel"
            style={{ position: "relative", width: "100%", maxWidth: width, height: "100%", background: "var(--bg)", borderLeft: "1px solid var(--border)", boxShadow: "var(--shadow-modal)", display: "flex", flexDirection: "column", outline: "none" }}
          >
            <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 8px 10px 18px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
              <div id={titleId} style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
              <button type="button" onClick={requestClose} aria-label="Close" className="ui-focus-ring" style={{ ...headerButton, width: 32, height: 32, minWidth: 32, minHeight: 32 }}>
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
            {footer && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0, background: "var(--bg-panel)" }}>{footer}</div>}
          </div>
        </div>,
        host,
      )}
      {discardGuard}
      {busyLeaveGuard}
    </>
  );
}
