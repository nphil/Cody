"use client";

import { memo, useState, useRef, useEffect, useMemo, useCallback, type ComponentProps, type TransitionEvent } from "react";
import { Copy, Check, GitFork, CornerUpLeft, ChevronRight, Brain } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { ClickableImage } from "./ImageLightbox";
import { translate, useI18n, type Locale } from "@/lib/i18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { isEmptyThinkingBlock } from "@/lib/message-display";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { Tooltip, Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./ui/primitives";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useSmoothStreamText, shouldPaceStream, splitMarkdownReveal, splitPlainReveal, chunkRevealWords, type StreamPaceMode, type StreamPacerOptions } from "@/hooks/useSmoothStreamText";
import { useStreamTuning } from "@/hooks/useStreamTuning";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
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
} from "@/lib/types";

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();
const MAX_MARKDOWN_CHARS = 100_000;
/** Tool output rendered inline before the "view full output" reveal. */
const MAX_INLINE_RESULT_CHARS = 200_000;

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
  toolCallsDefaultCollapsed?: boolean;
  thinkingDefaultExpanded?: boolean;
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

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, sessionId, toolCallsDefaultCollapsed = true, thinkingDefaultExpanded = false }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} toolCallsDefaultCollapsed={toolCallsDefaultCollapsed} thinkingDefaultExpanded={thinkingDefaultExpanded} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "xdev-mount-notice") {
      return null;
    }
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
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
    && prev.toolCallsDefaultCollapsed === next.toolCallsDefaultCollapsed
    && prev.thinkingDefaultExpanded === next.thinkingDefaultExpanded;
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
  toolCallsDefaultCollapsed,
  thinkingDefaultExpanded,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  toolCallsDefaultCollapsed: boolean;
  thinkingDefaultExpanded: boolean;
}) {
  const { t, locale } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp, locale) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  // Only the last block of the live message is still growing; earlier blocks
  // became final the moment a successor appeared and must render (and flush)
  // as settled text, so pacing and word entrances apply to exactly one block.
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

  if (blocks.length === 0 && !isStreaming) return null;

  // The --live bar is an unboxed-text affordance: boxed blocks (tool calls,
  // thinking) carry their own borders, and the full-height accent bar would
  // paint over their left edge while a tool is running.
  const isLiveText = isStreaming && !blocks.some((b) => b.type === "toolCall" || b.type === "thinking");

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
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
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
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} isStreaming={isStreaming} isActiveStreamBlock={originalIndex === activeStreamIndex} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} toolCallsDefaultCollapsed={toolCallsDefaultCollapsed} thinkingDefaultExpanded={thinkingDefaultExpanded} />
        ))}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
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

function BlockView({ block, toolResults, isStreaming, isActiveStreamBlock, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex, toolCallsDefaultCollapsed, thinkingDefaultExpanded }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; isActiveStreamBlock?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number; toolCallsDefaultCollapsed: boolean; thinkingDefaultExpanded: boolean }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} isActiveStreamBlock={isActiveStreamBlock} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} defaultExpanded={thinkingDefaultExpanded} isStreaming={isStreaming} isActiveStreamBlock={isActiveStreamBlock} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} isStreaming={isStreaming} isActiveStreamBlock={isActiveStreamBlock} defaultCollapsed={toolCallsDefaultCollapsed} />;
  }
  return null;
}

/** Pacer options for one block, derived from the live tuning. In "drain"
 *  mode the faster drain rate replaces the streaming catch-up rate. */
function usePacerOptions(mode: StreamPaceMode, lenient = false): StreamPacerOptions | undefined {
  const tuning = useStreamTuning();
  return useMemo(() => (mode === "snap" ? undefined : {
    catchUpMs: mode === "drain" ? tuning.drainCatchUpMs : tuning.catchUpMs,
    minRevealChars: tuning.minRevealChars,
    maxBacklogChars: tuning.maxBacklogChars,
    wordLookaheadChars: tuning.wordLookaheadChars,
    lenientPrefix: lenient,
  }), [mode, lenient, tuning]);
}

// Every message_update frame delivers freshly parsed block objects, so the
// block memos below compare content (text/thinking strings, tool call ids)
// instead of object identity: finished blocks of the streaming message then
// skip their ReactMarkdown re-parse and only the actively growing block
// re-renders per frame.
const TextBlock = memo(function TextBlock({ block, isStreaming, isActiveStreamBlock, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; isActiveStreamBlock?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const tuning = useStreamTuning();
  // Oversized messages fall back to SafeMarkdownBody's raw-reveal button;
  // pacing text that will not render as markdown is pointless churn.
  const sizeOk = block.text.length <= MAX_MARKDOWN_CHARS;
  const paced = shouldPaceStream({
    isStreaming: isStreaming === true,
    isActiveBlock: isActiveStreamBlock === true,
    prefersReducedMotion,
  }) && sizeOk;
  // A superseded block (a tool call started below it) drains its remaining
  // backlog at the drain rate instead of snapping — when the knob is off
  // (drainCatchUpMs = 0, the default) it snaps exactly as it always has.
  const mode: StreamPaceMode = paced
    ? "pace"
    : isStreaming === true && sizeOk && !prefersReducedMotion && tuning.drainCatchUpMs > 0
      ? "drain"
      : "snap";
  const options = usePacerOptions(mode);
  const displayed = useSmoothStreamText(block.text, mode, options);
  const showPaced = mode === "pace" || (mode === "drain" && displayed !== block.text);
  if (!showPaced) {
    return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
  }
  return <PacedMarkdownText text={displayed} cwd={cwd} onOpenFile={onOpenFile} />;
}, (prev, next) => (
  prev.block.text === next.block.text
  && prev.isStreaming === next.isStreaming
  && prev.isActiveStreamBlock === next.isActiveStreamBlock
  && prev.cwd === next.cwd
  && prev.onOpenFile === next.onOpenFile
));

/**
 * The live block's paced render: a markdown prefix that only changes when a
 * completed line migrates into it, plus a plain-text tail of just-revealed
 * words that re-renders every animation frame. Per-frame work is the split
 * scan and a bounded window of tail spans — the markdown subtree is memoized
 * on the prefix string and skipped while only the tail grows, and the tail's
 * older words settle into a single static text node so an unbroken paragraph
 * cannot inflate the span count.
 */
function PacedMarkdownText({ text, cwd, onOpenFile }: { text: string; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const tuning = useStreamTuning();
  const split = useMemo(() => splitMarkdownReveal(text), [text]);
  const tailWindow = useMemo(() => splitPlainReveal(split.tail, tuning.plainTailWindowChars), [split.tail, tuning.plainTailWindowChars]);
  return (
    <div className="stream-reveal">
      {split.prefix !== "" && (
        <StreamRevealPrefix text={split.prefix} sampleParse={split.tail === ""} cwd={cwd} onOpenFile={onOpenFile} />
      )}
      {split.tail !== "" && (
        <div className={`markdown-body stream-reveal-tail${split.paragraphGap ? " stream-reveal-tail--para" : ""}`}>
          {tailWindow.prefix}
          {chunkRevealWords(tailWindow.tail, split.tailOffset + tailWindow.tailOffset).map((chunk) => (
            <span key={chunk.key} className="stream-word">{chunk.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// While the tail is live the prefix parses unsampled — it advances at line
// granularity, and the ≤10 Hz sampler's delay would blank each migrating
// line for up to 100ms (gone from the tail, not yet in the parse). In
// prefix-only mode (open code fence, oversized tail) the prefix grows per
// frame again, so the normal streaming sampling takes back over.
const StreamRevealPrefix = memo(function StreamRevealPrefix({ text, sampleParse, cwd, onOpenFile }: { text: string; sampleParse: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <SafeMarkdownBody isStreaming sampleParse={sampleParse} className="stream-reveal-prefix" cwd={cwd} onOpenFile={onOpenFile}>{text}</SafeMarkdownBody>;
});

/**
 * Streamed reasoning gets the same paced treatment as body text, but it is
 * plain pre-wrap text — no markdown-safety constraint — so the boundary just
 * keeps the trailing window animated. Gated on `active` (streaming + last
 * block + panel expanded): a collapsed panel must not run an invisible rAF
 * loop, and expanding mid-stream snaps to the current text instead of
 * replaying it.
 */
function PacedPlainText({ text, streaming, activeBlock }: { text: string; streaming: boolean; activeBlock: boolean }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const tuning = useStreamTuning();
  const paced = shouldPaceStream({ isStreaming: streaming, isActiveBlock: activeBlock, prefersReducedMotion });
  const mode: StreamPaceMode = paced
    ? "pace"
    : streaming && !prefersReducedMotion && tuning.drainCatchUpMs > 0
      ? "drain"
      : "snap";
  const options = usePacerOptions(mode);
  const displayed = useSmoothStreamText(text, mode, options);
  const showPaced = mode === "pace" || (mode === "drain" && displayed !== text);
  if (!showPaced) return <>{text}</>;
  const split = splitPlainReveal(displayed, tuning.plainTailWindowChars);
  return (
    <>
      {split.prefix}
      {chunkRevealWords(split.tail, split.tailOffset).map((chunk) => (
        <span key={chunk.key} className="stream-word">{chunk.text}</span>
      ))}
    </>
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

const ThinkingBlock = memo(function ThinkingBlock({ block, duration, sessionId, entryId, blockIndex, defaultExpanded, isStreaming, isActiveStreamBlock }: {
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
}) {
  const { t } = useI18n();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded;
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { animating, beginToggle, onPanelTransitionEnd } = useCollapseMotion();
  // History loads strip thinking text (session-reader deferThinking) and leave
  // it behind a route, so the fetch is driven by visibility however it was
  // reached: opened by hand, expanded by the preference at mount, or revealed
  // when the preference changes. One request per block, ever.
  const requestedRef = useRef(false);

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
      className="collapse-box chat-block-in"
      data-expanded={expanded ? "" : undefined}
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
                : <PacedPlainText text={block.thinking ?? ""} streaming={isStreaming === true && expanded} activeBlock={isActiveStreamBlock === true} />)}
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
));


const ToolCallBlock = memo(function ToolCallBlock({ block, result, duration, isStreaming, isActiveStreamBlock, defaultCollapsed = true }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; isStreaming?: boolean; isActiveStreamBlock?: boolean; defaultCollapsed?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(Boolean(isStreaming) && !defaultCollapsed);
  const { animating, beginToggle, onPanelTransitionEnd } = useCollapseMotion();
  const prefersReducedMotion = usePrefersReducedMotion();
  const tuning = useStreamTuning();
  // Streaming tool input arrives as raw network bursts (the input JSON and
  // the header preview repaint per frame). When the knob is on, both run
  // through the pacer in lenient-prefix mode — the stringified JSON re-closes
  // its braces on every growth, which must retract a few chars, not snap.
  const inputLive = isStreaming === true && isActiveStreamBlock === true && result === undefined && !prefersReducedMotion && tuning.paceToolInput;
  const inputJson = useMemo(() => JSON.stringify(block.input, null, 2) ?? "", [block.input]);
  const toolPaceOptions = usePacerOptions(inputLive ? "pace" : "snap", true);
  const displayedJson = useSmoothStreamText(inputJson, inputLive && expanded ? "pace" : "snap", toolPaceOptions);
  const displayedPreview = useSmoothStreamText(getToolPreview(block), inputLive ? "pace" : "snap", toolPaceOptions);
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;

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
  const isError = result?.isError ?? false;
  // Tool-result images (preview_screenshot and friends) render as
  // always-visible thumbnails, not behind the collapse — a screenshot the
  // agent took of its work is the point of the tool call.
  const resultImages = result && Array.isArray(result.content)
    ? result.content.filter((b): b is ImageContent => b.type === "image")
    : [];

  return (
    <div
      className="collapse-box chat-block-in"
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
          <span style={{ color: isError ? "var(--status-error)" : "var(--status-success)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
            {block.toolName}
          </span>
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "64ch", marginRight: "auto" }}>
            {displayedPreview}
          </span>
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
              resultDiff ? (
                <PairedDiffResult
                  diff={resultDiff}
                />
              ) : (
                <>
                  <TaskResultPanel details={result.details} />
                  <PairedResult
                    text={resultText ?? ""}
                    isEmpty={resultIsEmpty}
                    isError={isError}
                  />
                </>
              )
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
      {resultImages.length > 0 && (
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
  && prev.defaultCollapsed === next.defaultCollapsed
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

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
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

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
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

  return (
    <div className="chat-message collapse-scope" style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
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
