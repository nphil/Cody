"use client";

import { memo, useState, useRef, useEffect, useMemo, useCallback, type ComponentProps, type TransitionEvent } from "react";
import { Copy, Check, GitFork, CornerUpLeft, ChevronRight, Brain, CircleAlert, CircleSlash, LoaderCircle } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { ClickableImage } from "./ImageLightbox";
import { translate, useI18n, type Locale } from "@/lib/i18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { isEmptyThinkingBlock, isVisibleTranscriptMessage } from "@/lib/message-display";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { Tooltip, Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./ui/primitives";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { StreamingMarkdown } from "./StreamingMarkdown";

import { requestDistill, retryDistill, useDistillChatSettings, useDistillState, useSeenOnScreen, type DistillRequest, type DistillState } from "@/hooks/useDistill";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { formatModelDisplayName } from "@/lib/model-display";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  ActivityDisplayMode,
} from "@/lib/types";

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();
const MAX_MARKDOWN_CHARS = 100_000;
/** Tool output rendered inline before the "view full output" reveal. */
const MAX_INLINE_RESULT_CHARS = 200_000;
/** Live thinking is re-summarized only after this much NEW reasoning, and
 *  never more often than THINKING_DISTILL_INTERVAL_MS — one collapsed line
 *  is not worth a model call per token batch. */
const THINKING_DISTILL_GROWTH_CHARS = 600;
const THINKING_DISTILL_INTERVAL_MS = 4_000;
/** Below this a reply is already its own summary: distilling "Done." costs a
 *  model call and gives back a longer sentence. */
const REPLY_DISTILL_MIN_CHARS = 400;

function formatMessageSize(chars: number): string {
  return chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} MB` : `${Math.round(chars / 1_000)} KB`;
}

export function SafeMarkdownBody({ children, className, ...props }: ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }

  if (!showRaw) {
    return (
      <button
        type="button"
        onClick={() => setShowRaw(true)}
        style={{ display: "block", width: "100%", margin: "4px 0", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
      >
        {t("messageView.largeMessageReveal", { size: formatMessageSize(children.length) })}
      </button>
    );
  }

  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", overscrollBehavior: "contain", fontSize: 12, lineHeight: 1.5 }}>
      <pre style={{ margin: 0, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
        {children}
      </pre>
    </div>
  );
}

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error(translate("messageView.invalidThinkingResponse"));
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  thinkingDefaultExpanded?: boolean;
  activityDisplayMode?: ActivityDisplayMode;
}

function formatTime(ts: number | undefined, locale: Locale): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString(locale, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, sessionId, thinkingDefaultExpanded = false, activityDisplayMode = "compact" }: Props) {
  if (!isVisibleTranscriptMessage(message, activityDisplayMode, toolResults)) return null;
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} thinkingDefaultExpanded={thinkingDefaultExpanded} activityDisplayMode={activityDisplayMode} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "xdev-mount-notice") return null;
    if ((message as CustomMessage).customType === "compaction") return <CompactionMessageView message={message as CustomMessage} />;
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} activityDisplayMode={activityDisplayMode} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} activityDisplayMode={activityDisplayMode} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.entryId === next.entryId
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditContent === next.onEditContent
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.sessionId === next.sessionId
    && prev.thinkingDefaultExpanded === next.thinkingDefaultExpanded
    && prev.activityDisplayMode === next.activityDisplayMode;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
}) {
  const { t, locale } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [actionsActive, setActionsActive] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback();

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const time = formatTime(message.timestamp, locale);
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  return (
    <div
      className="chat-user-message"
      style={{ marginBottom: 18, display: "flex", flexDirection: "column", alignItems: "flex-end", paddingRight: 6 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: "85%", minWidth: 0 }}>
        <div
          className="chat-message-card"
          style={{
            maxWidth: "100%",
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
            padding: "8px 12px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  <ClickableImage
                    key={i}
                    src={src}
                    alt=""
                    style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid color-mix(in srgb, var(--accent) 18%, transparent)" }}
                  />
                );
              })}
            </div>
          )}
          {content && <SafeMarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
        </div>

        {/* Bottom row: action buttons + timestamp — inside the bubble's column,
            spanning its width, so the timestamp aligns with its right edge. */}
        {(time || canFork || canNavigate || true) && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end",
            gap: 6, marginTop: 3, width: "100%",
          }}>
          <div
            className="touch-reveal"
            style={{
              display: "flex", gap: 3,
              opacity: hovered || actionsActive ? 1 : 0,
              pointerEvents: hovered || actionsActive ? "auto" : "none",
              transition: "opacity var(--dur-fast) var(--ease-out-warm)",
            }}
            onFocusCapture={() => setActionsActive(true)}
            onBlurCapture={() => setActionsActive(false)}
          >
            <Tooltip content={t("messageView.copyMessage")}>
              <button
                onClick={() => copyContent(content)}
                aria-label={t("messageView.copyMessage")}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "3px 8px", height: 22,
                  background: "none", border: "none",
                  borderRadius: 5,
                  color: copied ? "var(--accent)" : "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 11, fontWeight: 400,
                  whiteSpace: "nowrap",
                  transition: "color var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
              >
                {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
                {copied ? t("messageView.copied") : t("messageView.copy")}
              </button>
            </Tooltip>
          </div>
          {(canFork || canNavigate) && (
            <div
              style={{
                display: "flex", gap: 3,
                opacity: (hovered || actionsActive || forking) ? 1 : 0,
                pointerEvents: (hovered || actionsActive || forking) ? "auto" : "none",
                transition: "opacity var(--dur-fast) var(--ease-out-warm)",
              }}
              onFocusCapture={() => setActionsActive(true)}
              onBlurCapture={() => setActionsActive(false)}
            >
              {canNavigate && (
                <Tooltip content={t("messageView.editFromHereTitle")}>
                  <button
                    onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(content); }}
                    aria-label={t("messageView.editFromHereTitle")}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", height: 22,
                      background: "none", border: "none",
                      borderRadius: 5,
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      fontSize: 11, fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color var(--dur-fast) var(--ease-out-warm)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <CornerUpLeft size={11} strokeWidth={1.8} />
                    {t("messageView.editFromHere")}
                  </button>
                </Tooltip>
              )}
              {canFork && (
                <Tooltip content={forking ? t("messageView.creatingSession") : t("messageView.newSessionTitle")}>
                  <button
                    onClick={() => { onFork!(entryId!); }}
                    disabled={forking}
                    aria-label={forking ? t("messageView.creatingSession") : t("messageView.newSessionTitle")}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", height: 22,
                      background: "none", border: "none",
                      borderRadius: 5,
                      color: forking ? "var(--accent)" : "var(--text-dim)",
                      cursor: forking ? "not-allowed" : "pointer",
                      fontSize: 11, fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color var(--dur-fast) var(--ease-out-warm)",
                    }}
                    onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <GitFork size={11} strokeWidth={1.8} />
                    {forking ? t("messageView.creating") : t("messageView.newSession")}
                  </button>
                </Tooltip>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function isInterruptedMessage(errorMessage?: string | null, stopReason?: string): boolean {
  if (stopReason === "aborted") return true;
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase().trim();
  return (
    lower === "interrupted by user" ||
    lower === "interrupted" ||
    lower === "generation stopped by user" ||
    lower.startsWith("interrupted by user") ||
    lower.startsWith("interrupted:") ||
    lower === "aborted" ||
    lower === "request aborted"
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  thinkingDefaultExpanded,
  activityDisplayMode,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  activityDisplayMode: ActivityDisplayMode;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  thinkingDefaultExpanded: boolean;
}) {
  const { t, locale } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp, locale) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const visibleBlockItems = blockItems.filter(({ block }) => (
    activityDisplayMode !== "hidden"
    || block.type !== "toolCall"
    || Boolean(toolResults?.get((block as ToolCallContent).toolCallId)?.isError)
  ));
  const blocks = visibleBlockItems.map(({ block }) => block);
  const errorMessage = message.errorMessage?.trim() || null;
  const isInterrupted = isInterruptedMessage(errorMessage, message.stopReason);
  // Only the last block of the live message is still growing; earlier blocks
  // became final the moment a successor appeared and must render (and flush)
  // as settled text, so live rendering (the streaming reveal, thinking auto-expand) applies to exactly one block.
  const activeStreamIndex = isStreaming && blockItems.length > 0 ? blockItems[blockItems.length - 1].originalIndex : -1;
  const [hovered, setHovered] = useState(false);
  const [actionsActive, setActionsActive] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback();
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  // The copy control (the only consumer) is hidden while streaming — don't
  // re-join the growing text blocks on every token frame.
  const textContent = isStreaming
    ? ""
    : blocks
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");

  // ── Distill ──
  // A message is distilled only if it FINISHED in this page session. A
  // freshly appended assistant message renders once before the reconcile
  // that assigns entry ids, so "first seen without an entryId, has one now"
  // is exactly the set of replies this reader watched arrive; history always
  // arrives with its id already attached and is left alone.
  const distill = useDistillChatSettings();
  const firstSeenEntryIdRef = useRef(entryId);
  const finalizedHere = firstSeenEntryIdRef.current === undefined && entryId !== undefined;
  const replyRequest = useMemo<DistillRequest | null>(() => {
    if (!distill.supported || distill.replies === "off") return null;
    if (isStreaming === true || !finalizedHere) return null;
    if (sessionId === undefined || entryId === undefined) return null;
    if (textContent.length < REPLY_DISTILL_MIN_CHARS) return null;
    return {
      key: `${sessionId}:${entryId}:reply:${distill.replies}`,
      sessionId,
      entryId,
      kind: "reply",
      text: textContent,
      verbosity: distill.replies,
      final: true,
    };
  }, [distill.supported, distill.replies, isStreaming, finalizedHere, sessionId, entryId, textContent]);
  const replyState = useDistillState(replyRequest?.key ?? null);
  const [showFullReply, setShowFullReply] = useState(false);
  useEffect(() => {
    if (replyRequest !== null) requestDistill(replyRequest);
  }, [replyRequest]);
  const distillShown = replyState.text;
  const distilledReply = !showFullReply && distillShown !== "" && replyState.errorCode === null ? distillShown : null;
  // The thinking summary needs nothing per-block beyond this flag; sessionId,
  // entryId and the block index are already on their way down.
  const distillThinking = distill.supported && distill.thinking;
  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const bs = items.map(({ block }) => block);
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      // Rounded to the displayed precision before it hits state: the raw float
      // changes on essentially every tick, forcing a re-render of the live
      // message (and its markdown block) 3.3×/s independently of token arrival.
      if (elapsed > 0.5) {
        const next = Math.round((chars / 4 / elapsed) * 10) / 10;
        setTps((prev) => (prev === next ? prev : next));
      }
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !errorMessage) return null;

  // The --live bar is an unboxed-text affordance: boxed blocks (tool calls,
  // thinking) carry their own borders, and the full-height accent bar would
  // paint over their left edge while a tool is running.
  const isLiveText = isStreaming && !blocks.some((b) => b.type === "toolCall" || b.type === "thinking");

  // Where the distilled body renders: in place of the FIRST text block, so
  // it keeps the reply's position among the thinking and tool blocks.
  const distilledTextIndex = distilledReply === null
    ? -1
    : visibleBlockItems.find((item) => item.block.type === "text")?.originalIndex ?? -1;

  return (
    <div
      className={`chat-message collapse-scope${isLiveText ? " chat-message--live" : ""}`}
      style={{ marginBottom: 18 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{formatModelDisplayName(message.model, modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model])}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("messageView.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    // Speed tiers use the semantic status tokens as TEXT color
                    // (theme-adaptive, AA-verified) over a subtle tint — the
                    // old hardcoded palette failed AA for white-on-fill.
                    const tier = tps >= 50 ? "success" : tps >= 30 ? "renamed" : tps >= 15 ? "warning" : "error";
                    const tone = `var(--status-${tier})`;
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: `color-mix(in srgb, ${tone} 14%, var(--bg-panel))`, color: tone, fontSize: 11, fontWeight: 400 }}>
                        {t("messageView.tokensPerSecond", { tps: tps.toFixed(1) })}
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {visibleBlockItems.map(({ block, originalIndex }) => {
          // The distilled body stands in for the reply text only: thinking
          // and tool activity are not a reply and keep rendering as they do
          // today. Later text blocks fold into the one distilled view.
          if (distilledReply !== null && block.type === "text") {
            return originalIndex === distilledTextIndex
              ? <DistilledReply key={`${entryId ?? "stream"}-distilled`} text={distilledReply} cwd={cwd} onOpenFile={onOpenFile} />
              : null;
          }
          return (
            <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} isStreaming={isStreaming} isActiveStreamBlock={originalIndex === activeStreamIndex} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} thinkingDefaultExpanded={thinkingDefaultExpanded} activityDisplayMode={activityDisplayMode} distillThinking={distillThinking} />
          );
        })}
        {errorMessage && (
          isInterrupted ? (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 9px",
                border: "1px solid color-mix(in srgb, var(--text-muted) 25%, var(--border))",
                borderRadius: "var(--radius-control)",
                background: "color-mix(in srgb, var(--text-muted) 6%, var(--bg-panel))",
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              <CircleSlash size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span>{t("messageView.interruptedByUser")}</span>
            </div>
          ) : (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                padding: "7px 9px",
                border: "1px solid color-mix(in srgb, var(--status-error) 35%, var(--border))",
                borderRadius: "var(--radius-control)",
                background: "color-mix(in srgb, var(--status-error) 7%, var(--bg-panel))",
                color: "var(--status-error)",
                fontSize: 12,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              <CircleAlert size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{errorMessage}</span>
            </div>
          )
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {replyRequest !== null && (
          <ReplyDistillFooter
            state={replyState}
            distillKey={replyRequest.key}
            showFull={showFullReply}
            onToggle={() => setShowFullReply((prev) => !prev)}
          />
        )}
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage, t, locale)}
          </div>
        )}
        {textContent && !isStreaming && (
          <Tooltip content={t("messageView.copyMessage")}>
            <button
              className="touch-reveal"
              onClick={() => copyContent(textContent)}
              aria-label={t("messageView.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                opacity: (hovered || actionsActive) ? 1 : 0,
                pointerEvents: (hovered || actionsActive) ? "auto" : "none",
                transition: "opacity var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
              }}
              onFocus={() => setActionsActive(true)}
              onBlur={() => setActionsActive(false)}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
              {copied ? t("messageView.copied") : t("messageView.copy")}
            </button>
          </Tooltip>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, isActiveStreamBlock, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex, thinkingDefaultExpanded, activityDisplayMode, distillThinking }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; isActiveStreamBlock?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number; thinkingDefaultExpanded: boolean; activityDisplayMode: ActivityDisplayMode; distillThinking: boolean }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} isActiveStreamBlock={isActiveStreamBlock} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} defaultExpanded={thinkingDefaultExpanded} isStreaming={isStreaming} isActiveStreamBlock={isActiveStreamBlock} distillThinking={distillThinking} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} isStreaming={isStreaming} isActiveStreamBlock={isActiveStreamBlock} activityDisplayMode={activityDisplayMode} />;
  }
  return null;
}

// Every message_update frame delivers freshly parsed block objects, so the
// block memos below compare content (text/thinking strings, tool call ids)
// instead of object identity: finished blocks of the streaming message then
// skip their ReactMarkdown re-parse and only the actively growing block
// re-renders per frame.
const TextBlock = memo(function TextBlock({ block, isStreaming, isActiveStreamBlock, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; isActiveStreamBlock?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <StreamingMarkdown text={block.text} streaming={isStreaming === true && isActiveStreamBlock === true} plain={false} />;
}, (prev, next) => (
  prev.block.text === next.block.text
  && prev.isStreaming === next.isStreaming
  && prev.isActiveStreamBlock === next.isActiveStreamBlock
  && prev.cwd === next.cwd
  && prev.onOpenFile === next.onOpenFile
));

/**
 * The distilled body that stands in for a finished reply — the full
 * distilled text renders at once. Presentational only: AssistantMessageView
 * decides whether to render it at all, based on whether the distillation
 * has produced any text yet.
 */
function DistilledReply({ text, cwd, onOpenFile }: { text: string; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return (
    <div className="distill-reply" data-testid="distilled-reply">
      <SafeMarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{text}</SafeMarkdownBody>
    </div>
  );
}

/**
 * The distilled reply's one quiet row: switch between the two versions, and
 * — only when a distillation actually failed — say so once, with a retry.
 * `unsupported` says nothing at all: the feature is dormant, not broken.
 */
function ReplyDistillFooter({ state, distillKey, showFull, onToggle }: { state: DistillState; distillKey: string; showFull: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const failed = state.errorCode !== null && state.errorCode !== "unsupported";
  const rowStyle = { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" } as const;
  const buttonStyle = {
    padding: "2px 6px", background: "none", border: "none", borderRadius: 4,
    color: "var(--text-dim)", cursor: "pointer", fontSize: 11, fontWeight: 400, whiteSpace: "nowrap",
  } as const;
  if (failed) {
    return (
      <div style={rowStyle}>
        <span>{t("distill.failed")}</span>
        <button type="button" className="ui-focus-ring" style={buttonStyle} onClick={() => retryDistill(distillKey)}>
          {t("distill.retry")}
        </button>
      </div>
    );
  }
  if (state.text === "") {
    return state.status === "running"
      ? <div style={rowStyle}><span className="distill-summary-wait">{t("distill.distilling")}</span></div>
      : null;
  }
  return (
    <div style={rowStyle}>
      <button
        type="button"
        className="ui-focus-ring"
        data-testid="distill-toggle"
        style={buttonStyle}
        onClick={onToggle}
        title={state.model === null ? undefined : t("distill.byModel", { model: state.model })}
      >
        {showFull ? t("distill.showDistilled") : t("distill.showFull")}
      </button>
    </div>
  );
}

/**
 * Motion state for a collapsible box (tool call / thinking): `animating` is
 * true from the moment the user toggles until the panel's height/max-width
 * transition ends, so `will-change` (the --motion modifier) exists only while
 * the resize is in flight. The timeout is a safety net for engines whose
 * panel transition never fires.
 */
function useCollapseMotion() {
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    if (!animating) return;
    const id = window.setTimeout(() => setAnimating(false), 600);
    return () => window.clearTimeout(id);
  }, [animating]);
  const beginToggle = useCallback(() => setAnimating(true), []);
  const onPanelTransitionEnd = useCallback((e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.propertyName === "height" || e.propertyName === "max-width") setAnimating(false);
  }, []);
  return { animating, beginToggle, onPanelTransitionEnd };
}

/**
 * The one-line summary a collapsed thinking box carries when Distill is on.
 *
 * Three sources, in priority order, all optional and all failure-tolerant:
 * the settled block's own summary (server-cached, so a re-read is free), the
 * live one written while the block was still growing, and nothing at all.
 * A block whose summary never arrives renders exactly as it does today.
 *
 * While the reasoning streams, a new summary is asked for once the block has
 * grown THINKING_DISTILL_GROWTH_CHARS since the last request and at least
 * THINKING_DISTILL_INTERVAL_MS has passed; each supersedes the one before.
 * Settled blocks wait until they are actually scrolled to, so opening a long
 * session distills nothing.
 */
function useThinkingSummary({ enabled, sessionId, entryId, blockIndex, thinking, deferred, isStreaming, isActiveStreamBlock }: {
  enabled: boolean;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
  thinking: string;
  deferred: boolean;
  isStreaming: boolean;
  isActiveStreamBlock: boolean;
}): { text: string; working: boolean; ref: (node: HTMLElement | null) => void } {
  const liveKey = enabled && sessionId !== undefined ? `${sessionId}:live:${blockIndex}` : null;
  const finalKey = enabled && sessionId !== undefined && entryId !== undefined ? `${sessionId}:${entryId}:${blockIndex}` : null;
  const liveState = useDistillState(liveKey);
  const finalState = useDistillState(finalKey);

  const latestRef = useRef(thinking);
  latestRef.current = thinking;
  const askedLenRef = useRef(0);
  const askedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const growing = liveKey !== null && sessionId !== undefined && isStreaming && isActiveStreamBlock;
  useEffect(() => {
    // No cleanup on text change: a pending timer must survive the next token
    // batch, or a fast stream would clear it before it ever fires.
    if (!growing || liveKey === null || sessionId === undefined) return;
    if (timerRef.current !== null) return;
    if (latestRef.current.length - askedLenRef.current < THINKING_DISTILL_GROWTH_CHARS) return;
    const wait = Math.max(0, THINKING_DISTILL_INTERVAL_MS - (Date.now() - askedAtRef.current));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const text = latestRef.current;
      askedLenRef.current = text.length;
      askedAtRef.current = Date.now();
      requestDistill({ key: liveKey, sessionId, blockIndex, kind: "thinking", text, final: false });
    }, wait);
  }, [growing, liveKey, sessionId, blockIndex, thinking]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const [attach, seen] = useSeenOnScreen(finalKey !== null && !isStreaming);
  const [historyText, setHistoryText] = useState<string | null>(null);
  useEffect(() => {
    if (!seen || finalKey === null || sessionId === undefined || entryId === undefined) return;
    const text = deferred ? historyText : thinking;
    if (text === null) {
      // Deferred history keeps the reasoning behind a route. The loader is
      // shared with the expand path, so a summary and an expand of the same
      // block cost one request between them.
      let alive = true;
      void loadThinkingContent(sessionId, entryId, blockIndex)
        .then((loaded) => { if (alive) setHistoryText(loaded); })
        .catch(() => { /* unreadable history: no summary, the box is unchanged */ });
      return () => { alive = false; };
    }
    if (text === "") return;
    requestDistill({ key: finalKey, sessionId, entryId, blockIndex, kind: "thinking", text, final: true });
  }, [seen, finalKey, sessionId, entryId, blockIndex, deferred, thinking, historyText]);

  const text = useMemo(() => {
    if (finalState.text !== "") return finalState.text;
    // The live summary stands in until the settled one lands, but only when
    // it was written about a PREFIX of this block: keys are per session and
    // block index, so a later turn's live summary must not leak backwards.
    if (liveState.text !== "" && liveState.source !== "" && thinking.startsWith(liveState.source)) return liveState.text;
    return "";
  }, [finalState.text, liveState.text, liveState.source, thinking]);

  return {
    text,
    working: text === "" && (finalState.status === "running" || liveState.status === "running"),
    ref: attach,
  };
}

const ThinkingBlock = memo(function ThinkingBlock({ block, duration, sessionId, entryId, blockIndex, defaultExpanded, isStreaming, isActiveStreamBlock, distillThinking }: {
  block: ThinkingContent;
  duration?: number;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
  /** The Interface & Behavior preference. Only the initial state: a block the
   * user has opened or closed keeps that choice, so flipping the preference
   * moves every untouched block without reopening ones they dismissed. */
  defaultExpanded: boolean;
  isStreaming?: boolean;
  isActiveStreamBlock?: boolean;
  /** Distill is on AND this instance can serve it: summarize while collapsed. */
  distillThinking: boolean;
}) {
  const { t } = useI18n();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? (defaultExpanded || (isStreaming === true && isActiveStreamBlock === true));
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { animating, beginToggle, onPanelTransitionEnd } = useCollapseMotion();
  // History loads strip thinking text (session-reader deferThinking) and leave
  // it behind a route, so the fetch is driven by visibility however it was
  // reached: opened by hand, expanded by the preference at mount, or revealed
  // when the preference changes. One request per block, ever.
  const requestedRef = useRef(false);
  const summary = useThinkingSummary({
    enabled: distillThinking && !expanded,
    sessionId,
    entryId,
    blockIndex,
    thinking: block.thinking ?? "",
    deferred: block.deferred === true,
    isStreaming: isStreaming === true,
    isActiveStreamBlock: isActiveStreamBlock === true,
  });

  useEffect(() => {
    if (!expanded || !block.deferred || requestedRef.current) return;
    requestedRef.current = true;
    if (!sessionId || !entryId) {
      setError(t("messageView.thinkingUnavailable"));
      return;
    }

    setLoading(true);
    void loadThinkingContent(sessionId, entryId, blockIndex)
      .then((text) => setContent(text))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [expanded, block.deferred, sessionId, entryId, blockIndex, t]);

  const handleOpenChange = (nextOpen: boolean) => {
    beginToggle();
    setUserExpanded(nextOpen);
  };

  return (
    <div
      ref={summary.ref}
      className="collapse-box chat-block-in"
      data-expanded={expanded ? "" : undefined}
      data-streaming={isStreaming === true && isActiveStreamBlock === true ? "" : undefined}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <Collapsible
        open={expanded}
        onOpenChange={handleOpenChange}
      >
        <CollapsibleTrigger
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "6px 10px",
            background: "var(--bg-panel)",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 400,
            textAlign: "left",
          }}
        >
          <Brain size={11} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          <span>{t("messageView.thinking")}</span>
          {duration !== undefined && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{t("messageView.durationSeconds", { seconds: duration })}</span>
          )}
          <ChevronRight
            size={10}
            strokeWidth={1.6}
            style={{
              flexShrink: 0,
              marginLeft: duration === undefined ? "auto" : 4,
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform var(--dur-fast) var(--ease-out-warm)",
            }}
          />
        </CollapsibleTrigger>
        {!expanded && (summary.text !== "" || summary.working) && (
          <div className="distill-summary" data-testid="thinking-summary" title={summary.text === "" ? undefined : summary.text}>
            {summary.text === ""
              ? <span className="distill-summary-wait">{t("distill.summarizing")}</span>
              : <span key={summary.text} className="distill-summary-line">{summary.text}</span>}
          </div>
        )}
        <CollapsiblePanel
          className={`collapse-box-panel${animating ? " collapse-box-panel--motion" : ""}`}
          onTransitionEnd={onPanelTransitionEnd}
        >
          <div
            className="collapse-box-inner"
            style={{
              padding: "8px 10px",
              color: error ? "var(--status-error)" : "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              background: "var(--bg-panel)",
              borderTop: "1px solid var(--border)",
            }}
          >
            {loading
              ? t("messageView.loadingThinking")
              : error ?? (block.deferred
                ? content
                : <StreamingMarkdown text={block.thinking ?? ""} streaming={isStreaming === true && expanded} plain={true} />)}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}, (prev, next) => (
  prev.block.thinking === next.block.thinking
  && prev.block.deferred === next.block.deferred
  && prev.duration === next.duration
  && prev.sessionId === next.sessionId
  && prev.entryId === next.entryId
  && prev.blockIndex === next.blockIndex
  && prev.defaultExpanded === next.defaultExpanded
  && prev.isStreaming === next.isStreaming
  && prev.isActiveStreamBlock === next.isActiveStreamBlock
  && prev.distillThinking === next.distillThinking
));


interface HubSendSummary {
  to: string[];
  message: string;
  snippet: string;
}

interface HubJobRow {
  id: string;
  type: string;
  status: string;
  label: string;
  durationMs?: number;
  resolvedModel?: string;
}

function isHubToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "hub" || name.endsWith(".hub") || name.endsWith("_hub");
}

/** Outgoing agent steering: `hub` with `op: "send"`. */
function getHubSendSummary(input: unknown): HubSendSummary | null {
  if (!isRecord(input) || input.op !== "send") return null;
  const raw = Array.isArray(input.to) ? input.to : typeof input.to === "string" ? [input.to] : [];
  const to = raw
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, 10);
  if (to.length === 0) return null;
  const message = typeof input.message === "string" ? input.message : "";
  const firstLine = message.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const snippet = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return { to, message, snippet };
}

/** Structured hub job roster returned by `hub` with `op: "jobs"`. */
function getHubJobs(details: unknown): HubJobRow[] | null {
  if (!isRecord(details) || details.op !== "jobs" || !Array.isArray(details.jobs)) return null;
  const rows: HubJobRow[] = [];
  for (const raw of details.jobs) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (!id) continue;
    rows.push({
      id,
      type: typeof raw.type === "string" ? raw.type : "task",
      status: typeof raw.status === "string" ? raw.status : "running",
      label: typeof raw.label === "string" && raw.label ? raw.label : id,
      ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
      ...(typeof raw.resolvedModel === "string" && raw.resolvedModel ? { resolvedModel: raw.resolvedModel } : {}),
    });
    if (rows.length >= 50) break;
  }
  return rows.length > 0 ? rows : null;
}

function getHubJobsHeader(jobs: HubJobRow[]): string {
  const waiting = jobs.some((job) => job.status === "running" || job.status === "started" || job.status === "waiting");
  return waiting ? `waiting on ${jobs.length} job${jobs.length === 1 ? "" : "s"}` : `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
}

function formatHubJobDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 1000) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function getHubReceiptOutcome(details: unknown): string | null {
  if (!isRecord(details) || !Array.isArray(details.receipts) || details.receipts.length === 0) return null;
  const outcomes = details.receipts.map((receipt) => (
    isRecord(receipt) && typeof receipt.outcome === "string" ? receipt.outcome : null
  ));
  if (outcomes.some((outcome) => outcome === null || outcome !== outcomes[0])) return null;
  return outcomes[0];
}

function getHubReceipts(details: unknown): Array<{ to: string; outcome: string }> {
  if (!isRecord(details) || !Array.isArray(details.receipts)) return [];
  const out: Array<{ to: string; outcome: string }> = [];
  for (const raw of details.receipts) {
    if (!isRecord(raw) || typeof raw.to !== "string" || raw.to.length === 0) continue;
    out.push({ to: raw.to, outcome: typeof raw.outcome === "string" ? raw.outcome : "sent" });
    if (out.length >= 50) break;
  }
  return out;
}

const ToolCallBlock = memo(function ToolCallBlock({ block, result, duration, isStreaming, isActiveStreamBlock, activityDisplayMode = "compact" }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; isStreaming?: boolean; isActiveStreamBlock?: boolean; activityDisplayMode?: ActivityDisplayMode }) {
  const { t } = useI18n();
  const isRunning = result?.partial === true;
  const isError = result?.isError ?? false;
  const hidden = activityDisplayMode === "hidden" && !isError;
  const [expanded, setExpanded] = useState(activityDisplayMode === "full" || isError || isRunning);
  useEffect(() => {
    if (activityDisplayMode === "full" || isError) setExpanded(true);
    else if (activityDisplayMode === "compact") setExpanded(false);
  }, [activityDisplayMode, isError]);
  const { animating, beginToggle, onPanelTransitionEnd } = useCollapseMotion();
  const inputJson = useMemo(() => JSON.stringify(block.input, null, 2) ?? "", [block.input]);
  const displayedJson = inputJson;
  const displayedPreview = getToolPreview(block);
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const activityStatus = isRunning ? t("chatWindow.runningTool") : getStructuredActivityStatus(result);
  // Hub steering and job-roster calls use the same semantic row language as
  // OMP's TUI while retaining the generic renderer as a safe fallback.
  const hubSend = isHubToolName(block.toolName) ? getHubSendSummary(block.input) : null;
  const hubJobs = isHubToolName(block.toolName) ? getHubJobs(result?.details) : null;
  const hubReceiptOutcome = hubSend ? getHubReceiptOutcome(result?.details) : null;
  const hubToolLabel = hubSend
    ? `IRC → ${hubSend.to.join(", ")}${hubReceiptOutcome ? ` ${hubReceiptOutcome}` : ""}`
    : hubJobs
      ? getHubJobsHeader(hubJobs)
      : null;
  const hubPreview = hubSend
    ? (hubSend.snippet || hubSend.to.join(", "))
    : hubJobs
      ? hubJobs.map((job) => job.label).join(" · ")
      : null;
  const hasStructuredHubResult = Boolean(
    hubJobs ||
    (hubSend && result && !isError && isRecord(result.details) && result.details.op === "send"),
  );

  // Result display
  const resultText = result
    ? (typeof result.content === "string"
        ? result.content
        : (Array.isArray(result.content) ? result.content : [])
            .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n"))
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  // Tool-result images (preview_screenshot and friends) render as
  // always-visible thumbnails, not behind the collapse — a screenshot the
  // agent took of its work is the point of the tool call.
  const resultImages = result && Array.isArray(result.content)
    ? result.content.filter((b): b is ImageContent => b.type === "image")
    : [];

  if (hidden) return null;
  return (
    <div
      className="collapse-box chat-block-in"
      data-tool-state={isRunning ? "running" : result ? "complete" : undefined}
      aria-busy={isRunning || undefined}
      data-expanded={expanded ? "" : undefined}
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid color-mix(in srgb, var(--status-error) 45%, transparent)" : "1px solid color-mix(in srgb, var(--status-success) 25%, transparent)",
        background: isError ? "color-mix(in srgb, var(--status-error) 5%, transparent)" : "color-mix(in srgb, var(--status-success) 4%, transparent)",
      }}
    >
      <Collapsible
        open={expanded}
        onOpenChange={(next) => { beginToggle(); setExpanded(next); }}
      >
        {/* ── Tool call header ── */}
        <CollapsibleTrigger
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "6px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 400,
            textAlign: "left",
            minWidth: 0,
          }}
        >
          {isRunning && <LoaderCircle size={12} strokeWidth={1.8} className="icon-spin" aria-hidden="true" style={{ flexShrink: 0, color: "var(--status-success)" }} />}
          <span style={{ color: isError ? "var(--status-error)" : "var(--status-success)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
            {hubToolLabel ?? block.toolName}
          </span>
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "64ch", marginRight: "auto" }}>
            {hubPreview ?? displayedPreview}
          </span>
          {activityStatus && <span aria-live={isRunning ? "polite" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: activityStatus === "error" ? "var(--status-error)" : "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0 }}>{activityStatus}</span>}
          {duration !== undefined && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{t("messageView.durationSeconds", { seconds: duration })}</span>
          )}
          <ChevronRight
            size={10}
            strokeWidth={1.6}
            style={{
              flexShrink: 0,
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform var(--dur-fast) var(--ease-out-warm)",
            }}
          />
        </CollapsibleTrigger>

        {/* ── Expanded content (input args + paired result), mounted by the
            panel and width-pinned by .collapse-box-inner so the grow
            animation never re-wraps text ── */}
        <CollapsiblePanel
          className={`collapse-box-panel${animating ? " collapse-box-panel--motion" : ""}`}
          onTransitionEnd={onPanelTransitionEnd}
        >
          <div className="collapse-box-inner">
            {!isEditTool && (
              <pre
                style={{
                  margin: 0,
                  padding: "8px 10px",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  overflow: "auto",
                  overscrollBehavior: "contain",
                  backgroundColor: "var(--bg-subtle)",
                  borderTop: isError ? "1px solid color-mix(in srgb, var(--status-error) 25%, transparent)" : "1px solid color-mix(in srgb, var(--status-success) 20%, transparent)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {displayedJson}
              </pre>
            )}
            {result && (
              <div data-tool-output={isRunning && !resultIsEmpty ? "true" : undefined}>
                {isRunning && resultIsEmpty ? (
                  <>
                    <TaskResultPanel details={result.details} />
                    <HubResultPanel input={block.input} result={result} />
                    <div data-tool-running="true" style={{ padding: "8px 10px", borderTop: "1px solid color-mix(in srgb, var(--status-success) 15%, transparent)", color: "var(--text-dim)", fontSize: 12 }}>
                      {t("chatWindow.runningTool")}
                    </div>
                  </>
                ) : resultDiff ? (
                  <PairedDiffResult
                    diff={resultDiff}
                  />
                ) : (
                  <>
                    <TaskResultPanel details={result.details} />
                    <HubResultPanel input={block.input} result={result} />
                    {!hasStructuredHubResult && (
                      <PairedResult
                        text={resultText ?? ""}
                        isEmpty={resultIsEmpty}
                        isError={isError}
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
      {(expanded || isError) && resultImages.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 10px", borderTop: "1px solid color-mix(in srgb, var(--status-success) 20%, transparent)" }}>
          {resultImages.map((img, i) => {
            const src = imageSource(img);
            return src ? (
              <ClickableImage
                key={i}
                src={src}
                alt=""
                style={{ maxWidth: "min(440px, 100%)", maxHeight: 260, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)", background: "#fff" }}
              />
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}, (prev, next) => (
  // Input compares by reference: a streaming tool call re-parses its input
  // each frame (new object) and correctly re-renders; settled transcript
  // blocks keep their identity and skip.
  prev.block.toolCallId === next.block.toolCallId
  && prev.block.toolName === next.block.toolName
  && prev.block.input === next.block.input
  && prev.result === next.result
  && prev.duration === next.duration
  && prev.isStreaming === next.isStreaming
  && prev.isActiveStreamBlock === next.isActiveStreamBlock
  && prev.activityDisplayMode === next.activityDisplayMode
));

interface ResultDiff {
  text: string;
}

type TaskResultRowLike = Record<string, unknown>;

function taskRowStatus(row: TaskResultRowLike): "started" | "completed" | "failed" | "aborted" {
  if (row.aborted === true) return "aborted";
  if (typeof row.error === "string" && row.error) return "failed";
  if (typeof row.exitCode === "number") return row.exitCode === 0 ? "completed" : "failed";
  const status = row.status;
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "started";
}

function TaskResultStatusIcon({ status }: { status: "started" | "completed" | "failed" | "aborted" }) {
  return <SubagentStatusIcon status={status} />;
}

/**
 * Compact per-subagent summary rendered inside an expanded `task` tool call.
 * Feeds off the size-bounded task details allowlisted by the session reader
 * (lib/session-reader.ts stripToolResultDetails): settled results when
 * present, otherwise the mid-run progress snapshot.
 */
export function TaskResultPanel({ details }: { details: unknown }) {
  const { t, tn } = useI18n();
  if (!isRecord(details)) return null;
  const results = (Array.isArray(details.results) ? details.results : []).filter(isRecord);
  const progress = (Array.isArray(details.progress) ? details.progress : []).filter(isRecord);
  const asyncInfo = isRecord(details.async) ? details.async : null;
  if (results.length === 0 && progress.length === 0 && !asyncInfo) return null;

  // Settled results win; otherwise the mid-run progress snapshot; a bare
  // async marker (spawn recorded, no rows yet) still names the job.
  const rows = results.length > 0
    ? results
    : progress.length > 0
      ? progress
      : asyncInfo && typeof asyncInfo.jobId === "string"
        ? [{ id: asyncInfo.jobId, agent: "task", status: "started", task: asyncInfo.jobId } as TaskResultRowLike]
        : [];
  const totalTokens = rows.reduce((sum, row) => sum + (typeof row.tokens === "number" ? row.tokens : 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + (typeof row.cost === "number" ? row.cost : 0), 0);
  const totalDurationMs = typeof details.totalDurationMs === "number" ? details.totalDurationMs : undefined;
  const totalTokensLabel = formatTokens(totalTokens);
  const totalParts = [
    tn("chatWindow.subagentCount", rows.length),
    totalTokensLabel ? t("chatWindow.tokensUnit", { count: totalTokensLabel }) : null,
    formatCost(totalCost),
    formatDuration(totalDurationMs),
  ].filter(Boolean);

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        padding: "8px 10px",
        display: "grid",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{t("messageView.taskSubagents")}</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: 10.5 }}>
          {totalParts.join(" · ")}
        </span>
        {asyncInfo && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>⤴</span>
        )}
      </div>
      {rows.map((row, index) => {
        const id = typeof row.id === "string" ? row.id : `row-${index}`;
        const status = taskRowStatus(row);
        const task = typeof row.task === "string" && row.task ? row.task : (typeof row.assignment === "string" ? row.assignment : null);
        const rowTokens = formatTokens(typeof row.tokens === "number" ? row.tokens : undefined);
        const rowParts = [
          rowTokens ? t("chatWindow.tokensUnit", { count: rowTokens }) : null,
          formatCost(typeof row.cost === "number" ? row.cost : undefined),
          status !== "started" ? formatDuration(typeof row.durationMs === "number" ? row.durationMs : undefined) : null,
          shortModel(typeof row.resolvedModel === "string" ? row.resolvedModel : undefined),
        ].filter(Boolean);
        return (
          <div
            key={id}
            aria-label={`${typeof row.agent === "string" ? row.agent : "subagent"}: ${t(`chatWindow.subagentState.${status}`)}${task ? ` — ${task}` : ""}`}
            style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 11.5 }}
          >
            <TaskResultStatusIcon status={status} />
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
              {typeof row.agent === "string" ? row.agent : "subagent"}
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, color: "var(--text)" }}>
              {task ?? ""}
            </span>
            {rowParts.length > 0 && (
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                {rowParts.join(" · ")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Structured semantic body for `hub` tool calls. Outgoing steering renders
 * the target and message; the jobs operation renders the bounded roster.
 * Unknown or malformed hub operations deliberately fall back to the generic
 * tool-result renderer.
 */
export function HubResultPanel({ input, result }: { input: unknown; result?: ToolResultMessage }) {
  if (!isRecord(input) || typeof input.op !== "string") return null;

  if (input.op === "send") {
    const send = getHubSendSummary(input);
    if (!send) return null;
    const receipts = getHubReceipts(result?.details);
    return (
      <div
        data-hub-result="send"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--bg-subtle)",
          padding: "8px 10px",
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>{`IRC → ${send.to.join(", ")}`}</span>
          {receipts.length > 0 && (
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: 10.5 }}>
              {receipts.map((receipt) => receipt.outcome).join(" · ")}
            </span>
          )}
        </div>
        {send.message ? <MarkdownBody className="markdown-hub-message">{send.message}</MarkdownBody> : null}
      </div>
    );
  }

  if (input.op === "jobs") {
    const jobs = getHubJobs(result?.details);
    if (!jobs) return null;
    return (
      <div
        data-hub-result="jobs"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--bg-subtle)",
          padding: "8px 10px",
          display: "grid",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>{getHubJobsHeader(jobs)}</span>
        </div>
        {jobs.map((job) => {
          const duration = formatHubJobDuration(job.durationMs);
          const status = job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "started";
          return (
            <div
              key={job.id}
              style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 11.5 }}
            >
              <SubagentStatusIcon status={status} />
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
                {`[${job.type}]`}
              </span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, color: "var(--text)" }}>
                {job.label}
              </span>
              {duration && (
                <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  {duration}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return null;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid color-mix(in srgb, var(--status-success) 15%, transparent)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const { t } = useI18n();
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <SplitDiffHeader title={file.oldPath || t("messageView.diffBefore")} side="left" />
              <SplitDiffHeader title={file.newPath || t("messageView.diffAfter")} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "color-mix(in srgb, var(--status-success) 12%, transparent)"
      : cell.type === "removed"
      ? "color-mix(in srgb, var(--status-error) 13%, transparent)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "var(--status-success)" : cell.type === "removed" ? "var(--status-error)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "color-mix(in srgb, var(--status-success) 12%, transparent)" :
          kind === "removed" ? "color-mix(in srgb, var(--status-error) 13%, transparent)" :
          kind === "hunk" ? "color-mix(in srgb, var(--accent) 12%, transparent)" :
          "transparent";
        const color =
          kind === "added" ? "var(--status-success)" :
          kind === "removed" ? "var(--status-error)" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid var(--status-success)"
                : kind === "removed"
                ? "3px solid var(--status-error)"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function getStructuredActivityStatus(result?: ToolResultMessage): string | null {
  if (!result) return null;
  if (result.isError) return "error";
  if (!isRecord(result.details)) return null;
  const asyncDetails = result.details.async;
  if (isRecord(asyncDetails) && typeof asyncDetails.state === "string") return asyncDetails.state;
  return null;
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  const [showFull, setShowFull] = useState(false);
  // A tool result can hold megabytes in a single text node, and `pre-wrap` +
  // `break-all` makes the engine line-break the whole blob even though only
  // 400px of it is visible — then redo it on every width change (sidebar
  // drag). Show the head until the rest is asked for.
  const truncated = !isEmpty && !showFull && text.length > MAX_INLINE_RESULT_CHARS;
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "color-mix(in srgb, var(--status-error) 30%, transparent)" : "color-mix(in srgb, var(--status-success) 15%, transparent)"}`,
        background: isError ? "color-mix(in srgb, var(--status-error) 4%, transparent)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "var(--status-error)" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          // Without this the wheel latches to this box and then chains out to
          // the transcript with a visible stall.
          overscrollBehavior: "contain",
          maxHeight: 400,
          backgroundColor: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? t("messageView.noOutput") : (truncated ? text.slice(0, MAX_INLINE_RESULT_CHARS) : text)}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowFull(true)}
          style={{
            display: "block", width: "100%",
            padding: "6px 10px",
            border: "none",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 12,
            textAlign: "left",
            fontFamily: "inherit",
          }}
        >
          {t("messageView.viewFullOutput")}
        </button>
      )}
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t, locale } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp, locale);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {t("messageView.compactionLabel")}
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>
            {t("messageView.conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: 14, lineHeight: 1.5 }}>
            {t("messageView.compactionDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("messageView.noSummary")}</span>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(t("messageView.filesReadCount", { count: readFiles.length }));
  if (modifiedFiles.length > 0) parts.push(t("messageView.filesModifiedCount", { count: modifiedFiles.length }));

  return (
    <details className="compaction-file-details">
      <summary>{t("messageView.fileContext", { parts: parts.join(", ") })}</summary>
      {modifiedFiles.length > 0 && <CompactionFileList title={t("messageView.modifiedFiles")} files={modifiedFiles} />}
      {readFiles.length > 0 && <CompactionFileList title={t("messageView.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile, activityDisplayMode }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void; activityDisplayMode: ActivityDisplayMode }) {
  const { t, locale } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback();
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const isIrc = IRC_CUSTOM_TYPES.has(message.customType);
  const actionableError = isRecord(message.details) && message.details.notifyType === "error";
  if (activityDisplayMode === "hidden" && !actionableError) return null;
  const ircEnvelope = isIrc ? parseIrcEnvelope(text) : null;
  const displayText = ircEnvelope ? ircEnvelope.body : text;
  const title = isIrc
    ? (ircEnvelope?.sender ?? formatCustomType(message.customType))
    : message.customType === "advisor"
      ? t("messageView.advisorLabel")
      : formatCustomType(message.customType);
  const time = formatTime(message.timestamp, locale);


  return (
    <div className="chat-message collapse-scope" style={{ marginBottom: 16 }}>
      <div
        className="collapse-box"
        data-expanded={contentExpanded ? "" : undefined}
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {isIrc && message.customType === "irc:incoming" ? `← ${title}` : title}
          </span>
          {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("messageView.hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: displayText ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    <ClickableImage
                      key={i}
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  );
                })}
              </div>
            )}
            {displayText ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{displayText}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("messageView.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {displayText ? previewText(displayText) : t("messageView.showExtensionMessage")}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={() => copyContent(displayText || detailsText)}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {copied ? t("messageView.copied") : t("messageView.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay
                ? (contentExpanded ? t("messageView.collapse") : t("messageView.expand"))
                : (detailsExpanded ? t("messageView.hideDetails") : t("messageView.showDetails"))}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              backgroundColor: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              overscrollBehavior: "contain",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

/** data:/url src for an image block (nested source or pi-ai flat data shape).
 * Shared with ChatWindow's process-group thumbnail strip. */
export function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || translate("messageView.extensionType");
}

// Peer IRC messages are persisted as custom_message entries whose content is
// an envelope: "<irc>\nIncoming IRC message from agent `Name`:\n<body>". The
// card title must show the SENDER, not the raw customType.
const IRC_CUSTOM_TYPES = new Set(["irc:incoming", "irc:autoreply", "irc:relay"]);

function parseIrcEnvelope(content: string): { sender: string | null; body: string } {
  const lines = content.split("\n");
  let sender: string | null = null;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/agent\s*`([^`]+)`/);
    if (match) {
      sender = match[1];
      bodyStart = i + 1;
      break;
    }
  }
  return { sender, body: lines.slice(bodyStart).join("\n").trim() };
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return translate("messageView.showExtensionMessage");
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";

  if (isHubToolName(block.toolName) && isRecord(input)) {
    if (input.op === "send") {
      const send = getHubSendSummary(input);
      if (send) return send.snippet;
      return "send";
    }
    if (input.op === "jobs") return "jobs";
    if (typeof input.op === "string") return input.op;
  }

  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  },
  t: (key: string, vars?: Record<string, string | number>) => string,
  locale: Locale,
): string {
  const parts = [];
  if (usage.input) parts.push(t("messageView.usageInput", { tokens: usage.input.toLocaleString(locale) }));
  if (usage.output) parts.push(t("messageView.usageOutput", { tokens: usage.output.toLocaleString(locale) }));
  if (usage.cacheRead) parts.push(t("messageView.usageCacheRead", { tokens: usage.cacheRead.toLocaleString(locale) }));
  if (usage.cacheWrite) parts.push(t("messageView.usageCacheWrite", { tokens: usage.cacheWrite.toLocaleString(locale) }));
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function BashExecutionView({ message, sessionId, activityDisplayMode = "compact" }: { message: BashExecutionMessage; sessionId?: string; activityDisplayMode?: ActivityDisplayMode }) {
  const { t } = useI18n();
  const [fullOutput, setFullOutput] = useState<{ phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; output: string } | null>(null);
  // Bumped on every message change; an in-flight fetch from the previous
  // message must not write into the reused component instance.
  const fullOutputGenRef = useRef(0);
  // Branch navigation can swap a different bashExecution message into the same
  // index; the component instance is reused, so drop any loaded full output
  // (and its "ready" re-load guard) whenever the message identity changes.
  useEffect(() => {
    fullOutputGenRef.current += 1;
    setFullOutput(null);
  }, [message.command, message.fullOutputPath, message.output, message.timestamp]);
  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: message.output ? [{ type: "text", text: message.output }] : [],
        isError,
        timestamp: message.timestamp,
      };

  // Large executions record their full output to a temp file (fullOutputPath);
  // fetch it through the guarded bash-output route instead of re-reading the
  // truncated session payload.
  const loadFullOutput = useCallback(async () => {
    if (!message.fullOutputPath || !sessionId || fullOutput?.phase === "ready") return;
    const gen = fullOutputGenRef.current;
    setFullOutput({ phase: "loading" });
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`);
      const data = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (fullOutputGenRef.current !== gen) return;
      if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFullOutput({ phase: "ready", output: data.data?.output ?? "" });
    } catch (e) {
      if (fullOutputGenRef.current !== gen) return;
      setFullOutput({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [message.fullOutputPath, sessionId, fullOutput?.phase]);

  const downloadUrl = message.fullOutputPath && sessionId
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}&download=1`
    : null;

  if (activityDisplayMode === "hidden" && !isError) return null;
  return (
    <div className="chat-message collapse-scope" style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} activityDisplayMode={activityDisplayMode} />
      {downloadUrl && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
          {fullOutput?.phase !== "ready" && (
            <button
              type="button"
              disabled={fullOutput?.phase === "loading"}
              onClick={() => void loadFullOutput()}
              style={{ padding: 0, border: "none", background: "none", color: "var(--accent)", cursor: fullOutput?.phase === "loading" ? "default" : "pointer", fontSize: 12, opacity: fullOutput?.phase === "loading" ? 0.6 : 1, fontFamily: "inherit" }}
            >
              {fullOutput?.phase === "loading" ? t("messageView.fullOutputLoading") : t("messageView.viewFullOutput")}
            </button>
          )}
          <a href={downloadUrl} download style={{ color: "var(--text-dim)", fontSize: 12, textDecoration: "none" }}>
            {t("messageView.fullOutputDownload")}
          </a>
        </div>
      )}
      {fullOutput?.phase === "ready" && (
        <div style={{ maxHeight: 420, overflow: "auto", overscrollBehavior: "contain", marginTop: 6, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
          <pre style={{ margin: 0, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)" }}>
            {fullOutput.output}
          </pre>
        </div>
      )}
      {fullOutput?.phase === "error" && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--status-error)" }}>{fullOutput.message}</div>
      )}
    </div>
  );
}
