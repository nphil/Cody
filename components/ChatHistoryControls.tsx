"use client";

import type { CSSProperties, Ref } from "react";
import { ArrowDown, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import type { HistoryLoadStatus } from "@/hooks/useAgentSession";
import { useI18n } from "@/lib/i18n";

const EDGE_BUTTON_STYLE: CSSProperties = {
  alignSelf: "center",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 28,
  padding: "0 12px",
  margin: "10px auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontFamily: "inherit",
  fontSize: 12,
  touchAction: "manipulation",
};

/**
 * The control at the top ("earlier") or bottom ("newer") of the transcript when
 * the chat continues past what the window holds. It is the transcript's
 * IntersectionObserver sentinel too, so `buttonRef` goes on the one button.
 * A failed request says so and offers a retry; it never retries on its own.
 */
export function HistoryEdgeControl({ edge, status, onLoad, buttonRef }: {
  edge: "earlier" | "newer";
  status: HistoryLoadStatus;
  onLoad: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  const earlier = edge === "earlier";
  const testId = earlier ? "chat-show-earlier" : "chat-show-newer";
  if (status === "error") {
    return (
      <div role="alert" data-testid={`${testId}-error`} style={{ display: "flex", justifyContent: "center", alignItems: "baseline", gap: 10, margin: "10px 0", fontSize: 12, color: "var(--status-error)" }}>
        <span>{t(earlier ? "chatWindow.earlierMessagesFailed" : "chatWindow.newerMessagesFailed")}</span>
        <button type="button" ref={buttonRef} data-testid={testId} data-history-edge={edge} className="ui-focus-ring" onClick={onLoad} style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", fontFamily: "inherit", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
          {t("chatWindow.historyRetry")}
        </button>
      </div>
    );
  }
  const loading = status === "loading";
  const Icon = earlier ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid={testId}
      data-history-edge={edge}
      className="ui-focus-ring"
      disabled={loading}
      onClick={onLoad}
      style={{ ...EDGE_BUTTON_STYLE, cursor: loading ? "default" : "pointer" }}
    >
      {loading ? <Loader2 size={12} className="icon-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
      {t(loading
        ? (earlier ? "chatWindow.loadingEarlierMessages" : "chatWindow.loadingNewerMessages")
        : (earlier ? "chatWindow.showEarlierMessages" : "chatWindow.showNewerMessages"))}
    </button>
  );
}

/** Floats over the transcript's bottom edge while the live end is not what the window shows. */
export function JumpToLatestButton({ status, onJump }: { status: HistoryLoadStatus; onJump: () => void }) {
  const { t } = useI18n();
  const loading = status === "loading";
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 12, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 5 }}>
      <button
        type="button"
        data-testid="chat-jump-latest"
        className="ui-focus-ring"
        disabled={loading}
        onClick={onJump}
        style={{
          pointerEvents: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minHeight: 30,
          padding: "0 12px",
          border: `1px solid ${status === "error" ? "var(--status-error)" : "var(--border)"}`,
          borderRadius: "var(--radius-modal)",
          background: "var(--bg-panel)",
          color: status === "error" ? "var(--status-error)" : "var(--text)",
          boxShadow: "var(--shadow-pop)",
          fontFamily: "inherit",
          fontSize: 12,
          cursor: loading ? "default" : "pointer",
          touchAction: "manipulation",
        }}
      >
        {loading ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}
        {t(loading ? "chatWindow.jumpingToLatest" : status === "error" ? "chatWindow.jumpToLatestFailed" : "chatWindow.jumpToLatest")}
      </button>
    </div>
  );
}
