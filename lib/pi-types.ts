// Local mirrors of the omp shapes used by Cody. omp's SDK packages are
// Bun-only, so these types are hand-maintained against
// oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts (protocol v1).

import type { GoalModeState } from "./goal-state";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

/** Subset of omp's Model (pi-ai) that the web UI reads; extra fields pass through. */
export interface OmpModel {
  id: string;
  provider: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  thinking?: {
    mode?: string;
    efforts?: string[];
    requiresEffort?: boolean;
    defaultLevel?: string;
    /** omp 18.15+: the levels were guessed, not confirmed by the provider. */
    unverified?: boolean;
  };
  [key: string]: unknown;
}

export interface TodoItem {
  id?: string;
  content: string;
  // `blocked` and `blocker` exist only on omp before 18.19.0 (and in chat files
  // those engines saved). 18.19.0 removed both from its list and reads an old
  // blocked task back as `pending`. Cody still reads and shows them so a chat
  // on an older engine, or an old chat file read without an engine, stays
  // truthful; an engine that never sends them simply never produces one.
  status: "pending" | "in_progress" | "completed" | "blocked" | "abandoned";
  blocker?: string;
}

export interface TodoPhase {
  id?: string;
  name: string;
  tasks: TodoItem[];
}

/**
 * Cody's own overlay atop omp's TodoPhase (lib/plan-keeper/overlay.ts): what
 * the plan keeper knows about a session's list that the engine's own todo
 * state cannot hold. omp's TodoPhase has no subtask, label or summary field,
 * and it forgets a check-off it was handed whenever it rebuilds its list from
 * the session file, so all of it lives beside the phases, persisted per
 * session.
 */
export interface PlanOverlaySubtask {
  content: string;
  status: "pending" | "completed";
}

/** The keeper's one-line summary of a folded run of finished tasks, and how
 * many tasks it was written for. */
export interface PlanOverlayFold {
  summary: string;
  count: number;
}

export interface PlanOverlay {
  /** Keyed by the exact content of the parent (top-level) task. */
  subtasks: Record<string, PlanOverlaySubtask[]>;
  /** The tasks the KEEPER checked off, each as planTaskKey(phase, content)
   * (lib/plan-keeper/fold.ts). The durable record of those check-offs: it is
   * what puts them back after the engine loses them, and what gives them the
   * auto-mark the agent's own completions never get. An entry from before
   * phases were recorded is a bare task content and only earns the mark. */
  autoCompleted: string[];
  /** Short display labels, keyed by the exact content of the task. */
  labels: Record<string, string>;
  /** Summaries of folded runs of finished tasks, keyed by the planTaskKey of
   * the run's first task. */
  folds: Record<string, PlanOverlayFold>;
  updatedAt: number;
}

/** Emitted by the plan keeper whenever it changes the overlay: a full
 * replacement of the session's overlay, not a merge. */
export interface PlanOverlayUpdateFrame {
  type: "plan_overlay_update";
  overlay: PlanOverlay;
}

/** Emitted exactly when the keeper's set_todos call changed the engine's
 * phases (a check-off, or one it put back). Carries no payload of its own —
 * the browser refetches todoPhases the same way it already does on
 * turn_end. */
export interface TodoAutoUpdateFrame {
  type: "todo_auto_update";
}

/** Where `/slow` is stored: `global` is persisted config every session
 * shares (Claude subscriptions' low priority), `session` is this session's
 * own flex service tier. */
export type SlowModeScope = "session" | "global";

/** Mirror of omp's UsageLimitState (`get_state.usageLimit`): the stage a
 * provider account is in once past its usage limit. */
export type UsageLimitState =
  | { stage: "low_priority"; resetsAtSec: number; allowanceLeftPercent?: number }
  | { stage: "wrap_up"; resetsAtSec?: number; extraUsage: boolean };

/** Mirror of omp's RpcSessionState (the raw `get_state` payload). */
export interface RpcSessionState {
  model?: OmpModel;
  thinkingLevel: string | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  /** omp addition; absent on pi. */
  interruptMode?: "immediate" | "wait";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled?: boolean;
  messageCount: number;
  /** omp's name for the queued-message count. Absent on pi. */
  queuedMessageCount?: number;
  /** pi's name for the same count (omp renamed it queuedMessageCount). */
  pendingMessageCount?: number;
  /** omp addition; absent on pi. */
  todoPhases?: TodoPhase[];
  systemPrompt?: string[];
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  fastMode?: boolean;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  /** omp 18.6.3+. Absent on older omp, pi and ACP engines. */
  slowModeSupported?: boolean;
  slowModeEnabled?: boolean;
  slowModeScope?: SlowModeScope;
  usageLimit?: UsageLimitState;
  /** omp 18.4.11+: the session's goal, `null` when it has none. The KEY is
   * the capability — it is absent on older omp, pi and the ACP engines. */
  goal?: GoalModeState | null;
}

/**
 * The state shape Cody's own API returns to the browser
 * (AgentSessionWrapper adapts RpcSessionState and adds process-side flags).
 */
export interface RefusalDecision {
  id: string;
  fromModel: string;
  toModel: string | null;
  canContinue: boolean;
  createdAt: number;
}

export interface WebSessionState {
  sessionId: string;
  sessionFile: string;
  sessionName?: string;
  pendingRefusalDecision: RefusalDecision | null;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  interruptMode: "immediate" | "wait";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  model?: ModelLike & { name?: string; reasoning?: boolean; thinking?: { efforts?: string[]; unverified?: boolean } };
  messageCount: number;
  queuedMessageCount: number;
  contextUsage: ContextUsage | null;
  systemPrompt: string;
  thinkingLevel: string;
  fastModeEnabled: boolean;
  fastModeActive?: boolean;
  /** Slow-mode and usage-limit fields pass through untouched: the browser
   * derives what to show from them (lib/slow-mode-state.ts), and absence
   * means the engine has no such surface. */
  slowModeSupported?: boolean;
  slowModeEnabled?: boolean;
  slowModeScope?: SlowModeScope;
  usageLimit?: UsageLimitState;
  /** Native goal mode (lib/goal-state.ts): passed through only when the engine
   * reported the key, so absence means "no native goals here", never "no goal".
   * `goalAgeMs` is how long the engine had been waiting to count the goal's
   * time when this was read (the server shares the engine's clock). */
  goal?: GoalModeState | null;
  goalAgeMs?: number;
  autoRetryEnabled?: boolean;
  todoPhases: TodoPhase[];
  /** Absent when the plan keeper has never touched this session. */
  planOverlay?: PlanOverlay;
  extensionStatuses: Array<{ key: string; text: string }>;
  extensionWidgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

export type AvailableSlashCommandSource =
  | "builtin"
  | "skill"
  | "extension"
  | "custom"
  | "mcp_prompt"
  | "file";

/** Mirror of omp's RpcAvailableSlashCommand (`get_available_commands`). */
export interface RpcAvailableSlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string; usage?: string }>;
  source: AvailableSlashCommandSource;
}

/** Mirror of omp's BashResult (`bash` command response). The `elided*`,
 *  `column*` and `minimized` fields arrive with omp 18.16-18.17 and are absent
 *  from older engines. */
export interface BashResultInfo {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timedOut?: boolean;
  truncated: boolean;
  totalLines?: number;
  totalBytes?: number;
  outputLines?: number;
  outputBytes?: number;
  artifactId?: string;
  /** Bytes / lines dropped from the MIDDLE of `output` (head and tail kept). */
  elidedBytes?: number;
  elidedLines?: number;
  /** What the per-line column cap cut: bytes, lines, the first/last cut line, and the cap in bytes. */
  columnDroppedBytes?: number;
  columnTruncatedLines?: number;
  columnTruncatedRange?: { first: number; last: number };
  columnMax?: number;
  /** The output minimizer rewrote the output: filter label plus raw and kept byte counts. */
  minimized?: { filter?: string; inputBytes?: number; outputBytes?: number; artifactId?: string };
  workingDir?: string;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  premiumRequests?: number;
  /**
   * Failed edits by the engine's reason (`stale_tag`, `unseen_lines`, ...),
   * omp >= 18.13. Absent when nothing failed or the engine predates the field.
   */
  editRejections?: Record<string, number>;
  /**
   * API-equivalent spend: what the session would have cost on pay-as-you-go
   * pricing, never money actually charged on a subscription plan.
   *
   * Summed once per source (lib/session-usage.ts): each assistant message's
   * `usage.cost.total` in the parent transcript (omp prices those from
   * models.dev plus curated overrides), the same figure inside every subagent
   * transcript, and the first-party cost an engine reports for itself. The
   * parent's `task` toolResults carry a per-child cost too, but that is a
   * display value for events already counted here.
   */
  cost: number;
  /**
   * Model identifiers that reported nonzero token usage while their whole
   * contribution priced at zero — omp prices an uncatalogued model at zero
   * rather than flagging it unknown, so a nonempty list here means `cost` is a
   * floor rather than a total.
   *
   * Populated by the session aggregator over every transcript the session
   * touched, so a child that ran an uncatalogued model is named here as well.
   * Absent (rather than empty) when no per-model signal was computed at all:
   * the UI must read absence as "no signal", never as "every model was
   * priced". An itemized caveat is only rendered when this array actually
   * carries names, and a zero `cost` against real tokens is reported as
   * unpriced rather than as $0.
   */
  unpricedModels?: string[];
  contextUsage?: ContextUsage;
}

/** One question of omp's `ask` dialog (omp >= 18.4, after `set_ask_dialog`).
 *  Options never include "Other" — the host always offers free text.
 *  `recommended` is the INDEX of the recommended option. */
export interface OmpAskQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  recommended?: number;
}

/** Positional presentation metadata for a `select` option (omp >= 18.4):
 *  `optionDetails[i]` describes `options[i]`; entries without a description are `{}`. */
export interface OmpSelectOptionDetail {
  description?: string;
}

/**
 * What omp >= 18.20 adds to a `select` frame so a host without a form dialog can draw the field the way omp's own
 * screen does (modes/rpc/rpc-types.ts). Older engines send none of these.
 * - `initialIndex`: the row to start on (a radio group's chosen row, a checkbox group's last-touched row).
 * - `selectionMarker`: the rows are a radio group or a checkbox group.
 * - `checkedIndices`: the ticked rows of a checkbox group, in full, on every frame.
 * - `markableCount`: only the leading rows carry a marker; the rest are actions (a checkbox group's Done row).
 */
export interface OmpSelectMarkers {
  initialIndex?: number;
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: number[];
  markableCount?: number;
}

/**
 * omp's rpc-ui extension UI request frames, including the methods missing from
 * the browser-facing union in lib/types.ts (`open_url`, `cancel`). The wrapper
 * adds `expiresAt` when a timeout is present so reconnecting clients can
 * expire stale dialogs.
 */
export type OmpExtensionUiRequest =
  | ({ type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; optionDetails?: OmpSelectOptionDetail[]; timeout?: number; expiresAt?: number } & OmpSelectMarkers)
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; secret?: boolean; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; promptStyle?: boolean; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "ask"; questions: OmpAskQuestion[]; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | { type: "extension_ui_request"; id: string; method: "open_url"; url: string; launchUrl?: string; instructions?: string };

/**
 * omp's RPC host-tool bridge: Cody registers host tools (set_host_tools)
 * that the agent can call; the server emits host_tool_call frames the UI
 * executes, and the UI answers with host_tool_result. Mirrors
 * oh-my-pi modes/rpc/rpc-types.ts.
 */
export interface HostToolParameter {
  type?: string;
  description?: string;
  [key: string]: unknown;
}

export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: "always" | "discoverable" | "explicit";
}

export interface HostToolCallFrame {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface HostToolCancelFrame {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

export interface HostToolResultFrame {
  type: "host_tool_result";
  id: string;
  result: unknown;
  isError?: boolean;
}

/**
 * omp's RPC host-URI bridge: the host registers URL schemes
 * (set_host_uri_schemes) that the agent's read/write tools resolve through
 * the UI; the server emits host_uri_request frames the UI satisfies with
 * host_uri_result. Mirrors oh-my-pi modes/rpc/rpc-types.ts.
 */
export interface HostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export type HostUriOperation = "read" | "write";

export interface HostUriRequestFrame {
  type: "host_uri_request";
  id: string;
  operation: HostUriOperation;
  url: string;
  /** Present for write operations. */
  content?: string;
}

export interface HostUriCancelFrame {
  type: "host_uri_cancel";
  id: string;
  targetId: string;
}

export interface HostUriResultFrame {
  type: "host_uri_result";
  id: string;
  content?: string;
  contentType?: "text/markdown" | "application/json" | "text/plain";
  isError?: boolean;
  error?: string;
}
