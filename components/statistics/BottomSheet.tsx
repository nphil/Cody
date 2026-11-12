"use client";

import type { CSSProperties, ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** What the sheet is about, for people who cannot see it. */
  label: string;
  children: ReactNode;
}

/**
 * Turns the app's centred dialog into a sheet that rises from the bottom edge.
 * Inline styles are the only thing that beats the dialog's own, and the
 * entrance keyframes live in statistics-css.ts. The popup itself never
 * scrolls (its close button is pinned to it); the body inside does.
 */
const SHEET_STYLE: CSSProperties = {
  top: "auto",
  bottom: 0,
  left: 0,
  right: 0,
  margin: "0 auto",
  transform: "none",
  width: "min(100%, 560px)",
  maxWidth: "100%",
  maxHeight: "min(88dvh, 720px)",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  borderBottom: "none",
  borderRadius: "var(--radius-modal) var(--radius-modal) 0 0",
  animation: "stats-sheet-rise var(--dur-med) var(--ease-out-warm) both",
};

/**
 * The phone's detail panel. Focus is held inside while it is open and goes back
 * to what opened it afterwards; Escape, the backdrop and the close button all
 * dismiss it.
 */
export function BottomSheet({ open, onClose, label, children }: BottomSheetProps) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent ariaLabel={label} onClose={onClose} closeLabel={t("statistics.page.close")} style={SHEET_STYLE}>
        <div className="stats-sheet-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
