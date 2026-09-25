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
  ToolResultMessage,
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
import { AgentCommandError, sendAgentCommand } from "@/lib/agent-client";
import { engineSupports } from "@/lib/engine-capabilities";
import { translate } from "@/lib/i18n";
import { describeEngineError, errorDedupeKey, type ErrorKind } from "@/lib/error-text";
import { thinkingLevelLabel } from "@/lib/thinking-level-labels";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { createMessageUpdateCoalescer, type MessageUpdateCoalescer } from "@/lib/message-update-coalescer";
import { createReconcileGuard, type ReconcileGuard } from "@/lib/reconcile-guard";
import {
  evaluateStreamHealth,
  reconnectDelayMs,
  shouldClearLostTurn,
  shouldGiveUpReconnecting,
} from "@/lib/stream-recovery";
import { getToolNamesForPreset, type ToolPreset } from "@/lib/tool-presets";
import { getPreferredToolPreset, subscribeToPreferredToolPreset } from "@/lib/tool-preset-preference";
import {
  advanceSmartModelForAutomaticChange,
  clearSmartModelAfterManualSelection,
  clearSmartModelAfterThinkingLevelChange,
  parseSmartModelProvenance,
  resolveSmartModel,
  smartModelForSession,
  type SmartModelProvenance,
  type ThinkingLevelChangeSource,
} from "@/hooks/session-model-provenance";
import { newSessionSpawnPlan } from "@/hooks/session-preset-state";
import {
  classifyFallbackReason,
  fallbackAttributionForRole,
  fallbackAttributionForSubagentEvent,
  isFastModeUnavailableError,
  pendingModelSwitchApplied,
  queueModelSwitch,
  releaseModelSwitchAtBoundary,
  sameSessionControlScope,
  sessionControlScope,
  resolveThinkingSelector,
  type FallbackReasonKind,
  type ModelFallbackAttribution,
  type ModelFallbackJob,
  type PendingModelSwitch,
  type ScopedModel,
} from "@/hooks/session-control-scope";
import { SESSION_PROMPT_IMAGE, SESSION_PROMPT_STEERING, sessionPromptCapabilityBits } from "@/hooks/session-prompt-capabilities";
import { toast } from "@/components/ui/toast";
import { compactionStatusReducer, type CompactionStatus } from "@/lib/compaction-status";
import { expandWebSlashCommand } from "@/lib/web-slash-commands";
import { createActiveGoal, parseActiveGoal, type ActiveGoal, type ActivePlan } from "@/lib/web-mode-state";
import type { HostToolDefinition, HostUriSchemeDefinition, PlanOverlay, RpcAvailableSlashCommand, SessionStatsInfo, TodoPhase } from "@/lib/pi-types";
import { asCount, asNumber, asString, isRecord } from "@/lib/type-guards";
import { addUsageTotals, aggregateMessageUsage, emptyUsageTotals, usageTokenTotal, type UsageTotals } from "@/lib/session-usage";
import { SESSION_STORAGE_PREFIXES } from "@/lib/storage-keys";
import { captureTranscriptAnchor, restoreTranscriptAnchor, type TranscriptAnchor } from "@/lib/transcript-anchor";
import {
  parseSubagentActivityEvent,
  parseSubagentLifecycle,
  parseSubagentProgress,
  parseSubagentProgressEvent,
  parseSubagentSnapshot,
  withModelHandoff,
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

/** Read provider/runtime errors without ever rendering an object as
 * "[object Object]". Error payloads vary across OMP versions and may be
 * nested inside assistant, turn_end, or response frames. */
function readAgentError(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }
  if (!isRecord(value)) return null;
  for (const key of ["errorMessage", "error", "message", "detail"]) {
    const text = readAgentError(value[key]);
    if (text) return text;
  }
  return value.stopReason === "error" ? translate("agentSession.responseFailed") : null;
}

function readTerminalAgentError(event: AgentEvent): string | null {
  for (const value of [event.errorMessage, event.error, event.message]) {
    const text = readAgentError(value);
    if (text) return text;
  }
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const text = readAgentError(event.messages[index]);
      if (text) return text;
    }
  }
  return null;
}

function hasVisibleAssistantContent(value: unknown): boolean {
  if (!isRecord(value) || value.role !== "assistant") return false;
  if (!Array.isArray(value.content)) return typeof value.content === "string" && value.content.trim().length > 0;
  return value.content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    return block.type === "image";
  });
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
  summary?: string;
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
  // Plan-keeper overlay (subtasks + which top-level contents the keeper
  // auto-completed) for the session's in-progress task. Cody's own
  // buildWebState addition, not an omp-reported field; absent/null means no
  // keeper data exists yet for this session.
  planOverlay?: PlanOverlay | null;
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
  // permission posture (Claude: Manual / Accept edits / Plan / Auto).
  // Never sent by an rpc-dialect engine,
  // and absent means "no picker" — there is no global fallback to consult.
  availableModes?: { id?: unknown; name?: unknown; description?: unknown }[];
  currentModeId?: string | null;
  // ACP's _session/steering extension reports false when a feature is absent.
  imageSupported?: boolean;
  steeringSupported?: boolean;
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

function readPlanOverlaySubtask(value: unknown): { content: string; status: "pending" | "completed" } | null {
  if (!isRecord(value)) return null;
  const content = asString(value.content);
  const status = value.status;
  if (!content || (status !== "pending" && status !== "completed")) return null;
  return { content, status };
}

/** Defensively copy a plan-keeper overlay off get_state or a
 * `plan_overlay_update` frame, dropping anything malformed rather than
 * rendering a subtask list or auto-mark that cannot be trusted. A record
 * that fails to parse at all returns null (caller keeps the previous
 * overlay); a well-formed-but-empty one still returns a real value, so a
 * keeper clearing its last subtasks actually clears the UI. */
function readPlanOverlay(value: unknown): PlanOverlay | null {
  if (!isRecord(value)) return null;
  const subtasks: PlanOverlay["subtasks"] = {};
  if (isRecord(value.subtasks)) {
    for (const [parent, list] of Object.entries(value.subtasks)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((item) => readPlanOverlaySubtask(item) ?? []);
      if (items.length > 0) subtasks[parent] = items;
    }
  }
  const autoCompleted = Array.isArray(value.autoCompleted)
    ? value.autoCompleted.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { subtasks, autoCompleted, updatedAt: asNumber(value.updatedAt) ?? 0 };
}

export type SessionPromptCapabilities = { imageSupported: boolean };



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
const SMART_MODEL_STORAGE_PREFIX = SESSION_STORAGE_PREFIXES.smartModel;
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

function readPersistedSmartModel(sessionId: string): SmartModelProvenance | null {
  try {
    const raw = sessionStorage.getItem(SMART_MODEL_STORAGE_PREFIX + sessionId);
    return raw ? parseSmartModelProvenance(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function persistSmartModel(provenance: SmartModelProvenance): void {
  try {
    sessionStorage.setItem(SMART_MODEL_STORAGE_PREFIX + provenance.forSession, JSON.stringify(provenance));
  } catch {
    // Best-effort only (quota exceeded, private mode, SSR).
  }
}

function clearPersistedSmartModel(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    sessionStorage.removeItem(SMART_MODEL_STORAGE_PREFIX + sessionId);
  } catch {
    // ignore storage errors
  }
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
  /** Set when this notice was produced by {@link engineErrorNotice}/
   * {@link noticeFromCaughtError}: a normalized key so a repeat of the same
   * underlying error bumps this notice's `count` instead of piling up a new
   * one, and its errorKind so a refusal can render its own icon/tone. */
  dedupeKey?: string;
  errorKind?: ErrorKind;
  /** How many times this same (deduped) notice has fired since it last
   * appeared. Starts undefined/1; NoticeShelf shows "×2" once it climbs. */
  count?: number;
};

export type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

export type NoticeAction =
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
export type AutoModelSwitchJob = ModelFallbackJob;

export interface AutoModelSwitchInfo {
  from: string;
  to: string;
  role?: string;
  reason?: string;
  /** Classified `reason`: a refusal needs a manual re-pick, a usage limit
   * resolves itself at the reset. Null when the text is unrecognized. */
  reasonKind?: FallbackReasonKind | null;
  job: AutoModelSwitchJob;
}

/** Public composer state for a user model pick waiting for a safe boundary. */
export interface ModelSwitchPending {
  provider: string;
  modelId: string;
  name: string;
  phase: "waiting" | "applying";
}

type PendingModelSwitchRequest = PendingModelSwitch & {
  selection: "manual" | "smart";
  pick: { provider: string; modelId: string; at: number };
};

function fallbackJobKey(job: ModelFallbackJob): string {
  return job.kind === "subagent" ? "subagent:" + job.subagentId : "main";
}

function fallbackJobLabel(attribution: ModelFallbackAttribution): string {
  const { job, role } = attribution;
  return translate(job.roleLabelKey, { name: job.agent ?? job.subagentId ?? "", role });
}

function fallbackAppliedMessage(attribution: ModelFallbackAttribution, from: string, to: string, reason: string | undefined): string {
  const job = fallbackJobLabel(attribution);
  // A refusal and a quota limit call for different actions, so they are said
  // differently; anything unrecognized still shows the provider's own words.
  switch (classifyFallbackReason(reason)) {
    case "refusal":
      return translate("agentSession.fallbackAppliedRefusal", { job, from, to });
    case "usage":
      return translate("agentSession.fallbackAppliedUsage", { job, from, to });
    default:
      return reason
        ? translate("agentSession.fallbackApplied", { job, from, to, reason })
        : translate("agentSession.fallbackAppliedUnknownReason", { job, from, to });
  }
}

function fallbackSucceededMessage(attribution: ModelFallbackAttribution, model: string): string {
  return translate("agentSession.fallbackSucceeded", { job: fallbackJobLabel(attribution), model });
}

/** Notices get a warning (amber) tone when the situation isn't really an
 * error to fix so much as something to understand: the model made a choice
 * (refusal), or an account condition that resolves on its own (usage/credits)
 * or without user action once the provider recovers (overloaded). Everything
 * else — auth, outdated engines, transport failures, unrecognized text — is a
 * real error tone. */
function noticeToneForErrorKind(kind: ErrorKind): NoticeType {
  switch (kind) {
    case "refusal":
    case "usage":
    case "credits":
    case "overloaded":
      return "warning";
    default:
      return "error";
  }
}

/** The single place raw engine/provider error text turns into what a person
 * reads: `hooks/useAgentSession.ts`'s message_end/auto_retry/notice/prompt_error
 * handling and its generic catch blocks all funnel through this (directly or
 * via {@link noticeFromCaughtError}), so an ACP engine's raw `notice` text
 * (`lib/harness/acp-session.ts`, e.g. "Claude Code: Error: 429 {...}") gets the
 * exact same cleanup and refusal/usage/etc. distinction as omp's own events —
 * one choke point, not one per engine. Returns null for a user-initiated
 * abort: that is not a failure to report, just the turn stopping. */
function engineErrorNotice(
  rawMessage: string,
  fallbackProvider?: string,
): { type: NoticeType; message: string; dedupeKey: string; kind: ErrorKind } | null {
  const described = describeEngineError(rawMessage);
  if (described.kind === "aborted") return null;
  const provider = described.provider ?? fallbackProvider ?? translate("agentSession.genericProvider");
  let message: string;
  switch (described.kind) {
    case "refusal":
      message = translate("agentSession.errorRefusal", { provider, detail: described.detail });
      break;
    case "outdated":
      message = translate("agentSession.errorOutdated", { provider });
      break;
    case "credits":
      message = translate("agentSession.errorCredits", { provider, detail: described.detail });
      break;
    case "auth":
      // Same hint the credentials branch below used to give inline: point at
      // the one panel that actually fixes it.
      message = `${described.detail.replace(/[.\s]+$/, "")}. ${translate("agentSession.providerKeysHint")}`;
      break;
    case "overloaded":
      message = translate("agentSession.errorOverloaded", { provider, detail: described.detail });
      break;
    case "usage":
      message = translate("agentSession.errorUsage", { detail: described.detail });
      break;
    case "transport":
      message = translate("agentSession.errorTransport", { detail: described.detail });
      break;
    default:
      message = described.detail;
  }
  return { type: noticeToneForErrorKind(described.kind), message, dedupeKey: errorDedupeKey(rawMessage), kind: described.kind };
}

/** Same as {@link engineErrorNotice}, starting from a caught JS `unknown`
 * rather than a raw string — the shape every `catch (e)` block already has. */
function noticeFromCaughtError(
  error: unknown,
  fallbackProvider?: string,
): { type: NoticeType; message: string; dedupeKey: string; kind: ErrorKind } | null {
  const raw = error instanceof Error ? error.message : String(error);
  return engineErrorNotice(raw, fallbackProvider);
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

/** Keep only tool-result blocks the transcript renderer understands. Engine
 * event payloads are untrusted, and a malformed live frame must not poison the
 * committed-message shape or make a render throw. */
function toolResultContent(value: unknown): ToolResultMessage["content"] {
  if (!Array.isArray(value)) return [];
  return value.filter((block): block is Record<string, unknown> => (
    isRecord(block)
    && (block.type === "image" || (block.type === "text" && typeof block.text === "string"))
  )) as unknown as ToolResultMessage["content"];
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
   * first connect and on any fallback event, so hardcoding "omp" told users
   * of other engines that omp was starting up. */
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
  /** Which launch a fresh spawn asks `/api/agent/new` for. "sidebar" is the
   * tool-less side-panel chat under cody-sidebar-chats/; absent = main. */
  sessionKind?: "sidebar";
  /** Sidebar only: the main chat session its `read_session` tool defaults to.
   * Sent at spawn, so the child knows what "this session" means. */
  contextSessionId?: string | null;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Opens a file in the web UI's file viewer (used by the open_file host tool). */
  onOpenFile?: (filePath: string, name: string, sessionId?: string) => void;
  /** Shows a loopback URL in the workspace Preview panel (open_url calls that
   *  target localhost; the open_preview host tool settles server-side and
   *  reaches the panel through the display-request SSE instead). */
  onOpenPreview?: (url: string, sessionId?: string) => void;
  /** Loopback URLs the assistant mentioned in a live reply — candidates for
   *  auto-opening the Preview panel once something answers there. */
  onPreviewUrlsSeen?: (urls: string[], sessionId?: string) => void;
  /** What a brand-new (unspawned) chat should send `/api/agent/new` as
   *  `presetId` — the composer's preset picker's current pick, computed
   *  by `hooks/useSessionPreset.ts`. `undefined` omits the field entirely
   *  (presets unsupported, or not yet loaded); `null` is an explicit Base
   *  settings pick. Read via `opts.newSessionPresetId` inside
   *  ensureNewSession rather than destructured above: nothing else needs it. */
  newSessionPresetId?: string | null;
}

export type ThinkingLevelOption = string;

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
// After a touch ends, scroll events that keep arriving within this gap of one
// another are momentum; a longer silence means the flick is over.
const TOUCH_MOMENTUM_IDLE_MS = 150;
const TOUCH_MOMENTUM_MAX_MS = 3000;
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
/** How long routing events are collected before they are delivered as one
 * message. Long enough to catch a retry and the fallback it caused (and
 * several subagents failing together), short enough that the notice still
 * arrives while the user is looking at the turn that caused it. */
const ROUTING_BURST_MS = 1_500;
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
// Keep a burst of errors from crowding every other useful notice off the
// shelf; at most two error-toned notices are visible at the same time.
const MAX_VISIBLE_ERROR_NOTICES = 2;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_ERROR_VISIBLE_MS = 30000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

function isQuotaLikeError(text: string): boolean {
  return /429|quota|RESOURCE_EXHAUSTED|Cloud Code Assist/i.test(text);
}

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

function markOldestNoticeExiting(notices: NoticeItem[], matches: (notice: NoticeItem) => boolean = () => true): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting && matches(notice));
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function visibleErrorCount(notices: NoticeItem[]): number {
  return notices.filter((notice) => notice.type === "error" && !notice.exiting).length;
}

/** True once a notice with the same `dedupeKey` already occupies `list`: the
 * caller bumps that one's `count` instead of adding a second copy. */
function bumpDuplicate(list: NoticeItem[], incoming: NoticeItem): NoticeItem[] | null {
  if (!incoming.dedupeKey) return null;
  const index = list.findIndex((notice) => notice.dedupeKey === incoming.dedupeKey);
  if (index === -1) return null;
  const next = [...list];
  // Un-exiting a bumped notice restarts its on-screen clock: the effect that
  // schedules eviction keys off `noticeState.visible`'s identity, which this
  // new array reference already invalidates.
  next[index] = { ...next[index], count: (next[index].count ?? 1) + 1, exiting: false };
  return next;
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  const stillPending: NoticeItem[] = [];
  for (const item of pending) {
    const blockedByErrorCap = item.type === "error" && visibleErrorCount(nextVisible) >= MAX_VISIBLE_ERROR_NOTICES;
    if (nextVisible.length >= MAX_NOTICES || blockedByErrorCap) {
      stillPending.push(item);
      continue;
    }
    nextVisible = [...nextVisible, item];
  }
  if (stillPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    // An error notice waiting on the error cap needs an ERROR slot freed, not
    // just any slot — evicting the oldest info/success notice would not lift
    // the cap that is actually blocking it.
    const headIsError = stillPending[0]?.type === "error";
    nextVisible = markOldestNoticeExiting(nextVisible, headIsError ? (notice) => notice.type === "error" : undefined);
  }
  return { visible: nextVisible, pending: stillPending };
}

export function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      const visibleBump = bumpDuplicate(state.visible, action.notice);
      if (visibleBump) return { ...state, visible: visibleBump };
      const pendingBump = bumpDuplicate(state.pending, action.notice);
      if (pendingBump) return { ...state, pending: pendingBump };

      const errorCapHit = action.notice.type === "error" && visibleErrorCount(state.visible) >= MAX_VISIBLE_ERROR_NOTICES;
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES || errorCapHit) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible, errorCapHit ? (notice) => notice.type === "error" : undefined),
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
  if (!result || typeof result !== "object" || !("tokensBefore" in result) || typeof result.tokensBefore !== "number") return null;
  const estimatedTokensAfter = "estimatedTokensAfter" in result && typeof result.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : 0;
  return { reason, tokensBefore: result.tokensBefore, estimatedTokensAfter };
}

function readCompactOutcome(result: unknown): "completed" | "noop" {
  if (!result || typeof result !== "object" || !("summary" in result) || typeof result.summary !== "string") return "completed";
  return /nothing\s+to\s+compact/i.test(result.summary) ? "noop" : "completed";
}
function compactionErrorOutcome(error: unknown): "failed" | "cancelled" | "unsupported" | "noop" {
  if (error instanceof AgentCommandError) {
    if (error.code === "unsupported") return "unsupported";
    if (error.code === "cancelled") return "cancelled";
    if (error.code === "nothing_to_compact") return "noop";
  }
  // OMP 0.18.1 reports its documented no-op only as this RpcCommandError text.
  if (error instanceof Error && /^nothing\s+to\s+compact\b/i.test(error.message)) return "noop";
  return "failed";
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
  modelError?: string;
  modelErrorCode?: "no_credentials";
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
    session, newSessionCwd, advisorEnabled, thinkingDefaultExpanded, onAgentEnd, onSessionNamed, onSessionCreated, onSessionForked, sessionKind, contextSessionId,
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
  // Set when the engine's "no models" is really "nothing is signed in": the
  // composer then shows Cody's own pointer at Settings › Providers instead of
  // the engine CLI's `/login` advice, which a web user cannot act on.
  const [modelErrorCode, setModelErrorCode] = useState<"no_credentials" | null>(null);
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
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  // `models` is the exact set a Local-only session may select
  // ("provider/modelId"); anything else must leave the mode first.
  const [localOnly, setLocalOnly] = useState<{ active: boolean; pending: boolean; supported: boolean; error?: string; models?: string[] }>({ active: false, pending: false, supported: false });
  const localOnlyRef = useRef(localOnly);
  localOnlyRef.current = localOnly;
  const [toolPreset, setToolPreset] = useState<ToolPreset>(() => getPreferredToolPreset());
  useEffect(() => subscribeToPreferredToolPreset(setToolPreset), []);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [thinkingLevelPending, setThinkingLevelPending] = useState(false);
  const [thinkingLevelTarget, setThinkingLevelTarget] = useState<string | null>(null);
  // The configured selector must be remembered between engine reports; the
  // rule and its reasons live in resolveThinkingSelector.
  const thinkingConfiguredAutoRef = useRef(false);
  const adoptThinkingLevel = useCallback((effective: string | undefined, configured?: string) => {
    const next = resolveThinkingSelector(effective, configured, thinkingConfiguredAutoRef.current);
    thinkingConfiguredAutoRef.current = next.rememberedAuto;
    setThinkingLevel(next.display);
  }, []);
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [fastModeActive, setFastModeActive] = useState<boolean | undefined>(undefined);
  const [fastModePending, setFastModePending] = useState(false);
  const [fastModeUnavailable, setFastModeUnavailable] = useState(false);
  const [promptCapabilities, setPromptCapabilities] = useState<SessionPromptCapabilities>({ imageSupported: false });
  const [steeringSupported, setSteeringSupported] = useState(false);
  // Runtime session modes returned by get_state and changed via RPC
  // (set_interrupt_mode / set_auto_compaction).
  const [interruptMode, setInterruptMode] = useState<"immediate" | "wait">("immediate");
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState(true);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(false);
  // Queue delivery modes (set_steering_mode / set_follow_up_mode).
  const [steeringMode, setSteeringMode] = useState<"all" | "one-at-a-time">("all");
  const [followUpMode, setFollowUpMode] = useState<"all" | "one-at-a-time">("all");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  // Retry errors are scoped to the requesting job so a child fallback never
  // inherits a provider error from the main conversation or another child.
  const retryErrorByJobRef = useRef(new Map<string, string>());
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
  const [modelSwitchPending, setModelSwitchPending] = useState<PendingModelSwitchRequest | null>(null);
  // The model Smart resolved — a live-session Smart pick, or the engine's own
  // resolution of a Smart new session. Smart-ness must survive the pin: while
  // the running model still IS this model, the composer keeps saying
  // "Smart · <name>" instead of silently reading like a manual pick. Scoped
  // to the session it was made for (loads and reconciles reuse loadSession,
  // so a reset there would wipe the pin mid-conversation); an engine switch
  // simply stops matching, which hands the label to the marker below.
  const [smartPinnedModel, setSmartPinnedModel] = useState<SmartModelProvenance | null>(null);
  // The engine's last unprompted model switch (retry fallback, usage-aware
  // routing, an engine-side /model). The 10s toast announces it once; this
  // keeps a composer marker naming the switch until the model moves again —
  // a downgrade that outlives its toast must stay explicable.
  const [autoModelSwitch, setAutoModelSwitch] = useState<(AutoModelSwitchInfo & { forSession: string }) | null>(null);
  // Session id of a spawning Smart new session: its first authoritative model
  // is Smart's own resolution and becomes smartPinnedModel. Id-keyed so a
  // sync for a different session (switched away mid-spawn) can never claim it.
  const smartPinnedModelRef = useRef<SmartModelProvenance | null>(null);
    const pendingSmartSpawnRef = useRef<string | null>(null);
  // Recent explicit picks suppress bare model_changed markers for every
  // command still in flight, not just the most recently chosen model.
  const recentUserModelPicksRef = useRef<Array<{ provider: string; modelId: string; at: number }>>([]);
  // Previous authoritative model, for naming the "from" side of a bare
  // model_changed that arrives without any fallback attribution.
  const lastAuthoritativeModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const initialCompactionStatus: CompactionStatus = { status: "idle", sessionId: session?.id ?? null };
  const [compactionStatus, dispatchCompactionStatus] = useReducer(compactionStatusReducer, initialCompactionStatus);
  useEffect(() => {
    if (compactionStatus.status === "idle" || compactionStatus.status === "pending" || compactionStatus.status === "running") return;
    const timer = window.setTimeout(() => dispatchCompactionStatus({ type: "dismiss", sessionId: compactionStatus.sessionId }), compactionStatus.status === "noop" ? 5_000 : 8_000);
    return () => window.clearTimeout(timer);
  }, [compactionStatus]);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  // In-flight tool results live outside the committed transcript. omp sends
  // the complete accumulated snapshot in each update, so the coalesced map
  // can replace a tool's prior output until its committed toolResult arrives.
  const [liveToolResults, setLiveToolResults] = useState<Map<string, ToolResultMessage>>(() => new Map());
  const setLiveToolResult = useCallback((toolCallId: string, result: ToolResultMessage | null) => {
    setLiveToolResults((prev) => {
      if (result === null) {
        if (!prev.has(toolCallId)) return prev;
        const next = new Map(prev);
        next.delete(toolCallId);
        return next;
      }
      const next = new Map(prev);
      next.set(toolCallId, result);
      return next;
    });
  }, []);
  const clearLiveToolResults = useCallback(() => {
    setLiveToolResults((prev) => (prev.size === 0 ? prev : new Map()));
  }, []);
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
  const subagentsRef = useRef<SubagentInfo[]>(subagents);
  subagentsRef.current = subagents;
  const [subagentEvents, setSubagentEvents] = useState<Record<string, SubagentActivityEvent[]>>({});
  const [subagentTranscriptVersions, setSubagentTranscriptVersions] = useState<Record<string, number>>({});
  const [todoPhases, setTodoPhases] = useState<TodoPhase[]>([]);
  const [planOverlay, setPlanOverlay] = useState<PlanOverlay | null>(null);
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
  // Commands can outlive a session/model switch. Their replies must never
  // repaint controls that now belong to another selection.
  const fastModeScopeRef = useRef(sessionControlScope(session?.id ?? null, null));
  const modelSwitchScopeRef = useRef(sessionControlScope(session?.id ?? null, null));
  const thinkingLevelScopeRef = useRef(sessionControlScope(session?.id ?? null, null));
  const fastModePendingRequestRef = useRef(0);
  const fastModePendingLatchRef = useRef(false);
  const thinkingLevelPendingRequestRef = useRef(0);
  const fastModeActiveRef = useRef<boolean | undefined>(undefined);
  const fastModeInactiveNoticeScopeRef = useRef<string | null>(null);
  const addNoticeRef = useRef<(notice: { id?: string; message: string; type?: NoticeType }) => void>(() => {});
  const modelSwitchDispatchingSessionRef = useRef<string | null>(null);
  const dispatchPendingModelSwitchRef = useRef<(() => void) | null>(null);
  const modelSwitchPendingRef = useRef<PendingModelSwitchRequest | null>(null);
  const modelSwitchAwaitingIdleRef = useRef<string | null>(null);
  const writeModelSwitchPending = useCallback((next: PendingModelSwitchRequest | null) => {
    modelSwitchPendingRef.current = next;
    setModelSwitchPending(next);
  }, []);
  const settlePendingModelSwitch = useCallback((sessionId: string | null, model: ScopedModel): boolean => {
    const pending = modelSwitchPendingRef.current;
    if (!pending || !pendingModelSwitchApplied(pending, sessionId, model)) return false;
    writeModelSwitchPending(null);
    addNoticeRef.current({
      type: "info",
      message: translate("agentSession.modelSwitchApplied", { name: pending.name }),
    });
    return true;
  }, [writeModelSwitchPending]);
    const setSmartModelProvenance = useCallback((provenance: SmartModelProvenance | null) => {
      smartPinnedModelRef.current = provenance;
      setSmartPinnedModel(provenance);
      if (provenance) persistSmartModel(provenance);
    }, []);
    const clearSmartModelProvenance = useCallback((sessionId: string, accepted: boolean) => {
      const next = clearSmartModelAfterManualSelection(smartPinnedModelRef.current, sessionId, accepted);
      if (next === smartPinnedModelRef.current) return;
      smartPinnedModelRef.current = next;
      setSmartPinnedModel(next);
      if (next) persistSmartModel(next);
      else clearPersistedSmartModel(sessionId);
    }, []);
    // A manual reasoning-level pick leaves Smart exactly like a manual
    // model pick; a preset's own default level (applied right after a
    // preset switch) must not — see handleThinkingLevelChange's `source`.
    const clearSmartModelForThinkingLevel = useCallback((sessionId: string, source: ThinkingLevelChangeSource, accepted: boolean) => {
      const next = clearSmartModelAfterThinkingLevelChange(smartPinnedModelRef.current, sessionId, source, accepted);
      if (next === smartPinnedModelRef.current) return;
      smartPinnedModelRef.current = next;
      setSmartPinnedModel(next);
      if (next) persistSmartModel(next);
      else clearPersistedSmartModel(sessionId);
    }, []);
  // Guards stale branch/leaf context responses: two rapid navigate clicks must
  // not let the older response overwrite the newer branch's messages.
  const contextRequestSeqRef = useRef(0);
  // Mirror of the isCompacting state that survives render batching, so two
  // clicks in the same tick cannot double-send a compact command.
  const isCompactingRef = useRef(false);
  // Monotonic fence for reconnect snapshots: a GET started before a newer
  // compaction request must not overwrite the newer request when it resolves.
  const compactionGenerationRef = useRef(0);
  // Set while an interrupt-and-reply (abort_and_prompt) is in flight: the
  // aborted turn's terminal agent_end must not tear down the new run that is
  // starting. Cleared on the new run's agent_start (or the intercept itself).
  const interruptReplyPendingRef = useRef(false);
  // Timestamp of the last client-side queue mutation (steer/follow-up sent).
  // get_state snapshots may lag behind the RPC round-trip, so a snapshot
  // reporting queuedMessageCount === 0 must not wipe a queue we just wrote.
  const queueMutatedAtRef = useRef(0);
  const agentRunningRef = useRef(false);
  // True from a provider call's start until a known safe step boundary. A
  // model command must never interrupt this stream on engines where close()
  // terminates the live response.
  const assistantProviderCallRef = useRef(false);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const pendingScrollToUserRef = useRef(false);
  // "Following": the viewport is pinned to the live tail. False once the user
  // scrolls up; every programmatic scroll is gated on it, and while it is
  // false the reader pin below holds the viewport on the same content instead.
  const completionScrollAllowedRef = useRef(true);
  // Non-null while a terminal run-end reload is replacing `messages` AND the
  // user was following at the bottom: holds the pre-reload array identity.
  // While set, follow scrolls stay instant; the layout effect below consumes
  // it before that commit paints.
  const completionRepinFromRef = useRef<AgentMessage[] | null>(null);
  // The reader pin. Captured on every user scroll while not following and
  // re-asserted after every commit and every content resize: the content
  // under the container's top edge stays exactly where the reader put it,
  // whatever the transcript does underneath — a token batch, a thinking box
  // opening or closing, the streaming bubble becoming a committed row, the
  // run's end folding the turn, the reload re-keying it. Named by transcript
  // identity (lib/transcript-anchor), not by DOM node, so a remount cannot
  // lose it the way browser scroll anchoring does.
  const readerAnchorRef = useRef<TranscriptAnchor | null>(null);
  // The scrollTop our own last instant write landed on. A scroll event at
  // that value is our echo; any other value with no programmatic window open
  // is the user (or the browser's own anchoring) and recomputes `following`.
  const expectedScrollTopRef = useRef<number | null>(null);
  // Touch scrolling in flight (finger down, or momentum still delivering
  // scroll events). Pin corrections wait it out: a scrollTop write during
  // momentum on iOS can end the gesture.
  const touchActiveRef = useRef(false);
  const touchEndedAtRef = useRef(0);
  const lastScrollEventAtRef = useRef(0);
  // True once a run ended while the user was reading: the finished turn stays
  // in its live, unfolded layout until they return to the bottom, so the
  // content they are reading cannot fold away into a collapsed group.
  const [readerHoldsTail, setReaderHoldsTail] = useState(false);
  const readerHoldsTailRef = useRef(false);
  /** A run just ended under a reader: keep the finished turn in its live layout until they return to the bottom. */
  const holdTailForReader = useCallback(() => {
    if (completionScrollAllowedRef.current || readerHoldsTailRef.current) return;
    readerHoldsTailRef.current = true;
    setReaderHoldsTail(true);
  }, []);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionLocalOnlyRef = useRef(false);
  // A manual reasoning-level pick made before this new chat has spawned —
  // leaves Smart exactly like an explicit model pick does (`newSessionModel
  // !== null`), so `ensureNewSession` and `isAutoModelSelection` both read
  // it through `newSessionSpawnPlan`. Reset when the user explicitly picks
  // Smart again (`selectSmartModel`).
  const manualPreSpawnLevelRef = useRef(false);
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
  // Reconciliation can be triggered by several independent browser events.
  // Keep one authoritative poll in flight and retry once when another trigger
  // arrived while it was running; a stalled request expires after 30 seconds.
  const reconcileGuardRef = useRef<ReconcileGuard | null>(null);
  if (reconcileGuardRef.current === null) reconcileGuardRef.current = createReconcileGuard({ timeoutMs: 30_000 });
  // Last quota-like error seen during the current run, and whether the run
  // produced any assistant content. Used to surface a persistent error when
  // the agent stops without a visible failure.
  const lastQuotaErrorRef = useRef<string | null>(null);
  const lastRunErrorRef = useRef<string | null>(null);
  const slashCommandRunRef = useRef(false);
  const runHadContentRef = useRef(false);
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
    const smart = sid ? readPersistedSmartModel(sid) : null;
    smartPinnedModelRef.current = smart;
    setSmartPinnedModel(smart);
    setPromptCapabilities((current) => current.imageSupported ? { imageSupported: false } : current);
    setSteeringSupported((current) => current ? false : current);
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
    setPlanOverlay(null);
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
        byId.set(entry.id, withModelHandoff(existing, entry));
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
  /** Invalidate controls whose reply belongs to a different session or model. */
  const updateSessionControlScope = useCallback((sid: string | null, model: ScopedModel, preserveFastModePending = false) => {
    const next = sessionControlScope(sid, model);
    const previous = modelSwitchScopeRef.current;
    modelSwitchScopeRef.current = next;
    if (previous.sessionId !== next.sessionId) {
      recentUserModelPicksRef.current = [];
      retryErrorByJobRef.current.clear();
      // Another session's configured selector is unknown until its own
      // thinking_level_changed says so: fall back to the effective level.
      thinkingConfiguredAutoRef.current = false;
    }
    const pendingModelSwitch = modelSwitchPendingRef.current;
    if (pendingModelSwitch && pendingModelSwitch.scope.sessionId !== next.sessionId) {
      writeModelSwitchPending(null);
    }
    if (!sameSessionControlScope(fastModeScopeRef.current, next)) {
      fastModeScopeRef.current = next;
      fastModeActiveRef.current = undefined;
      fastModeInactiveNoticeScopeRef.current = null;
      setFastModeActive(undefined);
      setFastModeUnavailable(false);
      if (!preserveFastModePending) {
        fastModePendingRequestRef.current += 1;
        fastModePendingLatchRef.current = false;
        setFastModePending(false);
      }
    }
    if (!sameSessionControlScope(thinkingLevelScopeRef.current, next)) {
      thinkingLevelScopeRef.current = next;
      thinkingLevelPendingRequestRef.current += 1;
      setThinkingLevelPending(false);
      setThinkingLevelTarget(null);
    }
    return next;
  }, [writeModelSwitchPending]);


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
      const sessionId = sessionIdRef.current;
      updateSessionControlScope(sessionId, model ? { provider: model.provider, modelId: model.modelId } : null);
      setLiveModelMeta(model);
      if (!model) return true;
      lastAuthoritativeModelRef.current = { provider: model.provider, modelId: model.modelId };
      const resolvedModel = { provider: model.provider, modelId: model.modelId };
      settlePendingModelSwitch(sessionId, resolvedModel);
      if (!assistantProviderCallRef.current) dispatchPendingModelSwitchRef.current?.();
      // A Smart new session's first resolved model is explicit Smart provenance,
      // even when ensure_session sent the configured default as a concrete model.
      if (sessionId && pendingSmartSpawnRef.current === sessionId) {
        pendingSmartSpawnRef.current = null;
        setSmartModelProvenance(resolveSmartModel({ forSession: sessionId }, sessionId, resolvedModel));
      } else if (sessionId) {
        const smart = smartModelForSession(smartPinnedModelRef.current, sessionId);
        if (smart) setSmartModelProvenance(advanceSmartModelForAutomaticChange(smart, sessionId, resolvedModel));
      }
      setCurrentModelOverride((prev) =>
        prev && (prev.provider !== model.provider || prev.modelId !== model.modelId) ? null : prev
      );
      return true;
    }, [setSmartModelProvenance, settlePendingModelSwitch, updateSessionControlScope]);

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
  const adoptSessionPromptCapabilities = useCallback((state: AgentStateResponse | null | undefined) => {
    const capabilities = sessionPromptCapabilityBits(state);
    const imageSupported = (capabilities & SESSION_PROMPT_IMAGE) !== 0;
    const steering = (capabilities & SESSION_PROMPT_STEERING) !== 0;
    setPromptCapabilities((current) => current.imageSupported === imageSupported ? current : { imageSupported });
    setSteeringSupported((current) => current === steering ? current : steering);
  }, []);
  /** Adopt Fast only after the owning model snapshot won its race. */
  const adoptFastModeState = useCallback((state: AgentStateResponse | null | undefined, sid: string): boolean => {
    if (sessionIdRef.current !== sid || !sameSessionControlScope(fastModeScopeRef.current, sessionControlScope(sid, state?.model ? {
      provider: state.model.provider,
      modelId: state.model.id,
    } : null))) return false;

    const enabled = state?.fastModeEnabled;
    const active = state?.fastModeActive;
    const wasActive = fastModeActiveRef.current;
    if (typeof enabled === "boolean") setFastModeEnabled(enabled);
    fastModeActiveRef.current = active;
    setFastModeActive(active);

    const scopeKey = [fastModeScopeRef.current.sessionId, fastModeScopeRef.current.provider, fastModeScopeRef.current.modelId].join("\u0000");
    if (active === true) {
      setFastModeUnavailable(false);
      fastModeInactiveNoticeScopeRef.current = null;
    } else if (enabled === true && wasActive === true && fastModeInactiveNoticeScopeRef.current !== scopeKey) {
      fastModeInactiveNoticeScopeRef.current = scopeKey;
      addNoticeRef.current({ type: "info", message: translate("agentSession.fastModeInactive") });
    }
    return true;
  }, []);


  const refreshLiveModelState = useCallback(async (sid: string): Promise<boolean> => {
    const token = beginAuthoritativeModelSync();
    const modeSeq = modeSyncSeqRef.current;
    try {
      const res = await fetch("/api/sessions/" + encodeURIComponent(sid) + "/state");
      if (!res.ok) return false;
      const agentState = await res.json() as { running: boolean; state?: AgentStateResponse };
      if (sessionIdRef.current !== sid) return false;
      adoptSessionModels(agentState.state);
      adoptSessionModes(agentState.state, sid, modeSeq);
      adoptSessionPromptCapabilities(agentState.state);
      const applied = applyAuthoritativeModel(toThinkingModelMeta(agentState.state?.model), token);
      if (!applied) return false; // stale snapshot — drop its derived state too
      if (agentState.state?.thinkingLevel !== undefined) {
        adoptThinkingLevel(agentState.state.thinkingLevel);
      }
      adoptFastModeState(agentState.state, sid);
      if (agentState.state?.autoRetryEnabled !== undefined) setAutoRetryEnabled(agentState.state.autoRetryEnabled);
      if (agentState.state?.interruptMode !== undefined) setInterruptMode(agentState.state.interruptMode);
      if (agentState.state?.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
      if (agentState.state?.steeringMode !== undefined) setSteeringMode(agentState.state.steeringMode);
      if (agentState.state?.followUpMode !== undefined) setFollowUpMode(agentState.state.followUpMode);
      return agentState.state?.thinkingLevel !== undefined;
    } catch {
      // Best effort; the next loadSession/reconcile re-syncs.
      return false;
    }
  }, [adoptFastModeState, adoptThinkingLevel, applyAuthoritativeModel, beginAuthoritativeModelSync, adoptSessionModels, adoptSessionModes, adoptSessionPromptCapabilities]);

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
                dispatchCompactionStatus({ type: "reconcile", sessionId: sid, active: liveState?.isCompacting === true, now: Date.now() });
        adoptSessionModels(liveState);
        adoptSessionModes(liveState, sid, modeSeq);
        adoptSessionPromptCapabilities(liveState);
        const modelApplied = applyAuthoritativeModel(toThinkingModelMeta(liveState?.model), token);
        if (liveState) {
          if (liveState.contextUsage !== undefined) setLiveContextUsage(readLiveContextUsage(liveState.contextUsage));
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt || null);
          if (modelApplied && liveState.thinkingLevel !== undefined) adoptThinkingLevel(liveState.thinkingLevel);
          if (modelApplied) adoptFastModeState(liveState, sid);
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
          if (liveState.planOverlay !== undefined) setPlanOverlay(readPlanOverlay(liveState.planOverlay) ?? null);
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
  }, [refreshSubagentUsage, adoptFastModeState, adoptThinkingLevel, applyAuthoritativeModel, beginAuthoritativeModelSync, adoptPermissionRequests, adoptSessionModels, adoptSessionModes, adoptSessionPromptCapabilities]);

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
        // No explicit pick and no manual pre-spawn reasoning-level pick is
        // Smart. Persist that source against the real session identity
        // before its first reconciliation can resolve a concrete model.
        const spawn = newSessionSpawnPlan({
          modelPicked: newSessionModel !== null,
          localOnly: newSessionLocalOnlyRef.current,
          manualLevelPicked: manualPreSpawnLevelRef.current,
          presetId: opts.newSessionPresetId,
        });
        if (selectedModel && spawn.sendModel) setPendingModel(selectedModel);
        const toolNames = getToolNamesForPreset(toolPreset);
        const res = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "ensure_session",
            ...(sessionKind ? { kind: sessionKind } : {}),
            ...(sessionKind === "sidebar" && contextSessionId ? { contextSessionId } : {}),
            toolNames,
            ...(selectedModel && spawn.sendModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" && spawn.sendThinkingLevel ? { thinkingLevel } : {}),
            ...(advisorEnabled ? { advisor: true } : {}),
            ...(newSessionLocalOnlyRef.current ? { localOnly: true } : {}),
            ...(opts.newSessionPresetId !== undefined && spawn.sendPresetId ? { presetId: opts.newSessionPresetId } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        ++compactionGenerationRef.current;
        dispatchCompactionStatus({ type: "reset", sessionId: realId });
        if (newSessionLocalOnlyRef.current) setLocalOnly((current) => ({ ...current, active: true, pending: false }));
        updateSessionControlScope(realId, selectedModel, true);
        if (spawn.smartSpawn) {
          pendingSmartSpawnRef.current = realId;
          setSmartModelProvenance({ forSession: realId });
        }
        return realId;
      })();

      ensuringNewSessionRef.current = promise;
      try {
        return await promise;
      } finally {
        ensuringNewSessionRef.current = null;
      }
    }, [advisorEnabled, contextSessionId, isNew, newSessionCwd, opts.newSessionPresetId, sessionKind, newSessionModel, newSessionDefaultModel, setSmartModelProvenance, thinkingLevel, toolPreset, updateSessionControlScope]);

  const selectLocalOnly = useCallback(async (): Promise<boolean> => {
    if (localOnly.pending || !localOnly.supported) return false;
    // Already on: re-selecting must not restart the engine for nothing.
    if (localOnly.active) return true;
    const sid = sessionIdRef.current;
    setLocalOnly((current) => ({ ...current, pending: true, error: undefined }));
    try {
      if (!sid) {
        newSessionLocalOnlyRef.current = true;
        const created = await ensureNewSession();
        if (!created) throw new Error("Could not create a Local-only session.");
        setLocalOnly((current) => ({ ...current, active: true, pending: false }));
        return true;
      }
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/local-routing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      const body = await response.json() as { active?: unknown; error?: unknown; models?: unknown };
      if (!response.ok || body.active !== true) throw new Error(typeof body.error === "string" ? body.error : "Local-only routing could not be applied.");
      const models = Array.isArray(body.models) ? body.models.filter((entry): entry is string => typeof entry === "string") : undefined;
      if (sessionIdRef.current === sid) setLocalOnly((current) => ({ ...current, active: true, pending: false, supported: true, models }));
      // The server moved the session onto the local primary; show it.
      void refreshLiveModelState(sid);
      return true;
    } catch (error) {
      if (sessionIdRef.current === sid || sid === null) {
        setLocalOnly((current) => ({ ...current, active: false, pending: false, error: error instanceof Error ? error.message : String(error) }));
      }
      newSessionLocalOnlyRef.current = false;
      return false;
    }
  }, [ensureNewSession, localOnly.active, localOnly.pending, localOnly.supported, refreshLiveModelState]);

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
            // Reconnect can happen after a terminal compaction when no chat
            // turn is believed running, so the normal turn-only reconcile is
            // insufficient. Read only the engine's authoritative state.
            const compactionStateReadStartedAt = Date.now();
            const compactionStateReadGeneration = compactionGenerationRef.current;
            void fetch(`/api/agent/${encodeURIComponent(sid)}`)
              .then((response) => (response.ok ? response.json() as Promise<{ state?: AgentStateResponse }> : null))
              .then((snapshot) => {
                if (sessionIdRef.current !== sid || compactionGenerationRef.current !== compactionStateReadGeneration) return;
                const active = snapshot?.state?.isCompacting === true;
                isCompactingRef.current = active;
                setIsCompacting(active);
                dispatchCompactionStatus({ type: "reconcile", sessionId: sid, active, now: Date.now(), observedAt: compactionStateReadStartedAt, generation: compactionStateReadGeneration });
              })
              .catch(() => {});
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

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType; dedupeKey?: string; errorKind?: ErrorKind }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
        dedupeKey: notice.dedupeKey,
        errorKind: notice.errorKind,
      },
    });
  }, []);
  addNoticeRef.current = addNotice;

  /** Route a raw engine/provider error string through {@link engineErrorNotice}
   * and post the result as a notice — or say nothing at all for a
   * user-initiated abort, which is not a failure to report. */
  const addEngineErrorNotice = useCallback((rawMessage: string, fallbackProvider?: string) => {
    const described = engineErrorNotice(rawMessage, fallbackProvider);
    if (!described) return;
    addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
  }, [addNotice]);

  const dispatchPendingModelSwitch = useCallback(async (): Promise<boolean> => {
    const pending = modelSwitchPendingRef.current;
    if (!pending) return false;
    if (modelSwitchAwaitingIdleRef.current === pending.scope.sessionId) return false;
    const dispatchingSession = modelSwitchDispatchingSessionRef.current;
    if (dispatchingSession !== null && dispatchingSession === pending.scope.sessionId) return true;
    const released = releaseModelSwitchAtBoundary(pending, modelSwitchScopeRef.current, true);
    if (!released.command) {
      if (released.pending === null) writeModelSwitchPending(null);
      return false;
    }
    const applying: PendingModelSwitchRequest = { ...pending, phase: "applying" };
    const sid = applying.scope.sessionId;
    if (!sid) {
      writeModelSwitchPending(null);
      return false;
    }
    modelSwitchDispatchingSessionRef.current = sid;
    writeModelSwitchPending(applying);
    try {
      await sendAgentCommand(sid, { type: "set_model", provider: applying.provider, modelId: applying.modelId });
      if (modelSwitchPendingRef.current === applying && sameSessionControlScope(modelSwitchScopeRef.current, applying.scope)) {
        pendingSmartSpawnRef.current = null;
        if (applying.selection === "smart") {
          setSmartModelProvenance(resolveSmartModel({ forSession: sid }, sid, { provider: applying.provider, modelId: applying.modelId }));
        } else {
          clearSmartModelProvenance(sid, true);
        }
        setAutoModelSwitch(null);
      }
      void refreshLiveModelState(sid);
      return true;
    } catch (error) {
      const current = modelSwitchPendingRef.current;
      if (error instanceof AgentCommandError && error.code === "session_busy") {
        // The backend emits this code only when the chosen model crosses a
        // prompt-profile boundary. Keep the explicit pick, but wait for an
        // actual idle boundary: message_end and tool frames are still part of
        // the provider operation that cannot be restarted safely.
        if (current?.scope.sessionId === sid) {
          modelSwitchAwaitingIdleRef.current = sid;
          writeModelSwitchPending({ ...(current.phase === "waiting" ? current : applying), phase: "waiting" });
        }
        return false;
      }
      if (current === applying && sameSessionControlScope(modelSwitchScopeRef.current, applying.scope)) {
        writeModelSwitchPending(null);
        const described = noticeFromCaughtError(error);
        if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
      } else if (
        current?.phase === "waiting"
        && sameSessionControlScope(current.scope, sessionControlScope(sid, { provider: applying.provider, modelId: applying.modelId }))
        && sameSessionControlScope(modelSwitchScopeRef.current, applying.scope)
      ) {
        // A newer pick was waiting for this rejected command's target. Rebase
        // it to the still-authoritative model so the user's latest choice wins.
        writeModelSwitchPending({ ...current, scope: applying.scope });
      }
      return false;
    } finally {
      if (modelSwitchDispatchingSessionRef.current === sid) modelSwitchDispatchingSessionRef.current = null;
      const next = modelSwitchPendingRef.current;
      if (modelSwitchAwaitingIdleRef.current !== sid
        && !assistantProviderCallRef.current
        && next?.phase === "waiting"
        && sameSessionControlScope(next.scope, modelSwitchScopeRef.current)) {
        dispatchPendingModelSwitchRef.current?.();
      }
    }
  }, [addNotice, clearSmartModelProvenance, refreshLiveModelState, setSmartModelProvenance, writeModelSwitchPending]);
  dispatchPendingModelSwitchRef.current = () => { void dispatchPendingModelSwitch(); };

  // Routing events arrive in bursts — a retry, its fallback, a second job's
  // fallback, three subagents recovering at once — and each one used to
  // raise its own toast. Six toasts in ten seconds is not six pieces of
  // information; it is none. They are collected briefly and delivered as
  // ONE message. A lone event still reads exactly as it did before.
  const routingBurstRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; entries: { message: string; kind: "info" | "success"; silent: boolean }[] }>({ timer: null, entries: [] });

  const flushRoutingBurst = useCallback(() => {
    const burst = routingBurstRef.current;
    burst.timer = null;
    const entries = burst.entries;
    burst.entries = [];
    if (entries.length === 0) return;
    if (entries.length === 1) {
      const [only] = entries;
      if (!only.silent) toast[only.kind](only.message, undefined, { durationMs: MODEL_SWITCH_TOAST_MS, clamp: true });
      addNotice({ type: only.kind, message: only.message });
      return;
    }
    const message = entries.map((entry) => entry.message).join("\n");
    const summary = translate("agentSession.routingSummary", { count: String(entries.length) });
    // The detail stays in the transcript, where it can be read at leisure;
    // the toast only says how much happened and points at it.
    if (entries.some((entry) => !entry.silent)) toast.info(summary, undefined, { durationMs: MODEL_SWITCH_TOAST_MS, clamp: true });
    addNotice({ type: "info", message: `${summary}\n${message}` });
  }, [addNotice]);

  const queueRoutingNotice = useCallback((message: string, kind: "info" | "success", silent: boolean) => {
    const burst = routingBurstRef.current;
    burst.entries.push({ message, kind, silent });
    clearTimeout(burst.timer ?? undefined);
    burst.timer = setTimeout(() => flushRoutingBurst(), ROUTING_BURST_MS);
  }, [flushRoutingBurst]);

  const announceFallbackApplied = useCallback((attribution: ModelFallbackAttribution, from: string, to: string) => {
    const reason = retryErrorByJobRef.current.get(fallbackJobKey(attribution.job));
    const message = fallbackAppliedMessage(attribution, from, to, reason);
    if (attribution.job.kind === "main" && sessionIdRef.current) {
      setAutoModelSwitch({ from, to, role: attribution.role, reason, reasonKind: classifyFallbackReason(reason), job: attribution.job, forSession: sessionIdRef.current });
      setSmartPinnedModel(null);
    }
    // A subagent's switch already has a home in the subagent panel; it is
    // recorded in the transcript but never interrupts.
    queueRoutingNotice(message, "info", attribution.job.kind !== "main");
  }, [queueRoutingNotice]);

  const announceFallbackSucceeded = useCallback((attribution: ModelFallbackAttribution, model: string) => {
    retryErrorByJobRef.current.delete(fallbackJobKey(attribution.job));
    queueRoutingNotice(fallbackSucceededMessage(attribution, model), "success", attribution.job.kind !== "main");
  }, [queueRoutingNotice]);

  const dismissNotice = useCallback((id: string) => {
    dispatchNotice({ type: "remove", id });
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
    const hadContent = runHadContentRef.current;
    const quotaMessage = lastQuotaErrorRef.current;
    const runError = lastRunErrorRef.current;
    const allowEmptyResponse = slashCommandRunRef.current;
    try {
      // The reload below replaces `messages` wholesale. A follower is
      // re-pinned instantly through the reflow (the terminal re-pin effect);
      // a reader keeps their place through the reader pin, and the finished
      // turn stays unfolded under them until they return to the bottom.
      completionRepinFromRef.current = messagesRef.current;
      holdTailForReader();
      // Pass the fence into loadSession: the pre-check above only guards the
      // start — a next prompt that begins while the reload is in flight must
      // not be overwritten by the finished run's snapshot.
      if (sid) await loadSession(sid, false, true, runId);
    } finally {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      optimisticUserMessageKeyRef.current = null;
      if (!agentRunningRef.current) return;
      if (runError) {
        addEngineErrorNotice(runError, engineNameRef.current);
        if (isQuotaLikeError(runError)) {
          toast.error("Quota reached", runError, { durationMs: 12000 });
        } else {
          toast.error("Request failed", runError, { durationMs: 12000 });
        }
      } else if (!hadContent && quotaMessage && isQuotaLikeError(quotaMessage)) {
        addNotice({ type: "error", message: quotaMessage });
        toast.error("Quota reached", quotaMessage, { durationMs: 12000 });
      } else if (!hadContent && !allowEmptyResponse) {
        const message = translate("agentSession.responseFailed");
        addNotice({ type: "error", message });
        toast.error("Request failed", message, { durationMs: 10000 });
      }
      agentRunningRef.current = false;
      assistantProviderCallRef.current = false;
      if (modelSwitchAwaitingIdleRef.current === sid) modelSwitchAwaitingIdleRef.current = null;
      void dispatchPendingModelSwitch();
      setAgentRunning(false);
      setAgentPhase(null);
      clearLiveToolResults();
      setRetryInfo(null);
      retryErrorByJobRef.current.clear();
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
      runHadContentRef.current = false;
      lastQuotaErrorRef.current = null;
      lastRunErrorRef.current = null;
      slashCommandRunRef.current = false;
      onAgentEnd?.();
    }
  }, [addNotice, addEngineErrorNotice, clearLiveToolResults, dispatchPendingModelSwitch, holdTailForReader, loadSession, onAgentEnd, refreshSubagentUsage, resetSubagentActivityState]);

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
    const guard = reconcileGuardRef.current;
    if (!guard) return;
    const token = guard.tryAcquire();
    if (token === null) return;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      adoptSessionPromptCapabilities(state);
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      isCompactingRef.current = state?.isCompacting ?? false;
      setIsCompacting(state?.isCompacting ?? false);
            dispatchCompactionStatus({ type: "reconcile", sessionId: sid, active: state?.isCompacting === true, now: Date.now() });
      // Also mid-run: this poll is the only todo-phase refresh while streaming.
      if (state?.todoPhases !== undefined) setTodoPhases(state.todoPhases ?? []);
      if (state?.planOverlay !== undefined) setPlanOverlay(readPlanOverlay(state.planOverlay) ?? null);
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
    } finally {
      const reissue = guard.release(token);
      if (reissue && agentRunningRef.current && promptRunIdRef.current === runId && sessionIdRef.current === sid) {
        void reconcileAgentState(sid);
      }
    }
  }, [finishPromptWithoutStream, refreshSubagentRoster, adoptPermissionRequests, adoptSessionPromptCapabilities]);

  // todo_auto_update means "todoPhases (and planOverlay) changed, go
  // refetch" — unlike todo_reminder/todo_auto_clear (omp-native frames that
  // only ever fire while a turn is actively running, so reconcileAgentState's
  // run-gate is correct for them), the plan keeper's own final pass fires on
  // TERMINAL agent_end and finishes its model call well after that — by the
  // time todo_auto_update arrives, agentRunningRef has already flipped
  // false and reconcileAgentState would silently no-op, dropping exactly
  // the completions a trailing keeper pass is most likely to contain. This
  // refresh is intentionally unconditional and narrow: just the two fields
  // the keeper owns, regardless of whether a turn is running.
  const refreshTodoState = useCallback((sid: string) => {
    fetch(`/api/agent/${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() as Promise<{ state?: AgentStateResponse }> : null))
      .then((d) => {
        if (sessionIdRef.current !== sid) return;
        if (d?.state?.todoPhases !== undefined) setTodoPhases(d.state.todoPhases ?? []);
        if (d?.state?.planOverlay !== undefined) setPlanOverlay(readPlanOverlay(d.state.planOverlay) ?? null);
      })
      .catch(() => {
        // Network still down — the next todo_auto_update / turn_end / reload retries.
      });
  }, []);

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
    reconcileGuardRef.current?.reset();
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
        reconcileGuardRef.current?.reset();
        agentRunningRef.current = true;
        assistantProviderCallRef.current = true;
        retryErrorByJobRef.current.clear();
        // The engine acknowledged this run, so from here a `connected` frame
        // reporting an idle engine means the run was lost, not that it never
        // started. A new run also resolves any stale lost-turn banner.
        runConfirmedRef.current = true;
        setStreamAlert(null);
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        clearLiveToolResults();
        dispatch({ type: "start" });
        runHadContentRef.current = false;
        lastQuotaErrorRef.current = null;
        lastRunErrorRef.current = null;
        break;
      case "agent_end": {
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
        // Capture fallback before clearing: if the run produced no visible
        // assistant content and we saw a quota error, surface it persistently
        // even when the engine sent no terminal notice.
        const hadContent = runHadContentRef.current;
        const previousQuotaMessage = lastQuotaErrorRef.current;
        const terminalError = readTerminalAgentError(event) ?? lastRunErrorRef.current;
        if (terminalError && isQuotaLikeError(terminalError)) {
          lastQuotaErrorRef.current = terminalError;
        }
        const quotaMessage = terminalError && isQuotaLikeError(terminalError)
          ? terminalError
          : previousQuotaMessage;
        if (!hadContent) {
          if (quotaMessage && isQuotaLikeError(quotaMessage)) {
            addNotice({ type: "error", message: quotaMessage });
            toast.error("Quota reached", quotaMessage, { durationMs: 12000 });
          } else if (terminalError) {
            addNotice({ type: "error", message: terminalError });
            toast.error("Request failed", terminalError, { durationMs: 12000 });
          } else if (!slashCommandRunRef.current) {
            const message = translate("agentSession.responseFailed");
            addNotice({ type: "error", message });
            toast.error("Request failed", message, { durationMs: 10000 });
          }
        } else if (terminalError && isQuotaLikeError(terminalError)) {
          // The provider can exhaust quota after a partial response; keep that
          // fact visible even though the run did produce content.
          addNotice({ type: "error", message: terminalError });
          toast.error("Quota reached", terminalError, { durationMs: 12000 });
        }
        // Capture sid + runId BEFORE clearing: the terminal reload below is
        // async, and a next prompt (or session switch) that starts while it is
        // in flight must not be overwritten by this finished run's snapshot.
        const endedSid = sessionIdRef.current;
        const endedRunId = promptRunIdRef.current;
        agentRunningRef.current = false;
        assistantProviderCallRef.current = false;
        if (modelSwitchAwaitingIdleRef.current === endedSid) modelSwitchAwaitingIdleRef.current = null;
        void dispatchPendingModelSwitch();
        setAgentRunning(false);
        setAgentPhase(null);
        clearLiveToolResults();
        setRetryInfo(null);
        retryErrorByJobRef.current.clear();
        setSubagents([]);
        subagentRosterGenerationRef.current += 1;
        resetSubagentActivityState();
        dispatch({ type: "end" });
        runHadContentRef.current = false;
        lastQuotaErrorRef.current = null;
        lastRunErrorRef.current = null;
        slashCommandRunRef.current = false;
        if (endedSid) {
          // Same contract as finishPromptWithoutStream: re-pin a follower,
          // hold the tail unfolded for a reader.
          completionRepinFromRef.current = messagesRef.current;
          holdTailForReader();
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
              adoptSessionPromptCapabilities(d.state);
              const applied = applyAuthoritativeModel(toThinkingModelMeta(d.state.model), endToken);
              if (!applied) return; // stale snapshot — drop everything derived from it
              if (d.state?.contextUsage !== undefined) setLiveContextUsage(readLiveContextUsage(d.state.contextUsage));
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt || null);
              // A terminal model snapshot may carry a newly learned Fast state.
              adoptFastModeState(d.state, endedSid);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.todoPhases !== undefined) setTodoPhases(d.state.todoPhases ?? []);
              if (d.state?.planOverlay !== undefined) setPlanOverlay(readPlanOverlay(d.state.planOverlay) ?? null);
              // omp reports only a queued count; an empty (or dead) session
              // means the client-tracked queue texts are stale.
              if ((!d.state || d.state.queuedMessageCount === 0) && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      }
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
      case "prompt_error": {
        const raw = readAgentError(event.errorMessage)
          ?? readAgentError(event.error)
          ?? readAgentError(event.message)
          ?? translate("agentSession.commandFailed");
        lastRunErrorRef.current = raw;
        // A failed prompt is terminal: no agent_end follows it. Without this the
        // spinner and the locked input wait for the 15s reconcile poll. Fenced
        // with the run id for the same reason as prompt_result above.
        if (agentRunningRef.current) void finishPromptWithoutStream(sessionIdRef.current, promptRunIdRef.current);
        else addEngineErrorNotice(raw, engineNameRef.current);
        break;
      }
      case "error":
      case "agent_error":
      case "turn_error":
      case "model_error":
      case "server_error":
      case "internal_error":
      case "rpc_frame_error": {
        const message = readTerminalAgentError(event) ?? translate("agentSession.responseFailed");
        lastRunErrorRef.current = message;
        if (!agentRunningRef.current) addNotice({ type: "error", message });
        break;
      }
      case "notice": {
        const level = event.level as string | undefined;
        const message = readAgentError(event.message)
          ?? readAgentError(event.errorMessage)
          ?? readAgentError(event.error)
          ?? "";
        if (/^xd:\/\/:\s*mounted\s+mcp__/i.test(message)) {
          toast.info("MCP tools updated", message, { clamp: true });
        } else if ((level === "error" || level === "warning") && message) {
          // Normalize engine/provider failures through the shared classifier,
          // while retaining Cody's quota retry bookkeeping and toast.
          addEngineErrorNotice(message, engineNameRef.current);
          if (isQuotaLikeError(message)) {
            lastQuotaErrorRef.current = message;
            toast.error("Quota reached", message, { durationMs: 12000 });
          }
        } else {
          addNotice({ type: "info", message });
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
        const text = readAgentError(event.text) ?? "";
        if (/^xd:\/\/:\s*mounted\s+mcp__/i.test(text)) toast.info("MCP tools updated", text, { clamp: true });
        else if (text) {
          addNotice({ type: "info", message: text });
          if (isQuotaLikeError(text)) {
            lastQuotaErrorRef.current = text;
            toast.error("Quota reached", text, { durationMs: 12000 });
          }
        }
        break;
      }
      case "thinking_level_changed":
        adoptThinkingLevel(event.thinkingLevel as string | undefined, event.configured as string | undefined);
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
            const now = Date.now();
            const recentPicks = recentUserModelPicksRef.current.filter((pick) => now - pick.at < 15_000);
            recentUserModelPicksRef.current = recentPicks;
            const isOwnEcho = recentPicks.some((pick) => pick.provider === next.provider && pick.modelId === next.modelId);
            if (!isOwnEcho && previous && (previous.provider !== next.provider || previous.modelId !== next.modelId)) {
              const from = `${previous.provider}/${previous.modelId}`;
              const to = `${next.provider}/${next.modelId}`;
              setAutoModelSwitch((current) => (
                current && current.forSession === sid && current.to.endsWith(next.modelId)
                  ? current
                  : { from, to, job: fallbackAttributionForRole("default", subagentsRef.current).job, forSession: sid }
              ));
              setSmartPinnedModel((current) => (
                current && current.provider === next.provider && current.modelId === next.modelId ? current : null
              ));
            }
            if (d.state.thinkingLevel !== undefined) adoptThinkingLevel(d.state.thinkingLevel);
            adoptFastModeState(d.state, sid);
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
        if (event.thinkingLevel !== undefined) adoptThinkingLevel(event.thinkingLevel as string | undefined);
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
        const messageError = readAgentError(msg);
        if (messageError) lastRunErrorRef.current = messageError;
        if (msg?.role === "user") {
          break;
        }
        assistantProviderCallRef.current = true;
        if (msg) {
          if (hasVisibleAssistantContent(msg)) runHadContentRef.current = true;
          const text = extractMessageText(msg);
          if (text && isQuotaLikeError(text)) lastQuotaErrorRef.current = text.slice(0, 800);
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
        const messageError = readAgentError(completed);
        if (messageError) lastRunErrorRef.current = messageError;
        if (completed) {
          if (hasVisibleAssistantContent(completed)) runHadContentRef.current = true;
          const text = extractMessageText(completed as Partial<AgentMessage>);
          if (text && isQuotaLikeError(text)) lastQuotaErrorRef.current = text.slice(0, 800);
        }
        if (completed?.role === "toolResult" && typeof completed.toolCallId === "string") {
          // The durable result is authoritative; remove the ephemeral entry
          // before appending so committed and live snapshots cannot race.
          setLiveToolResult(completed.toolCallId, null);
        }
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
          // describeEngineError tells a refusal from an auth failure from an
          // outdated-engine error from a plain outage, and cleans out the
          // JSON/request-id/URL junk a provider body carries; the auth branch
          // still gets the one hint that actually fixes it, the keys panel.
          addEngineErrorNotice(detail, engineNameRef.current);
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
        if (completed?.role === "assistant") {
          assistantProviderCallRef.current = false;
          void dispatchPendingModelSwitch();
        }
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        assistantProviderCallRef.current = false;
        void dispatchPendingModelSwitch();
        const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!id) break;
        const name = typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
        setLiveToolResult(id, { role: "toolResult", toolCallId: id, toolName: name, content: [], partial: true });
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
        const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!id) break;
        const partial = isRecord(event.partialResult) ? event.partialResult : null;
        const content = toolResultContent(partial?.content);
        const toolName = typeof event.toolName === "string" && event.toolName ? event.toolName : undefined;
        setLiveToolResults((prev) => {
          const existing = prev.get(id);
          const next = new Map(prev);
          next.set(id, {
            role: "toolResult",
            toolCallId: id,
            ...(toolName ?? existing?.toolName ? { toolName: toolName ?? existing?.toolName } : {}),
            content,
            ...(partial?.isError === true ? { isError: true } : existing?.isError ? { isError: true } : {}),
            ...(partial?.details !== undefined ? { details: partial.details } : existing?.details !== undefined ? { details: existing.details } : {}),
            partial: true,
          });
          return next;
        });
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
        assistantProviderCallRef.current = true;
        const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!id) break;
        const finalResult = isRecord(event.result) ? event.result : null;
        // Keep the last live snapshot visible, but mark it settled, until the
        // durable toolResult message arrives on the stream.
        setLiveToolResults((prev) => {
          const existing = prev.get(id);
          const next = new Map(prev);
          next.set(id, {
            role: "toolResult",
            toolCallId: id,
            ...(typeof event.toolName === "string" && event.toolName
              ? { toolName: event.toolName }
              : existing?.toolName ? { toolName: existing.toolName } : {}),
            content: finalResult && Array.isArray(finalResult.content)
              ? toolResultContent(finalResult.content)
              : existing?.content ?? [],
            ...(finalResult?.isError === true || event.isError === true || existing?.isError === true ? { isError: true } : {}),
            ...(finalResult?.details !== undefined ? { details: finalResult.details } : existing?.details !== undefined ? { details: existing.details } : {}),
          });
          return next;
        });
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
      case "todo_auto_update":
        if (sessionIdRef.current) refreshTodoState(sessionIdRef.current);
        break;
      case "plan_overlay_update": {
        const overlay = readPlanOverlay(event.overlay);
        if (overlay) setPlanOverlay(overlay);
        break;
      }
      case "auto_retry_start": {
        const attribution = fallbackAttributionForRole(event.role, subagentsRef.current);
        const rawErrorMessage = typeof event.errorMessage === "string" && event.errorMessage.trim()
          ? event.errorMessage.trim()
          : undefined;
        // The retry banner is a compact one-liner, not a full notice — clean
        // the provider's text the same way (no JSON, no request id, no
        // trailing URL) but keep it as the bare detail rather than wrapping
        // it in a refusal/usage sentence, which would not fit next to
        // "Retrying 2/5". Retain the raw text for quota retry bookkeeping.
        const errorMessage = rawErrorMessage ? describeEngineError(rawErrorMessage).detail : undefined;
        if (attribution.job.kind === "main") {
          setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage });
        }
        if (rawErrorMessage) {
          retryErrorByJobRef.current.set(fallbackJobKey(attribution.job), rawErrorMessage);
          if (isQuotaLikeError(rawErrorMessage)) lastQuotaErrorRef.current = rawErrorMessage;
        }
        break;
      }
      case "auto_retry_end": {
        const attribution = fallbackAttributionForRole(event.role, subagentsRef.current);
        if (attribution.job.kind === "main") setRetryInfo(null);
        break;
      }
      case "retry_fallback_applied": {
        const attribution = fallbackAttributionForRole(event.role, subagentsRef.current);
        const from = typeof event.from === "string" ? event.from : "?";
        const to = typeof event.to === "string" ? event.to : "?";
        announceFallbackApplied(attribution, from, to);
        break;
      }
      case "retry_fallback_succeeded": {
        const attribution = fallbackAttributionForRole(event.role, subagentsRef.current);
        const model = typeof event.model === "string" ? event.model : "?";
        announceFallbackSucceeded(attribution, model);
        break;
      }
      // Turn boundaries are where todo items flip (the model checks phases
      // off between turns, and subagent-driven updates land without any
      // parent-session tool frame). Refresh there instead of waiting for the
      // 15s reconcile poll, so items check off as they complete instead of
      // arriving in poll-sized batches.
      case "turn_end":
        {
          const messageError = readTerminalAgentError(event);
          if (messageError) lastRunErrorRef.current = messageError;
        }
        assistantProviderCallRef.current = false;
        void dispatchPendingModelSwitch();
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
      case "auto_compaction_start": {
        const sid = sessionIdRef.current;
        if (!sid) break;
        isCompactingRef.current = true;
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        const compactionGeneration = ++compactionGenerationRef.current;
        dispatchCompactionStatus({ type: "running", sessionId: sid, source: "automatic", now: Date.now(), generation: compactionGeneration });
        break;
      }
      case "auto_compaction_end": {
        const sid = sessionIdRef.current;
        isCompactingRef.current = false;
        setIsCompacting(false);
        if (!sid) break;
        if (event.skipped === true) {
          dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome: "noop", source: "automatic", now: Date.now() });
        } else if (event.aborted === true) {
          dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome: "cancelled", source: "automatic", now: Date.now() });
        } else if (typeof event.errorMessage === "string" && event.errorMessage.length > 0) {
          setCompactError(event.errorMessage);
          setCompactResult(null);
          dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome: "failed", source: "automatic", now: Date.now(), message: event.errorMessage });
        } else {
          setCompactResult(readCompactResult(event.result, "auto"));
          dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome: "completed", source: "automatic", now: Date.now() });
          void loadSession(sid);
        }
        break;
      }
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
        if (progressId && progress?.retryState?.errorMessage) {
          retryErrorByJobRef.current.set("subagent:" + progressId, progress.retryState.errorMessage);
        }
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
        const childEvent = isRecord(payload?.event) ? payload.event : null;
        const childType = typeof childEvent?.type === "string" ? childEvent.type : null;
        const attribution = fallbackAttributionForSubagentEvent(payload, subagentsRef.current);
        if (attribution && childType === "auto_retry_start") {
          const errorMessage = typeof childEvent?.errorMessage === "string" && childEvent.errorMessage.trim()
            ? childEvent.errorMessage.trim()
            : undefined;
          if (errorMessage) retryErrorByJobRef.current.set(fallbackJobKey(attribution.job), errorMessage);
        } else if (attribution && childType === "retry_fallback_applied") {
          announceFallbackApplied(
            attribution,
            typeof childEvent?.from === "string" ? childEvent.from : "?",
            typeof childEvent?.to === "string" ? childEvent.to : "?",
          );
        } else if (attribution && childType === "retry_fallback_succeeded") {
          announceFallbackSucceeded(attribution, typeof childEvent?.model === "string" ? childEvent.model : "?");
        }
        const progressPatch = parseSubagentProgressEvent(payload);
        if (subagentId && progressPatch) {
          setSubagents((prev) => {
            const target = prev.findIndex((subagent) => subagent.id === subagentId);
            if (target === -1) return prev;
            const current = prev[target];
            const nextEntry: SubagentInfo = {
              ...current,
              progress: { ...current.progress, ...progressPatch },
              lastUpdate: Date.now(),
              source: "live",
            };
            const next = [...prev];
            next[target] = nextEntry;
            subagentsRef.current = next;
            return next;
          });
        }
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
  }, [addNotice, addEngineErrorNotice, announceFallbackApplied, announceFallbackSucceeded, applyAuthoritativeModel, adoptFastModeState, adoptThinkingLevel, adoptSessionModels, adoptSessionModes, adoptSessionPromptCapabilities, beginAuthoritativeModelSync, clearLiveToolResults, consumeQueuedMessage, dispatchPendingModelSwitch, finishPromptWithoutStream, handleExtensionUiRequest, handleHostToolCall, handleHostUriRequest, holdTailForReader, loadSession, maybeAutoNameSession, mergeSubagents, onAgentEnd, onPreviewUrlsSeen, reconcileAgentState, refreshTodoState, resetSubagentActivityState, setLiveToolResult]);
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
    slashCommandRunRef.current = isSlashCommandPrompt;
    agentRunningRef.current = true;
    assistantProviderCallRef.current = true;
    // Optimistic: the stream is opened and the prompt posted below, so the
    // server has not acknowledged this run yet (see runConfirmedRef).
    runConfirmedRef.current = false;
    clearLiveToolResults();
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
        // Spawning takes seconds: the user may have opened another chat while
        // it was in flight (this instance is unmounted). Deliver the prompt in
        // the background, but do not promote or attach UI listeners from this
        // abandoned instance.
        const ownerGone = !hookAliveRef.current;

        if (sid) {
          sentSessionId = sid;
          // omp assigns the real id before the first prompt finishes. Promote
          // now so the sidebar can show this active session during streaming.
          if (!ownerGone) promoteNewSession(1, message);
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
              // set_model re-applies the model default, so restore the
              // reasoning level the user chose before the first prompt.
              if (thinkingLevel !== "auto") {
                await sendAgentCommand(sid, { type: "set_thinking_level", level: thinkingLevel });
              }
            }
          }
          if (!ownerGone) {
            await ensureEventsConnected(sid);
            void refreshSubagentRoster(sid);
          }
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
      const detail = describeEngineError(e instanceof Error ? e.message : String(e)).detail;
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
      assistantProviderCallRef.current = false;
      lastRunErrorRef.current = null;
      slashCommandRunRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      clearLiveToolResults();
      dispatch({ type: "end" });
      return false;
    }
  }, [isNew, newSessionCwd, newSessionModel, session, thinkingLevel, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, opts.chatInputRef, refreshSubagentRoster, registerHostTools, registerHostUriSchemes, clearLiveToolResults]);

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
      clearLiveToolResults();
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
      const detail = describeEngineError(e instanceof Error ? e.message : String(e)).detail;
      addNotice({ type: "error", message: detail });
      // The interrupted turn keeps running; what failed is THIS message, and it
      // was never delivered. Same banner as a failed first send.
      setStreamAlert({ kind: "send_failed", detail });
      return false;
    }
  }, [addNotice, clearLiveToolResults, ensureEventsConnected, refreshSubagentRoster]);

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
      // Same abandonment rule as handleSend: navigating away mid-spawn must
      // not pull the fresh chat into this session's history.
      if (hookAliveRef.current) {
        await loadSession(sid);
        promoteNewSession(1, inputText);
      }
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

  /** Turn Local-only off for a live session when a pick needs a model it
   * forbids. Resolves true when the pick may proceed: the model is inside
   * the Local-only set (a manual local pick keeps the mode), or the mode was
   * turned off. A refusal (a turn still running) is reported, never swallowed. */
  const leaveLocalOnlyFor = useCallback(async (sid: string, provider: string, modelId: string, selection: "manual" | "smart"): Promise<boolean> => {
    if (!localOnlyRef.current.active) return true;
    const key = `${provider}/${modelId}`;
    if (selection === "manual") {
      let allowed = localOnlyRef.current.models;
      if (!allowed) {
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/local-routing`);
          const body = response.ok ? await response.json() as { active?: unknown; models?: unknown } : null;
          if (body && body.active !== true) {
            if (sessionIdRef.current === sid) setLocalOnly((current) => ({ ...current, active: false, pending: false, models: undefined }));
            return true;
          }
          allowed = Array.isArray(body?.models) ? body.models.filter((entry): entry is string => typeof entry === "string") : undefined;
        } catch {
          allowed = undefined;
        }
      }
      if (allowed?.includes(key)) return true;
    }
    setLocalOnly((current) => ({ ...current, pending: true, error: undefined }));
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/local-routing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const body = await response.json().catch(() => ({})) as { active?: unknown; error?: unknown };
      if (!response.ok || body.active !== false) throw new Error(typeof body.error === "string" ? body.error : translate("agentSession.localOnlyLeaveFailed"));
      if (sessionIdRef.current === sid) setLocalOnly((current) => ({ ...current, active: false, pending: false, models: undefined }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sessionIdRef.current === sid) setLocalOnly((current) => ({ ...current, pending: false, error: message }));
      addNotice({ type: "error", message });
      return false;
    }
  }, [addNotice]);

  const handleModelChange = useCallback(async (provider: string, modelId: string, selection: "manual" | "smart" = "manual"): Promise<boolean> => {
    if (isNew) {
      // Smart on an already-spawned new session still reads as Smart.
      setNewSessionModel(selection === "smart" ? null : { provider, modelId });
      setPendingModel({ provider, modelId });
      updateSessionControlScope(sessionIdRef.current, { provider, modelId });
    }
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return isNew;
    if (sessionIdRef.current !== sid) return false;
    // Smart or a model outside the Local-only set is a request to leave
    // Local-only. The server refuses such a set_model while the mode is on,
    // so the mode goes first and the switch follows.
    if (localOnlyRef.current.active && !(await leaveLocalOnlyFor(sid, provider, modelId, selection))) return false;
    if (sessionIdRef.current !== sid) return false;
    // ACP transports do not yet guarantee that set_model is safe while a
    // prompt is live. The picker is disabled there, and this guards races.
    if (agentRunningRef.current && !(await engineSupports("chatExtras"))) return false;
    if (sessionIdRef.current !== sid) return false;

    const scope = modelSwitchScopeRef.current.sessionId === sid
      ? modelSwitchScopeRef.current
      : updateSessionControlScope(
        sid,
        isNew
          ? { provider, modelId }
          : (liveModelMeta ? { provider: liveModelMeta.provider, modelId: liveModelMeta.modelId } : null),
      );
    const applying = modelSwitchPendingRef.current?.phase === "applying"
      && modelSwitchPendingRef.current.scope.sessionId === sid
      ? modelSwitchPendingRef.current
      : null;
    if (applying && applying.provider === provider && applying.modelId === modelId) return true;
    // Re-selecting the current model cancels a waiting request. If a previous
    // command is already applying, it instead queues a reversal after that
    // command's acknowledgement so the latest user choice still wins.
    if (!isNew && !applying && scope.provider === provider && scope.modelId === modelId) {
      writeModelSwitchPending(null);
      setAutoModelSwitch(null);
      return true;
    }

    const name = (modelCatalogSource === "session"
      ? sessionModels.list.find((entry) => entry.provider === provider && entry.id === modelId)?.name
      : modelNames[provider + ":" + modelId]) ?? modelId;
    const now = Date.now();
    const pick = { provider, modelId, at: now };
    recentUserModelPicksRef.current = [
      ...recentUserModelPicksRef.current.filter((recent) => now - recent.at < 15_000),
      pick,
    ].slice(-4);
    const requestScope = applying
      ? sessionControlScope(sid, { provider: applying.provider, modelId: applying.modelId })
      : scope;
    const pending: PendingModelSwitchRequest = {
      ...queueModelSwitch(requestScope, { provider, modelId, name }),
      selection,
      pick,
    };
    writeModelSwitchPending(pending);
    if (agentRunningRef.current && assistantProviderCallRef.current) return true;
    return dispatchPendingModelSwitch();
  }, [dispatchPendingModelSwitch, isNew, leaveLocalOnlyFor, liveModelMeta, modelCatalogSource, modelNames, sessionModels.list, setNewSessionModel, updateSessionControlScope, writeModelSwitchPending]);

  // An unspawned session delegates the default choice to the engine's role
  // plan. A spawned one answers false: the picker then resolves Smart to the
  // configured default and applies it through handleModelChange(…, "smart"),
  // which leaves Local-only first.
  const selectSmartModel = useCallback((): boolean => {
    if (sessionIdRef.current) return false;
    newSessionLocalOnlyRef.current = false;
    manualPreSpawnLevelRef.current = false;
    setLocalOnly((current) => ({ ...current, active: false, pending: false, error: undefined, models: undefined }));
    setNewSessionModel(null);
    pendingSmartSpawnRef.current = null;
    return true;
  }, [setNewSessionModel]);

  const handleFastModeChange = useCallback(async (enabled: boolean) => {
      if (fastModePendingLatchRef.current) return;
      // Latch before session creation so a double-click cannot issue two commands.
      const request = fastModePendingRequestRef.current + 1;
      fastModePendingRequestRef.current = request;
      fastModePendingLatchRef.current = true;
      setFastModePending(true);
      // Drop state snapshots captured before this control request.
      beginAuthoritativeModelSync();
      let scope = fastModeScopeRef.current;
      try {
        const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current ?? await ensureNewSession();
        if (!sid || fastModePendingRequestRef.current !== request) return;
        scope = fastModeScopeRef.current;
        const result = await sendAgentCommand<{ enabled?: boolean; active?: boolean }>(sid, { type: "set_fast_mode", enabled });
        if (fastModePendingRequestRef.current !== request || !sameSessionControlScope(fastModeScopeRef.current, scope)) return;
        if (typeof result?.enabled === "boolean") setFastModeEnabled(result.enabled);
        if (typeof result?.active === "boolean") {
          fastModeActiveRef.current = result.active;
          setFastModeActive(result.active);
          if (result.active) setFastModeUnavailable(false);
          if (enabled && result.enabled && !result.active) {
            addNotice({ type: "info", message: translate("agentSession.fastModeInactive") });
          }
        }
        void refreshLiveModelState(sid);
      } catch (error) {
        if (fastModePendingRequestRef.current !== request || !sameSessionControlScope(fastModeScopeRef.current, scope)) return;
        console.error("Failed to change Fast mode:", error);
        if (enabled && isFastModeUnavailableError(error)) setFastModeUnavailable(true);
        const described = noticeFromCaughtError(error);
        if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
      } finally {
        if (fastModePendingRequestRef.current === request && sameSessionControlScope(fastModeScopeRef.current, scope)) {
          fastModePendingLatchRef.current = false;
          setFastModePending(false);
        }
      }
    }, [addNotice, beginAuthoritativeModelSync, ensureNewSession, refreshLiveModelState]);

  /** Toggle automatic retry for transient model failures. */
  const handleAutoRetryChange = useCallback(async (enabled: boolean) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setAutoRetryEnabled(enabled);
    try {
      await sendAgentCommand(sid, { type: "set_auto_retry", enabled });
    } catch (error) {
      setAutoRetryEnabled((current) => (current === enabled ? !enabled : current));
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
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
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
    }
  }, [addNotice, loadSession, refreshLiveModelState]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompactingRef.current || isCompacting) return;
    isCompactingRef.current = true;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    const compactionGeneration = ++compactionGenerationRef.current;
    dispatchCompactionStatus({ type: "request", sessionId: sid, source: "manual", now: Date.now(), generation: compactionGeneration });
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      if (sessionIdRef.current !== sid) return;
      const outcome = readCompactOutcome(result);
      setCompactResult(outcome === "completed" ? readCompactResult(result, "manual") : null);
      dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome, now: Date.now() });
      await loadSession(sid, true);
      void refreshLiveModelState(sid);
    } catch (error) {
      if (sessionIdRef.current !== sid) return;
      const outcome = compactionErrorOutcome(error);
      if (outcome === "failed") setCompactError(error instanceof Error ? error.message : String(error));
      setCompactResult(null);
      dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome, now: Date.now(), message: outcome === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined });
    } finally {
      if (sessionIdRef.current === sid) {
        isCompactingRef.current = false;
        setIsCompacting(false);
      }
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
      setModelErrorCode(d.modelErrorCode ?? null);
      setModelCatalogSource(d.catalogSource === "session" ? "session" : "global");
      setModelThinkingLevels(d.thinkingLevels ?? {});
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
          if (!sid) return complete({ handled: true, error: translate("agentSession.noSessionToCompact") });
          if (isCompactingRef.current || isCompacting) return { handled: true };
          isCompactingRef.current = true;
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const compactionGeneration = ++compactionGenerationRef.current;
          dispatchCompactionStatus({ type: "request", sessionId: sid, source: "manual", now: Date.now(), generation: compactionGeneration });
          try {
            const result = await sendAgentCommand<CompactCommandResult>(sid, {
              type: "compact",
              ...(args ? { customInstructions: args } : {}),
            });
            if (sessionIdRef.current !== sid) return { handled: true };
            const outcome = readCompactOutcome(result);
            setCompactResult(outcome === "completed" ? readCompactResult(result, "manual") : null);
            dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome, now: Date.now() });
            await loadSession(sid, true);
            promoteNewSession();
            return complete({ handled: true, message: outcome === "noop" ? translate("compaction.nothingToCompact") : translate("agentSession.compactedContext") });
          } catch (error) {
            if (sessionIdRef.current !== sid) return { handled: true };
            const outcome = compactionErrorOutcome(error);
            const message = error instanceof Error ? error.message : String(error);
            if (outcome === "failed") setCompactError(message);
            setCompactResult(null);
            dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome, now: Date.now(), message: outcome === "failed" ? message : undefined });
            return outcome === "failed" ? complete({ handled: true, error: message }) : complete({ handled: true, message: outcome === "noop" ? translate("compaction.nothingToCompact") : undefined });
          }
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
      if (commandName === "compact" && sid && sessionIdRef.current === sid) {
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
      if (!sid) {
        const error = new Error("No active session.");
        addNotice({ type: "error", message: error.message });
        throw error;
      }
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "steer",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
        queueMutatedAtRef.current = Date.now();
        setQueuedMessages((prev) => ({ ...prev, steering: [...prev.steering, message] }));
      } catch (error) {
        console.error("Failed to steer:", error);
        const described = noticeFromCaughtError(error);
        if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
        throw error;
      }
    }, [addNotice]);

  const handlePromptWithStreamingBehavior = useCallback(async (
      message: string,
      behavior: "steer" | "followUp",
      images?: AttachedImage[],
    ) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        const error = new Error("No active session.");
        addNotice({ type: "error", message: error.message });
        throw error;
      }
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
      } catch (error) {
        console.error("Failed to queue prompt:", error);
        const described = noticeFromCaughtError(error);
        if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
        throw error;
      }
    }, [addNotice]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        const error = new Error("No active session.");
        addNotice({ type: "error", message: error.message });
        throw error;
      }
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "follow_up",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
        queueMutatedAtRef.current = Date.now();
        setQueuedMessages((prev) => ({ ...prev, followUp: [...prev.followUp, message] }));
      } catch (error) {
        console.error("Failed to follow up:", error);
        const described = noticeFromCaughtError(error);
        if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
        throw error;
      }
    }, [addNotice]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
      if (sessionIdRef.current === sid) dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome: "cancelled", now: Date.now() });
    } catch (error) {
      if (sessionIdRef.current !== sid) return;
      const message = error instanceof Error ? error.message : String(error);
      setCompactError(message);
      dispatchCompactionStatus({ type: "settle", sessionId: sid, outcome: "failed", now: Date.now(), message });
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption, source: ThinkingLevelChangeSource = "manual") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) {
      // A new conversation has no engine yet. The pick is held here and
      // ensureNewSession applies it at spawn, before the first prompt; dropping
      // it left the selector stuck on Auto and the first turn on the default.
      if (!isNew) return;
      // A MANUAL pick here leaves Smart, same as an explicit pre-spawn model
      // pick — the picker hides and the eventual spawn drops any bound
      // preset (see `newSessionSpawnPlan`). A "preset"-sourced call never
      // reaches this branch (it only fires from a live PUT's success, which
      // requires a real session id), but source is still checked so a
      // future caller cannot fall into this by accident.
      if (source === "manual") manualPreSpawnLevelRef.current = true;
      thinkingConfiguredAutoRef.current = level === "auto";
      setThinkingLevel(level);
      return;
    }
    const scope = thinkingLevelScopeRef.current;
    const request = thinkingLevelPendingRequestRef.current + 1;
    thinkingLevelPendingRequestRef.current = request;
    setThinkingLevelPending(true);
    setThinkingLevelTarget(level);
    // The accepted level must win over any snapshot captured before this request.
    beginAuthoritativeModelSync();
    // An explicit level's thinking_level_changed echo carries no `configured`
    // field, so the selector the user asked for is recorded up front and put
    // back if the engine refuses.
    const previousConfiguredAuto = thinkingConfiguredAutoRef.current;
    thinkingConfiguredAutoRef.current = level === "auto";
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
      if (thinkingLevelPendingRequestRef.current !== request || !sameSessionControlScope(thinkingLevelScopeRef.current, scope)) return;
      // "If I change the reasoning level or model then it's no longer smart
      // mode" — but only a MANUAL pick means that; a preset's own default
      // level, applied right after a preset switch, must not cancel the
      // preset the user just chose (source distinguishes the two).
      clearSmartModelForThinkingLevel(sid, source, true);
      await refreshLiveModelState(sid);
      if (thinkingLevelPendingRequestRef.current !== request || !sameSessionControlScope(thinkingLevelScopeRef.current, scope)) return;
      addNotice({ type: "info", message: translate("agentSession.thinkingLevelApplied", { level: thinkingLevelLabel(level, translate) }) });
    } catch (error) {
      if (thinkingLevelPendingRequestRef.current !== request || !sameSessionControlScope(thinkingLevelScopeRef.current, scope)) return;
      thinkingConfiguredAutoRef.current = previousConfiguredAuto;
      console.error("Failed to set thinking level:", error);
      const described = noticeFromCaughtError(error);
      if (described) addNotice({ type: described.type, message: described.message, dedupeKey: described.dedupeKey, errorKind: described.kind });
    } finally {
      if (thinkingLevelPendingRequestRef.current === request && sameSessionControlScope(thinkingLevelScopeRef.current, scope)) {
        setThinkingLevelPending(false);
        setThinkingLevelTarget(null);
      }
    }
  }, [addNotice, beginAuthoritativeModelSync, clearSmartModelForThinkingLevel, isNew, refreshLiveModelState]);

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



  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    // `behavior: "auto"` falls back to the container's computed
    // `scroll-behavior` (which inherits `html { scroll-behavior: smooth }`),
    // so a per-frame live follow would restart an eased scroll animation
    // every frame — an endless chase that lags the growing content. Callers
    // pass "instant" for live follow; "smooth" stays for idle scrolls.
    const instant = reducedMotion || behavior === "instant";
    end.scrollIntoView({ block: "nearest", behavior: instant ? "instant" : behavior });
    if (instant) {
      // An instant scroll has landed: its scroll event will report exactly this value.
      expectedScrollTopRef.current = container.scrollTop;
    } else {
      // A UA-animated scroll reports intermediate values we cannot predict; window it.
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    }
  }, [reducedMotion]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleTouchStart = useCallback(() => {
    touchActiveRef.current = true;
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);
  const handleTouchEnd = useCallback(() => {
    touchActiveRef.current = false;
    touchEndedAtRef.current = Date.now();
  }, []);
  /** A finger is down, or momentum after a flick is still delivering scroll events. */
  const isTouchScrolling = useCallback(() => {
    if (touchActiveRef.current) return true;
    const now = Date.now();
    return now - touchEndedAtRef.current < TOUCH_MOMENTUM_MAX_MS && now - lastScrollEventAtRef.current < TOUCH_MOMENTUM_IDLE_MS;
  }, []);

  /** Re-assert the reader pin: the anchored content back at its offset. No-op while following. */
  const repinReader = useCallback(() => {
    if (completionScrollAllowedRef.current) return;
    const container = scrollContainerRef.current;
    const anchor = readerAnchorRef.current;
    if (!container || !anchor || isTouchScrolling()) return;
    if (restoreTranscriptAnchor(container, anchor) !== 0) expectedScrollTopRef.current = container.scrollTop;
  }, [isTouchScrolling]);

  const handleScrollPositionChange = useCallback(() => {
    const now = Date.now();
    lastScrollEventAtRef.current = now;
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    // A user wheel, keyboard, touch, or scrollbar scroll must win over the
    // suppression of our own scroll events: during a busy stream those are
    // issued every frame, so checking them first would trap the user at the
    // bottom. Our own scrolls are told apart by VALUE (an instant write lands
    // on a known scrollTop) or, for a UA-animated one, by a short window.
    // What remains is a scroll no input event announced: a momentum flick
    // past the intent window, find-in-page, the browser's own anchoring
    // adjustment, a clamp when content below shrank. For a READER every one
    // of those must re-capture the anchor, or the pin would drag them back to
    // where the flick started. A FOLLOWER is never demoted by one: a clamp's
    // scroll event is delivered a frame late, by which time new tokens have
    // grown the content again and the geometry reads "not at bottom" —
    // measured stranding a follower 180px above the tail.
    const userScrollIntent = now <= userScrollIntentUntilRef.current;
    if (!userScrollIntent) {
      if (now < ignoreProgrammaticScrollUntilRef.current) return;
      const expected = expectedScrollTopRef.current;
      if (expected !== null && Math.abs(container.scrollTop - expected) <= 1) return;
      if (completionScrollAllowedRef.current) return;
    }
    // Recompute even while idle: otherwise the flag stays false after a run
    // ends while the user is scrolled up, and a message that arrives outside
    // a run (queued follow-up, steering reply) would never auto-scroll.
    const following = end.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom <= 24;
    completionScrollAllowedRef.current = following;
    if (following) {
      readerAnchorRef.current = null;
      if (readerHoldsTailRef.current) {
        readerHoldsTailRef.current = false;
        setReaderHoldsTail(false);
      }
    } else {
      readerAnchorRef.current = captureTranscriptAnchor(container);
    }
  }, []);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      // A session opens at its bottom, whatever the previous one was scrolled to.
      completionScrollAllowedRef.current = true;
      readerAnchorRef.current = null;
      readerHoldsTailRef.current = false;
      setReaderHoldsTail(false);
      ++compactionGenerationRef.current;
      dispatchCompactionStatus({ type: "reset", sessionId: session.id });
      updateSessionControlScope(session.id, null);
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            agentRunningRef.current = true;
            assistantProviderCallRef.current = agentState.state.isStreaming === true;
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
          if (agentState.state.isCompacting !== undefined) {
                      setIsCompacting(agentState.state.isCompacting);
                      dispatchCompactionStatus({ type: "reconcile", sessionId: session.id, active: agentState.state.isCompacting, now: Date.now() });
                    }
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
    } else {
      updateSessionControlScope(null, null);
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
  }, [refreshSubagentRoster, registerHostTools, registerHostUriSchemes, updateSessionControlScope]);

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
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [hasMessages, loading, handleScrollPositionChange, markUserScrollIntent, handleTouchStart, handleTouchEnd]);

  // The reader pin, React half: after EVERY commit of the host component —
  // a token batch, a message boundary swapping the streaming bubble for its
  // committed row, the run's end, the terminal reload re-keying the tail, a
  // lazy-loaded page prepending above — put the anchored content back at its
  // offset before the frame paints. Cheap (one attribute query and one rect)
  // and a no-op while following.
  useLayoutEffect(() => {
    repinReader();
  });

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
  //  - the CONTENT grows or shrinks after commit — deferred tool-result
  //    images arriving, fonts swapping, a collapse animating frame by frame,
  //    a content-visibility placeholder realizing its true height.
  // A follower is re-pinned to the bottom on either ("instant" because an
  // eased chase during a drag-resize lags the pointer); a reader is re-pinned
  // to their anchor — the ResizeObserver half of the reader pin, which is
  // what holds a reader still on Safari (no native scroll anchoring) and
  // through animations React never commits.
  const transcriptMounted = !loading && (messages.length > 0 || streamState.isStreaming);
  useEffect(() => {
    if (!transcriptMounted || typeof ResizeObserver === "undefined") return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (completionScrollAllowedRef.current) scrollToBottom("instant");
      else repinReader();
    });
    observer.observe(container);
    // The content wrapper is the scroller's only child; its border-box height
    // IS the scrollHeight, so observing it catches late content growth.
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, [transcriptMounted, scrollToBottom, repinReader]);

  // Terminal re-pin for a FOLLOWER. When a run ends, the transcript is
  // reloaded from disk and `messages` is replaced: the streamed tail unmounts
  // and every turn re-enters a `.chat-turn` wrapper whose content-visibility
  // placeholder only realizes its true height as it paints. A smooth scroll
  // issued against the pre-reload geometry animates toward a stale offset and
  // lands mid-conversation, so pin the bottom before this commit paints and
  // once more a frame later after realized heights settle. A reader needs
  // nothing here: the reader pin already ran for this commit.
  useLayoutEffect(() => {
    const from = completionRepinFromRef.current;
    if (from === null || from === messages) return;
    completionRepinFromRef.current = null;
    if (!completionScrollAllowedRef.current) return;
    scrollToBottom("instant");
    requestAnimationFrame(() => {
      if (completionScrollAllowedRef.current) scrollToBottom("instant");
    });
  }, [messages, scrollToBottom]);

  useEffect(() => () => {
    hookAliveRef.current = false;
    if (followScrollFrameRef.current !== null) cancelAnimationFrame(followScrollFrameRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sid = session?.id ?? null;
    void (async () => {
      try {
        const configResponse = await fetch("/api/local-routing");
        const config = await configResponse.json() as { supported?: unknown; error?: unknown };
        if (cancelled) return;
        const supported = config.supported === true;
        if (!sid) {
          setLocalOnly((current) => ({ ...current, supported, active: false, pending: false, ...(typeof config.error === "string" ? { error: config.error } : {}) }));
          return;
        }
        const sessionResponse = await fetch(`/api/sessions/${encodeURIComponent(sid)}/local-routing`);
        const sessionState = sessionResponse.ok ? await sessionResponse.json() as { active?: unknown; error?: unknown; models?: unknown } : null;
        if (cancelled || sessionIdRef.current !== sid) return;
        setLocalOnly({
          active: sessionState?.active === true,
          ...(Array.isArray(sessionState?.models) ? { models: sessionState.models.filter((entry): entry is string => typeof entry === "string") } : {}),
          pending: false,
          supported,
          ...(typeof sessionState?.error === "string" ? { error: sessionState.error } : typeof config.error === "string" ? { error: config.error } : {}),
        });
      } catch {
        if (!cancelled) setLocalOnly({ active: false, pending: false, supported: false, error: "Local-only routing is unavailable." });
      }
    })();
    return () => { cancelled = true; };
  }, [session?.id]);

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
    const timeout = oldest.type === "error" ? NOTICE_ERROR_VISIBLE_MS : NOTICE_VISIBLE_MS;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, timeout);
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
    agentRunning, modelNames: effectiveModelNames, modelList: effectiveModelList, modelSelectable, modelsLoading, modelError, modelErrorCode, modelThinkingLevels, newSessionModel, toolPreset, thinkingLevel, thinkingLevelPending, thinkingLevelTarget, fastModeEnabled, fastModeActive, fastModePending, fastModeUnavailable, promptCapabilities, steeringSupported, autoRetryEnabled, interruptMode, autoCompactionEnabled, steeringMode, followUpMode,
    liveModelMeta,
    // Keep provenance session-scoped at the public boundary too: consumers
    // must never infer this conversation's routing from a prior session's pin.
    smartPinnedModel: smartModelForSession(smartPinnedModel, session?.id ?? sessionIdRef.current),
    modelSwitchPending: modelSwitchPending && modelSwitchPending.scope.sessionId === (session?.id ?? sessionIdRef.current)
      ? { provider: modelSwitchPending.provider, modelId: modelSwitchPending.modelId, name: modelSwitchPending.name, phase: modelSwitchPending.phase }
      : null,
    // Mode list and current mode, only while they belong to THIS session.
    availableModes: sessionModes.forSession === (session?.id ?? sessionIdRef.current) ? sessionModes.options : NO_MODES,
    currentModeId: sessionModes.forSession === (session?.id ?? sessionIdRef.current) ? sessionModes.current : null,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, compactionStatus, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, dismissNotice, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    permissionRequests, respondToPermission,
    // Smart is on for an unpinned new session, and stays on after the pin —
    // whether Smart resolved it (live pick) or the engine did (Smart spawn) —
    // for as long as the running model is still the one Smart chose in THIS
    // session (both facts are id-scoped, so a switch to another conversation
    // can never inherit them).
    isAutoModelSelection: (isNew && newSessionSpawnPlan({
      modelPicked: newSessionModel !== null,
      localOnly: localOnly.active,
      manualLevelPicked: manualPreSpawnLevelRef.current,
      presetId: opts.newSessionPresetId,
    }).smartSpawn)
      || (smartPinnedModel !== null
        && smartPinnedModel.forSession === (session?.id ?? sessionIdRef.current)
        && displayModelProvider === smartPinnedModel.provider
        && displayModelId === smartPinnedModel.modelId),
    autoModelSwitch: autoModelSwitch && autoModelSwitch.forSession === (session?.id ?? sessionIdRef.current)
      ? { from: autoModelSwitch.from, to: autoModelSwitch.to, role: autoModelSwitch.role, reason: autoModelSwitch.reason, job: autoModelSwitch.job }
      : null,
    agentPhase,
    // Event-stream health: `streamDegraded` replaces the "Waiting for model…"
    // label while the stream is not delivering; `streamAlert` is the banner for
    // a lost turn or an exhausted reconnect, with its two actions.
    streamDegraded, streamAlert, dismissStreamAlert, retryEventStream,
    subagents, subagentEvents, subagentTranscriptVersions, activeSubagentCount, currentTodoPhase, todoPhases, planOverlay,
    activeGoal, activePlan,
    localOnly,
    isNew,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef,
    pendingScrollToUserRef, initialScrollDoneRef,
    // The reader pin, for the transcript: whether the viewport follows the
    // tail, what a reader is anchored on, and whether the finished turn must
    // stay unfolded under them.
    followingRef: completionScrollAllowedRef, readerAnchorRef, readerHoldsTail,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, selectSmartModel, selectLocalOnly, handleFastModeChange, handleAutoRetryChange, handleInterruptModeChange, handleAutoCompactionChange, handleSteeringModeChange, handleFollowUpModeChange, handleCycleModel, handleCycleThinkingLevel, handleAbortRetry, handleInterruptAndReply,
    handleCompact, handleHandoff, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    removeQueuedMessage, promoteQueuedToSteer,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleModeChange, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    liveToolResults,
    // Subscriptions
    handleAgentEventRef,
  };
}
