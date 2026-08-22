"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, TriangleAlert, X } from "lucide-react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, ImageContent, SessionInfo, SessionTreeNode, TextContent, ToolCallContent, ToolResultMessage } from "@/lib/types";
import { translate, useI18n } from "@/lib/i18n";
import { countToolCallBlocks, getDisplayableAssistantBlocks, groupHasThinking, splitFinalAssistantBlocks } from "@/lib/message-display";
import { estimateTurnHeight, type TurnContentSignal } from "@/lib/turn-height-estimate";
import { imageSource, MessageView } from "./MessageView";
import { ClickableImage } from "./ImageLightbox";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ExtensionDialog } from "./ExtensionDialog";
import { SubagentTranscriptDialog } from "./SubagentTranscriptDialog";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ComposerPanels } from "./ComposerPanels";
import { StatusTextCrossfade } from "./StatusTextCrossfade";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import { useAgentSession, type AgentPhase, type NoticeItem, type RunningToolInfo, type StreamAlert, type SubagentInfo } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useStreamTuning } from "@/hooks/useStreamTuning";
import { streamTuningCssVars } from "@/lib/stream-tuning";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { resolveAvailableThinkingLevels } from "@/lib/thinking-levels";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import {
  captureScrollDistance,
  getNextVisibleCount,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  advisorEnabled?: boolean;
  /** The active engine serves the rpc-dialect chat extras (thinking levels,
   * model switching, forking, compaction, steering). False hides those
   * affordances instead of letting them fail against the engine. */
  chatExtras?: boolean;
  /** Engine supports priority fast mode (omp set_fast_mode). */
  fastModeCapable?: boolean;
  /** Engine emits subagent rosters/progress (omp get_subagents + frames). */
  subagentsCapable?: boolean;
  toolCallsDefaultCollapsed?: boolean;
  thinkingDefaultExpanded?: boolean;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  /** Per-model token usage of the loaded conversation, for the top bar's
   * session popover. Null on unmount so a closed chat clears the readout. */
  onModelUsageChange?: (usage: SessionModelUsage[] | null) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenPreview?: (url: string, sessionId?: string) => void;
  onPreviewUrlsSeen?: (urls: string[], sessionId?: string) => void;
}

/** Token traffic one model produced in the loaded conversation. */
export interface ContextModelUsage {
  provider: string;
  modelId: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The same rows with their display name resolved, ready to render outside
 * this component — the model catalog lives here, not in AppShell. */
export interface SessionModelUsage extends ContextModelUsage {
  name: string;
}

/** A tool call must announce an elapsed time once it has run this long —
 * below it, the churn would be noise; above it, silence reads as a hang. */
const LONG_TOOL_THRESHOLD_MS = 8_000;

function formatToolElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${totalSeconds}s`;
}

function oldestRunningTool(phase: AgentPhase): RunningToolInfo | null {
  if (phase?.kind !== "running_tools" || phase.tools.length === 0) return null;
  return phase.tools.reduce((oldest, tool) => (tool.startedAt < oldest.startedAt ? tool : oldest));
}

function phaseLabel(phase: AgentPhase, now: number): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((tool) => tool.name);
    let label: string;
    if (names.length === 0) label = translate("chatWindow.runningTool");
    else if (names.length <= 3) label = translate("chatWindow.runningNamed", { names: names.join(", ") });
    else label = translate("chatWindow.runningNamedMore", { names: names.slice(0, 2).join(", "), more: names.length - 2 });
    // The oldest tool is the one worth narrating: append the newest line it
    // streamed about itself and, once it has run a while, for how long. A
    // long silent call (omp's gh run_watch behind `write xd://github`,
    // polling a GitHub Actions run to completion) must read as a live watch
    // with a clock on it, never as a hang.
    const oldest = oldestRunningTool(phase);
    if (oldest) {
      if (oldest.statusText) label += ` — ${oldest.statusText}`;
      const elapsed = now - oldest.startedAt;
      if (elapsed >= LONG_TOOL_THRESHOLD_MS) label += ` · ${formatToolElapsed(elapsed)}`;
    }
    return label;
  }
  if (phase?.kind === "waiting_model") return translate("chatWindow.waitingModel");
  if (phase?.kind === "running_command") return translate("chatWindow.runningCommand");
  return translate("chatWindow.thinking");
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;// Trigger the next history page while the sentinel is still this far below
// the top edge, so a normal upward scroll seamlessly continues into the newly
// loaded messages. Triggering only at the very top made the load invisible:
// the restore anchored the viewport to the old content, so the user parked on
// the banner and the load looked like a no-op.
const LOAD_MORE_ROOT_MARGIN = "400px 0px 0px 0px";

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

/** Concatenates a user/developer/custom/toolResult message's text blocks
 *  (its content shape: a plain string or a TextContent/ImageContent array)
 *  into one string, alongside its image count — the raw ingredients
 *  `estimateTurnHeight` turns into a placeholder height. */
function collectMessageText(content: string | (TextContent | ImageContent)[]): { text: string; imageCount: number } {
  if (typeof content === "string") return { text: content, imageCount: 0 };
  let text = "";
  let imageCount = 0;
  for (const block of content) {
    if (block.type === "text") text += `${block.text}\n`;
    else if (block.type === "image") imageCount += 1;
  }
  return { text, imageCount };
}

/** Cheap per-message content signal for `estimateTurnHeight` — see that
 *  module for why this only has to be roughly right, not exact. */
function turnContentSignal(message: AgentMessage): TurnContentSignal {
  switch (message.role) {
    case "user":
    case "developer":
    case "custom":
    case "toolResult":
      return collectMessageText(message.content);
    case "assistant": {
      const blocks = getDisplayableAssistantBlocks(message);
      let text = "";
      let imageCount = 0;
      for (const block of blocks) {
        if (block.type === "text") text += `${block.text}\n`;
        else if (block.type === "image") imageCount += 1;
      }
      return { text, imageCount, toolCallCount: countToolCallBlocks(blocks) };
    }
    case "bashExecution":
      return { text: `${message.command}\n${message.output}` };
    case "pythonExecution":
      return { text: `${message.code}\n${message.output}` };
    case "fileMention":
      return { text: message.files.map((file) => file.content ?? "").join("\n") };
    default:
      return {};
  }
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function OmpRuntimeVersion() {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/omp-version")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { version: string | null } | null) => {
        if (!cancelled && data?.version) setVersion(data.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
      omp <span style={{ color: "var(--text)" }}>{version ? `v${version}` : t("chatWindow.versionNotFound")}</span>
    </span>
  );
}

/** Tool-result images produced inside a collapsed process group. A screenshot
 * the agent took of its work (preview_screenshot) is the point of the turn,
 * so it must not disappear with the collapse. */
function collectGroupResultImages(
  messages: AgentMessage[],
  indices: number[],
  toolResultsMap: Map<string, ToolResultMessage>,
  extraBlocks: AssistantContentBlock[],
): ImageContent[] {
  const images: ImageContent[] = [];
  const fromResult = (toolCallId: string) => {
    const result = toolResultsMap.get(toolCallId);
    if (!result || !Array.isArray(result.content)) return;
    for (const block of result.content) {
      if (block.type === "image") images.push(block);
    }
  };
  const fromMessageBlocks = (content: AssistantContentBlock[]) => {
    for (const block of content) {
      if (block.type === "toolCall") fromResult((block as ToolCallContent).toolCallId);
    }
  };
  for (const idx of indices) {
    const message = messages[idx];
    if (message.role === "assistant" && Array.isArray(message.content)) fromMessageBlocks(message.content);
  }
  fromMessageBlocks(extraBlocks);
  return images.slice(0, 6);
}

function ProcessDetailsGroup({ messageCount, toolCallCount, resultImages, defaultExpanded = false, children }: { messageCount: number; toolCallCount: number; resultImages?: ImageContent[]; defaultExpanded?: boolean; children: ReactNode }) {
  const { t, tn } = useI18n();
  // Reasoning on a committed turn lives inside this group, and its children are
  // not even mounted while it is shut — so "Expand thinking blocks" has to open
  // the group or it would only ever apply to the streaming turn. A group the
  // user has toggled keeps their choice.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded;
  const parts = [t("chatWindow.processDetails"), tn("chatWindow.messageCount", messageCount)];
  if (toolCallCount > 0) parts.push(tn("chatWindow.toolCallCount", toolCallCount));

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setUserExpanded(!expanded)}
        className="process-details-toggle"
        title={expanded ? t("chatWindow.collapseProcessDetails") : t("chatWindow.expandProcessDetails")}
      >
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
        <span className="process-details-label">
          {parts.join(" · ")}
        </span>
      </button>
      {/* Collapsed only: expanding shows the same images inside their tool
          blocks, so the strip would duplicate them. */}
      {!expanded && resultImages && resultImages.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
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
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

interface CommittedTranscriptProps {
  messages: AgentMessage[];
  entryIds: string[];
  conversationMeta: { toolResultsMap: Map<string, ToolResultMessage>; lastAnchorIdx: number; visibleRefIndexByMessage: Map<number, number> };
  messageRefs: React.RefObject<(HTMLDivElement | null)[]>;
  isStreaming: boolean;
  sessionBusy: boolean;
  isNew: boolean;
  forkingEntryId: string | null;
  /** Forking is omp-only; false renders the transcript without fork actions. */
  canFork: boolean;
  handleFork: (entryId: string) => void;
  handleNavigate: (entryId: string) => void;
  handleEditContent: (content: string) => void;
  modelNames: Record<string, string>;
  messageCwd: string | undefined;
  onOpenFile?: (filePath: string) => void;
  sessionId: string | undefined;
  toolCallsDefaultCollapsed: boolean;
  thinkingDefaultExpanded: boolean;
  visibleCount: number;
  /** True while the viewport is near the bottom of the conversation. When
   *  false (user is reading history), the render window anchors its top so
   *  messages appended by a running agent cannot slide the viewed messages
   *  out of the window. */
  nearBottom: boolean;
  sentinelRef: React.RefObject<HTMLButtonElement | null>;
  handleLoadMoreClick: () => void;
}

/** One slot in the transcript's render window: either a single message, the
 *  final answer split off its assistant message, or the collapsed process
 *  group folded out of a turn. Planning the slots is cheap; building their
 *  React elements is not, so only the windowed slots get built.
 *
 *  `estimatedHeight` (lib/turn-height-estimate.ts) becomes the turn wrapper's
 *  inline `contain-intrinsic-size`, computed here alongside everything else
 *  this function already has in hand so it rides the same memoization
 *  (`buildTranscriptUnits` is only re-run when `messages` actually changes)
 *  instead of recomputing per render during streaming. */
type TranscriptUnit =
  | { kind: "message"; idx: number; estimatedHeight: number }
  | { kind: "answer"; idx: number; message: AssistantMessage; estimatedHeight: number }
  | {
      kind: "process";
      userIdx: number;
      finalAssistantIdx: number;
      processIndices: number[];
      finalProcessMessage: AssistantMessage | null;
      hasAnswer: boolean;
      estimatedHeight: number;
    };

/** Turns at the end of the transcript that opt out of CSS containment: the
 *  follow-scroll measures the end sentinel, and a skipped subtree would report
 *  its `contain-intrinsic-size` placeholder instead of its real height. */
const LIVE_TAIL_UNITS = 6;

/**
 * Group the transcript into render units without building any elements. Same
 * grouping the renderer used to do inline, but separated so the window can be
 * computed first: the elements before `startIndex` were previously built and
 * then thrown away by `slice`, which cost O(total history) on every committed
 * message change.
 */
function buildTranscriptUnits(messages: AgentMessage[], lastAnchorIdx: number, tailIsLive: boolean): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  const heightForMessage = (idx: number) => estimateTurnHeight(turnContentSignal(messages[idx]));
  // Process groups render collapsed by default (ProcessDetailsGroup) — the
  // toggle button is the only thing that actually paints until expanded, so
  // its placeholder stays near the floor regardless of how much (or little)
  // text/tool-calls are folded underneath. Scaling it with the hidden
  // content would recreate the same placeholder-vs-real mismatch this
  // estimate exists to fix, just in the opposite (over-reserving) direction.
  const collapsedProcessHeight = estimateTurnHeight({});

  for (let idx = 0; idx < messages.length;) {
    const msg = messages[idx];
    if (!isGroupAnchor(msg)) {
      units.push({ kind: "message", idx, estimatedHeight: heightForMessage(idx) });
      idx += 1;
      continue;
    }

    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    const isLiveTail = tailIsLive && endIdx === messages.length && userIdx === lastAnchorIdx;

    if (finalAssistantIdx === -1 || isLiveTail) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        units.push({ kind: "message", idx: renderIdx, estimatedHeight: heightForMessage(renderIdx) });
      }
      idx = endIdx;
      continue;
    }

    units.push({ kind: "message", idx: userIdx, estimatedHeight: heightForMessage(userIdx) });

    const processIndices: number[] = [];
    for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
      if (hasDisplayableProcessMessage(messages[processIdx])) processIndices.push(processIdx);
    }
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
      : null;
    const hasAnswer = finalSplit.answerBlocks.length > 0;

    if (processIndices.length + (finalProcessMessage ? 1 : 0) > 0) {
      units.push({ kind: "process", userIdx, finalAssistantIdx, processIndices, finalProcessMessage, hasAnswer, estimatedHeight: collapsedProcessHeight });
    }
    if (hasAnswer) {
      const answerMessage = withAssistantBlocks(finalAssistant, finalSplit.answerBlocks);
      units.push({ kind: "answer", idx: finalAssistantIdx, message: answerMessage, estimatedHeight: estimateTurnHeight(turnContentSignal(answerMessage)) });
    }
    for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
      units.push({ kind: "message", idx: renderIdx, estimatedHeight: heightForMessage(renderIdx) });
    }
    idx = endIdx;
  }
  return units;
}

function turnClassName(live: boolean, compact: boolean): string {
  if (live) return "chat-turn chat-turn--live";
  return compact ? "chat-turn chat-turn--compact" : "chat-turn";
}

/**
 * The committed (non-streaming) transcript. Extracted from ChatWindow and
 * memoized over the committed messages so token-streaming updates (which only
 * change `streamingMessage`, rendered separately) do not re-run the O(history)
 * grouping/splitting work at display-frame cadence.
 */
const CommittedTranscript = memo(function CommittedTranscript({
  messages, entryIds, conversationMeta, messageRefs, isStreaming, sessionBusy, isNew, forkingEntryId,
  canFork, handleFork, handleNavigate, handleEditContent, modelNames, messageCwd, onOpenFile, sessionId,
  toolCallsDefaultCollapsed, thinkingDefaultExpanded, visibleCount, nearBottom, sentinelRef, handleLoadMoreClick,
}: CommittedTranscriptProps) {
  const { t } = useI18n();
  const { toolResultsMap, lastAnchorIdx, visibleRefIndexByMessage } = conversationMeta;

  // One stable callback per ref slot: a fresh closure per render makes React
  // detach and re-attach every message ref on every render, which churns the
  // array the minimap measures.
  const refCallbacksRef = useRef<Array<((el: HTMLDivElement | null) => void) | undefined>>([]);
  const messageRefCallback = (refIndex: number) => {
    const callbacks = refCallbacksRef.current;
    let callback = callbacks[refIndex];
    if (!callback) {
      callback = (el: HTMLDivElement | null) => { messageRefs.current[refIndex] = el; };
      callbacks[refIndex] = callback;
    }
    return callback;
  };

  const renderMessage = (idx: number, options: { keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
    const msg = options.messageOverride ?? messages[idx];
    const prevAssistantEntryId =
      msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
        ? entryIds[idx - 1]
        : undefined;
    const keyPrefix = options.keyPrefix ?? "message";
    let showTimestamp = false;
    if (msg.role === "assistant") {
      showTimestamp = true;
      for (let j = idx + 1; j < messages.length; j++) {
        const r = messages[j].role;
        if (r === "user") break;
        if (r === "assistant") { showTimestamp = false; break; }
      }
      // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
      if (showTimestamp && isStreaming && idx === messages.length - 1) {
        showTimestamp = false;
      }
    }
    if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
    return (
      <MessageView
        key={`${keyPrefix}-view-${idx}`}
        message={msg}
        toolResults={toolResultsMap}
        modelNames={modelNames}
        cwd={messageCwd}
        onOpenFile={onOpenFile}
        entryId={entryIds[idx]}
        onFork={!canFork || sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
        forking={forkingEntryId === entryIds[idx]}
        onNavigate={sessionBusy ? undefined : handleNavigate}
        prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
        onEditContent={handleEditContent}
        showTimestamp={showTimestamp}
        prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
        sessionId={sessionId}
        toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
        thinkingDefaultExpanded={thinkingDefaultExpanded}
      />
    );
  };

  const renderUnit = (unit: TranscriptUnit, live: boolean): ReactNode => {
    // Per-turn estimate (lib/turn-height-estimate.ts), computed once in
    // buildTranscriptUnits and carried on the unit — overrides the
    // stylesheet's flat contain-intrinsic-size (app/globals.css `.chat-turn`)
    // so an unpainted turn's placeholder is close to its real height. The
    // CSS rule stays in place as the fallback for the instant before this
    // inline style attaches.
    const turnStyle: React.CSSProperties = { containIntrinsicSize: `auto ${unit.estimatedHeight}px` };
    if (unit.kind === "process") {
      const processBlocks = unit.finalProcessMessage?.content ?? [];
      const processRefIdx = unit.processIndices
        .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
        .find((value): value is number => typeof value === "number")
        ?? (unit.hasAnswer ? undefined : visibleRefIndexByMessage.get(unit.finalAssistantIdx));
      return (
        <div
          key={`process-group-${unit.userIdx}-${unit.finalAssistantIdx}`}
          className={turnClassName(live, true)}
          style={turnStyle}
          ref={processRefIdx === undefined ? undefined : messageRefCallback(processRefIdx)}
        >
          <ProcessDetailsGroup
            messageCount={unit.processIndices.length + (unit.finalProcessMessage ? 1 : 0)}
            toolCallCount={countToolCalls(messages, unit.processIndices) + countToolCallBlocks(processBlocks)}
            resultImages={collectGroupResultImages(messages, unit.processIndices, toolResultsMap, processBlocks)}
            defaultExpanded={thinkingDefaultExpanded && groupHasThinking(messages, unit.processIndices, processBlocks)}
          >
            {unit.processIndices.map((processIdx) => renderMessage(processIdx, { keyPrefix: "process" }))}
            {unit.finalProcessMessage && renderMessage(unit.finalAssistantIdx, { keyPrefix: "process-final", messageOverride: unit.finalProcessMessage, showTimestamp: false })}
          </ProcessDetailsGroup>
        </div>
      );
    }
    const refIdx = visibleRefIndexByMessage.get(unit.idx);
    const isUserTurn = unit.kind === "message" && messages[unit.idx].role === "user";
    return (
      <div
        key={`turn-${unit.idx}`}
        className={turnClassName(live, isUserTurn)}
        style={turnStyle}
        ref={refIdx === undefined ? undefined : messageRefCallback(refIdx)}
      >
        {renderMessage(unit.idx, unit.kind === "answer" ? { messageOverride: unit.message } : undefined)}
      </div>
    );
  };

  const units = useMemo(
    () => buildTranscriptUnits(messages, lastAnchorIdx, sessionBusy || isStreaming),
    [messages, lastAnchorIdx, sessionBusy, isStreaming],
  );

  // Anchor the render window while the user is reading history: the plain
  // end-anchored window (total - visibleCount) slides forward as a running
  // agent appends messages, silently pushing the viewed messages out of the
  // window with no scroll correction. While not near the bottom, keep the
  // window's top at the last end-anchored position and let the appended tail
  // grow into the window; returning to the bottom re-engages the end anchor.
  // The anchor lives in state and is written from an effect: advancing a ref
  // during render is impure, and a render React later discards would leave the
  // anchor pointing at a window that was never shown.
  const [anchorStartIndex, setAnchorStartIndex] = useState<number | null>(null);
  const endAnchoredStart = Math.max(0, units.length - visibleCount);
  const startIndex = nearBottom || anchorStartIndex === null
    ? endAnchoredStart
    : Math.min(anchorStartIndex, endAnchoredStart);
  const hasMore = startIndex > 0;
  useEffect(() => {
    setAnchorStartIndex((prev) => {
      if (nearBottom) return null;
      return prev === null ? endAnchoredStart : Math.min(prev, endAnchoredStart);
    });
  }, [nearBottom, endAnchoredStart]);

  const liveTailStart = units.length - LIVE_TAIL_UNITS;
  return (
    <>
      {hasMore && (
        <button
          ref={sentinelRef}
          type="button"
          onClick={handleLoadMoreClick}
          className="py-3 w-full text-center text-xs text-text-muted hover:text-text transition-colors cursor-pointer"
        >
          {t("chatWindow.scrollUpToLoad", { count: startIndex })}
        </button>
      )}
      {units.slice(startIndex).map((unit, offset) => renderUnit(unit, startIndex + offset >= liveTailStart))}
    </>
  );
});

/** Memoized: AppShell holds ~60 state values (git badge polls, update checks,
 *  the context-usage tick ChatWindow itself pushes up), and each of those
 *  re-renders would otherwise rebuild this whole tree. */
export const ChatWindow = memo(function ChatWindow({ session, newSessionCwd, advisorEnabled, chatExtras = true, fastModeCapable = true, subagentsCapable = true, toolCallsDefaultCollapsed = true, thinkingDefaultExpanded = false, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onModelUsageChange, onOpenFile, onOpenPreview, onPreviewUrlsSeen }: Props) {
  const { t, tn } = useI18n();
  const { playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  const tuning = useStreamTuning();
  const tuningCssVars = useMemo(() => streamTuningCssVars(tuning), [tuning]);

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render. playDoneSound
  // checks the sound preference itself.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const wrappedOnAgentEnd = useCallback(() => {
    playDoneSoundRef.current();
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((content: string) => {
    chatInputRef?.current?.insertIfEmpty(content);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelsLoading, modelError, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel, fastModeEnabled, fastModeActive,
    liveModelMeta,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase, streamDegraded, streamAlert, dismissStreamAlert, retryEventStream, activeGoal, activePlan,
    subagents, subagentEvents, subagentTranscriptVersions, activeSubagentCount, currentTodoPhase, todoPhases,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    removeQueuedMessage, promoteQueuedToSteer,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleFastModeChange, handleCycleModel, handleCycleThinkingLevel, handleAbortRetry, loadSlashCommands,
  } = useAgentSession({
    session, newSessionCwd, advisorEnabled, thinkingDefaultExpanded, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
    onOpenFile, onOpenPreview, onPreviewUrlsSeen,
  });
  const sessionBusy = agentRunning || bashRunning;

  // Register the abort handler for the global Esc shortcut. The cleanup
  // matters: unmounting mid-run must not leave the module-global handler
  // pointing at this (now unmounted) instance's handleAbort.
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
    return () => registerAbortHandler(null);
  }, [sessionBusy, handleAbort]);

  // Cycle model / thinking level via ⌘/Ctrl+Alt+M and ⌘/Ctrl+Alt+T (RPC
  // cycle_model / cycle_thinking_level). Meta/Alt combos avoid clashing with
  // ordinary typing in the composer.
  useEffect(() => {
    if (!session) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "m") {
        e.preventDefault();
        void handleCycleModel();
      } else if (key === "t") {
        e.preventDefault();
        void handleCycleThinkingLevel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, handleCycleModel, handleCycleThinkingLevel]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentInfo | null>(null);
  // True while the viewport is at/near the conversation bottom. Drives the
  // anchored render window in CommittedTranscript.
  const [nearBottom, setNearBottom] = useState(true);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Scroll events fire well above 60 Hz on precision trackpads; coalesce the
    // three layout reads into one per frame so they land in the rAF phase
    // instead of interleaving with the frame's style writes.
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const next = el.scrollTop + el.clientHeight >= el.scrollHeight - 96;
      setNearBottom((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scrollContainerRef]);
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  // "auto" (observer fired while scrolling) anchors the viewport to the old
  // content; "click" (user pressed the banner) reveals the loaded messages at
  // the top of the viewport instead.
  const loadMoreModeRef = useRef<"auto" | "click">("auto");

  // IntersectionObserver on the sentinel banner at the top of the message
  // list. When the user scrolls near the top, load the next page of older
  // messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Only auto-load on a genuine upward scroll. On fresh open the
        // sentinel sits at the top of the rendered window and is visible at
        // scrollTop = 0 — auto-loading then races the initial scroll-to-bottom
        // (the capture happens before the scroll, and the restore pins the
        // viewport to the top of the last page until every page is loaded).
        if (entries[0]?.isIntersecting && container.scrollTop > 0) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          loadMoreModeRef.current = "auto";
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      // Expand the root upward so the page loads while the banner is still
      // below the top edge — by the time the user reaches the top, the loaded
      // messages are already there and the scroll continues into them.
      { root: container, rootMargin: LOAD_MORE_ROOT_MARGIN, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (loadMoreModeRef.current === "click") {
      // Explicit request: reveal the loaded page. The browser's scroll
      // anchoring already kept the previous content in view, so move the
      // viewport up to the loaded messages.
      const sentinel = sentinelRef.current;
      if (sentinel) {
        // More pages remain: place the banner's bottom edge just above the
        // viewport so the newest loaded message is at the top.
        const containerRect = container.getBoundingClientRect();
        const sentinelRect = sentinel.getBoundingClientRect();
        container.scrollTop = container.scrollTop + (sentinelRect.bottom - containerRect.top) + 1;
      } else {
        // Everything loaded — the banner unmounted; show the top of the session.
        container.scrollTop = 0;
      }
    } else {
      container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    }
    loadMoreModeRef.current = "auto";
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);

  const handleLoadMoreClick = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      // Sentinel value so the restore effect above runs and reveals the page.
      prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
    }
    loadMoreModeRef.current = "click";
    setVisibleCount((prev) => getNextVisibleCount(prev));
  }, [scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    chatInputRef?.current?.addFiles(files);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const conversationMeta = useMemo(() => {
    const toolResultsMap = new Map<string, ToolResultMessage>();
    let lastAnchorIdx = -1;
    const visibleRefIndexByMessage = new Map<number, number>();
    let refIdx = 0;

    messages.forEach((message, index) => {
      if (message.role === "toolResult") toolResultsMap.set((message as ToolResultMessage).toolCallId, message as ToolResultMessage);
      if (isGroupAnchor(message)) lastAnchorIdx = index;
      if (message.role === "user" || message.role === "assistant") visibleRefIndexByMessage.set(index, refIdx++);
    });

    return { toolResultsMap, lastAnchorIdx, visibleRefIndexByMessage };
  }, [messages]);
  // The minimap needs one ref slot per user/assistant message — the same set
  // conversationMeta already indexed, so re-filtering `messages` per render
  // (an O(N) pass plus an array allocation on every streaming frame) is waste.
  const messageRefs = useMessageRefs(conversationMeta.visibleRefIndexByMessage.size);
  // Tool-call ids already rendered by COMMITTED messages — memoized away from
  // the streaming path so a per-token update only re-scans the live bubble.
  const committedToolCallIds = useMemo(() => {
    const renderedIds = new Set<string>();
    for (const message of messages) {
      if (message?.role !== "assistant") continue;
      for (const block of (message as Partial<AssistantMessage>).content ?? []) {
        if (block.type === "toolCall") renderedIds.add(block.toolCallId);
      }
    }
    return renderedIds;
  }, [messages]);
  const pendingToolHeaders = useMemo(() => {
    if (agentPhase?.kind !== "running_tools") return [];
    const renderedIds = new Set(committedToolCallIds);
    const streaming = streamState.streamingMessage;
    if (streaming?.role === "assistant") {
      for (const block of (streaming as Partial<AssistantMessage>).content ?? []) {
        if (block.type === "toolCall") renderedIds.add(block.toolCallId);
      }
    }
    return agentPhase.tools.filter((tool) => !renderedIds.has(tool.id));
  }, [agentPhase, committedToolCallIds, streamState.streamingMessage]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  // One-second clock behind the elapsed readout on long tool calls. It runs
  // only while a tool is executing, keyed on the oldest start time so a new
  // tool in the same batch does not reset the interval; message rows are
  // memoized, so the per-second re-render stays in the status surfaces.
  const [toolClockNow, setToolClockNow] = useState(() => Date.now());
  const oldestToolStartedAt = agentPhase?.kind === "running_tools" && agentPhase.tools.length > 0
    ? Math.min(...agentPhase.tools.map((tool) => tool.startedAt))
    : null;
  useEffect(() => {
    if (oldestToolStartedAt === null) return;
    setToolClockNow(Date.now());
    const timer = setInterval(() => setToolClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [oldestToolStartedAt]);

  // Memoized because the live-metadata fallback allocates a fresh array: a new
  // identity here defeats ChatInput's memo, re-rendering the whole composer on
  // every streaming frame.
  const availableThinkingLevels = useMemo(() => (
    displayModelValue
      ? resolveAvailableThinkingLevels(
          modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`],
          displayModelValue,
          liveModelMeta,
        )
      : null
  ), [displayModelValue, modelThinkingLevels, liveModelMeta]);

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  // The quota popover used to render this list itself; it now feeds the top
  // bar's session popover, which is where the rest of the session's token
  // readouts already live.
  const contextModelUsage = useMemo<ContextModelUsage[]>(() => {
    const byModel = new Map<string, ContextModelUsage>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const assistant = message as AssistantMessage;
      if (!assistant.provider || !assistant.model) continue;
      const key = `${assistant.provider}:${assistant.model}`;
      const usage = byModel.get(key) ?? {
        provider: assistant.provider,
        modelId: assistant.model,
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      usage.turns += 1;
      usage.input += assistant.usage?.input ?? 0;
      usage.output += assistant.usage?.output ?? 0;
      usage.cacheRead += assistant.usage?.cacheRead ?? 0;
      usage.cacheWrite += assistant.usage?.cacheWrite ?? 0;
      byModel.set(key, usage);
    }
    return [...byModel.values()];
  }, [messages]);

  const modelUsageRows = useMemo<SessionModelUsage[]>(() => (
    contextModelUsage.map((entry) => ({
      ...entry,
      name: modelList.find((option) => option.provider === entry.provider && option.id === entry.modelId)?.name
        ?? modelNames[`${entry.provider}:${entry.modelId}`]
        ?? (displayModelValue?.provider === entry.provider && displayModelValue.modelId === entry.modelId
          ? liveModelMeta?.name ?? null
          : null)
        ?? entry.modelId,
    }))
  ), [contextModelUsage, modelList, modelNames, displayModelValue, liveModelMeta]);
  // Push it up the same way as sessionStats: keyed on scalars so a fresh array
  // identity per render cannot loop the parent.
  const modelUsageKey = modelUsageRows
    .map((row) => [row.provider, row.modelId, row.name, row.turns, row.input, row.output, row.cacheRead, row.cacheWrite].join(":"))
    .join("|");
  const modelUsageRef = useRef(modelUsageRows);
  modelUsageRef.current = modelUsageRows;
  useEffect(() => {
    onModelUsageChange?.(modelUsageRef.current);
  }, [modelUsageKey, onModelUsageChange]);
  useEffect(() => () => { onModelUsageChange?.(null); }, [onModelUsageChange]);

  // Steering and the follow-up queue are omp-protocol commands; a turn-based
  // engine answers them "unsupported", so they are not offered at all — the
  // composer shows a waiting state for the duration of the turn instead.
  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={chatExtras && agentRunning ? handleSteer : undefined}
      onFollowUp={chatExtras && agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={chatExtras && agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      chatExtras={chatExtras}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelsLoading={modelsLoading}
      modelError={modelError}
      onModelChange={chatExtras ? handleModelChange : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={chatExtras && (session || isNew) ? handleThinkingLevelChange : undefined}
      fastModeEnabled={fastModeEnabled}
      fastModeActive={fastModeActive}
      fastModeSupported={fastModeCapable && chatExtras && Boolean(displayModelValue && modelList.some((entry) => entry.provider === displayModelValue.provider && entry.id === displayModelValue.modelId && entry.supportsFastMode))}
      onFastModeChange={session || isNew ? handleFastModeChange : undefined}
      onAbortRetry={session ? handleAbortRetry : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      modelNameOverride={liveModelMeta?.name ?? null}
      retryInfo={retryInfo}
      activeGoal={activeGoal}
      activePlan={activePlan}
      advisorEnabled={chatExtras && advisorEnabled}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRemoveQueuedMessage={removeQueuedMessage}
      onPromoteQueuedToSteer={promoteQueuedToSteer}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div role="status" className="flex h-full items-center justify-center" style={{ color: "var(--text-muted)" }}>
        {t("chatWindow.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex h-full items-center justify-center" style={{ color: "var(--accent-strong)", padding: "0 16px", textAlign: "center", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && (
        <div className="drop-zone-overlay pointer-events-none absolute inset-0 z-50 flex items-center justify-center backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="drop-ripple-ring absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-zone-illustration"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="color-mix(in srgb, var(--accent) 8%, transparent)" stroke="color-mix(in srgb, var(--accent) 50%, transparent)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="color-mix(in srgb, var(--accent) 16%, transparent)" stroke="color-mix(in srgb, var(--accent) 40%, transparent)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="color-mix(in srgb, var(--accent) 22%, transparent)" stroke="color-mix(in srgb, var(--accent) 55%, transparent)" strokeWidth="1.6"/>
            <g stroke="color-mix(in srgb, var(--accent) 45%, transparent)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      <SubagentTranscriptDialog
        subagent={selectedSubagent}
        sessionId={session?.id ?? sessionIdRef.current ?? null}
        transcriptVersion={selectedSubagent ? (subagentTranscriptVersions[selectedSubagent.id] ?? 0) : 0}
        events={selectedSubagent ? (subagentEvents[selectedSubagent.id] ?? []) : undefined}
        onClose={() => setSelectedSubagent(null)}
      />

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full" style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH }}>
            <div
               className="mb-3 empty-chat-brand"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 8,
                marginRight: 8,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "0.04em", color: "var(--accent)", flexShrink: 0, whiteSpace: "nowrap" }}>⌥</span>
                <span style={{ fontSize: 18, color: "var(--text)", fontWeight: 600, letterSpacing: "0.02em", flexShrink: 0, whiteSpace: "nowrap" }}>cody</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  cody <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <OmpRuntimeVersion />
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        {/* Hide the Firefox scrollbar on desktop only: ChatMinimap provides the
            position indicator there, but on mobile there is no minimap and
            users need the scrollbar (Chrome's overlay scrollbar still shows). */}
        <div ref={scrollContainerRef} className={`chat-scroll-region flex-1 overflow-y-auto pt-6` + (isMobile ? "" : " [scrollbar-width:none]")} style={tuningCssVars}>
          <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
              <ExtensionStatusBar statuses={extensionStatuses} />
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            <CommittedTranscript
              messages={messages}
              entryIds={entryIds}
              conversationMeta={conversationMeta}
              messageRefs={messageRefs}
              isStreaming={streamState.isStreaming}
              sessionBusy={sessionBusy}
              isNew={isNew}
              forkingEntryId={forkingEntryId}
              canFork={chatExtras}
              handleFork={handleFork}
              handleNavigate={handleNavigate}
              handleEditContent={handleEditContent}
              modelNames={modelNames}
              messageCwd={messageCwd}
              onOpenFile={onOpenFile}
              sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
              thinkingDefaultExpanded={thinkingDefaultExpanded}
              visibleCount={visibleCount}
              nearBottom={nearBottom}
              sentinelRef={sentinelRef}
              handleLoadMoreClick={handleLoadMoreClick}
            />
            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} toolCallsDefaultCollapsed={toolCallsDefaultCollapsed} thinkingDefaultExpanded={thinkingDefaultExpanded} />
            )}

            {toolCallsDefaultCollapsed && pendingToolHeaders.map((tool) => (
              <div
                key={tool.id}
                className="chat-block-in"
                role="status"
                aria-label={t("chatWindow.runningNamed", { names: tool.name })}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  marginBottom: 8, padding: "6px 10px",
                  border: "1px solid color-mix(in srgb, var(--status-success) 25%, transparent)",
                  borderRadius: "var(--radius-control)",
                  background: "color-mix(in srgb, var(--status-success) 4%, transparent)",
                  color: "var(--text-muted)", fontSize: 12,
                }}
              >
                <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span style={{ color: "var(--status-success)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>{tool.name}</span>
                {tool.statusText && (
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tool.statusText}</span>
                )}
                {toolClockNow - tool.startedAt >= LONG_TOOL_THRESHOLD_MS && (
                  <span style={{ marginLeft: "auto", flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{formatToolElapsed(toolClockNow - tool.startedAt)}</span>
                )}
              </div>
            ))}

            {/* A stream that broke under a running turn, said out loud: the
                spinner alone cannot distinguish "thinking" from "wedged". */}
            {streamAlert && (
              <StreamAlertBanner
                alert={streamAlert}
                onRetry={retryEventStream}
                onDismiss={dismissStreamAlert}
              />
            )}

            {/* Status slot: reserved for the whole run so the status line
                appearing/disappearing (streaming content taking over, tool
                headers resolving) and text swaps never shift the transcript
                or the follow-scroll target. min-height matches the old
                py-2 rows, so nothing moved visually. */}
            {sessionBusy && (
              <div className="chat-status-slot">
                {agentRunning && !streamState.streamingMessage && pendingToolHeaders.length === 0 && (
                  <div role="status" aria-live="polite" className="text-[13px] text-text-muted flex items-center gap-2">
                    <span
                      aria-hidden
                      className="live-status-dot live-pulse inline-block h-2 w-2 shrink-0 rounded-full bg-accent"
                    />
                    <StatusTextCrossfade
                      text={[
                        // A degraded stream must never read as a healthy wait, and
                        // once the retries are exhausted it must not claim to be
                        // reconnecting either — the banner beside it says it is not.
                        streamAlert?.kind === "stream_lost"
                          ? t("agentStream.disconnected")
                          : streamDegraded
                            ? t("agentStream.reconnecting")
                            : phaseLabel(agentPhase, toolClockNow),
                        activeSubagentCount > 0 ? tn("chatWindow.subagentCount", activeSubagentCount) : null,
                        currentTodoPhase
                          ? t("chatWindow.todoPhaseStatus", {
                              name: currentTodoPhase.name,
                              done: currentTodoPhase.done,
                              total: currentTodoPhase.total,
                            })
                          : null,
                      ].filter(Boolean).join(" · ")}
                    />
                  </div>
                )}
                {bashRunning && !pendingBash && (
                  <div role="status" aria-live="polite" className="text-[13px] text-text-muted flex items-center gap-2">
                    <span
                      aria-hidden
                      className="live-status-dot live-pulse inline-block h-2 w-2 shrink-0 rounded-full bg-accent"
                    />
                    <StatusTextCrossfade text={t("chatWindow.runningCommand")} />
                  </div>
                )}
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {/* Real height rather than padding below: `block: "nearest"`
                stops once this sentinel's whole box is visible, so the
                follow-scroll always leaves this much clearance between the
                last row and the composer seam. */}
            <div ref={messagesEndRef} aria-hidden style={{ height: 16 }} />
            </div>
          </div>
        </div>
        {isMobile ? null : (
          <ChatMinimap
            messages={messages}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
          />
        )}
      </div>

      <div className="relative" style={{ flexShrink: 0 }}>
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            <ComposerPanels
              todoPhases={todoPhases}
              subagents={subagentsCapable && chatExtras ? subagents : []}
              onSelectSubagent={setSelectedSubagent}
            />
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
      </div>
      </>
      )}
    </div>
  );
});

function ExtensionStatusBar({ statuses }: { statuses: Array<{ key: string; text: string }> }) {
  if (statuses.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
      {statuses.map((status) => (
        <div
          key={status.key}
          className="ui-compact-surface"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "4px 8px",
            border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{status.key}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status.text}</span>
        </div>
      ))}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          className="ui-compact-surface"
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Persistent, dismissible banner for a broken chat stream — deliberately not a
 * NoticeShelf toast, which fades after five seconds. Both cases leave the user
 * with something to do: re-send the lost prompt, or retry the connection.
 */
function StreamAlertBanner({
  alert,
  onRetry,
  onDismiss,
}: {
  alert: NonNullable<StreamAlert>;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const color = alert.kind === "turn_lost" ? "var(--status-warning)" : "var(--status-error)";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "8px 0",
        padding: "8px 10px",
        borderRadius: "var(--radius-control)",
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
        color: "var(--text)",
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden style={{ color, flexShrink: 0 }}>
        <TriangleAlert size={14} />
      </span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {alert.kind === "send_failed"
          // The reason the send failed is the actionable half (a too-large
          // attachment names itself), so it is shown, not just logged.
          ? `${t("agentStream.sendFailed")}${alert.detail ? ` ${alert.detail}` : ""}`
          : alert.kind === "stream_lost" ? t("agentStream.streamLost") : t("agentStream.turnLost")}
      </span>
      {alert.kind === "stream_lost" && (
        <button
          type="button"
          onClick={onRetry}
          className="ui-smooth ui-focus-ring"
          style={{
            flexShrink: 0,
            cursor: "pointer",
            padding: "3px 8px",
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontSize: 11,
          }}
        >
          {t("agentStream.retry")}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("agentStream.dismiss")}
        title={t("agentStream.dismiss")}
        className="ui-smooth ui-focus-ring"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          cursor: "pointer",
          padding: 3,
          borderRadius: "var(--radius-control)",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "var(--status-error)"
          : notice.type === "warning"
            ? "var(--status-warning)"
            : notice.type === "success"
              ? "var(--status-success)"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 36,
              height: 36,
              maxHeight: 48,
              marginBottom: index === notices.length - 1 ? 0 : 4,
              overflow: "hidden",
              borderRadius: "var(--radius-control)",
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating ? "var(--shadow-pop)" : "var(--shadow-card)",
              fontSize: 12,
              lineHeight: 1.35,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out var(--dur-med) ease-in forwards"
                : "notice-shelf-in var(--dur-med) var(--ease-out-warm) both",
              padding: "0 10px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "8px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--overlay-backdrop)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
          aria-label={t("chatWindow.extensionTerminalInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chatWindow.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("chatWindow.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
