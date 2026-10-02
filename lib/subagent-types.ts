// Shared subagent wire + history types (mirrors of oh-my-pi task/types.ts
// AgentProgress / SubagentLifecyclePayload / SingleResult, kept small and
// defensive: every field is optional because payloads are parsed leniently).

import type { AgentMessage } from "./types";
import { asNumber, asString, isRecord } from "./type-guards";
export type SubagentAgentSource = "bundled" | "user" | "project";

export interface SubagentRetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  startedAtMs: number;
}

/** One finished tool call in a child's rolling window. `intent`, `argsKey` and
 * `isError` arrive with omp 18.4+; an older engine sends only tool/args/endMs. */
export interface SubagentRecentTool {
  tool: string;
  args: string;
  endMs: number;
  intent?: string;
  argsKey?: string;
  isError?: boolean;
}

/** Live per-subagent progress snapshot (oh-my-pi AgentProgress). */
export interface SubagentProgress {
  index?: number;
  id?: string;
  agent?: string;
  agentSource?: SubagentAgentSource;
  status?: "pending" | "running" | "completed" | "failed" | "aborted";
  task?: string;
  assignment?: string;
  description?: string;
  lastIntent?: string;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartMs?: number;
  /** omp 18.4+: the model-written intent of the tool call running NOW. Unlike
   * `lastIntent` (the most recent intent of any call) it is cleared for a
   * call that carries none, so it never labels a tool with a stale intent. */
  currentToolIntent?: string;
  /** omp 18.4+: which argument `currentToolArgs` previews (e.g. "path"). */
  currentToolArgsKey?: string;
  recentTools?: SubagentRecentTool[];
  recentOutput?: string[];
  toolCount?: number;
  requests?: number;
  tokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  cost?: number;
  durationMs?: number;
  modelOverride?: string | string[];
  modelRole?: string;
  resolvedModel?: string;
  thinkingLevel?: string;
  resolvedModelIsFallback?: boolean;
  retryState?: SubagentRetryState;
  retryFailure?: { attempt: number; errorMessage: string };
  inflightTaskDetails?: unknown;
  extractedToolData?: Record<string, unknown[]>;
}

/** Compact live-activity entry, derived from successive progress frames. */
export interface SubagentActivityEvent {
  kind: "tool" | "model_changed" | "thinking_level_changed" | "retry_fallback_applied";
  label: string;
  ts: number;
  from?: string;
  to?: string;
  thinkingLevel?: string;
}

/** Settled per-subagent result from a parent task toolResult (SingleResult). */
export interface SubagentHistoryResult {
  exitCode?: number;
  truncated?: boolean;
  cost?: number;
  structuredOutput?: { source?: string; mode?: string; status?: string; error?: string };
  error?: string;
  aborted?: boolean;
  abortReason?: string;
  outputPath?: string;
  patchPath?: string;
  branchName?: string;
}

/** On-disk subagent history recovered from a parent session's task toolResults. */
export interface SubagentHistoryEntry {
  id: string;
  agent: string;
  agentSource?: SubagentAgentSource;
  status: "started" | "completed" | "failed" | "aborted";
  task?: string;
  assignment?: string;
  description?: string;
  index: number;
  sessionFile?: string;
  transcriptAvailable: boolean;
  /** True when the spawn was detached/async (parent turn kept working). */
  detached?: boolean;
  lastIntent?: string;
  toolCount?: number;
  requests?: number;
  tokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  cost?: number;
  durationMs?: number;
  modelOverride?: string | string[];
  modelRole?: string;
  resolvedModel?: string;
  resolvedModelIsFallback?: boolean;
  retryFailure?: { attempt: number; errorMessage: string };
  result?: SubagentHistoryResult;
}

/** get_subagents snapshot (RpcSubagentSnapshot) as seen over the wire. */
export interface SubagentSnapshotLike {
  id: string;
  index: number;
  agent: string;
  agentSource?: SubagentAgentSource;
  description?: string;
  status: "started" | "completed" | "failed" | "aborted" | "pending" | "running";
  task?: string;
  assignment?: string;
  sessionFile?: string;
  lastUpdate?: number;
  progress?: unknown;
  parentToolCallId?: string;
}

function asAgentSource(value: unknown): SubagentAgentSource | undefined {
  return value === "bundled" || value === "user" || value === "project" ? value : undefined;
}

function asProgressStatus(value: unknown): SubagentProgress["status"] | undefined {
  return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "aborted"
    ? value
    : undefined;
}

const EXPLICIT_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function splitResolvedModel(value: string): { resolvedModel: string; thinkingLevel?: string } {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return { resolvedModel: value };
  const thinkingLevel = value.slice(separator + 1);
  return EXPLICIT_THINKING_LEVELS.has(thinkingLevel)
    ? { resolvedModel: value.slice(0, separator), thinkingLevel }
    : { resolvedModel: value };
}

function parseRecentTool(value: unknown): SubagentRecentTool | undefined {
  if (!isRecord(value)) return undefined;
  const tool = asString(value.tool);
  if (!tool) return undefined;
  const out: SubagentRecentTool = { tool, args: asString(value.args) ?? "", endMs: asNumber(value.endMs) ?? 0 };
  const intent = asString(value.intent)?.trim();
  if (intent) out.intent = intent;
  const argsKey = asString(value.argsKey);
  if (argsKey) out.argsKey = argsKey;
  if (typeof value.isError === "boolean") out.isError = value.isError;
  return out;
}

/** Defensively copy an AgentProgress-shaped object into a SubagentProgress. */
export function parseSubagentProgress(value: unknown): SubagentProgress | undefined {
  if (!isRecord(value)) return undefined;
  const out: SubagentProgress = {};
  const index = asNumber(value.index);
  if (index !== undefined) out.index = index;
  const id = asString(value.id);
  if (id !== undefined) out.id = id;
  const agent = asString(value.agent);
  if (agent !== undefined) out.agent = agent;
  const agentSource = asAgentSource(value.agentSource);
  if (agentSource !== undefined) out.agentSource = agentSource;
  const status = asProgressStatus(value.status);
  if (status !== undefined) out.status = status;
  const task = asString(value.task);
  if (task !== undefined) out.task = task;
  const assignment = asString(value.assignment);
  if (assignment !== undefined) out.assignment = assignment;
  const description = asString(value.description);
  if (description !== undefined) out.description = description;
  const lastIntent = asString(value.lastIntent);
  if (lastIntent !== undefined) out.lastIntent = lastIntent;
  const currentTool = asString(value.currentTool);
  if (currentTool !== undefined) out.currentTool = currentTool;
  const currentToolArgs = asString(value.currentToolArgs);
  if (currentToolArgs !== undefined) out.currentToolArgs = currentToolArgs;
  const currentToolStartMs = asNumber(value.currentToolStartMs);
  if (currentToolStartMs !== undefined) out.currentToolStartMs = currentToolStartMs;
  const currentToolIntent = asString(value.currentToolIntent)?.trim();
  if (currentToolIntent) out.currentToolIntent = currentToolIntent;
  const currentToolArgsKey = asString(value.currentToolArgsKey);
  if (currentToolArgsKey) out.currentToolArgsKey = currentToolArgsKey;
  if (Array.isArray(value.recentTools)) {
    const recentTools = value.recentTools.map(parseRecentTool).filter((x): x is SubagentRecentTool => x !== undefined);
    out.recentTools = recentTools;
  }
  if (Array.isArray(value.recentOutput)) out.recentOutput = value.recentOutput.filter((x): x is string => typeof x === "string");
  const toolCount = asNumber(value.toolCount);
  if (toolCount !== undefined) out.toolCount = toolCount;
  const requests = asNumber(value.requests);
  if (requests !== undefined) out.requests = requests;
  const tokens = asNumber(value.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  const contextTokens = asNumber(value.contextTokens);
  if (contextTokens !== undefined) out.contextTokens = contextTokens;
  const contextWindow = asNumber(value.contextWindow);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  const cost = asNumber(value.cost);
  if (cost !== undefined) out.cost = cost;
  const durationMs = asNumber(value.durationMs);
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (typeof value.modelOverride === "string" || (Array.isArray(value.modelOverride) && value.modelOverride.every((x) => typeof x === "string"))) {
    out.modelOverride = value.modelOverride;
  }
  const modelRole = asString(value.modelRole);
  if (modelRole !== undefined) out.modelRole = modelRole;
  const resolvedModel = asString(value.resolvedModel);
  if (resolvedModel !== undefined) {
    const parsed = splitResolvedModel(resolvedModel);
    out.resolvedModel = parsed.resolvedModel;
    if (parsed.thinkingLevel !== undefined) out.thinkingLevel = parsed.thinkingLevel;
  }
  if (typeof value.resolvedModelIsFallback === "boolean") out.resolvedModelIsFallback = value.resolvedModelIsFallback;
  if (isRecord(value.retryState)) {
    const attempt = asNumber(value.retryState.attempt);
    const maxAttempts = asNumber(value.retryState.maxAttempts);
    const delayMs = asNumber(value.retryState.delayMs);
    const errorMessage = asString(value.retryState.errorMessage);
    const startedAtMs = asNumber(value.retryState.startedAtMs);
    // All fields are documented as required upstream; fabricating defaults for
    // a partial frame would render a false "retrying" state.
    if (attempt !== undefined && maxAttempts !== undefined && delayMs !== undefined && errorMessage !== undefined && startedAtMs !== undefined) {
      out.retryState = { attempt, maxAttempts, delayMs, errorMessage, startedAtMs };
    }
  }
  if (isRecord(value.retryFailure)) {
    const attempt = asNumber(value.retryFailure.attempt);
    const errorMessage = asString(value.retryFailure.errorMessage);
    if (attempt !== undefined && errorMessage !== undefined) {
      out.retryFailure = { attempt, errorMessage };
    }
  }
  if (value.inflightTaskDetails !== undefined) out.inflightTaskDetails = value.inflightTaskDetails;
  if (isRecord(value.extractedToolData)) out.extractedToolData = value.extractedToolData as Record<string, unknown[]>;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map a get_subagents snapshot to roster form. */
export function parseSubagentSnapshot(value: unknown): SubagentInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const agent = asString(value.agent);
  if (!id || !agent) return undefined;
  let status: SubagentInfo["status"];
  if (value.status === "started" || value.status === "completed" || value.status === "failed" || value.status === "aborted") {
    status = value.status;
  } else if (value.status === "pending" || value.status === "running") {
    status = "started";
  } else {
    // Unknown/future lifecycle status — a malformed frame must not fabricate a
    // live chip.
    return undefined;
  }
  const info: SubagentInfo = {
    id,
    agent,
    status,
    index: asNumber(value.index) ?? -1,
    source: "live",
  };
  const agentSource = asAgentSource(value.agentSource);
  if (agentSource !== undefined) info.agentSource = agentSource;
  const description = asString(value.description);
  if (description !== undefined) info.description = description;
  const task = asString(value.task);
  if (task !== undefined) info.task = task;
  const assignment = asString(value.assignment);
  if (assignment !== undefined) info.assignment = assignment;
  const sessionFile = asString(value.sessionFile);
  if (sessionFile !== undefined) info.sessionFile = sessionFile;
  const parentToolCallId = asString(value.parentToolCallId);
  if (parentToolCallId !== undefined) info.parentToolCallId = parentToolCallId;
  const lastUpdate = asNumber(value.lastUpdate);
  if (lastUpdate !== undefined) info.lastUpdate = lastUpdate;
  const progress = parseSubagentProgress(value.progress);
  if (progress !== undefined) info.progress = progress;
  return info;
}

/** Map a subagent_lifecycle frame to roster form. Stricter than a snapshot:
 * requires id + status, and unlike snapshots the wire may omit `agent` (it
 * defaults to "subagent"). Unknown statuses must not fabricate a live chip. */
export function parseSubagentLifecycle(value: unknown): SubagentInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const statusRaw = asString(value.status);
  if (!id || !statusRaw) return undefined;
  if (statusRaw !== "started" && statusRaw !== "completed" && statusRaw !== "failed" && statusRaw !== "aborted") return undefined;
  const info: SubagentInfo = {
    id,
    agent: asString(value.agent) ?? "subagent",
    status: statusRaw,
    index: asNumber(value.index) ?? -1,
    lastUpdate: Date.now(),
    source: "live",
  };
  const agentSource = asAgentSource(value.agentSource);
  if (agentSource !== undefined) info.agentSource = agentSource;
  const description = asString(value.description);
  if (description !== undefined) info.description = description;
  const sessionFile = asString(value.sessionFile);
  if (sessionFile !== undefined) info.sessionFile = sessionFile;
  const parentToolCallId = asString(value.parentToolCallId);
  if (parentToolCallId !== undefined) info.parentToolCallId = parentToolCallId;
  if (typeof value.detached === "boolean") info.detached = value.detached;
  return info;
}

/**
 * What changed between two progress snapshots of one child, as activity
 * entries: a tool it started, a model switch (a fallback when the new model
 * is marked as one), a reasoning-level change. Progress frames are omp's
 * throttled summary (~7/s per child), so a tool that starts and ends between
 * two frames is not seen — the transcript still has it.
 */
export function activityFromProgressChange(
  previous: SubagentProgress | undefined,
  next: SubagentProgress,
  ts: number = Date.now(),
): SubagentActivityEvent[] {
  const events: SubagentActivityEvent[] = [];
  const tool = next.currentTool;
  if (tool && (tool !== previous?.currentTool || next.currentToolStartMs !== previous?.currentToolStartMs)) {
    const intent = (next.currentToolIntent ?? next.lastIntent)?.trim();
    const args = next.currentToolArgs?.trim();
    const label = intent
      ? "→ " + tool + ": " + intent
      : args ? "→ " + tool + " (" + args.slice(0, 80) + ")" : "→ " + tool;
    events.push({ kind: "tool", label, ts });
  }
  const from = previous?.resolvedModel;
  const to = next.resolvedModel;
  if (from && to && from !== to) {
    events.push(next.resolvedModelIsFallback && !previous?.resolvedModelIsFallback
      ? { kind: "retry_fallback_applied", label: "Fallback: " + from + " → " + to, from, to, ts }
      : { kind: "model_changed", label: to, to, ts });
  }
  const thinkingLevel = next.thinkingLevel;
  if (previous?.thinkingLevel && thinkingLevel && thinkingLevel !== previous.thinkingLevel) {
    events.push({ kind: "thinking_level_changed", label: thinkingLevel, thinkingLevel, ts });
  }
  return events;
}

// SubagentInfo is defined here so server-side history and the hook share the
// same roster shape; hooks/useAgentSession re-exports it for components.
export interface SubagentInfo {
  id: string;
  agent: string;
  agentSource?: SubagentAgentSource;
  description?: string;
  status: "started" | "completed" | "failed" | "aborted";
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  index: number;
  detached?: boolean;
  progress?: SubagentProgress;
  lastUpdate?: number;
  /** Settled result for history entries (SingleResult-derived). */
  result?: SubagentHistoryResult;
  /** Roster origin: live frames/snapshots (default) vs on-disk history. */
  source?: "live" | "history";
  /**
   * The child changed model WHILE RUNNING — which in practice means omp's
   * task prewalk handed it off to the cheap model at its first edit/write.
   * Recorded as an observation, not as a prewalk-specific frame: omp emits
   * a plain `model_changed` for the handoff, and a running child changing
   * model IS the event worth showing either way.
   */
  modelHandoff?: { from: string; to: string; at: string };
}

/**
 * The merged subagent, with a model handoff recorded when the incoming
 * frame names a different resolved model than the one already running.
 *
 * Only a change BETWEEN two known models counts: a child reporting its
 * model for the first time has not handed off, and an absent value in a
 * later frame is missing telemetry, not a switch back. An earlier handoff
 * is kept unless a newer one supersedes it, so the chip still says what
 * happened after the child settles.
 */
export function withModelHandoff(existing: SubagentInfo, incoming: SubagentInfo): SubagentInfo {
  const merged = { ...existing, ...incoming };
  const from = existing.progress?.resolvedModel;
  const to = incoming.progress?.resolvedModel;
  if (!from || !to || from === to) return merged;
  return { ...merged, modelHandoff: { from, to, at: new Date().toISOString() } };
}

/** What a running child is doing, for a chip or activity line: the intent of
 * the call running now when the engine reports one (omp 18.4+), otherwise the
 * last intent seen (older engines). */
export function subagentActivityIntent(progress: SubagentProgress | undefined): string | undefined {
  const intent = (progress?.currentToolIntent ?? progress?.lastIntent)?.trim();
  return intent || undefined;
}

/** True when an RPC failure means "this engine does not know the command":
 * omp 18.3 answers `Unknown command: <type>`, and the wrapper's own refusal
 * for a restricted-vocabulary engine says "not supported by this engine".
 * Callers use it to fall back to what worked before the command existed. */
export function isUnsupportedCommandError(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "unsupported") return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Unknown command/i.test(message) || /not supported by this engine/i.test(message);
}

/**
 * One page of a subagent transcript. The disk reader
 * (`/api/sessions/:id/subagents/:subagentId`, lib/subagent-history.ts) and omp's
 * `get_subagent_messages` share the first block of fields; the optional rest is
 * disk-only. A page is always whole JSONL lines: `fromByte` and `nextByte` are
 * both line starts, so any returned offset is a valid cursor.
 */
export interface SubagentTranscriptPage {
  sessionFile: string;
  /** Byte offset of the first line in the page. */
  fromByte: number;
  /** Byte offset just past the last line in the page (the next page's `fromByte`). */
  nextByte: number;
  /** True when `fromByte` was past the end of the file and the read restarted at byte 0. */
  reset: boolean;
  messages: AgentMessage[];
  /** Byte offset of the source line of each message, parallel to `messages`.
   * Stable for the life of the file, so it is the row identity. */
  offsets?: number[];
  /** Size of the file when the page was read. */
  totalBytes?: number;
  /** End of the last COMPLETE line in the file when the page was read.
   * `nextByte >= endByte` means there is nothing newer to fetch. */
  endByte?: number;
  /** Whether any line precedes `fromByte`. */
  hasEarlier?: boolean;
  error?: string;
}
