"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import {
  readPermissionRequest,
  readPermissionRequests,
  type AgentPermissionRequest,
} from "@/lib/permission-request";
import { extractLoopbackUrls, normalizePreviewUrl } from "@/lib/preview-url";
import { derivePersistedContextUsage, type ContextUsageValue } from "@/lib/context-usage";
import type { ThinkingModelMeta } from "@/lib/thinking-levels";
import { sendAgentCommand } from "@/lib/agent-client";
import { engineSupports } from "@/lib/engine-capabilities";
import { translate } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { createMessageUpdateCoalescer, type MessageUpdateCoalescer } from "@/lib/message-update-coalescer";
import {
  evaluateStreamHealth,
  reconnectDelayMs,
  shouldClearLostTurn,
  shouldGiveUpReconnecting,
} from "@/lib/stream-recovery";
import { getToolNamesForPreset, type ToolPreset } from "@/lib/tool-presets";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { toast } from "@/components/ui/toast";
import { expandWebSlashCommand } from "@/lib/web-slash-commands";
import { createActiveGoal, parseActiveGoal, type ActiveGoal, type ActivePlan } from "@/lib/web-mode-state";
import type { HostToolDefinition, HostUriSchemeDefinition, RpcAvailableSlashCommand, SessionStatsInfo, TodoPhase } from "@/lib/pi-types";
import { asCount, isRecord } from "@/lib/type-guards";
import { addUsageTotals, aggregateMessageUsage, emptyUsageTotals, usageTokenTotal, type UsageTotals } from "@/lib/session-usage";
import { SESSION_STORAGE_PREFIXES } from "@/lib/storage-keys";
import {
  parseSubagentActivityEvent,
  parseSubagentLifecycle,
  parseSubagentProgress,
  parseSubagentSnapshot,
  type SubagentActivityEvent,
  type SubagentInfo,
  type SubagentSnapshotLike,
} from "@/lib/subagent-types";

// SubagentInfo lives in lib/subagent-types (shared with the server-side
// history module); keep the export path stable for components.
export type { SubagentInfo } from "@/lib/subagent-types";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    todoPhases: TodoPhase[];
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

const SUBAGENT_ACTIVITY_BUFFER_MAX = 50;
// Distinct subagent ids retained in the activity/version maps. Each per-id
// array is already capped, but a long turn can spawn unbounded ids (repeated
// or recursive task calls) — the OUTER maps must be bounded too.
const SUBAGENT_ACTIVITY_MAX_IDS = 64;

/** Keep only the most recently inserted entries of an id-keyed map. */
function pruneSubagentIdMap<T>(map: Record<string, T>): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= SUBAGENT_ACTIVITY_MAX_IDS) return map;
  const next = { ...map };
  let over = keys.length - SUBAGENT_ACTIVITY_MAX_IDS;
  // JS orders integer-like keys (e.g. a digits-only subagent id "12345")
  // numerically before string keys, so insertion order only holds for the
  // non-integer keys. Evict those oldest-first; integer-like keys — whose
  // relative age is unknowable from a plain object — are evicted last so an
  // actively-updated digits-only id is never wrongly pruned.
  const ordered = keys.filter((key) => !/^(?:0|[1-9]\d*)$/.test(key));
  for (const key of ordered) {
    if (over <= 0) break;
    delete next[key];
    over -= 1;
  }
  if (over > 0) {
    for (const key of keys) {
      if (over <= 0) break;
      if (next[key] === undefined) continue;
      delete next[key];
      over -= 1;
    }
  }
  return next;
}


interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

// Shape of lib/rpc-manager's WebSessionState as seen over HTTP.
type AgentStateResponse = {
  // Raw get_state passthrough: the resolved model omp is actually running.
  model?: { provider: string; id: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } };
  contextUsage?: ContextUsageValue | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  autoRetryEnabled?: boolean;
  interruptMode?: "immediate" | "wait";
  autoCompactionEnabled?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  // Approvals the engine is blocked on right now. Carried in state, not only
  // in the event stream, so a reloaded tab finds the request whose event it
  // was not connected for — without this, a blocked turn looks hung forever.
  // Only ACP engines report it; every other engine leaves it undefined, and
  // undefined must never be read as "nothing is pending".
  pendingPermissions?: unknown;
  // omp only reports a count; the queued texts are tracked client-side.
  queuedMessageCount?: number;
  todoPhases?: TodoPhase[];
  // The engine's OWN model catalog, for engines that carry model selection as
  // per-SESSION state instead of a sessionless registry (every ACP engine:
  // the list an agent publishes depends on the account the session opened
  // with). /api/models answers `catalogSource: "session"` for those and hands
  // back an empty list rather than the neighbouring engine's catalog; these
  // two fields are where the real list lives. `modelSelectable` is decided per
  // SESSION, never per engine — an agent that published no selector reports
  // false and the picker stays hidden.
  availableModels?: { provider?: unknown; id?: unknown; name?: unknown }[];
  modelSelectable?: boolean;
  // The session modes an ACP agent published at session/new — its own
  // permission posture (Claude: Manual / Accept edits / Plan / Auto; Hermes:
  // Default / Accept Edits / Don't Ask). Never sent by an rpc-dialect engine,
  // and absent means "no picker" — there is no global fallback to consult.
  availableModes?: { id?: unknown; name?: unknown; description?: unknown }[];
  currentModeId?: string | null;
};

/** Read a session-scoped catalog off get_state, dropping anything malformed
 * rather than rendering a row that cannot be selected. */
function readSessionModels(state: AgentStateResponse | null | undefined): ModelEntry[] {
  if (!state || !Array.isArray(state.availableModels)) return [];
  return state.availableModels.flatMap((entry) => {
    const provider = typeof entry?.provider === "string" ? entry.provider : "";
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!provider || !id) return [];
    const name = typeof entry?.name === "string" && entry.name ? entry.name : id;
    return [{ provider, id, name }];
  });
}

export type SessionModeOption = { id: string; name: string; description?: string };
const NO_MODES: SessionModeOption[] = [];

/** Read the session's mode list off get_state, dropping anything malformed
 * rather than rendering a row that cannot be selected. */
function readSessionModes(state: AgentStateResponse | null | undefined): SessionModeOption[] {
  if (!state || !Array.isArray(state.availableModes)) return NO_MODES;
  return state.availableModes.flatMap((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!id) return [];
    const name = typeof entry?.name === "string" && entry.name ? entry.name : id;
    const description = typeof entry?.description === "string" && entry.description ? entry.description : undefined;
    return [description ? { id, name, description } : { id, name }];
  });
}

function readLiveContextUsage(value: unknown): ContextUsageValue | null {
  if (!isRecord(value)) return null;
  const { percent, contextWindow, tokens } = value;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  if (percent !== null && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0)) {
    return null;
  }
  if (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) {
    return null;
  }
  if (percent === null && tokens === null) return null;
  return {
    percent: typeof percent === "number" ? percent : (tokens as number) / contextWindow * 100,
    contextWindow,
    tokens: typeof tokens === "number" ? tokens : null,
  };
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };

// omp reports only queuedMessageCount over RPC; the queued texts live in React
// state and would vanish on reload. Mirror them into sessionStorage (per
// session, best-effort, size-bounded) so a reload can restore the queue panel.
const QUEUE_STORAGE_PREFIX = SESSION_STORAGE_PREFIXES.queue;
const QUEUE_STORAGE_MAX_CHARS = 50_000;

function isEmptyQueue(queue: QueuedMessages): boolean {
  return queue.steering.length === 0 && queue.followUp.length === 0;
}

function readPersistedQueue(sessionId: string): QueuedMessages | null {
  try {
    const raw = sessionStorage.getItem(QUEUE_STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QueuedMessages> | null;
    const onlyStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const queue = { steering: onlyStrings(parsed?.steering), followUp: onlyStrings(parsed?.followUp) };
    return isEmptyQueue(queue) ? null : queue;
  } catch {
    return null;
  }
}

function persistQueue(sessionId: string, queue: QueuedMessages): void {
  try {
    const key = QUEUE_STORAGE_PREFIX + sessionId;
    if (isEmptyQueue(queue)) {
      sessionStorage.removeItem(key);
      return;
    }
    // Size bound: drop oldest texts until the payload fits.
    let bounded = queue;
    let raw = JSON.stringify(bounded);
    while (raw.length > QUEUE_STORAGE_MAX_CHARS && bounded.steering.length + bounded.followUp.length > 1) {
      bounded = bounded.steering.length >= bounded.followUp.length
        ? { ...bounded, steering: bounded.steering.slice(1) }
        : { ...bounded, followUp: bounded.followUp.slice(1) };
      raw = JSON.stringify(bounded);
    }
    if (raw.length > QUEUE_STORAGE_MAX_CHARS) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, raw);
  } catch {
    // Best-effort only (quota exceeded, private mode, SSR).
  }
}

function clearPersistedQueue(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    sessionStorage.removeItem(QUEUE_STORAGE_PREFIX + sessionId);
  } catch {
    // ignore storage errors
  }
}

function normalizeThinkingLevel(level: string | undefined): ThinkingLevelOption {
  // omp's "inherit" sentinel means "no explicit selection" — show as auto.
  if (!level || level === "inherit") return "auto";
  return level as ThinkingLevelOption;
}

/** Narrow the live state's model (OmpModel: id-based) to the composer's shape. */
function toThinkingModelMeta(model: { provider?: string; id?: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } } | null | undefined): ThinkingModelMeta | null {
  if (!model?.provider || !model.id) return null;
  return { provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning, thinking: model.thinking };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
// omp's rpc-ui frames add open_url (OAuth) and cancel on top of lib/types' union.
type IncomingExtensionUiRequest =
  | ExtensionUiRequest
  | { type: "extension_ui_request"; id: string; method: "open_url"; url: string; launchUrl?: string; instructions?: string }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string };
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

/** A tool call the engine is executing right now. `startedAt` feeds the
 * elapsed indicator once a tool runs long; `statusText` is the newest line the
 * tool streamed about itself (tool_execution_update) — for a long watch like
 * `write xd://github` (omp's gh run_watch polling a GitHub Actions run) it is
 * the only signal separating "watching CI" from "hung". */
export interface RunningToolInfo {
  id: string;
  name: string;
  startedAt: number;
  statusText?: string;
}

/** An engine-initiated model switch (retry fallback, usage-aware routing,
 * engine-side /model), kept until the model moves again so the composer can
 * wear a persistent marker — the 10s toast alone is easy to miss and the
 * downgraded model outlives it. `role`/`reason` are known only for switches
 * omp attributed via its retry_fallback_applied event. */
export interface AutoModelSwitchInfo {
  from: string;
  to: string;
  role?: string;
  reason?: string;
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: RunningToolInfo[] }
  | null;

/** First informative line of a streamed partial tool result, compacted for the
 * one-line status surfaces (markdown heading markers stripped, clamped). */
export function toolUpdateStatusText(partialResult: unknown): string | undefined {
  if (!isRecord(partialResult) || !Array.isArray(partialResult.content)) return undefined;
  for (const block of partialResult.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const line = block.text.split("\n").map((entry) => entry.replace(/^#+\s*/, "").trim()).find((entry) => entry.length > 0);
    if (!line) continue;
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  return undefined;
}

/**
 * A stream problem the user must be told about, rather than left to infer from
 * a spinner that never stops.
 *
 * `turn_lost`: the server reported an idle engine on (re)connect while this
 * client was waiting for a turn — the engine restarted and the pending turn
 * died with it. The prompt is deliberately NOT re-sent: silently repeating a
 * mutating instruction is worse than losing one.
 *
 * `stream_lost`: manual reconnects failed for the whole budget. The retry is
 * the user's to make now.
 *
 * `send_failed`: the prompt never reached the engine at all — the POST was
 * refused (an attachment over the transport's frame limit, say), timed out, or
 * the network dropped it. The optimistic bubble and the running state are rolled
 * back, and this banner is what stops that from reading as a turn still in
 * flight. Not auto-resent, for the same reason `turn_lost` is not.
 */
export type StreamAlert =
  | { kind: "turn_lost" }
  | { kind: "stream_lost" }
  | { kind: "send_failed"; detail?: string }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats"; retainInput?: boolean };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  advisorEnabled?: boolean;
  /** False when the active engine has no subagents: skip the roster call
   * entirely rather than provoking an "unsupported" rejection per send. */
  subagentsCapable?: boolean;
  /** What to call the engine in notices and toasts. These fire on any slow
   * first connect and on any fallback event, so hardcoding "omp" told a
   * Hermes user that omp was starting up. */
  engineName?: string;
  /** The Interface & Behavior preference. When thinking is shown by default,
   *  session loads must NOT defer thinking text: a deferred block renders
   *  expanded-but-empty, the load's pin-to-bottom lands, and then hundreds of
   *  per-block fetches grow the transcript above the viewport — the
   *  stream-end "bounce". Deferral is purely a payload optimization for
   *  blocks that would start collapsed. */
  thinkingDefaultExpanded?: boolean;
  onAgentEnd?: () => void;
  /** A nameless session just got a name from the server: reload the session
   *  list so the sidebar stops showing the first-message fallback. */
  onSessionNamed?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
  /** Opens a file in the web UI's file viewer (used by the open_file host tool). */
  onOpenFile?: (filePath: string, name: string, sessionId?: string) => void;
  /** Shows a loopback URL in the workspace Preview panel (open_url calls that
   *  target localhost; the open_preview host tool settles server-side and
   *  reaches the panel through the display-request SSE instead). */
  onOpenPreview?: (url: string, sessionId?: string) => void;
  /** Loopback URLs the assistant mentioned in a live reply — candidates for
   *  auto-opening the Preview panel once something answers there. */
  onPreviewUrlsSeen?: (urls: string[], sessionId?: string) => void;
}

export type ThinkingLevelOption = string;

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
/** Naming attempts per session per mount: one for the normal case, one spare
 * for a turn that ended before the engine had flushed the session file. */
const AUTO_NAME_MAX_ATTEMPTS = 2;
/** Model-switch toasts explain a mid-run change of engine behavior — worth a
 * slow read, so they stay up far longer than the 4s default. */
const MODEL_SWITCH_TOAST_MS = 10_000;
const BASH_STATE_RECONCILE_MS = 1_000;
// A cold `omp --mode rpc-ui` spawn (extension + skill + LSP discovery) can take
// far longer than a few seconds, and the SSE route may only answer once the
// child is ready. Give up only after the child would have timed out anyway
// (rpc-process waitReady is 120s server-side) rather than dropping the prompt.
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 60_000;
// Tell the user something is happening if the stream is still connecting.
const EVENT_STREAM_SLOW_CONNECT_MS = 4_000;
// The prompt POST is an acknowledgement — the engine answers it in milliseconds
// and the turn itself streams over SSE. The stream is already connected by the
// time it is sent (ensureEventsConnected waits for `connected`), so a POST still
// unanswered after this is not a slow start: it is a request that will never
// come back, and waiting on it forever is exactly the wedge this cap removes.
const PROMPT_SEND_TIMEOUT_MS = 30_000;
// How often the stream watchdog re-checks a believed-running turn. Cheap: it
// reads two refs and sets a boolean React bails out of when unchanged.
const STREAM_HEALTH_POLL_MS = 2_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? translate("agentSession.eventStreamTimeout")
      : translate("agentSession.eventStreamFailed"));
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Shared guard for URLs opened from agent/extension open_url requests. Allows
 * only http, https and mailto; rejects javascript:, data:, vbscript:, file:,
 * protocol-relative (//...) and any other scheme so a hostile or malformed URL
 * cannot escape the browser. Preserves existing behavior for safe URLs.
 */
function isSafeOpenUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const url = raw.trim();
  if (!url) return false;
  // Protocol-relative (//host/...) — ambiguous scheme, reject.
  if (url.startsWith("//")) return false;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function describeMcpMountNotice(message: CustomMessage): string {
  return extractMessageText(message).trim() || "The MCP tool inventory changed.";
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number") return null;
  // The server estimates estimatedTokensAfter from the summary when omp's
  // CompactionResult omits it; default to 0 as a last resort.
  return {
    reason,
    tokensBefore: r.tokensBefore,
    estimatedTokensAfter: typeof r.estimatedTokensAfter === "number" ? r.estimatedTokensAfter : 0,
  };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string; supportsFastMode?: boolean; contextWindow?: number };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  modelError?: string;
  /** "global" — the sessionless registry this response carries. "session" —
   * the engine publishes its models on the session instead, so `modelList` is
   * legitimately empty here and the composer reads get_state. Deliberately
   * NOT an error: nothing is broken. */
  catalogSource?: "global" | "session";
};

type SlashCommandsResponse = {
  commands?: RpcAvailableSlashCommand[];
};

// Map omp's slash-command sources onto the palette's grouping. Builtins are
// skipped: the client intercepts its own builtin set, and other omp builtins
// still work when typed (omp executes them via the prompt command).
function toSlashCommandInfo(command: RpcAvailableSlashCommand): SlashCommandInfo | null {
  if (command.source === "builtin") return null;
  const source: SlashCommandInfo["source"] = command.source === "extension"
    ? "extension"
    : command.source === "skill"
      ? "skill"
      : "prompt";
  return { name: command.name, description: command.description, source };
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, advisorEnabled, thinkingDefaultExpanded, onAgentEnd, onSessionNamed, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
    onOpenFile, onOpenPreview, onPreviewUrlsSeen,
  } = opts;

  const reducedMotion = usePrefersReducedMotion();
  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  // Latest committed transcript identity, readable from event callbacks that
  // must not re-create per message (the run-end handlers capture it so the
  // follow logic can tell the terminal reload's commit apart from the state
  // churn that precedes it).
  const messagesRef = useRef<AgentMessage[]>(messages);
  messagesRef.current = messages;
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  // False once this hook instance unmounts: background loops (prompt/bash
  // settlement polling) must not keep firing on a dead instance.
  const hookAliveRef = useRef(true);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  // Where this engine's models live. "global" is the sessionless registry
  // /api/models reads (omp, pi); "session" means the engine publishes them on
  // the session itself and the route hands back an honest empty list. The
  // composer must read the right one — showing the empty global list under an
  // ACP engine is the "No models" bug wearing a different hat.
  const [modelCatalogSource, setModelCatalogSource] = useState<"global" | "session">("global");
  const [sessionModels, setSessionModels] = useState<{ list: ModelEntry[]; selectable: boolean }>(
    () => ({ list: [], selectable: false }),
  );
  // Id-scoped like autoModelSwitch: a mode list adopted for one session is
  // never offered on the next (a fresh chat, or a session under an engine
  // that has no modes at all).
  const [sessionModes, setSessionModes] = useState<{ forSession: string | null; options: SessionModeOption[]; current: string | null }>(
    () => ({ forSession: null, options: NO_MODES, current: null }),
  );
  const [liveModelMeta, setLiveModelMeta] = useState<ThinkingModelMeta | null>(null);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>(() => getPreferredToolPreset());
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [fastModeActive, setFastModeActive] = useState<boolean | undefined>(undefined);
  // Runtime session modes returned by get_state and changed via RPC
  // (set_interrupt_mode / set_auto_compaction).
  const [interruptMode, setInterruptMode] = useState<"immediate" | "wait">("immediate");
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState(true);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(false);
  // Queue delivery modes (set_steering_mode / set_follow_up_mode).
  const [steeringMode, setSteeringMode] = useState<"all" | "one-at-a-time">("all");
  const [followUpMode, setFollowUpMode] = useState<"all" | "one-at-a-time">("all");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  // The last provider error auto-retry reported, kept past auto_retry_end so a
  // retry_fallback_applied toast can name the reason for the model switch.
  const lastRetryErrorRef = useRef<string | null>(null);
  /** Naming attempts already spent, per session id — the auto-name call must
   * not repeat once a session has a name (or has proved unnameable). */
  const autoNameAttemptsRef = useRef(new Map<string, number>());
  const [liveContextUsage, setLiveContextUsage] = useState<ContextUsageValue | null>(null);
  // Usage recorded outside the parent transcript, kept apart so the headline
  // adds each source exactly once. `subagentUsage` is summed from the
  // children's own transcripts (server-side, see the subagents route);
  // `engineUsage` accumulates the additive usage_event frames that Claude Code
  // and codex report instead of recording usage on the messages they emit.
  const [subagentUsage, setSubagentUsage] = useState<UsageTotals | null>(null);
  const [engineUsage, setEngineUsage] = useState<UsageTotals | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  // The model Smart resolved — a live-session Smart pick, or the engine's own
  // resolution of a Smart new session. Smart-ness must survive the pin: while
  // the running model still IS this model, the composer keeps saying
  // "Smart · <name>" instead of silently reading like a manual pick. Scoped
  // to the session it was made for (loads and reconciles reuse loadSession,
  // so a reset there would wipe the pin mid-conversation); an engine switch
  // simply stops matching, which hands the label to the marker below.
  const [smartPinnedModel, setSmartPinnedModel] = useState<{ provider: string; modelId: string; forSession: string } | null>(null);
  // The engine's last unprompted model switch (retry fallback, usage-aware
  // routing, an engine-side /model). The 10s toast announces it once; this
  // keeps a composer marker naming the switch until the model moves again —
  // a downgrade that outlives its toast must stay explicable.
  const [autoModelSwitch, setAutoModelSwitch] = useState<(AutoModelSwitchInfo & { forSession: string }) | null>(null);
  // Session id of a spawning Smart new session: its first authoritative model
  // is Smart's own resolution and becomes smartPinnedModel. Id-keyed so a
  // sync for a different session (switched away mid-spawn) can never claim it.
  const pendingSmartSpawnRef = useRef<string | null>(null);
  // The user's last explicit pick, so the model_changed echo of our own
  // set_model is never dressed up as an engine-initiated switch.
  const lastUserModelPickRef = useRef<{ provider: string; modelId: string; at: number } | null>(null);
  // Previous authoritative model, for naming the "from" side of a bare
  // model_changed that arrives without any fallback attribution.
  const lastAuthoritativeModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  // Event-stream health, surfaced so a believed-running turn is never rendered
  // as a healthy "Waiting for model…" against a stream that is not delivering.
  const [streamDegraded, setStreamDegraded] = useState(false);
  const [streamAlert, setStreamAlert] = useState<StreamAlert>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  // Approvals the agent is blocked on. Plural and ordered: the protocol allows
  // more than one outstanding at a time, and each is answered on its own.
  const [permissionRequests, setPermissionRequests] = useState<AgentPermissionRequest[]>([]);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [subagentEvents, setSubagentEvents] = useState<Record<string, SubagentActivityEvent[]>>({});
  const [subagentTranscriptVersions, setSubagentTranscriptVersions] = useState<Record<string, number>>({});
  const [todoPhases, setTodoPhases] = useState<TodoPhase[]>([]);
  const [activeGoal, setActiveGoal] = useState<ActiveGoal | null>(null);
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null);
  const activeSubagentCount = subagents.filter((subagent) => subagent.source !== "history" && subagent.status === "started").length;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stream-health bookkeeping (see lib/stream-recovery). framesSeen counts
  // frames of the CURRENT connection and resets on every connect; the failure
  // streak drives the reconnect backoff and its give-up budget.
  const streamFramesRef = useRef(0);
  const streamUnhealthySinceRef = useRef<number | null>(null);
  // False until this session has opened a stream at all. A brand-new session
  // can sit in agentRunning for a long time while ensure_session spawns the
  // engine, and "no stream yet" is not a broken stream.
  const streamAttachedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectFailingSinceRef = useRef<number | null>(null);
  // Assigned after finishPromptWithoutStream exists: connectEvents is declared
  // long before it, and the connected-frame reconciliation needs it.
  const lostTurnRecoveryRef = useRef<((sid: string) => void) | null>(null);
  // True once the SERVER acknowledged the current run (agent_start, or a
  // get_state that reported it streaming). handleSend flips agentRunning
  // optimistically BEFORE opening the stream and posting the prompt, so that
  // connection's `connected` frame legitimately says idle — reconciling on it
  // would cancel every send. Only an acknowledged run can be "lost".
  const runConfirmedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  // Guards stale branch/leaf context responses: two rapid navigate clicks must
  // not let the older response overwrite the newer branch's messages.
  const contextRequestSeqRef = useRef(0);
  // Mirror of the isCompacting state that survives render batching, so two
  // clicks in the same tick cannot double-send a compact command.
  const isCompactingRef = useRef(false);
  // Set while an interrupt-and-reply (abort_and_prompt) is in flight: the
  // aborted turn's terminal agent_end must not tear down the new run that is
  // starting. Cleared on the new run's agent_start (or the intercept itself).
  const interruptReplyPendingRef = useRef(false);
  // Timestamp of the last client-side queue mutation (steer/follow-up sent).
  // get_state snapshots may lag behind the RPC round-trip, so a snapshot
  // reporting queuedMessageCount === 0 must not wipe a queue we just wrote.
  const queueMutatedAtRef = useRef(0);
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  // Non-null while a terminal run-end reload is replacing `messages` AND the
  // user was following at the bottom: holds the pre-reload array identity.
  // While set, follow scrolls stay instant; the layout effect below consumes
  // it on the reload's commit to re-pin before that commit paints.
  const completionRepinFromRef = useRef<AgentMessage[] | null>(null);
  // Reader's scroll offset captured when a terminal reload is armed while
  // the user is scrolled up (NOT following). The re-pin layout effect
  // restores it across the reload commit — without this, the wholesale
  // `messages` replacement re-realizes every turn's content-visibility
  // placeholder and the kept scrollTop lands on shifted content, which is
  // the "completion ding threw me way up the transcript" bug.
  const completionScrollAnchorRef = useRef<number | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  // Raw child-session events stream at token rate; coalesce the per-subagent
  // revision bumps to one per animation frame so an open dialog only re-pages
  // once per frame instead of per event.
  const subagentVersionFlushRef = useRef<Set<string> | null>(null);
  const subagentVersionFlushFrameRef = useRef<number | null>(null);
  // Delayed live-roster hydration after mount/reconnect; cancelled on unmount
  // so a stale get_subagents cannot target a session that was switched away.
  const rosterRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptRunIdRef = useRef(0);
  // Bumped on every roster clear (run end): in-flight get_subagents/history
  // responses from the finished run must not merge into the cleared (or next
  // run's) roster. The prompt runId alone is not enough — it is not
  // invalidated on terminal.
  const subagentRosterGenerationRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  // True once this mount has persisted a non-empty queue: gates removal so a
  // just-mounted empty state cannot wipe a stored queue before restore runs.
  const queuePersistDirtyRef = useRef(false);
  const eventCoalescerRef = useRef<MessageUpdateCoalescer | null>(null);
  if (eventCoalescerRef.current === null) {
    eventCoalescerRef.current = createMessageUpdateCoalescer((event) => {
      handleAgentEventRef.current?.(event as AgentEvent);
    });
  }
  const eventCoalescer = eventCoalescerRef.current;

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  // For existing sessions, the live state's resolved model wins over the
  // session file's entry: omp may have fallen back to the default model when
  // the recorded one is gone (disabled provider, renamed id), and the file
  // entry then describes a model that is not actually running. pendingModel
  // stays at the bottom (below the file entry) — it only fills the gap while
  // a brand-new session has no file data yet, and a failed new-session
  // set_model must not mask omp's actual resolved model.
  const displayModel = isNew
    ? (newSessionModel ?? newSessionDefaultModel)
    : (currentModelOverride ?? (liveModelMeta
        ? { provider: liveModelMeta.provider, modelId: liveModelMeta.modelId }
        : data?.context.model ?? pendingModel));
  const displayModelProvider = displayModel?.provider;
  const displayModelId = displayModel?.modelId;
  const persistedContextUsage = useMemo(
    () => derivePersistedContextUsage(
      messages,
      displayModelProvider === undefined || displayModelId === undefined
        ? null
        : { provider: displayModelProvider, modelId: displayModelId },
      modelList,
    ),
    [messages, displayModelProvider, displayModelId, modelList],
  );
  const contextUsage = liveContextUsage ?? persistedContextUsage;

  const sessionStats = useMemo(() => {
    // Usage that is real but absent from `messages`: every subagent's own
    // transcript (omp writes those beside the parent file, where the session
    // walk never looks) plus engines that report usage as stream frames. Both
    // are counted once, at the event that reported them — the subagent roster's
    // per-child tokens/cost are DISPLAY values for those very events, so adding
    // them here would count every child twice.
    const external = addUsageTotals(subagentUsage ?? emptyUsageTotals(), engineUsage ?? emptyUsageTotals());
    if (sessionStatsOverride) {
      // The engine's own account of the session, left exactly as it reported
      // it. omp's getSessionStats already folds subagent usage in from each
      // `task` toolResult's `details.usage` rollup (session/session-stats.ts),
      // so adding `external` here would count the children a second time —
      // once from the rollup and once from their transcripts. Where that rollup
      // is absent (async/detached spawns never write it) omp under-reports, but
      // silently doubling a number this UI did not compute is the worse of the
      // two errors: it cannot be told apart from real spend.
      return { ...sessionStatsOverride, contextUsage: contextUsage ?? undefined };
    }
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      toolCalls += msg.content.filter((c) => c.type === "toolCall").length;
    }
    const usage = addUsageTotals(aggregateMessageUsage(messages), external);
    const tokens = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usageTokenTotal(usage),
    };
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost: usage.cost,
      // Absent rather than empty when nothing was flagged: the UI reads absence
      // as "no per-model signal", never as "everything was priced".
      ...(usage.unpricedModels.length > 0 ? { unpricedModels: usage.unpricedModels } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, subagentUsage, engineUsage, contextUsage, data?.filePath, session?.id, session?.name]);

  // Goal mode is web-hosted because omp's native /goal is TUI-only. Keep it
  // scoped to its session so switching conversations never leaks objectives.
  useEffect(() => {
    const sid = session?.id;
    setActivePlan(null);
    if (!sid) {
      setActiveGoal(null);
      return;
    }
    setActiveGoal(parseActiveGoal(sessionStorage.getItem(`${SESSION_STORAGE_PREFIXES.goal}${sid}`)));
  }, [session?.id]);

  // Runtime usage belongs to one session identity. Never carry it into a
  // different existing session or a newly composed workspace.
  useEffect(() => {
    setLiveContextUsage(null);
    setEngineUsage(null);
    setSubagentUsage(null);
  }, [session?.id, newSessionCwd]);

  // A plan request is in progress only for its current agent turn.
  useEffect(() => {
    if (!agentRunning) setActivePlan(null);
  }, [agentRunning]);

  // First phase that still has unfinished work; null once everything is done
  // (or no todo list exists), which hides the status-line suffix.
  const currentTodoPhase = useMemo(() => {
    for (let index = 0; index < todoPhases.length; index++) {
      const phase = todoPhases[index];
      const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
      const done = tasks.filter((task) => task.status === "completed").length;
      if (tasks.some((task) => task.status === "pending" || task.status === "in_progress")) {
        return { name: phase.name, index: index + 1, phaseCount: todoPhases.length, done, total: tasks.length };
      }
    }
    return null;
  }, [todoPhases]);

  // Merge a batch of roster entries, keeping live frames over history.
  // Merge a batch of roster entries, keeping live frames over history.
  // `skipNewerThan` lets callers refuse to overwrite entries updated by live
  // frames after a point-in-time snapshot was requested (a snapshot taken
  // while a child ran must not regress its later terminal lifecycle status).
  const mergeSubagents = useCallback((incoming: SubagentInfo[], options?: { skipNewerThan?: number }) => {
    if (!incoming.length) return;
    const skipNewerThan = options?.skipNewerThan;
    setSubagents((prev) => {
      const byId = new Map(prev.map((subagent) => [subagent.id, subagent]));
      for (const entry of incoming) {
        const existing = byId.get(entry.id);
        if (existing && skipNewerThan !== undefined && (existing.lastUpdate ?? 0) >= skipNewerThan) continue;
        if (!existing) {
          // A terminal frame for an id this roster never saw, landing outside
          // a run (late detached completion, out-of-order frame), is
          // archaeology: adding it would resurrect a chip the run-end prune
          // just removed. A *running* subagent is always adopted.
          if (entry.status !== "started" && !agentRunningRef.current) continue;
          byId.set(entry.id, entry);
          continue;
        }
        byId.set(entry.id, { ...existing, ...entry });
      }
      // Preserve insertion order (chronological): live frames arrive as they
      // happen and existing entries keep their position on update. Sorting by
      // `index` would interleave task calls, since omp restarts the index for
      // every call.
      return [...byId.values()];
    });
  }, []);

  // Subagent usage summed server-side from the children's own transcripts.
  // A fresh snapshot, not a delta: the route re-sums every child transcript
  // on each call, so this REPLACES the running total — it sharpens while
  // children work and settles at run end. The roster itself is deliberately
  // NOT recovered from disk: the composer panel is a live view of the
  // CURRENT run, and seeding it with every subagent the session ever ran is
  // what bloated long conversations to 20+ stale chips. Past runs stay
  // reachable through each task call's in-message summary (TaskResultPanel).
  const refreshSubagentUsage = useCallback(async (sid: string) => {
    // Engines with no subagent vocabulary have nothing to sum, and this
    // fired on EVERY loadSession — a request that could only answer empty.
    if (opts.subagentsCapable === false) return;
    const generation = subagentRosterGenerationRef.current;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/subagents`);
      if (!res.ok) return;
      const data = await res.json() as { subagentUsage?: UsageTotals | null };
      // Fence AFTER the awaited json: the session or roster generation may
      // have changed while the response was in flight.
      if (sessionIdRef.current !== sid || subagentRosterGenerationRef.current !== generation) return;
      setSubagentUsage(data.subagentUsage ?? null);
    } catch {
      // Best effort; the headline just misses child usage until the next call.
    }
  }, [opts.subagentsCapable]);

  // Hydrate the LIVE roster from get_subagents. The registry only holds
  // currently-running subagents, so this fills gaps after an SSE reconnect or
  // a missed lifecycle frame; it never reports finished runs.
  const refreshSubagentRoster = useCallback(async (sid: string) => {
    // Engines without subagents answer get_subagents with an "unsupported"
    // 400 — tolerated by design, but asking anyway means a console error on
    // every send for Claude, Codex and any ACP engine. The capability is
    // already known; respect it.
    if (opts.subagentsCapable === false) return;
    const requestedAt = Date.now();
    const runId = promptRunIdRef.current;
    const generation = subagentRosterGenerationRef.current;
    try {
      const result = await sendAgentCommand<{ subagents?: SubagentSnapshotLike[] }>(sid, { type: "get_subagents" });
      // Fence: the request may resolve after the user switched sessions, the
      // run ended and a new prompt started, or the roster was cleared — its
      // snapshot belongs to a different roster generation and must not merge
      // or prune the new one.
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId || subagentRosterGenerationRef.current !== generation) return;
      const snapshots = (result.subagents ?? [])
        .map(parseSubagentSnapshot)
        .filter((subagent): subagent is SubagentInfo => subagent !== undefined);
      // The snapshot is a point-in-time view: never overwrite entries that
      // live frames updated after the request was made (their state is newer).
      mergeSubagents(snapshots, { skipNewerThan: requestedAt });
      // The registry deletes a subagent before get_subagents returns once its
      // lifecycle is terminal, so a live entry missing from the snapshot means
      // a terminal frame was missed over SSE. Drop it; history recovery and
      // fresh lifecycle frames remain authoritative for other entries. Entries
      // updated AFTER the snapshot was requested are newer than the registry
      // state we got and must survive the prune.
      const liveIds = new Set(snapshots.map((s) => s.id));
      setSubagents((prev) => {
        const next = prev.filter((s) => s.source !== "live" || liveIds.has(s.id) || (s.lastUpdate ?? 0) >= requestedAt);
        return next.length === prev.length ? prev : next;
      });
      // Child transcripts grew while this ran — refresh the usage headline.
      void refreshSubagentUsage(sid);
    } catch {
      // Best effort: subagent_lifecycle/progress frames are the primary source.
    }
  }, [mergeSubagents, refreshSubagentUsage, opts.subagentsCapable]);

  // Clear per-run activity state at run end. MUST also cancel the pending
  // version-flush rAF: a queued subagent_event flush would otherwise repopulate
  // the version map for dead subagent ids right after the clear.
  const resetSubagentActivityState = useCallback(() => {
    if (subagentVersionFlushFrameRef.current !== null) {
      cancelAnimationFrame(subagentVersionFlushFrameRef.current);
      subagentVersionFlushFrameRef.current = null;
    }
    subagentVersionFlushRef.current = null;
    setSubagentEvents({});
    setSubagentTranscriptVersions({});
  }, []);

  // Monotonic sequence for authoritative model syncs. Every async sync
  // (state fetch, model_changed GET) captures a token at START and only
  // applies its snapshot if it is still the newest — a slow stale response
  // can never clobber a newer one (e.g. an old model_changed GET landing
  // after the user picked another model).
  const authoritativeModelSeqRef = useRef(0);
  const beginAuthoritativeModelSync = useCallback((): number => {
    authoritativeModelSeqRef.current += 1;
    return authoritativeModelSeqRef.current;
  }, []);

  // Authoritative resolved-model sync (model_changed / config_update events,
  // post-command refreshes). A runtime model switch (retry-fallback, prewalk
  // hand-off, /model) supersedes the user's last explicit pick — the composer
  // must reflect the model actually running. `token` guards stale async
  // snapshots; synchronous event payloads apply unconditionally. Returns
  // whether the snapshot was applied — callers must drop ALL state derived
  // from a stale response (including its thinking level), not just the model.
  const applyAuthoritativeModel = useCallback((model: ThinkingModelMeta | null, token?: number): boolean => {
    if (token !== undefined && token !== authoritativeModelSeqRef.current) return false;
    authoritativeModelSeqRef.current += 1;
    setLiveModelMeta(model);
    if (!model) return true;
    lastAuthoritativeModelRef.current = { provider: model.provider, modelId: model.modelId };
    // A Smart new session's first resolved model IS Smart's answer.
    if (pendingSmartSpawnRef.current !== null && pendingSmartSpawnRef.current === sessionIdRef.current) {
      const forSession = pendingSmartSpawnRef.current;
      pendingSmartSpawnRef.current = null;
      setSmartPinnedModel({ provider: model.provider, modelId: model.modelId, forSession });
    }
    setCurrentModelOverride((prev) =>
      prev && (prev.provider !== model.provider || prev.modelId !== model.modelId) ? null : prev
    );
    return true;
  }, []);

  // Lightweight live-state sync after composer commands. A command against an
  // idle-disposed session restarts omp, which re-resolves the model from the
  // session file — the freshly resolved model (and clamped thinking level)
  // must reach the composer so the ladder/active level match reality.
  /** Adopt a session-scoped catalog off get_state. Engines with a global
   * registry never send these fields, and an absent field must not be read as
   * "the agent withdrew its selector" — only an explicit report replaces
   * what is held. */
  const adoptSessionModels = useCallback((state: AgentStateResponse | null | undefined) => {
    if (!state || state.modelSelectable === undefined) return;
    const list = readSessionModels(state);
    const selectable = state.modelSelectable === true && list.length > 0;
    setSessionModels((current) => {
      if (current.selectable === selectable
        && current.list.length === list.length
        && current.list.every((entry, index) => entry.provider === list[index].provider && entry.id === list[index].id && entry.name === list[index].name)) {
        return current;
      }
      return { list, selectable };
    });
  }, []);

  /** Adopt the session's mode list off get_state. Unlike models there is no
   * global registry to fall back on, so an absent field IS the answer: this
   * session offers no modes, and whatever an earlier one published must go. */
  // Bumped by every set_mode. A state fetch captures it BEFORE the request
  // goes out and adopts nothing if it moved while the response was in
  // flight: that snapshot predates the switch and would put the picker back
  // to the old mode until the next fetch.
  const modeSyncSeqRef = useRef(0);
  const adoptSessionModes = useCallback((state: AgentStateResponse | null | undefined, sid: string, seq: number) => {
    if (seq !== modeSyncSeqRef.current) return;
    const options = readSessionModes(state);
    const reported = typeof state?.currentModeId === "string" ? state.currentModeId : null;
    const current = reported && options.some((option) => option.id === reported) ? reported : (options[0]?.id ?? null);
    setSessionModes((held) => {
      if (held.forSession === sid && held.current === current
        && held.options.length === options.length
        && held.options.every((option, index) => option.id === options[index].id && option.name === options[index].name && option.description === options[index].description)) {
        return held;
      }
      return { forSession: sid, options, current };
    });
  }, []);

  const refreshLiveModelState = useCallback(async (sid: string) => {
    const token = beginAuthoritativeModelSync();
    const modeSeq = modeSyncSeqRef.current;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
      if (!res.ok) return;
      const agentState = await res.json() as { running: boolean; state?: AgentStateResponse };
      if (sessionIdRef.current !== sid) return;
      adoptSessionModels(agentState.state);
      adoptSessionModes(agentState.state, sid, modeSeq);
      const applied = applyAuthoritativeModel(toThinkingModelMeta(agentState.state?.model), token);
      if (!applied) return; // stale snapshot — drop its thinking level too
      if (agentState.state?.thinkingLevel !== undefined) {
        setThinkingLevel(normalizeThinkingLevel(agentState.state.thinkingLevel));
      }
      // Fast mode is family-scoped in omp: switching to a fast-supported
      // model flips the child's state without any event, so the composer
      // toggle must re-sync from the refreshed state.
      if (agentState.state?.fastModeEnabled !== undefined) {
        setFastModeEnabled(agentState.state.fastModeEnabled);
      }
      setFastModeActive(agentState.state?.fastModeActive);
      if (agentState.state?.autoRetryEnabled !== undefined) setAutoRetryEnabled(agentState.state.autoRetryEnabled);
      if (agentState.state?.interruptMode !== undefined) setInterruptMode(agentState.state.interruptMode);
      if (agentState.state?.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
      if (agentState.state?.steeringMode !== undefined) setSteeringMode(agentState.state.steeringMode);
      if (agentState.state?.followUpMode !== undefined) setFollowUpMode(agentState.state.followUpMode);
    } catch {
      // Best effort; the next loadSession/reconcile re-syncs.
    }
  }, [applyAuthoritativeModel, beginAuthoritativeModelSync, adoptSessionModels, adoptSessionModes]);

  /**
   * Adopt a `get_state.pendingPermissions` snapshot.
   *
   * This is what makes a reload survivable: the permission_request event fired
   * before this page existed, so state is the only place the open request can
   * still be found. It runs on every reconcile poll too, so the array identity
   * is kept when the same requests are still open — a fresh array every 15s
   * would re-render the card (and reset nothing, but churn everything below
   * it) for no reason.
   */
  const adoptPermissionRequests = useCallback((raw: unknown) => {
    const next = readPermissionRequests(raw);
    setPermissionRequests((prev) => (
      prev.length === next.length && prev.every((request, index) => request.requestId === next[index].requestId)
        ? prev
        : next
    ));
  }, []);

  // Ref, not a dependency: loadSession must stay identity-stable across a
  // preference toggle (a new identity would re-run the mount effect and
  // reload the open session mid-run).
  const thinkingDefaultExpandedRef = useRef(thinkingDefaultExpanded === true);
  thinkingDefaultExpandedRef.current = thinkingDefaultExpanded === true;

  // Same reasoning: the engine's display name is read from deep inside the
  // event handler and the connect path, neither of which may change identity
  // when /api/info finally answers. "Cody" is the placeholder until it does,
  // so a notice never renders with an empty hole where a name belongs.
  const engineNameRef = useRef(opts.engineName ?? "Cody");
  engineNameRef.current = opts.engineName ?? "Cody";

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false, fenceRunId?: number) => {
    let messagesLoaded = false;
    if (sessionIdRef.current === sid) setLiveContextUsage(null);
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferMedia: "1" });
      // Thinking text is deferred only when blocks start collapsed. With the
      // show-thinking preference on, a deferred block mounts expanded but
      // EMPTY: the load's pin-to-bottom lands first and per-block fetches
      // then regrow the transcript above the viewport — the visible bounce
      // when a run ends (the terminal reload takes this exact path), plus one
      // HTTP request per thinking block. Ship the text inline instead.
      if (!thinkingDefaultExpandedRef.current) params.set("deferThinking", "1");
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      // A terminal reload for a finished run must not overwrite the messages
      // of a run that started while this fetch was in flight (it would delete
      // the new run's optimistic user bubble).
      if (fenceRunId !== undefined && promptRunIdRef.current !== fenceRunId) return null;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setTodoPhases(d.context.todoPhases ?? []);
      // Child-transcript usage for the headline. The roster is NOT seeded
      // from history — it is a live view of the current run only.
      void refreshSubagentUsage(sid);
      setCurrentModelOverride(null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (!includeState) {
        if (showLoading) setLoading(false);
        return null;
      }

      try {
        // Capture the sequence token BEFORE the fetch: a response snapshotted
        // earlier must not mint a fresh token on arrival and clobber a newer
        // sync that started while this request was in flight.
        const token = beginAuthoritativeModelSync();
        const modeSeq = modeSyncSeqRef.current;
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) {
          if (showLoading) setLoading(false);
          return null;
        }
        if (fenceRunId !== undefined && promptRunIdRef.current !== fenceRunId) {
          if (showLoading) setLoading(false);
          return null;
        }

        const liveState = agentState.state;
        adoptSessionModels(liveState);
        adoptSessionModes(liveState, sid, modeSeq);
        const modelApplied = applyAuthoritativeModel(toThinkingModelMeta(liveState?.model), token);
        if (liveState) {
          if (liveState.contextUsage !== undefined) setLiveContextUsage(readLiveContextUsage(liveState.contextUsage));
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt || null);
          if (modelApplied && liveState.thinkingLevel !== undefined) setThinkingLevel(normalizeThinkingLevel(liveState.thinkingLevel));
          if (liveState.fastModeEnabled !== undefined) setFastModeEnabled(liveState.fastModeEnabled);
          setFastModeActive(liveState.fastModeActive);
          if (liveState.autoRetryEnabled !== undefined) setAutoRetryEnabled(liveState.autoRetryEnabled);
          if (liveState.interruptMode !== undefined) setInterruptMode(liveState.interruptMode);
          if (liveState.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(liveState.autoCompactionEnabled);
          if (liveState.steeringMode !== undefined) setSteeringMode(liveState.steeringMode);
          if (liveState.followUpMode !== undefined) setFollowUpMode(liveState.followUpMode);
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          // THE reload path. A page load never sees the permission_request
          // event that fired before it, so without adopting state here a tab
          // reopened on a blocked turn shows a session that waits forever with
          // nothing to click. Engines with no approval channel omit the field
          // entirely, and undefined must not be read as "none pending".
          if (liveState.pendingPermissions !== undefined) adoptPermissionRequests(liveState.pendingPermissions);
          if (liveState.todoPhases !== undefined) setTodoPhases(liveState.todoPhases ?? []);
          if (liveState.queuedMessageCount === 0 && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
        } else {
          // No live engine at all, so nothing can be blocked on an approval.
          // A card carried over from the previous session would be
          // unanswerable — the request it names died with its process.
          adoptPermissionRequests(undefined);
          if (!agentState.running && Date.now() - queueMutatedAtRef.current >= 5000) {
            setQueuedMessages(EMPTY_QUEUE);
          }
        }
        if (showLoading) setLoading(false);
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        if (showLoading) setLoading(false);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [refreshSubagentUsage, applyAuthoritativeModel, beginAuthoritativeModelSync, adoptPermissionRequests, adoptSessionModels, adoptSessionModes]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    const seq = ++contextRequestSeqRef.current;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[]; todoPhases: TodoPhase[] } };
      // Fence like loadSession: drop the response if the session changed or a
      // newer navigate started while this request was in flight.
      if (sessionIdRef.current !== sid || contextRequestSeqRef.current !== seq) return;
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setTodoPhases(d.context.todoPhases ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage?: string) => {
    firstMessage ??= translate("agentSession.noMessages");
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      // No explicit pick = Smart: whatever model the spawned session first
      // reports is Smart's resolution, and the composer should keep saying so.
      const smartSpawn = newSessionModel === null;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
          ...(advisorEnabled ? { advisor: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (smartSpawn) pendingSmartSpawnRef.current = realId;
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [advisorEnabled, isNew, newSessionCwd, newSessionModel, newSessionDefaultModel, toolPreset, thinkingLevel]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = (data?.commands ?? [])
        .map(toSlashCommandInfo)
        .filter((c): c is SlashCommandInfo => c !== null);
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  // Reconnect actions captured after their definitions (host-tool and URI
  // registrations are per-wrapper and are not persisted by omp, and the
  // roster needs a fresh get_subagents snapshot) so the fatal-error reconnect
  // below can restore everything the mount flow sets up — not just the stream.
  const reconnectActionsRef = useRef<((sid: string) => void) | null>(null);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    // A pending coalesced update belongs to the stream being replaced.
    eventCoalescer.reset();
    // Health is per-connection: the new socket has delivered nothing yet, and
    // the previous one's unhealthy stretch does not carry over.
    streamFramesRef.current = 0;
    streamUnhealthySinceRef.current = null;
    streamAttachedRef.current = true;
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      // The stream is live as soon as the response headers land, whether or not
      // the server also sends an explicit `connected` frame.
      es.onopen = () => settle("connected");

      es.onmessage = (e) => {
        // Liveness first: even a frame we cannot parse proves the stream is
        // delivering, which is all the watchdog asks of it.
        streamFramesRef.current += 1;
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") {
            settle("connected");
            // A frame arrived, so this connection succeeded: end the failure
            // streak that drives the backoff and its give-up budget.
            reconnectAttemptRef.current = 0;
            reconnectFailingSinceRef.current = null;
            // Ground truth. The server stamps the engine's real run state on
            // every (re)connect; an idle engine under a client that is still
            // waiting means the turn died with the old process.
            if (shouldClearLostTurn(agentRunningRef.current && runConfirmedRef.current, event)) {
              lostTurnRecoveryRef.current?.(sid);
            }
          }
          // message_update frames arrive at network rate (often 30-100+/s);
          // the coalescer buffers the latest one and dispatches at display
          // rate, flushing synchronously before any other event type.
          eventCoalescer.push(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions. Keep the timer in a ref so unmount or a
          // session switch cancels it — otherwise an orphaned stream respawns
          // after the hook is torn down.
          settle("closed");
          if (eventSourceRef.current === es && agentRunningRef.current) {
            eventSourceRef.current = null;
            const now = Date.now();
            reconnectFailingSinceRef.current ??= now;
            if (shouldGiveUpReconnecting(reconnectFailingSinceRef.current, now)) {
              // The session is not coming back on its own. Stop retrying (the
              // old fixed-interval loop could hammer a 404 forever) and hand
              // the user an explicit retry instead of an endless spinner.
              setStreamAlert({ kind: "stream_lost" });
              return;
            }
            // Exponential backoff, capped: 1s, 2s, 4s, 8s, then 15s.
            const retryDelay = reconnectDelayMs(reconnectAttemptRef.current);
            reconnectAttemptRef.current += 1;
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              if (agentRunningRef.current && sessionIdRef.current === sid) {
                void connectEvents(sid);
                // The reconnect restores the event stream, but host tools, URI
                // schemes, and the subagent roster were registered on the old
                // connection — re-register them so the agent keeps working.
                reconnectActionsRef.current?.(sid);
              }
            }, retryDelay);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
  }, [eventCoalescer]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  /**
   * Answer one approval the agent is blocked on. Optimistic like the
   * extension-UI reply above: the card goes as soon as it is clicked, because
   * the click is the decision and leaving it on screen invites a second one.
   *
   * A failure is logged, never thrown — the caller is a click handler in the
   * transcript, and the server already treats a stale answer as a no-op
   * (`{ answered: false }`) rather than an error. The authoritative removal is
   * the `permission_resolved` event, which arrives for every settlement:
   * this answer, an abort, the turn ending, or the session dying.
   */
  const respondToPermission = useCallback(async (requestId: string, optionId: string) => {
    const sid = sessionIdRef.current;
    setPermissionRequests((prev) => prev.filter((request) => request.requestId !== requestId));
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "respond_permission", requestId, optionId });
    } catch (e) {
      console.error("Failed to answer permission request:", e);
    }
  }, []);

  // A request belongs to the conversation that raised it. Switching sessions
  // must drop the cards immediately rather than let another session's approval
  // hang over the new transcript — clicking it would answer a request in a
  // conversation the user is no longer looking at. The new session's own
  // pending approvals arrive from its get_state hydration.
  useEffect(() => {
    setPermissionRequests((prev) => (prev.length === 0 ? prev : []));
  }, [session?.id]);

  // ---------------------------------------------------------------------
  // Host-tool bridge: Cody registers tools the AGENT can call. The server
  // emits host_tool_call frames; this UI executes them and answers with
  // host_tool_result (lib/rpc-manager routes registered tools to listeners).
  // The built-in `ask` tool already covers user questions via the extension
  // UI protocol, so we only register web-UI-specific capabilities.
  // ---------------------------------------------------------------------
  const HOST_TOOL_DEFINITIONS = useMemo<HostToolDefinition[]>(() => [
    {
      name: "open_url",
      description: "Open a URL in a new browser tab. Loopback URLs (localhost / 127.0.0.1) open in Cody's embedded Preview panel instead.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    {
      name: "notify",
      description: "Show a browser notification to the user.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string", description: "Optional notification body." },
        },
        required: ["title"],
      },
    },
    {
      name: "open_file",
      description: "Open a file in the workspace file viewer.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute or workspace-relative file path." } },
        required: ["path"],
      },
    },
  ], []);

  /** Re-register host tools on run start / SSE reconnect so the agent always
   * has them available (set_host_tools is per-wrapper, not persisted). */
  const registerHostTools = useCallback(async (sid: string) => {
    try {
      await sendAgentCommand(sid, { type: "set_host_tools", tools: HOST_TOOL_DEFINITIONS });
    } catch {
      // Older omp builds without host tools: the UI simply stays passive.
    }
  }, [HOST_TOOL_DEFINITIONS]);

  /** URI schemes the agent's read/write tools can resolve through the web UI.
   * `pi-web://clipboard` lets the agent read the user's clipboard (best-effort:
   * the browser may gate clipboard reads behind a permission prompt) and copy
   * text back. */
  const HOST_URI_SCHEMES = useMemo<HostUriSchemeDefinition[]>(() => [
    {
      scheme: "pi-web",
      description: "Browser-integrated resources: pi-web://clipboard reads/writes the user's clipboard via the web UI.",
      writable: true,
    },
  ], []);

  const registerHostUriSchemes = useCallback(async (sid: string) => {
    try {
      await sendAgentCommand(sid, { type: "set_host_uri_schemes", schemes: HOST_URI_SCHEMES });
    } catch {
      // Older omp builds: no URI bridge, nothing to do.
    }
  }, [HOST_URI_SCHEMES]);

  reconnectActionsRef.current = (sid: string) => {
    void registerHostTools(sid);
    void registerHostUriSchemes(sid);
    void refreshSubagentRoster(sid);
  };

  /** Answer a host_tool_call with a toolResult payload. */
  const respondHostTool = useCallback(async (sid: string, id: string, text: string, isError = false) => {
    try {
      await sendAgentCommand(sid, {
        type: "host_tool_result",
        id,
        isError,
        result: { content: [{ type: "text", text }] },
      });
    } catch (e) {
      console.error("Failed to send host tool result:", e);
    }
  }, []);

  const handleHostToolCall = useCallback(async (id: string, toolName: string, args: Record<string, unknown>) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    switch (toolName) {
      case "open_url": {
        const raw = typeof args.url === "string" ? args.url : "";
        // Loopback URLs render in the workspace Preview panel instead of a
        // new tab: a host_tool_call arrives outside any user gesture, so
        // window.open is at the popup blocker's mercy — and the embedded
        // panel is the surface built for local dev servers anyway.
        const loopback = normalizePreviewUrl(raw);
        if (loopback && onOpenPreview) {
          onOpenPreview(loopback, sid);
          await respondHostTool(sid, id, `Opened ${loopback} in the workspace Preview panel`);
          break;
        }
        const safe = isSafeOpenUrl(raw);
        const url = safe ? raw : "";
        if (url && typeof window !== "undefined") {
          const opened = window.open(url, "_blank", "noopener,noreferrer");
          opened?.focus?.();
        }
        const message = safe ? (raw ? `Opened ${raw}` : "No URL provided") : "Unsafe or invalid URL not opened";
        await respondHostTool(sid, id, message, !safe && !!raw);
        break;
      }
      case "notify": {
        const title = str(args.title) ?? "OMP";
        const message = str(args.message) ?? "";
        if (typeof Notification !== "undefined") {
          try {
            if (Notification.permission === "granted") {
              new Notification(title, { body: message });
            } else if (Notification.permission === "default") {
              const permission = await Notification.requestPermission();
              if (permission === "granted") new Notification(title, { body: message });
            }
          } catch {
            // Notification API blocked — the result still succeeds.
          }
        }
        await respondHostTool(sid, id, "Notification shown");
        break;
      }
      case "open_file": {
        const path = str(args.path) ?? "";
        if (path && onOpenFile) {
          try {
            const name = path.split(/[\\/]/).pop() || path;
            onOpenFile(path, name, sid);
          } catch {
            // ignore navigation failures
          }
        }
        await respondHostTool(sid, id, path ? `Opened ${path}` : "No path provided", !path);
        break;
      }
      default:
        await respondHostTool(sid, id, `Host tool \"${toolName}\" is not available in Cody`, true);
    }
  }, [onOpenFile, onOpenPreview, respondHostTool]);

  /** Answer a host_uri_request (agent read/write of a registered scheme). */
  const respondHostUri = useCallback(async (sid: string, id: string, frame: { content?: string; contentType?: "text/markdown" | "application/json" | "text/plain"; isError?: boolean; error?: string }) => {
    try {
      await sendAgentCommand(sid, { type: "host_uri_result", id, ...frame });
    } catch (e) {
      console.error("Failed to send host URI result:", e);
    }
  }, []);

  const handleHostUriRequest = useCallback(async (id: string, operation: "read" | "write", url: string, content?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const resource = url.replace(/^pi-web:\/\//i, "") || "";
    if (resource === "clipboard") {
      if (operation === "read") {
        if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
          await respondHostUri(sid, id, { isError: true, error: "Clipboard read is not available in this browser" });
          return;
        }
        try {
          const text = await navigator.clipboard.readText();
          await respondHostUri(sid, id, { content: text || "(clipboard is empty)", contentType: "text/plain" });
        } catch {
          // Permission denied / document not focused: surface a readable error.
          await respondHostUri(sid, id, { isError: true, error: "Clipboard read was denied. Click into the Cody window and try again." });
        }
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(content ?? "");
          await respondHostUri(sid, id, {});
          return;
        } catch {
          await respondHostUri(sid, id, { isError: true, error: "Clipboard write failed in this browser" });
          return;
        }
      }
      await respondHostUri(sid, id, { isError: true, error: "Clipboard write is not available in this browser" });
      return;
    }
    await respondHostUri(sid, id, { isError: true, error: `Unknown pi-web resource: ${resource}` });
  }, [respondHostUri]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  // Declared after addNotice: the dependency array below is evaluated during
  // render, so addNotice must already be initialized.
  const ensureEventsConnected = useCallback(async (sid: string) => {
    // Only this (send-blocking) path announces a slow connect; the mount and
    // auto-reconnect paths call connectEvents directly and stay silent.
    const slowNotice = setTimeout(() => {
      addNotice({ type: "info", message: translate("agentSession.startingAgent", { name: engineNameRef.current }) });
    }, EVENT_STREAM_SLOW_CONNECT_MS);
    let result: EventStreamConnectionResult;
    try {
      result = await connectEvents(sid);
    } finally {
      clearTimeout(slowNotice);
    }
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [addNotice, connectEvents]);

  const handleExtensionUiRequest = useCallback((request: IncomingExtensionUiRequest) => {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        break;
      case "cancel":
        setExtensionDialog((current) => current?.id === request.targetId ? null : current);
        break;
      case "open_url": {
        // OAuth and similar flows: try to open a tab (often blocked outside a
        // user gesture), and always surface the URL as a notice fallback.
        // Reject unsafe schemes (javascript:/data:/file:/protocol-relative).
        const url = request.launchUrl ?? request.url;
        const safeUrl = isSafeOpenUrl(url) ? url : "";
        if (safeUrl) {
          try {
            window.open(safeUrl, "_blank", "noopener,noreferrer");
          } catch {
            // Pop-up blocked — the notice below still carries the URL.
          }
        }
        addNotice({
          id: request.id,
          type: "info",
          message: safeUrl
            ? (request.instructions ? `${request.instructions}\n${safeUrl}` : translate("agentSession.openInBrowser", { url: safeUrl }))
            : translate("agentSession.unsafeUrlBlocked"),
        });
        break;
      }
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText ? [...rest, { key: request.statusKey, text: request.statusText }] : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request as ExtensionUiCustomRequest;
        });
        break;
    }
  }, [addNotice, opts.chatInputRef]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId?: number) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (runId !== undefined && promptRunIdRef.current !== runId) return;
    try {
      // The reload below replaces `messages` wholesale. A follower must be
      // re-pinned instantly through the reflow; a reader scrolled up must
      // keep the exact offset (see the terminal re-pin effect).
      completionRepinFromRef.current = messagesRef.current;
      completionScrollAnchorRef.current = completionScrollAllowedRef.current
        ? null
        : scrollContainerRef.current?.scrollTop ?? null;
      // Pass the fence into loadSession: the pre-check above only guards the
      // start — a next prompt that begins while the reload is in flight must
      // not be overwritten by the finished run's snapshot.
      if (sid) await loadSession(sid, false, true, runId);
    } finally {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      optimisticUserMessageKeyRef.current = null;
      if (!agentRunningRef.current) return;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      lastRetryErrorRef.current = null;
      setSubagents([]);
      subagentRosterGenerationRef.current += 1;
      // Bound per-run activity state: without this, subagentEvents and the
      // transcript-version map retain one entry per subagent id forever.
      resetSubagentActivityState();
      // The run is over: the roster stays EMPTY (still-working detached
      // children re-adopt themselves through their live frames). Only the
      // usage headline is refreshed from the settled child transcripts.
      if (sid) void refreshSubagentUsage(sid);
      dispatch({ type: "end" });
      onAgentEnd?.();
    }
  }, [loadSession, onAgentEnd, refreshSubagentUsage, resetSubagentActivityState]);

  // The engine restarted (container restart, crash) while this client was
  // waiting for a turn: the resumed engine is idle and no agent_end will ever
  // arrive for the dead turn. Settle the run through the same path a missed
  // agent_end takes — it re-reads the transcript, so whatever the turn managed
  // to persist still shows — and raise a banner saying the prompt was lost.
  // The prompt is NOT re-sent: a duplicated mutating instruction is worse than
  // a lost one. Assigned during render like reconnectActionsRef below, because
  // connectEvents is declared before finishPromptWithoutStream exists.
  lostTurnRecoveryRef.current = (sid: string) => {
    setStreamAlert({ kind: "turn_lost" });
    void finishPromptWithoutStream(sid, promptRunIdRef.current);
  };

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (
      hookAliveRef.current
      && sessionIdRef.current === sid
      && agentRunningRef.current
      && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS
    ) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as prompt_done.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      isCompactingRef.current = state?.isCompacting ?? false;
      setIsCompacting(state?.isCompacting ?? false);
      // Also mid-run: this poll is the only todo-phase refresh while streaming.
      if (state?.todoPhases !== undefined) setTodoPhases(state.todoPhases ?? []);
      // Approvals are mirrored BEFORE the busy check below, because a turn
      // blocked on one is precisely a busy turn — reading them after the early
      // return would only ever see a session that no longer has any. This is
      // the recovery net for a permission event lost to a dropped stream;
      // the reload case is handled in loadSession, which does not require a
      // run to be in flight at all.
      if (state?.pendingPermissions !== undefined) adoptPermissionRequests(state.pendingPermissions);
      // And the only reliable re-sync for a missed subagent lifecycle frame.
      void refreshSubagentRoster(sid);
      if ((!state || state.queuedMessageCount === 0) && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setLiveContextUsage(readLiveContextUsage(state.contextUsage));
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, refreshSubagentRoster, adoptPermissionRequests]);

  // A session with no name of its own shows a 50-character slice of its first
  // message in the sidebar — a sentence fragment, not a name. Once the first
  // turn has ended (the transcript is on disk and the engine has had its own
  // chance to title the session) ask the server for a real one.
  //
  // Fire-and-forget by contract: nothing is awaited and every failure is
  // silent, because naming is a convenience the turn must never wait on — the
  // sidebar simply keeps the fallback it already had.
  const maybeAutoNameSession = useCallback((sid: string) => {
    if (session?.name) return;
    const attempts = autoNameAttemptsRef.current.get(sid) ?? 0;
    if (attempts >= AUTO_NAME_MAX_ATTEMPTS) return;
    autoNameAttemptsRef.current.set(sid, attempts + 1);
    fetch(`/api/sessions/${encodeURIComponent(sid)}/auto-name`, { method: "POST" })
      .then((res) => {
        // Either the session now has a name or it has nothing nameable in it
        // (409); neither is worth a second call.
        if (res.ok || res.status === 409) autoNameAttemptsRef.current.set(sid, AUTO_NAME_MAX_ATTEMPTS);
        if (res.ok && hookAliveRef.current) onSessionNamed?.();
      })
      .catch(() => {});
  }, [onSessionNamed, session?.name]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  // Reconnect by hand after the automatic attempts were exhausted (the
  // stream_lost banner's action). Clears the failure streak so the backoff
  // starts over, and re-checks the run against the server — the stream may
  // have been down across a turn that has since ended.
  const retryEventStream = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    reconnectAttemptRef.current = 0;
    reconnectFailingSinceRef.current = null;
    setStreamAlert(null);
    void connectEvents(sid);
    reconnectActionsRef.current?.(sid);
    void reconcileAgentState(sid);
  }, [connectEvents, reconcileAgentState]);

  const dismissStreamAlert = useCallback(() => setStreamAlert(null), []);

  // Watchdog: while a turn is believed to be in flight, a stream that is not
  // OPEN — or that has never delivered a single frame, which is what a
  // half-open connection looks like — must stop being rendered as a healthy
  // "Waiting for model…". Verdict and grace period live in lib/stream-recovery.
  useEffect(() => {
    if (!agentRunning) {
      streamUnhealthySinceRef.current = null;
      setStreamDegraded(false);
      return;
    }
    const tick = () => {
      // Nothing has been connected yet (a new session is still being minted):
      // there is no stream to call unhealthy.
      if (!streamAttachedRef.current) {
        streamUnhealthySinceRef.current = null;
        setStreamDegraded(false);
        return;
      }
      const health = evaluateStreamHealth({
        agentRunning: true,
        readyState: eventSourceRef.current?.readyState ?? null,
        framesSeen: streamFramesRef.current,
        unhealthySince: streamUnhealthySinceRef.current,
        now: Date.now(),
      });
      streamUnhealthySinceRef.current = health.unhealthySince;
      setStreamDegraded(health.degraded);
    };
    tick();
    const interval = setInterval(tick, STREAM_HEALTH_POLL_MS);
    return () => clearInterval(interval);
  }, [agentRunning]);

  // A stream problem belongs to one session; never carry its banner — or the
  // previous session's stream bookkeeping — across a session switch or into a
  // freshly composed workspace.
  useEffect(() => {
    setStreamAlert(null);
    setStreamDegraded(false);
    streamAttachedRef.current = false;
    streamUnhealthySinceRef.current = null;
    reconnectAttemptRef.current = 0;
    reconnectFailingSinceRef.current = null;
  }, [session?.id, newSessionCwd]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const consumeQueuedMessage = useCallback((text: string) => {
    if (!text) return;
    setQueuedMessages((prev) => {
      const si = prev.steering.indexOf(text);
      if (si !== -1) return { ...prev, steering: prev.steering.filter((_, i) => i !== si) };
      const fi = prev.followUp.indexOf(text);
      if (fi !== -1) return { ...prev, followUp: prev.followUp.filter((_, i) => i !== fi) };
      return prev;
    });
  }, []);

  /** Remove one queued message from the client-side queue mirror. omp's RPC
   *  protocol has no queue-mutation commands, so this only affects the queue
   *  panel: a message removed here may still be delivered by the running agent
   *  (it then arrives in the chat like any delivered turn). */
  const removeQueuedMessage = useCallback((text: string) => {
    if (!text) return;
    setQueuedMessages((prev) => {
      const si = prev.steering.indexOf(text);
      const fi = prev.followUp.indexOf(text);
      if (si === -1 && fi === -1) return prev;
      return {
        steering: si === -1 ? prev.steering : prev.steering.filter((_, i) => i !== si),
        followUp: fi === -1 ? prev.followUp : prev.followUp.filter((_, i) => i !== fi),
      };
    });
  }, []);

  /** Promote the first queued follow-up to a steering message (client-side
   *  relabel; the delivery order itself is owned by omp). */
  const promoteQueuedToSteer = useCallback((text: string) => {
    if (!text) return;
    setQueuedMessages((prev) => {
      const fi = prev.followUp.indexOf(text);
      if (fi === -1) return prev;
      return {
        steering: [...prev.steering, text],
        followUp: prev.followUp.filter((_, i) => i !== fi),
      };
    });
  }, []);

  // Mirror queued texts into sessionStorage so a reload can restore them.
  // The dirty gate keeps the initial empty state from wiping a stored queue
  // before the mount-time restore has run.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const empty = isEmptyQueue(queuedMessages);
    if (empty && !queuePersistDirtyRef.current) return;
    queuePersistDirtyRef.current = !empty;
    persistQueue(sid, queuedMessages);
  }, [queuedMessages]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        interruptReplyPendingRef.current = false;
        agentRunningRef.current = true;
        // The engine acknowledged this run, so from here a `connected` frame
        // reporting an idle engine means the run was lost, not that it never
        // started. A new run also resolves any stale lost-turn banner.
        runConfirmedRef.current = true;
        setStreamAlert(null);
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // isTerminal === false means an async delivery resumes this run soon.
        if (event.isTerminal === false) break;
        // An interrupt-and-reply aborts the current turn: its terminal
        // agent_end arrives while abort_and_prompt is already starting the new
        // run — keep the running state alive for it.
        if (interruptReplyPendingRef.current) {
          interruptReplyPendingRef.current = false;
          break;
        }
        // A late agent_end can arrive over SSE after reconcileAgentState
        // already finished this run — don't re-trigger completion.
        if (!agentRunningRef.current) break;
        // Capture sid + runId BEFORE clearing: the terminal reload below is
        // async, and a next prompt (or session switch) that starts while it is
        // in flight must not be overwritten by this finished run's snapshot.
        const endedSid = sessionIdRef.current;
        const endedRunId = promptRunIdRef.current;
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        setSubagents([]);
        subagentRosterGenerationRef.current += 1;
        resetSubagentActivityState();
        dispatch({ type: "end" });
        if (endedSid) {
          // Same contract as finishPromptWithoutStream: re-pin a follower,
          // anchor a reader, before the reload's content-visibility reflow.
          completionRepinFromRef.current = messagesRef.current;
          completionScrollAnchorRef.current = completionScrollAllowedRef.current
            ? null
            : scrollContainerRef.current?.scrollTop ?? null;
          void loadSession(endedSid, false, false, endedRunId);
          const endToken = beginAuthoritativeModelSync();
          const endModeSeq = modeSyncSeqRef.current;
          fetch(`/api/agent/${encodeURIComponent(endedSid)}`)
            .then((r) => (r.ok ? r.json() as Promise<{ state?: AgentStateResponse }> : null))
            .then((d) => {
              if (!d?.state?.model) return;
              // Stale terminal snapshot: the user switched sessions or started
              // the next run while this request was in flight — drop it.
              if (sessionIdRef.current !== endedSid || promptRunIdRef.current !== endedRunId) return;
              adoptSessionModels(d.state);
              adoptSessionModes(d.state, endedSid, endModeSeq);
              const applied = applyAuthoritativeModel(toThinkingModelMeta(d.state.model), endToken);
              if (!applied) return; // stale snapshot — drop everything derived from it
              if (d.state?.contextUsage !== undefined) setLiveContextUsage(readLiveContextUsage(d.state.contextUsage));
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt || null);
              // Fast mode is family-scoped in omp: re-sync from the terminal
              // state so a run that switched models/families never leaves the
              // composer toggle stuck on a stale value.
              if (d.state?.fastModeEnabled !== undefined) setFastModeEnabled(d.state.fastModeEnabled);
              setFastModeActive(d.state?.fastModeActive);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.todoPhases !== undefined) setTodoPhases(d.state.todoPhases ?? []);
              // omp reports only a queued count; an empty (or dead) session
              // means the client-tracked queue texts are stale.
              if ((!d.state || d.state.queuedMessageCount === 0) && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "prompt_result":
        // A prompt handled entirely by a builtin/extension slash command:
        // no agent_start/agent_end pair will follow.
        if (event.agentInvoked !== false) break;
        if (!agentRunningRef.current) break;
        // Fence with the current run id like agent_end does: the reload below
        // is async, and a prompt that starts while it is in flight must not be
        // overwritten by this finished run's snapshot.
        void finishPromptWithoutStream(sessionIdRef.current, promptRunIdRef.current);
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? translate("agentSession.commandFailed") });
        // A failed prompt is terminal: no agent_end follows it. Without this the
        // spinner and the locked input wait for the 15s reconcile poll. Fenced
        // with the run id for the same reason as prompt_result above.
        if (agentRunningRef.current) void finishPromptWithoutStream(sessionIdRef.current, promptRunIdRef.current);
        break;
      case "notice": {
        const level = event.level as string | undefined;
        const message = (event.message as string | undefined)?.trim() ?? "";
        if (/^xd:\/\/:\s*mounted\s+mcp__/i.test(message)) {
          toast.info("MCP tools updated", message, { clamp: true });
        } else {
          addNotice({
            type: level === "error" ? "error" : level === "warning" ? "warning" : "info",
            message,
          });
        }
        break;
      }
      // An ACP engine has stopped mid-turn to ask whether it may do the thing
      // it is about to do. The turn genuinely blocks on the answer, so this
      // card is not a notification — it is the only way the turn finishes.
      case "permission_request": {
        const request = readPermissionRequest(event);
        // Nothing clickable means nothing to render; the server already
        // declines those, and a card that can never be answered would read as
        // the hang it exists to prevent.
        if (!request) break;
        setPermissionRequests((prev) => (
          prev.some((existing) => existing.requestId === request.requestId)
            ? prev
            : [...prev, request]
        ));
        break;
      }
      // Settled — by this browser, another tab, an abort, the turn ending, or
      // the session dying. Every one of those emits this, so it is the single
      // removal path and the card can never outlive the request.
      case "permission_resolved": {
        const requestId = typeof event.requestId === "string" ? event.requestId : "";
        if (!requestId) break;
        setPermissionRequests((prev) => (
          prev.some((existing) => existing.requestId === requestId)
            ? prev.filter((existing) => existing.requestId !== requestId)
            : prev
        ));
        break;
      }
      case "command_output": {
        const text = (event.text as string | undefined)?.trim() ?? "";
        if (/^xd:\/\/:\s*mounted\s+mcp__/i.test(text)) toast.info("MCP tools updated", text, { clamp: true });
        else if (text) addNotice({ type: "info", message: text });
        break;
      }
      case "thinking_level_changed":
        setThinkingLevel(normalizeThinkingLevel(event.thinkingLevel as string | undefined));
        break;
      case "mode_changed": {
        // The agent moved itself (a command typed at it, an escalation after a
        // refusal) or echoed our own set_mode — the picker follows either way.
        // An id the list never offered is ignored: it cannot be shown selected.
        const modeId = typeof (event as { modeId?: unknown }).modeId === "string" ? (event as unknown as { modeId: string }).modeId : null;
        const sid = sessionIdRef.current;
        if (!modeId || !sid) break;
        setSessionModes((held) => (
          held.forSession === sid && held.current !== modeId && held.options.some((option) => option.id === modeId)
            ? { ...held, current: modeId }
            : held
        ));
        break;
      }
      case "model_changed": {
        // Bare event: omp switched the resolved model (explicit /model,
        // retry-fallback, prewalk hand-off). No payload — sync from state.
        const sid = sessionIdRef.current;
        if (!sid) break;
        const token = beginAuthoritativeModelSync();
        void fetch(`/api/agent/${encodeURIComponent(sid)}`)
          .then((r) => (r.ok ? r.json() as Promise<{ state?: AgentStateResponse }> : null))
          .then((d) => {
            if (!d?.state?.model) return;
            if (sessionIdRef.current !== sid) return;
            const previous = lastAuthoritativeModelRef.current;
            const applied = applyAuthoritativeModel(toThinkingModelMeta(d.state.model), token);
            if (!applied) return; // stale snapshot — drop its thinking level too
            // A switch with no fallback attribution and no matching recent
            // user pick is still the engine acting on its own — mark it, so
            // even paths that emit only this bare event stay explicable. A
            // marker whose `to` already matches (the fallback event landed
            // first, with role + reason) is kept, not overwritten.
            const next = { provider: String(d.state.model.provider ?? ""), modelId: String(d.state.model.id ?? "") };
            const pick = lastUserModelPickRef.current;
            const isOwnEcho = pick !== null && Date.now() - pick.at < 15_000
              && pick.provider === next.provider && pick.modelId === next.modelId;
            if (!isOwnEcho && previous && (previous.provider !== next.provider || previous.modelId !== next.modelId)) {
              const from = `${previous.provider}/${previous.modelId}`;
              const to = `${next.provider}/${next.modelId}`;
              setAutoModelSwitch((current) => (
                current && current.forSession === sid && current.to.endsWith(next.modelId)
                  ? current
                  : { from, to, forSession: sid }
              ));
              setSmartPinnedModel((current) => (
                current && current.provider === next.provider && current.modelId === next.modelId ? current : null
              ));
            }
            if (d.state.thinkingLevel !== undefined) setThinkingLevel(normalizeThinkingLevel(d.state.thinkingLevel));
            if (d.state.fastModeEnabled !== undefined) setFastModeEnabled(d.state.fastModeEnabled);
            setFastModeActive(d.state.fastModeActive);
            if (d.state.autoRetryEnabled !== undefined) setAutoRetryEnabled(d.state.autoRetryEnabled);
            if (d.state.interruptMode !== undefined) setInterruptMode(d.state.interruptMode);
            if (d.state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(d.state.autoCompactionEnabled);
            if (d.state.steeringMode !== undefined) setSteeringMode(d.state.steeringMode);
            if (d.state.followUpMode !== undefined) setFollowUpMode(d.state.followUpMode);
          })
          .catch(() => {});
        break;
      }
      case "config_update": {
        // Payload event: model + thinkingLevel snapshot after a
        // config-affecting slash command (e.g. /model).
        const model = event.model as { provider?: string; id?: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } } | undefined;
        if (model) applyAuthoritativeModel(toThinkingModelMeta(model));
        if (event.thinkingLevel !== undefined) setThinkingLevel(normalizeThinkingLevel(event.thinkingLevel as string | undefined));
        break;
      }
      case "available_commands_update": {
        const commands = (event.commands as RpcAvailableSlashCommand[] | undefined) ?? [];
        setSlashCommands(commands.map(toSlashCommandInfo).filter((c): c is SlashCommandInfo => c !== null));
        break;
      }
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          // Delivered steering/follow-up texts leave the client-tracked queue.
          consumeQueuedMessage(extractMessageText(delivered));
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed?.role === "custom" && (completed as CustomMessage).customType === "xdev-mount-notice") {
          toast.info("MCP tools updated", describeMcpMountNotice(completed as CustomMessage), { clamp: true });
        } else if (completed?.role === "assistant" && completed.stopReason === "error") {
          // The engine could not produce a reply at all — no credentials, an
          // invalid key, a provider outage. Both rpc-dialect engines report it
          // exactly like this: an assistant message with no content and the
          // provider's own error text. Appending that as a bubble showed the
          // user nothing, silently; the failure belongs in a notice, in the
          // provider's words, so they know what to fix.
          const detail = typeof completed.errorMessage === "string" && completed.errorMessage.trim()
            ? completed.errorMessage.trim()
            : translate("agentSession.commandFailed");
          // A credentials failure gets the one hint that actually fixes it:
          // the keys panel. Anything else (context overflow, a provider
          // outage) is left in the provider's own words.
          const looksLikeCredentials = /\b(401|403)\b|\b(unauthori[sz]ed|forbidden|api[ _-]?key|credential|authenticat|invalid[ _-]?(x-)?api|no (provider|api) key)/i.test(detail);
          addNotice({
            type: "error",
            message: looksLikeCredentials ? `${detail.replace(/[.\s]+$/, "")}. ${translate("agentSession.providerKeysHint")}` : detail,
          });
          const hasContent = Array.isArray(completed.content) ? completed.content.length > 0 : Boolean(completed.content);
          if (hasContent) setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
          if (completed.role === "assistant" && onPreviewUrlsSeen) {
            // Loopback URLs in a live assistant reply are candidates for
            // auto-opening the Preview panel; the shell probes reachability
            // before acting, so mere mentions of a dead port stay quiet.
            const urls = extractLoopbackUrls(extractMessageText(completed));
            if (urls.length > 0) onPreviewUrlsSeen(urls, sessionIdRef.current ?? undefined);
          }
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name, startedAt: Date.now() });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        // Long-running tools stream progress about themselves (omp's gh
        // run_watch reports every CI poll this way). Keep only the newest
        // line per tool — without it a long `write xd://github` watch is
        // indistinguishable from a hang.
        const id = event.toolCallId as string;
        const statusText = toolUpdateStatusText(event.partialResult);
        if (!statusText) break;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const index = prev.tools.findIndex((t) => t.id === id);
          if (index === -1 || prev.tools[index].statusText === statusText) return prev;
          const tools = [...prev.tools];
          tools[index] = { ...tools[index], statusText };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        if (event.toolName === "todo" && sessionIdRef.current) {
          void reconcileAgentState(sessionIdRef.current);
        }
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "todo_reminder":
      case "todo_auto_clear":
        if (sessionIdRef.current) void reconcileAgentState(sessionIdRef.current);
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        // Remembered past auto_retry_end: a fallback that follows exhausted
        // retries names this error as its reason.
        if (typeof event.errorMessage === "string" && event.errorMessage.trim()) {
          lastRetryErrorRef.current = event.errorMessage.trim();
        }
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      // A silent model swap is the confusing half of retry fallback: the run
      // continues, the composer badge changes, and nothing says why. Surface
      // omp's own fallback events so the switch always announces its reason —
      // including the provider error that caused it — and give the toast time
      // to actually be read (10s, dismissible).
      case "retry_fallback_applied": {
        const from = typeof event.from === "string" ? event.from : "?";
        const to = typeof event.to === "string" ? event.to : "?";
        const role = typeof event.role === "string" ? event.role : "default";
        const reason = lastRetryErrorRef.current;
        const detail = translate("agentSession.fallbackAppliedDetail", { role, name: engineNameRef.current })
          + (reason ? `\n${translate("agentSession.fallbackReason", { reason })}` : "");
        // The toast announces the switch once; the marker outlives it on the
        // composer until the model moves again, so a downgraded session never
        // reads as if the downgrade were the user's own pick.
        if (sessionIdRef.current) {
          setAutoModelSwitch({ from, to, role, reason: reason ?? undefined, forSession: sessionIdRef.current });
        }
        setSmartPinnedModel(null);
        toast.info(
          translate("agentSession.fallbackApplied", { from, to }),
          detail,
          { durationMs: MODEL_SWITCH_TOAST_MS, clamp: true },
        );
        break;
      }
      case "retry_fallback_succeeded": {
        const model = typeof event.model === "string" ? event.model : "?";
        lastRetryErrorRef.current = null;
        toast.success(
          translate("agentSession.fallbackSucceeded", { model }),
          translate("agentSession.fallbackSucceededDetail", { name: engineNameRef.current }),
          { durationMs: MODEL_SWITCH_TOAST_MS },
        );
        break;
      }
      // Turn boundaries are where todo items flip (the model checks phases
      // off between turns, and subagent-driven updates land without any
      // parent-session tool frame). Refresh there instead of waiting for the
      // 15s reconcile poll, so items check off as they complete instead of
      // arriving in poll-sized batches.
      case "turn_end":
        if (sessionIdRef.current) {
          void reconcileAgentState(sessionIdRef.current);
          maybeAutoNameSession(sessionIdRef.current);
        }
        break;
      case "usage_event": {
        // Claude Code and codex account for themselves instead of recording
        // usage on the messages they emit, so their figures arrive as frames.
        // Every frame is a delta to add: no frame restates an earlier one (see
        // lib/harness/types.ts), so a turn that dies after reporting still
        // leaves what it spent counted, and a reconnect cannot inflate a total.
        const usage = event.usage;
        if (!isRecord(usage)) break;
        setEngineUsage((prev) => addUsageTotals(prev ?? emptyUsageTotals(), {
          input: asCount(usage.input),
          output: asCount(usage.output),
          cacheRead: asCount(usage.cacheRead),
          cacheWrite: asCount(usage.cacheWrite),
          cost: asCount(usage.cost),
          unpricedModels: [],
        }));
        break;
      }
      case "auto_compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted && !event.skipped) {
          setCompactResult(readCompactResult(event.result, "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "subagent_lifecycle": {
        // Roster fed by omp's subagent_lifecycle frames. Payload mirrors
        // SubagentLifecyclePayload (oh-my-pi task/types.ts); defensive
        // parsing degrades to ignoring the frame, never breaking the run.
        const info = parseSubagentLifecycle(event.payload);
        if (!info) break;
        mergeSubagents([info]);
        break;
      }
      case "host_tool_call": {
        // The wrapper only forwards REGISTERED host tools (see rpc-manager),
        // so a frame here is always one this UI can answer.
        const id = typeof event.id === "string" ? event.id : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        const args = isRecord(event.arguments) ? event.arguments : {};
        if (id && toolName) void handleHostToolCall(id, toolName, args);
        break;
      }
      case "host_uri_request": {
        // The wrapper only forwards REGISTERED schemes (see rpc-manager).
        const id = typeof event.id === "string" ? event.id : "";
        const url = typeof event.url === "string" ? event.url : "";
        const operation = event.operation === "write" ? "write" as const : "read" as const;
        const content = typeof event.content === "string" ? event.content : undefined;
        if (id && url) void handleHostUriRequest(id, operation, url, content);
        break;
      }
      case "subagent_progress": {
        // Progress frames carry the full AgentProgress snapshot (throttled to
        // one per 150ms and flushed at terminal). The reliable key is
        // progress.id; parentToolCallId/index are fallbacks.
        const payload = event.payload as { index?: unknown; agent?: unknown; agentSource?: unknown; task?: unknown; parentToolCallId?: unknown; sessionFile?: unknown; assignment?: unknown; detached?: unknown; progress?: unknown } | undefined;
        const progress = parseSubagentProgress(payload?.progress);
        const progressId = progress?.id;
        const index = typeof payload?.index === "number" ? payload.index : (progress?.index ?? -1);
        const parentToolCallId = typeof payload?.parentToolCallId === "string" ? payload.parentToolCallId : null;
        const task = typeof payload?.task === "string" && payload.task.trim() ? payload.task : (progress?.task ?? null);
        const assignment = typeof payload?.assignment === "string" ? payload.assignment : progress?.assignment;
        if (!progressId && !task && !parentToolCallId && index < 0) break;
        setSubagents((prev) => {
          if (prev.length === 0) return prev;
          let target = -1;
          if (progressId) {
            // A valid progress frame names its subagent; if that id is gone the
            // frame is stale (terminal frame was missed, then cleared) — falling
            // back to parentToolCallId/index could overwrite a DIFFERENT child.
            target = prev.findIndex((subagent) => subagent.id === progressId);
          } else {
            // ID-less fallback frames: prefer the exact (parent, index) pair
            // (batch children share parentToolCallId), then each key alone.
            if (parentToolCallId && index >= 0) {
              target = prev.findIndex((subagent) => subagent.parentToolCallId === parentToolCallId && subagent.index === index);
            }
            if (target === -1 && parentToolCallId) target = prev.findIndex((subagent) => subagent.parentToolCallId === parentToolCallId);
            if (target === -1 && index >= 0) target = prev.findIndex((subagent) => subagent.index === index);
          }
          if (target === -1) return prev;
          const current = prev[target];
          const nextEntry: SubagentInfo = {
            ...current,
            agent: typeof payload?.agent === "string" ? payload.agent : current.agent,
            // The snapshot's agent-source literal lives in payload.agentSource,
            // not payload.agent (which holds the agent name).
            agentSource:
              typeof payload?.agentSource === "string"
                && (payload.agentSource === "bundled" || payload.agentSource === "user" || payload.agentSource === "project")
                ? payload.agentSource
                : current.agentSource,
            ...(typeof payload?.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
            ...(typeof payload?.detached === "boolean" ? { detached: payload.detached } : {}),
            ...(task ? { task } : {}),
            ...(assignment !== undefined ? { assignment } : {}),
            ...(progress ? { progress } : {}),
            lastUpdate: Date.now(),
            source: "live",
          };
          // Progress frames arrive every ~150ms; skip the rerender when no
          // displayed field actually changed (lastUpdate is never rendered;
          // undefined values are omitted by JSON.stringify).
          if (JSON.stringify({ ...current, lastUpdate: undefined }) === JSON.stringify({ ...nextEntry, lastUpdate: undefined })) return prev;
          const next = [...prev];
          next[target] = nextEntry;
          return next;
        });
        break;
      }
      case "subagent_event": {
        // An events-level subscription embeds raw child-session events here.
        // The transcript remains paged on the server; a per-child revision
        // tells an open dialog to fetch only the appended byte range. Also
        // keep a bounded live-activity buffer for the transcript dialog.
        const payload = event.payload as { id?: unknown; event?: unknown } | undefined;
        const subagentId = typeof payload?.id === "string" ? payload.id : null;
        if (subagentId) {
          const pending = subagentVersionFlushRef.current ?? (subagentVersionFlushRef.current = new Set());
          pending.add(subagentId);
          if (subagentVersionFlushFrameRef.current === null) {
            subagentVersionFlushFrameRef.current = requestAnimationFrame(() => {
              subagentVersionFlushFrameRef.current = null;
              const queued = subagentVersionFlushRef.current;
              subagentVersionFlushRef.current = null;
              if (!queued || queued.size === 0) return;
              setSubagentTranscriptVersions((prev) => {
                let next = prev;
                for (const id of queued) next = { ...next, [id]: (next[id] ?? 0) + 1 };
                return pruneSubagentIdMap(next);
              });
            });
          }
          const activity = parseSubagentActivityEvent(payload);
          if (activity) {
            setSubagentEvents((prev) => {
              const existing = prev[subagentId] ?? [];
              const nextEvents = existing.length >= SUBAGENT_ACTIVITY_BUFFER_MAX
                ? [...existing.slice(existing.length - SUBAGENT_ACTIVITY_BUFFER_MAX + 1), activity]
                : [...existing, activity];
              // Re-key first so pruning evicts the LEAST recently UPDATED ids
              // (a plain spread keeps an existing key at its original position
              // and can evict an actively-updated early id).
              const next = { ...prev };
              delete next[subagentId];
              next[subagentId] = nextEvents;
              return pruneSubagentIdMap(next);
            });
          }
        }
        break;
      }
      case "extension_ui_request":
        handleExtensionUiRequest(event as unknown as IncomingExtensionUiRequest);
        break;
    }
  }, [addNotice, consumeQueuedMessage, finishPromptWithoutStream, handleExtensionUiRequest, handleHostToolCall, handleHostUriRequest, loadSession, maybeAutoNameSession, mergeSubagents, onAgentEnd, onPreviewUrlsSeen, reconcileAgentState, resetSubagentActivityState, applyAuthoritativeModel, beginAuthoritativeModelSync, adoptSessionModels, adoptSessionModes]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    if (agentRunningRef.current || bashRunningRef.current) return false;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    // Shell mode belongs to the rpc-dialect engines. An ACP session accepts no
    // `bash` command, so intercepting the `!` there would turn the user's line
    // into a request the engine rejects as unsupported and nothing would be
    // sent at all; the flag keeps it an ordinary first character so the line
    // falls through to the prompt path verbatim. The hook has no props path to
    // the capability set, so it reads the same memoized `/api/info` snapshot.
    const isBashCommand = !images?.length && trimmedMessage.startsWith("!")
      && await engineSupports("chatExtras");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return true;
    }

    const promptRunId = promptRunIdRef.current + 1;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    // Optimistic: the stream is opened and the prompt posted below, so the
    // server has not acknowledged this run yet (see runConfirmedRef).
    runConfirmedRef.current = false;
    setStreamAlert(null);
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;
    // The send click bubbles through the global pointer listener below. It is
    // not a request to stop following the response that this prompt starts.
    userScrollIntentUntilRef.current = 0;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      let sentSessionId: string | null = null;
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          // omp assigns the real id before the first prompt finishes. Promote
          // now so the sidebar can show this active session during streaming.
          promoteNewSession(1, message);
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          void refreshSubagentRoster(sid);
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          }, { timeoutMs: PROMPT_SEND_TIMEOUT_MS });
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        void refreshSubagentRoster(session.id);
        void registerHostTools(session.id);
        void registerHostUriSchemes(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        }, { timeoutMs: PROMPT_SEND_TIMEOUT_MS });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
      return true;
    } catch (e) {
      console.error("Failed to send message:", e);
      // Every failure here (stream connect, ensure_session, set_model, the
      // prompt POST itself) means the prompt never started, so roll the
      // optimistic bubble back instead of leaving a ghost message.
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      const detail = e instanceof Error ? e.message : String(e);
      addNotice({
        type: "error",
        message: e instanceof EventStreamConnectionError
          ? e.message
          : translate("agentSession.sendFailed", { detail }),
      });
      // A toast fades; the wedge this replaces did not. The banner stays until
      // dismissed so a prompt that never started can never read as one still
      // running — whatever the failure was (refused frame, timeout, network).
      setStreamAlert({ kind: "send_failed", detail });
      // Restore the user's text into the input instead of losing it. Mirrors the
      // shell-command recovery in executeBash; insertIfEmpty avoids clobbering
      // anything typed since.
      if (message) opts.chatInputRef?.current?.insertIfEmpty(message);
      optimisticUserMessageKeyRef.current = null;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, opts.chatInputRef, refreshSubagentRoster, registerHostTools, registerHostUriSchemes]);

  /** Abort the running agent and send the message as a fresh prompt
   * (abort_and_prompt). Only valid mid-run; the old turn's agent_end is
   * consumed by the pending-interrupt guard so the new run keeps streaming. */
  const handleInterruptAndReply = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    const sid = sessionIdRef.current;
    if (!sid || !agentRunningRef.current) return false;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    interruptReplyPendingRef.current = true;
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;
    userScrollIntentUntilRef.current = 0;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await ensureEventsConnected(sid);
      void refreshSubagentRoster(sid);
      await sendAgentCommand(sid, {
        type: "abort_and_prompt",
        message: trimmedMessage,
        ...(piImages?.length ? { images: piImages } : {}),
      }, { timeoutMs: PROMPT_SEND_TIMEOUT_MS });
      return true;
    } catch (e) {
      console.error("Failed to interrupt and reply:", e);
      interruptReplyPendingRef.current = false;
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      optimisticUserMessageKeyRef.current = null;
      const detail = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message: detail });
      // The interrupted turn keeps running; what failed is THIS message, and it
      // was never delivered. Same banner as a failed first send.
      setStreamAlert({ kind: "send_failed", detail });
      return false;
    }
  }, [addNotice, ensureEventsConnected, refreshSubagentRoster]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error(translate("agentSession.shellSessionFailed"));
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  // omp's RPC protocol has no navigate-within-tree command, so branch
  // selection is display-only: the viewed branch is loaded from the session
  // file, while a live agent keeps prompting from its own current leaf.
  const handleNavigate = useCallback(async (entryId: string) => {
    // While a run is active its streaming frames append to the displayed
    // message list — swapping in another branch's context mid-run would mix
    // the running turn into the wrong branch (same gating as MessageView's
    // sessionBusy-navigable check).
    if (bashRunningRef.current || agentRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current || agentRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    // An explicit pick: not Smart any more, and any auto-switch marker is
    // answered. The echo of our own set_model (omp emits model_changed for
    // it) must not be re-labelled as an engine-initiated switch.
    lastUserModelPickRef.current = { provider, modelId, at: Date.now() };
    setSmartPinnedModel(null);
    setAutoModelSwitch(null);
    pendingSmartSpawnRef.current = null;
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
      void refreshLiveModelState(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel, refreshLiveModelState]);

  // Returns a brand-new session to auto ("Smart") model resolution: omp picks
  // the model from the user's configured OMP roles plan instead of a pinned
  // provider/modelId. Only meaningful before the session has spawned — on a
  // live session the picker resolves the role itself and reports the pin
  // through markSmartPinnedModel below.
  const selectSmartModel = useCallback(() => {
    setNewSessionModel(null);
    setSmartPinnedModel(null);
    pendingSmartSpawnRef.current = null;
  }, [setNewSessionModel]);

  // A live-session Smart pick: the composer resolved the configured default
  // role to a concrete model and pinned it via handleModelChange — record
  // that the pin was Smart's answer so the label keeps saying "Smart · …"
  // instead of reading like a manual pick.
  const markSmartPinnedModel = useCallback((provider: string, modelId: string) => {
    const forSession = sessionIdRef.current;
    if (!forSession) return;
    setSmartPinnedModel({ provider, modelId, forSession });
    setAutoModelSwitch(null);
  }, []);

  const handleFastModeChange = useCallback(async (enabled: boolean) => {
    // A brand-new session has no runtime yet: the model picker updates local
    // state (so the Fast button appears), but set_fast_mode is a live-process
    // command — without spawning the session the click silently no-ops.
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current ?? await ensureNewSession();
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ enabled?: boolean; active?: boolean }>(sid, { type: "set_fast_mode", enabled });
      setFastModeEnabled(result?.enabled ?? enabled);
      setFastModeActive(result?.active);
      void refreshLiveModelState(sid);
    } catch (error) {
      console.error("Failed to change Fast mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, ensureNewSession, refreshLiveModelState]);

  /** Toggle automatic retry for transient model failures. */
  const handleAutoRetryChange = useCallback(async (enabled: boolean) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setAutoRetryEnabled(enabled);
    try {
      await sendAgentCommand(sid, { type: "set_auto_retry", enabled });
    } catch (error) {
      setAutoRetryEnabled((current) => (current === enabled ? !enabled : current));
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Change how steering interrupts the running agent (immediate vs wait). */
  const handleInterruptModeChange = useCallback(async (mode: "immediate" | "wait") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setInterruptMode(mode);
    try {
      await sendAgentCommand(sid, { type: "set_interrupt_mode", mode });
    } catch (error) {
      console.error("Failed to change interrupt mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Toggle automatic context compaction on the live session. */
  const handleAutoCompactionChange = useCallback(async (enabled: boolean) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setAutoCompactionEnabled(enabled);
    try {
      await sendAgentCommand(sid, { type: "set_auto_compaction", enabled });
    } catch (error) {
      console.error("Failed to change auto-compaction:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Change how queued steering messages are delivered (all at once / one at a time). */
  const handleSteeringModeChange = useCallback(async (mode: "all" | "one-at-a-time") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setSteeringMode(mode);
    try {
      await sendAgentCommand(sid, { type: "set_steering_mode", mode });
    } catch (error) {
      console.error("Failed to change steering mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Change how queued follow-up messages are delivered. */
  const handleFollowUpModeChange = useCallback(async (mode: "all" | "one-at-a-time") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setFollowUpMode(mode);
    try {
      await sendAgentCommand(sid, { type: "set_follow_up_mode", mode });
    } catch (error) {
      console.error("Failed to change follow-up mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Cycle to the next available model (⌘/Ctrl+Alt+M). */
  const handleCycleModel = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "cycle_model" });
      void refreshLiveModelState(sid);
    } catch (error) {
      console.error("Failed to cycle model:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, refreshLiveModelState]);

  /** Cycle to the next thinking level (⌘/Ctrl+Alt+T). */
  const handleCycleThinkingLevel = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "cycle_thinking_level" });
      void refreshLiveModelState(sid);
    } catch (error) {
      console.error("Failed to cycle thinking level:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, refreshLiveModelState]);

  /** Stop an in-progress automatic retry from the retry banner. */
  const handleAbortRetry = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setRetryInfo(null);
    try {
      await sendAgentCommand(sid, { type: "abort_retry" });
    } catch (error) {
      console.error("Failed to abort retry:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  const handleHandoff = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompactingRef.current || agentRunningRef.current || bashRunningRef.current) return;
    try {
      await sendAgentCommand(sid, { type: "handoff" });
      await loadSession(sid, true);
      void refreshLiveModelState(sid);
    } catch (error) {
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, loadSession, refreshLiveModelState]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompactingRef.current || isCompacting) return;
    isCompactingRef.current = true;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
      void refreshLiveModelState(sid);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      isCompactingRef.current = false;
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession, refreshLiveModelState]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    setModelsLoading(true);
    try {
      const modelCwd = newSessionCwd ?? session?.cwd ?? "";
      const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
      const res = await fetch(modelsUrl, signal ? { signal } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as ModelsResponse;
      setModelNames(d.models);
      setModelError(d.modelError ?? null);
      setModelCatalogSource(d.catalogSource === "session" ? "session" : "global");
      setModelThinkingLevels(d.thinkingLevels ?? {});
      setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
      const nextModelList = d.modelList ?? [];
      setModelList(nextModelList);
      // A session-scoped engine has no default to seed a new session with:
      // the agent resolves its own on session/new and reports it back through
      // get_state. Seeding from an empty global list would pin the composer to
      // nothing at all.
      if (isNew && d.catalogSource !== "session") {
        const match = d.defaultModel
          ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
          : undefined;
        const displayModel = match ?? nextModelList[0];
        setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      }
    } catch (e) {
      // Surface fetch/parse failures instead of silently rendering an empty
      // model list with no error state.
      if (!signal?.aborted) setModelError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelsLoading(false);
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? translate("agentSession.commandCompleted") });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompactingRef.current || isCompacting) return complete({ handled: true, error: translate("agentSession.noSessionToCompact") });
          isCompactingRef.current = true;
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          await loadSession(sid, true);
          isCompactingRef.current = false;
          setIsCompacting(false);
          // loadSession resolves to null unless state was requested, so promote
          // unconditionally — promoteNewSession no-ops for existing sessions and
          // is idempotent via newSessionPromotedRef.
          promoteNewSession();
          return complete({ handled: true, message: translate("agentSession.compactedContext") });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noSessionToReload") });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: translate("agentSession.reloadedResources") });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noSessionToName") });
          if (!args) return complete({ handled: true, error: translate("agentSession.nameUsage") });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          await loadSession(sid);
          promoteNewSession();
          return complete({ handled: true, message: translate("agentSession.sessionRenamed", { name: args }) });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noActiveSession") });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noActiveSession") });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: translate("agentSession.noMessageToCopy") });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: translate("agentSession.copiedLastMessage") });
        }

        default: {
          // Web-native prompt commands (/goal, /plan, ...). omp's same-named
          // builtins are TUI-only and never execute over RPC, so the palette
          // shows these instead (CLIENT_BUILTIN_COMMAND_NAMES drops omp's
          // copies). handleSend runs the full prompt pipeline — optimistic
          // bubble, running state, settlement — with the expanded text.
          const expansion = expandWebSlashCommand(text);
          if (expansion.kind === "not-web") return { handled: false };
          if (expansion.kind === "usage-error") {
            // error keeps the user's text in the input so they can append args.
            return complete({
              handled: true,
              error: translate("agentSession.commandRequiresArgs", {
                command: expansion.command,
                usage: translate(expansion.argumentHintKey),
              }),
            });
          }
          if (commandName === "plan") setActivePlan({ objective: args });
          const sent = await handleSend(expansion.prompt);
          if (!sent) {
            if (commandName === "plan") setActivePlan(null);
            return { handled: true, retainInput: true };
          }
          if (commandName === "goal") {
            const goal = createActiveGoal(args);
            setActiveGoal(goal);
            const activeSessionId = sessionIdRef.current;
            if (activeSessionId) sessionStorage.setItem(`${SESSION_STORAGE_PREFIXES.goal}${activeSessionId}`, JSON.stringify(goal));
          }
          return { handled: true };
        }
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") {
        isCompactingRef.current = false;
        setIsCompacting(false);
      }
    }
  }, [addNotice, ensureNewSession, handleSend, isCompacting, loadModels, loadSession, loadSlashCommands, promoteNewSession, onSessionStatsPanelOpen]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      // omp emits no queue snapshots; track the queued text locally until it
      // is delivered (user message_end) or the queue count drops to zero.
      queueMutatedAtRef.current = Date.now();
      setQueuedMessages((prev) => ({ ...prev, steering: [...prev.steering, message] }));
    } catch (e) {
      console.error("Failed to steer:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(message);
    }
  }, [addNotice, opts.chatInputRef]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      queueMutatedAtRef.current = Date.now();
      setQueuedMessages((prev) => behavior === "steer"
        ? { ...prev, steering: [...prev.steering, message] }
        : { ...prev, followUp: [...prev.followUp, message] });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(message);
    }
  }, [addNotice, opts.chatInputRef]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      queueMutatedAtRef.current = Date.now();
      setQueuedMessages((prev) => ({ ...prev, followUp: [...prev.followUp, message] }));
    } catch (e) {
      console.error("Failed to follow up:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(message);
    }
  }, [addNotice, opts.chatInputRef]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
      void refreshLiveModelState(sid);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [refreshLiveModelState]);

  const handleModeChange = useCallback(async (modeId: string) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    // Optimistic: the picker shows the pick at once; the engine's mode_changed
    // echo confirms it, and a refused switch is put back from live state.
    modeSyncSeqRef.current += 1;
    setSessionModes((held) => (
      held.forSession === sid && held.options.some((option) => option.id === modeId) ? { ...held, current: modeId } : held
    ));
    try {
      await sendAgentCommand(sid, { type: "set_mode", modeId });
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : translate("agentSession.commandFailed") });
      void refreshLiveModelState(sid);
    }
  }, [refreshLiveModelState, addNotice]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    setToolPresetState(preset);
    setPreferredToolPreset(preset);
    // The preset is applied at spawn time (--tools/--no-tools flags); omp's
    // RPC protocol cannot change the toolset of an already-running session.
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (sid) {
      addNotice({ type: "info", message: translate("agentSession.toolPresetNotice") });
    }
  }, [setToolPresetState, addNotice]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    // `behavior: "auto"` falls back to the container's computed
    // `scroll-behavior` (which inherits `html { scroll-behavior: smooth }`),
    // so a per-frame live follow would restart an eased scroll animation
    // every frame — an endless chase that lags the growing content. Callers
    // pass "instant" for live follow; "smooth" stays for idle scrolls.
    end.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "instant" : behavior });
  }, [reducedMotion]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const userScrollIntent = Date.now() <= userScrollIntentUntilRef.current;
    // A user wheel, keyboard, touch, or scrollbar scroll must win over the
    // timer used to suppress our own scroll events. During a busy stream that
    // timer is refreshed every frame, so checking it first would trap the user
    // at the bottom.
    if (!userScrollIntent && Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (!userScrollIntent) return;
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    // Recompute even while idle: otherwise the flag stays false after a run
    // ends while the user is scrolled up, and a message that arrives outside
    // a run (queued follow-up, steering reply) would never auto-scroll.
    completionScrollAllowedRef.current = end.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom <= 24;
  }, []);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            agentRunningRef.current = true;
            // The server itself reported this run in flight, so it counts as
            // acknowledged: if the engine dies later, the reconnect's
            // `connected` frame is allowed to declare the turn lost.
            runConfirmedRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            // Register the host-tool + URI bridges so the agent can call
            // open_url/notify/open_file and resolve pi-web://clipboard.
            void registerHostTools(session.id);
            void registerHostUriSchemes(session.id);
            // Rehydrate the live roster (missed lifecycle/progress frames).
            // Tracked + session-guarded: a session switch during the delay must
            // not issue a stale get_subagents against the old session.
            if (rosterRefreshTimerRef.current) {
              clearTimeout(rosterRefreshTimerRef.current);
              rosterRefreshTimerRef.current = null;
            }
            const rosterTimerSid = session.id;
            rosterRefreshTimerRef.current = setTimeout(() => {
              rosterRefreshTimerRef.current = null;
              if (sessionIdRef.current !== rosterTimerSid) return;
              void refreshSubagentRoster(rosterTimerSid);
            }, 600);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          // Model + thinking level are owned by loadSession (token-guarded);
          // re-applying this same snapshot here would mint a fresh token and
          // bypass the stale-response guard.
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setLiveContextUsage(readLiveContextUsage(agentState.state.contextUsage));
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt || null);
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessageCount === 0 && Date.now() - queueMutatedAtRef.current >= 5000) {
            setQueuedMessages(EMPTY_QUEUE);
            // The queue drained while the page was closed — a stored copy
            // from a previous page load is stale.
            clearPersistedQueue(session.id);
          } else if (typeof agentState.state.queuedMessageCount === "number") {
            // omp still holds queued messages: restore the client-tracked
            // texts persisted by the previous page load.
            const persisted = readPersistedQueue(session.id);
            if (persisted) {
              setQueuedMessages((prev) => (isEmptyQueue(prev) ? persisted : prev));
            }
          }
        }
      });
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      eventCoalescerRef.current?.reset();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (rosterRefreshTimerRef.current) {
        clearTimeout(rosterRefreshTimerRef.current);
        rosterRefreshTimerRef.current = null;
      }
      if (subagentVersionFlushFrameRef.current !== null) {
        cancelAnimationFrame(subagentVersionFlushFrameRef.current);
        subagentVersionFlushFrameRef.current = null;
      }
      subagentVersionFlushRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSubagentRoster, registerHostTools, registerHostUriSchemes]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  // Re-runs only when the scroll container can appear or disappear (the empty
  // new-session view and the loading state both render without one), not on
  // every appended message: tearing down and re-adding three listeners per
  // message happens at the busiest moment and throws away the browser's
  // event-handler fast paths. The handlers themselves read through refs.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [hasMessages, loading, handleScrollPositionChange, markUserScrollIntent]);

  // Follow the conversation: scroll to the user's latest message when they
  // send one, then keep the newest content in view while the agent streams.
  // `messages` identity changes on every message boundary and `streamState`
  // on every streaming token batch, so the scroll is throttled to one frame
  // during a run to avoid layout thrash. A manual scroll-up
  // (completionScrollAllowedRef === false) disables following.
  const followScrollFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const hasContent = messages.length > 0 || streamState.isStreaming;
    if (!hasContent) return;
    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      initialScrollDoneRef.current = true;
      scrollToBottom(streamState.isStreaming || agentRunningRef.current ? "instant" : "smooth");
    } else if (!initialScrollDoneRef.current) {
      // Wait for the message list to actually be mounted: while `loading` is
      // true the scroll container does not exist, so scrolling now would
      // no-op yet mark the initial scroll as done - leaving the viewport at
      // the top (which then auto-loads the full history) after load ends.
      // The `loading` dep re-runs this effect once the list is rendered.
      if (loading) return;
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
    } else if (completionScrollAllowedRef.current) {
      if (followScrollFrameRef.current === null) {
        followScrollFrameRef.current = requestAnimationFrame(() => {
          followScrollFrameRef.current = null;
          if (!completionScrollAllowedRef.current) return;
          scrollToBottom(completionRepinFromRef.current !== null || agentRunningRef.current || streamState.isStreaming ? "instant" : "smooth");
        });
      }
    }
  }, [messages, streamState, agentRunning, agentPhase, extensionWidgets, isCompacting, retryInfo, activeSubagentCount, todoPhases, permissionRequests, scrollToBottom, loading]);

  // The follow effect above only runs on React state changes, but the scroll
  // geometry also moves without one, in two directions:
  //  - the CONTAINER shrinks — composer panels mounting/expanding, the input
  //    growing a line, the window resizing — pushing the live tail (status
  //    line, pending tool headers) below the fold: the owner sees it "hidden
  //    behind the composer";
  //  - the CONTENT grows after commit — deferred tool-result images arriving,
  //    fonts swapping, collapse animations settling — leaving a followed
  //    viewport stranded above the true bottom (the stream-end "bounce"
  //    residue).
  // Re-pin on either while following; "instant" because an eased chase during
  // a drag-resize lags the pointer. A user who scrolled up keeps their
  // position (completionScrollAllowedRef is false).
  const transcriptMounted = !loading && (messages.length > 0 || streamState.isStreaming);
  useEffect(() => {
    if (!transcriptMounted || typeof ResizeObserver === "undefined") return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!completionScrollAllowedRef.current) return;
      scrollToBottom("instant");
    });
    observer.observe(container);
    // The content wrapper is the scroller's only child; its border-box height
    // IS the scrollHeight, so observing it catches late content growth.
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, [transcriptMounted, scrollToBottom]);

  // Terminal re-pin. When a run ends, the transcript is reloaded from disk
  // and `messages` is replaced: the streamed tail unmounts and every turn
  // re-enters a `.chat-turn` wrapper whose content-visibility placeholder
  // only realizes its true height as it paints. A smooth scroll issued
  // against the pre-reload geometry animates toward a stale offset and lands
  // mid-conversation. Two cases, both handled before this commit paints and
  // once more a frame later after realized heights settle:
  //  - the user was FOLLOWING: pin the viewport back to the bottom;
  //  - the user was READING (scrolled up): restore the exact scrollTop the
  //    arming site captured. Reading means they want to stay exactly there —
  //    a completion must never move them. The per-turn intrinsic-size
  //    estimates make the above-viewport geometry reproducible across the
  //    reload, so the restored offset shows the same content.
  // A fresh user wheel/keyboard scroll always wins over the re-assert.
  useLayoutEffect(() => {
    const from = completionRepinFromRef.current;
    if (from === null || from === messages) return;
    completionRepinFromRef.current = null;
    const anchor = completionScrollAnchorRef.current;
    completionScrollAnchorRef.current = null;
    if (completionScrollAllowedRef.current) {
      scrollToBottom("instant");
      requestAnimationFrame(() => {
        if (completionScrollAllowedRef.current) scrollToBottom("instant");
      });
      return;
    }
    if (anchor === null) return;
    const restore = () => {
      if (Date.now() <= userScrollIntentUntilRef.current) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
      container.scrollTop = anchor;
    };
    restore();
    requestAnimationFrame(restore);
  }, [messages, scrollToBottom]);

  useEffect(() => () => {
    hookAliveRef.current = false;
    if (followScrollFrameRef.current !== null) cancelAnimationFrame(followScrollFrameRef.current);
  }, []);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  // What the composer must show. A session-scoped engine's models arrive on
  // get_state, not from /api/models, and its `modelNames` map is built here so
  // a name resolves the same way for every engine.
  const effectiveModelList = modelCatalogSource === "session" ? sessionModels.list : modelList;
  const effectiveModelNames = useMemo(() => (
    modelCatalogSource === "session"
      ? Object.fromEntries(sessionModels.list.map((entry) => [`${entry.provider}:${entry.id}`, entry.name]))
      : modelNames
  ), [modelCatalogSource, sessionModels.list, modelNames]);
  /** Whether THIS session can change model at all. A global registry means
   * the engine's own set_model surface (gated by chatExtras upstream); a
   * session-scoped engine decides per session, because whether an ACP agent
   * publishes a selector depends on the account it opened with. */
  const modelSelectable = modelCatalogSource === "session" ? sessionModels.selectable : null;

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames: effectiveModelNames, modelList: effectiveModelList, modelSelectable, modelsLoading, modelError, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel, fastModeEnabled, fastModeActive, autoRetryEnabled, interruptMode, autoCompactionEnabled, steeringMode, followUpMode,
    liveModelMeta,
    // Mode list and current mode, only while they belong to THIS session.
    availableModes: sessionModes.forSession === (session?.id ?? sessionIdRef.current) ? sessionModes.options : NO_MODES,
    currentModeId: sessionModes.forSession === (session?.id ?? sessionIdRef.current) ? sessionModes.current : null,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    permissionRequests, respondToPermission,
    // Smart is on for an unpinned new session, and stays on after the pin —
    // whether Smart resolved it (live pick) or the engine did (Smart spawn) —
    // for as long as the running model is still the one Smart chose in THIS
    // session (both facts are id-scoped, so a switch to another conversation
    // can never inherit them).
    isAutoModelSelection: (isNew && newSessionModel === null)
      || (smartPinnedModel !== null
        && smartPinnedModel.forSession === (session?.id ?? sessionIdRef.current)
        && displayModelProvider === smartPinnedModel.provider
        && displayModelId === smartPinnedModel.modelId),
    autoModelSwitch: autoModelSwitch && autoModelSwitch.forSession === (session?.id ?? sessionIdRef.current)
      ? { from: autoModelSwitch.from, to: autoModelSwitch.to, role: autoModelSwitch.role, reason: autoModelSwitch.reason }
      : null,
    agentPhase,
    // Event-stream health: `streamDegraded` replaces the "Waiting for model…"
    // label while the stream is not delivering; `streamAlert` is the banner for
    // a lost turn or an exhausted reconnect, with its two actions.
    streamDegraded, streamAlert, dismissStreamAlert, retryEventStream,
    subagents, subagentEvents, subagentTranscriptVersions, activeSubagentCount, currentTodoPhase, todoPhases,
    activeGoal, activePlan,
    isNew,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef,
    pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, selectSmartModel, markSmartPinnedModel, handleFastModeChange, handleAutoRetryChange, handleInterruptModeChange, handleAutoCompactionChange, handleSteeringModeChange, handleFollowUpModeChange, handleCycleModel, handleCycleThinkingLevel, handleAbortRetry, handleInterruptAndReply,
    handleCompact, handleHandoff, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    removeQueuedMessage, promoteQueuedToSteer,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, handleModeChange, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
