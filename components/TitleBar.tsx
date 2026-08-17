"use client";

import type { ReactNode } from "react";
import { useDesktopShell } from "@/hooks/useDesktopShell";
import { useI18n } from "@/lib/i18n";

// Windows convention: the close button always hovers to this specific red,
// regardless of app theme/accent — it is not one of the themed tokens in
// app/globals.css (those vary widely per theme, e.g. pastel in Catppuccin/
// Rosé Pine) because the close-hover color is meant to read identically
// across every app on the OS, themed or not.
const CLOSE_HOVER_BG = "#e81123";

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <line x1="0.5" y1="5" x2="9.5" y2="5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 2.5V0.5H9.5V7.5H7.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

/** One 46px-wide, full-bar-height window-control button. Deliberately a
 * plain `<button>` with no data-tauri-drag-region of its own — Tauri's own
 * drag-region walk already blocks dragging on any clickable element (see
 * hooks/useDesktopShell.ts and the Tauri drag-region research notes), so no
 * opt-out attribute is needed here. Hover is JS-driven inline style, same
 * pattern AppShell.tsx uses for its own toolbar buttons (not a CSS :hover
 * rule — app/globals.css is out of scope for this component). */
function TitleBarButton({
  label,
  onClick,
  variant = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  variant?: "default" | "close";
  children: ReactNode;
}) {
  const isClose = variant === "close";
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="ui-focus-ring"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 46,
        height: "100%",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "var(--text-muted)",
        cursor: "default",
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = isClose ? CLOSE_HOVER_BG : "var(--bg-hover)";
        e.currentTarget.style.color = isClose ? "#fff" : "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Native-feeling window titlebar for the Tauri desktop shell — renders
 * nothing (`null`) outside it, so this is a no-op on web/Docker. See
 * docs/windows.md "Window chrome" and hooks/useDesktopShell.ts.
 *
 * The bar root carries `data-tauri-drag-region="deep"`, making the whole bar
 * (including the app-name/workspace label) drag the window, while the
 * min/max/close `<button>`s are automatically excluded from the drag by
 * Tauri's own click-target walk — no manual no-drag opt-out required.
 * Double-click-to-maximize is likewise handled natively by the same
 * drag-region script; no onDoubleClick handler is added here.
 */
export function TitleBar({ workspaceName }: { workspaceName?: string | null }) {
  const { isDesktop, isMaximized, minimize, toggleMaximize, close } = useDesktopShell();
  const { t } = useI18n();

  if (!isDesktop) return null;

  return (
    <div
      data-tauri-drag-region="deep"
      data-cody-titlebar=""
      className="cody-titlebar"
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 36,
        flexShrink: 0,
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* Left: app name + current workspace, if any */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          overflow: "hidden",
          paddingLeft: 10,
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text)" }}>Cody</span>
        {workspaceName && (
          <>
            <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span>
            <span
              title={workspaceName}
              style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {workspaceName}
            </span>
          </>
        )}
      </div>

      {/* Middle: pure drag spacer. The whole bar is already the drag region
          (data-tauri-drag-region="deep" above); this just claims the space
          between the label and the window controls. */}
      <div style={{ flex: 1 }} />

      {/* Right: window controls */}
      <div style={{ display: "flex", alignItems: "stretch", height: "100%", flexShrink: 0 }}>
        <TitleBarButton label={t("titleBar.minimize")} onClick={minimize}>
          <MinimizeGlyph />
        </TitleBarButton>
        <TitleBarButton label={t(isMaximized ? "titleBar.restore" : "titleBar.maximize")} onClick={toggleMaximize}>
          {isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </TitleBarButton>
        <TitleBarButton label={t("titleBar.close")} onClick={close} variant="close">
          <CloseGlyph />
        </TitleBarButton>
      </div>
    </div>
  );
}
