"use client";

import { memo, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { ArrowDown, ChevronUp, Loader2 } from "lucide-react";
import { useSubagentTranscript, type TranscriptPhase } from "@/hooks/useSubagentTranscript";
import { useTranscriptScroll } from "@/hooks/useTranscriptScroll";
import { useI18n } from "@/lib/i18n";
import type { TranscriptRow } from "@/lib/subagent-transcript";
import type { ToolResultMessage } from "@/lib/types";
import { MessageView } from "./MessageView";

/** Section label shared by the dialog's Result / Task / Transcript blocks. */
export const BLOCK_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const MUTED_LINE_STYLE: CSSProperties = { margin: 0, fontSize: 12, color: "var(--text-dim)" };

/** Quiet accent text button (Retry, Show more). */
export const TEXT_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--accent)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
};

/** Which assistant rows show their time: the last one before the next user
 *  message, exactly like the main chat (a run of tool-calling steps would
 *  otherwise stamp every row). */
function timestampKeysOf(rows: readonly TranscriptRow[]): Set<string> {
  const keys = new Set<string>();
  let next: string | null = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const role = rows[i].message.role;
    if (role === "assistant" && next !== "assistant") keys.add(rows[i].key);
    if (role === "assistant" || role === "user") next = role;
  }
  return keys;
}

/**
 * The rows, drawn by the MAIN chat's MessageView so a subagent reads exactly
 * like a conversation: thinking collapsed under its header, tool calls as the
 * normal collapsible cards with their results attached. Read-only on purpose:
 * no fork / edit / checkpoint props, no session or entry id (so nothing can be
 * fetched for a row), and `allowDistill={false}` so opening a transcript never
 * starts a model call. Memoized: a live status frame re-renders the dialog
 * shell, never this list.
 */
const TranscriptRows = memo(function TranscriptRows({ rows, toolResults, containerRef }: {
  rows: readonly TranscriptRow[];
  toolResults: Map<string, ToolResultMessage>;
  containerRef: (node: HTMLDivElement | null) => void;
}) {
  const stamped = useMemo(() => timestampKeysOf(rows), [rows]);
  return (
    <div ref={containerRef} data-testid="subagent-transcript-rows">
      {rows.map((row) => (
        // The wrapper is the row's identity for the scroll anchor and keeps the
        // history free of entrance motion (see .subagent-row in globals.css).
        <div key={row.key} className="subagent-row" data-row-key={row.key}>
          <MessageView
            message={row.message}
            toolResults={toolResults}
            showTimestamp={stamped.has(row.key)}
            thinkingDefaultExpanded={false}
            activityDisplayMode="compact"
            allowDistill={false}
          />
        </div>
      ))}
    </div>
  );
});

function TranscriptSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{ display: "grid", gap: 10, paddingTop: 2 }}>
      <div className="skeleton" style={{ height: 14, width: "34%" }} />
      <div className="skeleton" style={{ height: 34 }} />
      <div className="skeleton" style={{ height: 34, width: "88%" }} />
      <div className="skeleton" style={{ height: 14, width: "52%" }} />
    </div>
  );
}

/** One muted line, with the failure's own words and an optional retry. */
function Notice({ tone, text, detail, actionLabel, onAction }: {
  tone: "error" | "muted";
  text: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div role={tone === "error" ? "alert" : undefined} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px", fontSize: 12, color: tone === "error" ? "var(--status-error)" : "var(--text-dim)" }}>
      <span>{text}</span>
      {detail && <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{detail}</span>}
      {actionLabel && onAction && (
        <button type="button" className="ui-focus-ring" onClick={onAction} style={TEXT_BUTTON_STYLE}>{actionLabel}</button>
      )}
    </div>
  );
}

/** The ONE control for earlier messages, at the top of the transcript, shown
 *  only while earlier content exists. */
function EarlierControl({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-testid="subagent-show-earlier"
      className="ui-focus-ring"
      disabled={loading}
      onClick={onLoad}
      style={{
        alignSelf: "center",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 28,
        padding: "0 12px",
        marginBottom: 10,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        fontFamily: "inherit",
        fontSize: 12,
        cursor: loading ? "default" : "pointer",
        touchAction: "manipulation",
      }}
    >
      {loading ? <Loader2 size={12} className="icon-spin" aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
      {loading ? t("subagentTranscript.loadingEarlier") : t("subagentTranscript.showEarlier")}
    </button>
  );
}

/** What the transcript section needs to draw itself: the data layer's state
 *  plus what the scroll layer knows. Pure props in, markup out, so every state
 *  (loading, error, empty, earlier available, detached from the live end) is
 *  testable without a browser. */
export interface TranscriptViewProps {
  phase: TranscriptPhase;
  error: string | null;
  rows: readonly TranscriptRow[];
  toolResults: Map<string, ToolResultMessage>;
  /** The child is still running: an empty transcript means "not yet". */
  active: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: string | null;
  loadingLater: boolean;
  laterError: string | null;
  /** The newest rows are not on screen: a trimmed window, or lines that arrived while reading elsewhere. */
  showJump: boolean;
  rowsContainerRef: (node: HTMLDivElement | null) => void;
  onShowEarlier: () => void;
  onJump: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}

export function TranscriptView({
  phase, error, rows, toolResults, active, hasEarlier, loadingEarlier, earlierError, loadingLater, laterError,
  showJump, rowsContainerRef, onShowEarlier, onJump, onRetry, onRefresh,
}: TranscriptViewProps) {
  const { t } = useI18n();
  const ready = phase === "ready";
  const empty = ready && rows.length === 0 && !hasEarlier;
  return (
    <section aria-label={t("subagentTranscript.transcriptLabel")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.transcriptLabel")}</span>
      {phase === "loading" && <TranscriptSkeleton label={t("subagentTranscript.loading")} />}
      {phase === "error" && (
        <Notice tone="error" text={t("subagentTranscript.loadFailed")} detail={error} actionLabel={t("subagentTranscript.retry")} onAction={onRetry} />
      )}
      {(phase === "missing" || empty) && (
        <p style={MUTED_LINE_STYLE}>{active ? t("subagentTranscript.noMessages") : t("subagentTranscript.noTranscript")}</p>
      )}
      {ready && hasEarlier && (earlierError === null
        ? <EarlierControl loading={loadingEarlier} onLoad={onShowEarlier} />
        : <Notice tone="error" text={t("subagentTranscript.earlierFailed")} detail={earlierError} actionLabel={t("subagentTranscript.retry")} onAction={onShowEarlier} />)}
      {ready && <TranscriptRows rows={rows} toolResults={toolResults} containerRef={rowsContainerRef} />}
      {ready && loadingLater && <p style={MUTED_LINE_STYLE}>{t("subagentTranscript.loading")}</p>}
      {ready && laterError !== null && (
        <Notice tone="muted" text={t("subagentTranscript.refreshFailed")} detail={laterError} actionLabel={t("subagentTranscript.retry")} onAction={onRefresh} />
      )}
      {/* A zero-height sticky anchor: the pill floats above the bottom edge of
          the scroll area without taking a line of the content (the negative
          margin cancels the column gap above it). */}
      <div style={{ position: "sticky", bottom: 12, height: 0, marginTop: -8, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 2 }}>
        {showJump && (
          <button
            type="button"
            data-testid="subagent-jump-latest"
            className="ui-focus-ring"
            onClick={onJump}
            style={{
              position: "absolute",
              bottom: 0,
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              minHeight: 30,
              padding: "0 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-modal)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              boxShadow: "var(--shadow-pop)",
              fontFamily: "inherit",
              fontSize: 12,
              cursor: "pointer",
              touchAction: "manipulation",
            }}
          >
            <ArrowDown size={13} aria-hidden="true" />
            {t("subagentTranscript.jumpToLatest")}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * A subagent's transcript, flowing in the dialog body's one scroll container:
 * the newest page when it opens, earlier pages on request ("Show earlier" at
 * the top; also loaded on their own as the reader nears the top), new lines
 * appended while the child runs. Rendered only while the dialog is open — it
 * fetches on mount and does nothing after unmount.
 */
export const SubagentTranscript = memo(function SubagentTranscript({ sessionId, subagentId, sessionFile, rpcFallback, active, refreshKey, scroller, content }: {
  sessionId: string;
  subagentId: string;
  sessionFile?: string;
  /** A running child whose file the disk reader cannot see may be read through omp. */
  rpcFallback: boolean;
  /** The child is still running: new rows are followed, a missing file just means "not yet". */
  active: boolean;
  /** Bumps whenever the child may have written more (already throttled). */
  refreshKey: number;
  /** The dialog body that scrolls, and the single element inside it that wraps its content. */
  scroller: HTMLElement | null;
  content: HTMLElement | null;
}) {
  const viewportKeyRef = useRef<string | null>(null);
  // The rows' container, handed to the scroll layer to hold the reader's place.
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const setRowsNode = useCallback((node: HTMLDivElement | null) => { rowsRef.current = node; }, []);

  const {
    phase, error, rows, toolResults, startMark, endMark,
    hasEarlier, loadingEarlier, earlierError, attached, loadingLater, laterError,
    loadEarlier, loadLater, jumpToLatest, retry, refresh,
  } = useSubagentTranscript({ sessionId, subagentId, sessionFile, rpcFallback, active, refreshKey, viewportKeyRef });

  const ready = phase === "ready";
  const { pinned, unseen, toBottom, requestBottom } = useTranscriptScroll({
    scroller,
    content,
    rowsRef,
    ready,
    startMark,
    endMark,
    viewportKeyRef,
    onNearTop: () => hasEarlier && !loadingEarlier && earlierError === null && loadEarlier(),
    onNearBottom: () => !attached && !loadingLater && laterError === null && loadLater(),
  });

  const showEarlier = useCallback(() => { loadEarlier(); }, [loadEarlier]);
  const jump = useCallback(() => {
    if (attached) {
      toBottom();
      return;
    }
    requestBottom();
    jumpToLatest();
  }, [attached, toBottom, requestBottom, jumpToLatest]);

  return (
    <TranscriptView
      phase={phase}
      error={error}
      rows={rows}
      toolResults={toolResults}
      active={active}
      hasEarlier={hasEarlier}
      loadingEarlier={loadingEarlier}
      earlierError={earlierError}
      loadingLater={loadingLater}
      laterError={laterError}
      showJump={ready && (!attached || (unseen && !pinned))}
      rowsContainerRef={setRowsNode}
      onShowEarlier={showEarlier}
      onJump={jump}
      onRetry={retry}
      onRefresh={refresh}
    />
  );
});
