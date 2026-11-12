import { getHarness } from "../harness";
import { runOneShotModel } from "../model-plan/one-shot";
import { getOneShotAgentDir } from "../omp/isolated-agent-dir";
import { readModelRoles } from "../omp/model-roles";
import { ownerTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import type { PlanOverlay, PlanOverlaySubtask, PlanOverlayUpdateFrame, TodoAutoUpdateFrame, TodoItem, TodoPhase } from "../pi-types";
import { readPlanKeeperConfig } from "./config";
import { findEvidence, isGatedTask, passesGate, resolveClaimedTask } from "./evidence";
import { checkedTaskKeys, completeTasks, isOpenTask, LABEL_MIN_CHARS, planFoldsToSummarise, planTaskKey, type PlanFoldGroup } from "./fold";
import { emptyPlanOverlay, prunePlanOverlay, readPlanOverlay, writePlanOverlay } from "./overlay";
import { buildPlanKeeperPrompt, MAX_SUBTASKS, parsePlanKeeperAnswer, type PlanKeeperAnswer, type PlanKeeperDigestEntry, type PlanKeeperOpenTask } from "./prompts";

/**
 * Keeps the composer-attached plan LIVE without the main model having to
 * remember to mark tasks done: keeps a rolling log of session activity and,
 * while there is something new in it, asks a cheap model which open tasks
 * that log proves finished, then applies ONLY what its own guards accept.
 *
 * One instance per live rpc-dialect session (lib/rpc-manager.ts owns the
 * lifecycle). Every public `notify*` method is a fire-and-forget entry point:
 * it never throws and the caller never awaits it for correctness. FAIL SOFT
 * is the organizing rule, the same one Distill and the session namer follow:
 * any failure anywhere in a run — a missing binary, an engine no longer
 * knowing a role's model, a timeout, an answer with no JSON in it — means
 * this run applies nothing, not a broken todo list.
 *
 * Three things make a check-off REAL rather than cosmetic:
 *
 *  1. It goes into the engine's own list (`set_todos`), so the agent's next
 *     `todo` call, the engine's reminders and its "unfinished tasks"
 *     continuation all see it.
 *  2. The engine keeps that only in memory: it rebuilds its list from the
 *     session file after every compaction, restart and `rewind`, and what the
 *     keeper wrote is gone. So the check-off is also recorded in Cody's
 *     overlay, and every run starts by putting back whatever the engine lost
 *     (syncEngine) — unless the agent itself reopened the task since, which
 *     its `todo` calls on the wire say exactly (noteAgentTodo).
 *  3. `set_todos` replaces the whole list, so writing a copy read before the
 *     model call would erase what the agent did meanwhile. The keeper reads
 *     the list again right before it writes, changes nothing but the status
 *     of the tasks it is completing, and when the agent's own `todo` call
 *     lands at the same moment it redoes the write on top of that call's
 *     result.
 */

/** The log the model reads: at most this many entries and characters, oldest
 * dropped first. */
const DIGEST_MAX_ENTRIES = 60;
const DIGEST_MAX_CHARS = 16_000;
const DEBOUNCE_MS = 2_000;
/** Between the starts of two model calls while the agent is working. With the
 * debounce and a call that takes 10-20 s, work is checked off well inside a
 * minute of its evidence, and a long busy turn costs two calls a minute, not
 * one per tool. The pass at the end of a turn does not wait for it. */
const MODEL_INTERVAL_MS = 30_000;
/** Generous enough for a cold engine spawn, short enough that a wedged child
 * is abandoned while the answer is still useful (lib/session-namer.ts uses
 * the same reasoning for its own one-shot call). */
const RUN_TIMEOUT_MS = 45_000;
/** How often one write is redone when the agent's own `todo` calls keep
 * landing on top of it. */
const SYNC_ATTEMPTS = 3;
/** The engine answers `set_todos` and reports a `todo` call that ran just
 * before it within milliseconds of each other, in either order. */
const WRITE_RACE_MS = 1_000;
const MAX_PENDING_CALLS = 200;
const MAX_LABELS_PER_RUN = 6;
const MAX_GROUPS_PER_RUN = 3;
/** A label or summary the model did not deliver is asked for once more, then
 * left alone. */
const MAX_ASKS = 2;

/** [head, tail] characters kept of a text too long for the log. The tail is
 * the larger share: a test count, an exit status, a push result and a
 * subagent's verdict are all at the END of their output. */
const REQUEST_CLIP = [160, 60] as const;
const RESULT_CLIP = [160, 440] as const;
/** A whole subagent report: what `wait` returns, and what a background job
 * or a subagent hands back in a hidden message (half of those are under
 * 1,900 characters and so kept whole). */
const REPORT_CLIP = [600, 1_400] as const;
const MESSAGE_CLIP = [300, 700] as const;

/** The hidden messages that are evidence, by the engine's own type name, and
 * whose words they are. */
const HIDDEN_EVIDENCE: Record<string, "job" | "agent"> = {
  "async-result": "job",
  "launch-completion": "job",
  "rewind-report": "agent",
};

// ---------------------------------------------------------------- clock ---

/** Schedules `fn` and returns a cancel function; `fn` may return a promise so
 * a manual test clock can await the work it triggers (production's real
 * setTimeout ignores the return value either way). Same injection shape as
 * lib/message-update-coalescer.ts's FlushScheduler, extended with `now()` for
 * the model-interval rule. */
export interface PlanKeeperClock {
  now(): number;
  schedule(fn: () => void | Promise<void>, ms: number): () => void;
}

const REAL_CLOCK: PlanKeeperClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(() => {
      void fn();
    }, ms);
    return () => clearTimeout(timer);
  },
};

// --------------------------------------------------------------- runner ---

export interface PlanKeeperRunnerInput {
  /** Omitted for the final attempt: the engine resolves its own default. */
  model: string | undefined;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
}

/** One model call. The test seam: every failure is a value, never a throw —
 * same contract as lib/distill/runner.ts's DistillAttempt. */
export type PlanKeeperRunner = (input: PlanKeeperRunnerInput) => Promise<{ text: string | null; error: string | null }>;

function engineRunner(bin: string, timeZone: string, sessionId: string): PlanKeeperRunner {
  return (input) => runOneShotModel({
    bin,
    model: input.model,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    timeZone,
    // The same isolated agent dir Distill and the session namer run in
    // (lib/omp/isolated-agent-dir.ts). Against the real one the child first
    // connects to every MCP server the user has, which alone can outlast
    // RUN_TIMEOUT_MS.
    extraEnv: { PI_CODING_AGENT_DIR: getOneShotAgentDir() },
    usage: { purpose: "plan-keeper", sessionId },
  });
}

export type PlanKeeperEngineState =
  | { status: "ready"; bin: string }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Which engines the keeper can run under at all — the same rule as the
 * session namer and Distill (lib/distill/runner.ts distillEngine()): print
 * mode (`-p --mode=json`) is the rpc dialect's own CLI, and an ACP engine has
 * no equivalent Cody could drive. Those instances hide the feature rather
 * than render it broken.
 */
export function planKeeperEngine(): PlanKeeperEngineState {
  const harness = getHarness();
  if (!harness.rpcUi) {
    return { status: "unsupported", reason: `${harness.displayName} cannot run a one-off model call, so the plan keeper is unavailable on it.` };
  }
  const bin = harness.resolveBinary();
  if (!bin) return { status: "unavailable", reason: `The ${harness.binaryName} binary is not installed.` };
  return { status: "ready", bin };
}

/**
 * omp's smol, then tiny, then the engine's own default with no --model at
 * all — each a fallback for the previous one failing or answering empty.
 * Only omp's config.yml has these roles: lib/session-namer.ts's namerModel
 * follows the exact same rule for `tiny`, and under any other rpc-dialect
 * engine (pi) no selector is passed at all and the engine resolves its
 * default. Cody never invents a model name of its own — see the model roles
 * settings panel for where an operator actually assigns these two roles.
 */
function modelChain(harnessId: string): Array<string | undefined> {
  let roles: Record<string, string> = {};
  if (harnessId === "omp") {
    try {
      roles = readModelRoles().roles;
    } catch {
      // A config.yml that does not parse is the settings UI's problem to
      // report; the keeper just falls back to the engine's own default.
      roles = {};
    }
  }
  const chain: Array<string | undefined> = [];
  const seen = new Set<string>();
  for (const role of ["smol", "tiny"] as const) {
    const model = roles[role]?.trim();
    if (model && !seen.has(model)) {
      chain.push(model);
      seen.add(model);
    }
  }
  chain.push(undefined);
  return chain;
}

// --------------------------------------------------------------- digest ---

/** One line, cut in the MIDDLE when too long. */
function clip(text: string, [head, tail]: readonly [number, number]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= head + tail ? flat : `${flat.slice(0, head)} … ${flat.slice(flat.length - tail)}`;
}

/** The engine's own instructions to the agent inside a tool result: a call it
 * moved to the background, subagents it started. A paragraph each, on one
 * tool result in eleven (2,601 of 29,573 measured in real sessions, 777
 * characters on average) and nothing about the work — the result itself comes
 * later as a hidden message (notifyCustomMessage). Each pattern needs both
 * its opening and its closing words, so a notice a later engine rewords is
 * simply left in. */
const ENGINE_NOTICES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Backgrounded (?:early[^.]*\.\s*Backgrounded )?as job ([^\s;(]+)[\s\S]*?(?:wait to be woken|delivered automatically)\./g, "[moved to the background as $1; its result comes later]"],
  [/Results auto-deliver; NEVER poll\.[\s\S]*?claimed artifacts unverified\.(?:\s*(?:Tip|Coordinate): [^\n]*)*/g, "[results come later]"],
];

/** What a tool was asked to do: `i` is the concise-intent convention every
 * built-in tool follows (an eval cell calls it `title`), and the command or
 * path says the rest ("git push origin main" is evidence the intent line
 * alone is not). Raw args are the fallback for a tool that follows neither. */
function describeRequest(args: unknown): string {
  if (!isRecord(args)) return "";
  const intent = [args.i, args.title].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
  const detail = [args.command, args.path, args.pattern, args.query, args.url].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (intent || detail) return clip([intent, detail].filter(Boolean).join(" · "), REQUEST_CLIP);
  try {
    const raw = JSON.stringify(args) ?? "";
    return raw === "{}" ? "" : clip(raw, REQUEST_CLIP);
  } catch {
    return "";
  }
}

/** A tool result can be a bare string, an MCP-style `{content:[{type:"text",
 * text}]}` block array, a `{text}` object, or anything else a tool chooses to
 * return — this tries the shapes actually seen on the wire before falling
 * back to a raw dump, same spirit as lib/reply-question.ts's block-joining. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result)) {
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) return text;
    }
    if (typeof result.text === "string" && result.text.trim()) return result.text;
  }
  try {
    return JSON.stringify(result) ?? "";
  } catch {
    return String(result);
  }
}

// ----------------------------------------------------------------- todo ---

const TODO_STATUSES: Record<string, true> = { pending: true, in_progress: true, completed: true, blocked: true, abandoned: true };

/** The list inside a `todo` tool result, or null when it is not one. */
function readPhases(value: unknown): TodoPhase[] | null {
  if (!Array.isArray(value)) return null;
  const phases: TodoPhase[] = [];
  for (const phase of value) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks: TodoItem[] = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || typeof task.status !== "string" || !TODO_STATUSES[task.status]) return null;
      tasks.push({
        content: task.content,
        status: task.status as TodoItem["status"],
        ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

function samePhases(left: readonly TodoPhase[], right: readonly TodoPhase[]): boolean {
  return left.length === right.length && left.every((phase, phaseIndex) => {
    const other = right[phaseIndex];
    return phase.name === other.name && phase.tasks.length === other.tasks.length && phase.tasks.every((task, taskIndex) => {
      const twin = other.tasks[taskIndex];
      return task.content === twin.content && task.status === twin.status && (task.blocker ?? null) === (twin.blocker ?? null);
    });
  });
}

const NO_CLAIMS: ReadonlyMap<string, number> = new Map();

// ---------------------------------------------------------------- class ---

export interface PlanKeeperHooks {
  sessionId: string;
  /** Fresh todoPhases for THIS instant — the keeper never caches its own
   * copy, so it always works from what the engine actually holds. */
  getTodoPhases: () => Promise<TodoPhase[]>;
  /** Sends `set_todos` to the engine. Only called when a task's status
   * actually has to change. */
  setTodoPhases: (phases: TodoPhase[]) => Promise<void>;
  /** Pushes a frame to the browser over the session's existing SSE stream. */
  emit: (frame: PlanOverlayUpdateFrame | TodoAutoUpdateFrame) => void;
}

export interface PlanKeeperOptions {
  /** Test seam: replaces the real engine spawn entirely. */
  runner?: PlanKeeperRunner;
  /** Test seam: replaces Date.now()/setTimeout for deterministic cadence tests. */
  clock?: PlanKeeperClock;
}

/** A `tool_execution_start` / `tool_execution_end` frame exactly as the
 * engine sends it (so the caller passes the frame itself, unpicked). Only
 * the end frame carries the result, only the start frame the args. */
export interface PlanKeeperToolFrame {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  result?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}

/** What one model call was asked about. */
interface PlanKeeperRun {
  phases: TodoPhase[];
  open: PlanKeeperOpenTask[];
  digest: PlanKeeperDigestEntry[];
  groups: Array<PlanFoldGroup & { id: string }>;
  labelTargets: PlanKeeperOpenTask[];
}

export class PlanKeeper {
  private readonly hooks: PlanKeeperHooks;
  private readonly runnerOverride: PlanKeeperRunner | undefined;
  private readonly clock: PlanKeeperClock;

  private digest: PlanKeeperDigestEntry[] = [];
  private digestChars = 0;
  /** Number of the newest log entry; never reset. */
  private seq = 0;
  /** The newest log entry a model call has already judged. */
  private judgedSeq = 0;
  /** Args of tool calls still running, by toolCallId: the end frame has none. */
  private readonly callArgs = new Map<string, unknown>();

  /** Counts the agent's own `todo` calls, so a write can tell one landed
   * while it was in flight. */
  private todoEpoch = 0;
  /** The list as the agent's `todo` call left it, when that call raced a
   * keeper write and one of the two may have replaced the other. */
  private rebaseOnto: TodoPhase[] | null = null;
  private settingTodos = false;
  private lastSetAt: number | null = null;
  /** Tasks the AGENT completed, as seen on the wire. The engine loses those
   * too when the agent rewinds past its own `todo` call. */
  private readonly agentDone = new Set<string>();
  /** Per task: the log entry number when it was added or last reopened. Only
   * newer evidence can complete it. */
  private readonly taskSince = new Map<string, number>();
  /** How often a label or a summary has been asked for. */
  private readonly asked = new Map<string, number>();

  private scheduledCancel: (() => void) | null = null;
  private scheduledDueAt = 0;
  private running = false;
  private pendingRerun = false;
  private lastModelCallAt: number | null = null;
  /** The turn has ended with something in the log still unjudged: the next
   * model call does not wait out MODEL_INTERVAL_MS. */
  private turnOver = false;
  /** The log position a failed model call has already been retried for. */
  private retriedSeq = 0;
  private disposed = false;

  constructor(hooks: PlanKeeperHooks, options: PlanKeeperOptions = {}) {
    this.hooks = hooks;
    this.runnerOverride = options.runner;
    this.clock = options.clock ?? REAL_CLOCK;
  }

  private record(entry: Omit<PlanKeeperDigestEntry, "seq" | "at">): void {
    this.seq += 1;
    this.digest.push({ ...entry, seq: this.seq, at: this.clock.now() });
    this.digestChars += entry.text.length;
    while (this.digest.length > DIGEST_MAX_ENTRIES || (this.digestChars > DIGEST_MAX_CHARS && this.digest.length > 1)) {
      const dropped = this.digest.shift();
      if (!dropped) break;
      this.digestChars -= dropped.text.length;
    }
  }

  private recordTool(tool: string, request: string, result: string, failed: boolean): void {
    this.record({ kind: "tool", tool, request, result, failed, text: `${tool}${request ? ` (${request})` : ""} => ${failed ? "FAILED: " : ""}${result}` });
  }

  /** Test/inspection only: never used for a trigger decision. */
  digestSnapshot(): readonly PlanKeeperDigestEntry[] {
    return this.digest;
  }

  notifyToolExecutionStart(frame: PlanKeeperToolFrame): void {
    if (this.disposed || typeof frame.toolCallId !== "string") return;
    this.callArgs.set(frame.toolCallId, frame.args);
    if (this.callArgs.size > MAX_PENDING_CALLS) {
      // A call whose end frame never came (an aborted run) must not pile up.
      for (const stale of this.callArgs.keys()) {
        this.callArgs.delete(stale);
        break;
      }
    }
  }

  notifyToolExecutionEnd(frame: PlanKeeperToolFrame): void {
    if (this.disposed) return;
    const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
    let args = frame.args;
    if (typeof frame.toolCallId === "string") {
      args = this.callArgs.get(frame.toolCallId) ?? args;
      this.callArgs.delete(frame.toolCallId);
    }
    const failed = frame.isError === true;
    if (toolName === "todo") {
      // The agent keeping its own list is not evidence of work, and its text
      // would only teach the model to repeat it. It IS the one place the
      // agent says "this task is not done after all".
      this.noteAgentTodo(args, frame.result, failed);
      this.scheduleRun(this.rebaseOnto ? 0 : DEBOUNCE_MS, this.rebaseOnto !== null);
      return;
    }
    const report = toolName === "wait" || toolName === "task";
    let result = resultText(frame.result);
    for (const [notice, short] of ENGINE_NOTICES) result = result.replace(notice, short);
    this.recordTool(toolName, describeRequest(args), clip(result, report ? REPORT_CLIP : RESULT_CLIP), failed);
    this.scheduleRun();
  }

  /** The hidden messages that carry evidence: a background job or a subagent
   * reporting back, a supervised process exiting, the report the agent keeps
   * from an exploration it rewound. The engine delivers those as messages,
   * not as tool results, and they are exactly the "it finished, here is what
   * came out" a task waits on. Every other hidden message (reminders,
   * notices, the clock) is noise. */
  notifyCustomMessage(message: unknown): void {
    if (this.disposed || !isRecord(message) || message.role !== "custom" || typeof message.customType !== "string") return;
    // Compared, not just looked up: a type named like an Object member is not in the table.
    const source = HIDDEN_EVIDENCE[message.customType];
    if (source !== "job" && source !== "agent") return;
    const text = resultText(typeof message.content === "string" ? message.content : { content: message.content });
    if (!text.trim()) return;
    if (source === "agent") {
      this.record({ kind: "message", text: clip(text, MESSAGE_CLIP) });
    } else {
      // Several jobs can report back in one message. Each is its own piece
      // of evidence, with its own number for the model to cite.
      const jobs = text.split(/(?=── Job )/);
      for (const job of jobs) {
        if (jobs.length === 1 || job.startsWith("── Job ")) this.recordTool("background job", "", clip(job, REPORT_CLIP), false);
      }
    }
    this.scheduleRun();
  }

  notifySubagentTerminal(info: { agent?: string; description?: string; status: string }): void {
    if (this.disposed) return;
    const task = info.description?.trim() || info.agent || "subagent";
    this.record({ kind: "subagent", text: `${clip(task, RESULT_CLIP)} => ${info.status}` });
    this.scheduleRun();
  }

  notifyMessageEnd(text: string): void {
    if (this.disposed || !text.trim()) return;
    this.record({ kind: "message", text: clip(text, MESSAGE_CLIP) });
    this.scheduleRun();
  }

  notifyTurnEnd(): void {
    this.scheduleRun();
  }

  /** A turn starting, or a compaction finishing: the engine may have rebuilt
   * its list from the session file since the keeper last looked (a restart
   * or a rewind between turns, the compaction itself), and the agent is about
   * to work from it. No debounce — the check-offs go back before the agent's
   * next `todo` call reads a list that says the work is still open. */
  notifyListRebuilt(): void {
    this.turnOver = false;
    this.scheduleRun(0, true);
  }

  /** The turn is over, which is when the list gets read. Waits for neither
   * the debounce nor the interval between model calls: nothing more is coming
   * to batch with, and the agent's last words ("all three are done") are
   * evidence like any other. Still never concurrent with a run in flight, and
   * still one call per turn end at most. Returns the run so a caller that
   * needs to (tests) can await it; production fires it and forgets. */
  notifyTerminalAgentEnd(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.turnOver = true;
    this.scheduledCancel?.();
    this.scheduledCancel = null;
    return this.fire();
  }

  /** Cancels a pending timer. An in-flight run is left to finish — its own
   * hooks already reject harmlessly once the session is torn down. */
  dispose(): void {
    this.disposed = true;
    this.scheduledCancel?.();
    this.scheduledCancel = null;
  }

  /** One timer at a time. A trigger while one is pending rides along with it;
   * only an `urgent` one (a write that may have been replaced) pulls it
   * forward. */
  private scheduleRun(delay: number = DEBOUNCE_MS, urgent = false): void {
    if (this.disposed) return;
    const dueAt = this.clock.now() + delay;
    if (this.scheduledCancel) {
      if (!urgent || this.scheduledDueAt <= dueAt) return;
      this.scheduledCancel();
    }
    this.scheduledDueAt = dueAt;
    this.scheduledCancel = this.clock.schedule(() => {
      this.scheduledCancel = null;
      return this.fire();
    }, delay);
  }

  /** Never concurrent: a trigger while a run is in flight is remembered and
   * re-scheduled once it finishes, instead of running alongside it. */
  private async fire(): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.pendingRerun = true;
      return;
    }
    this.running = true;
    try {
      await this.runNow();
    } catch (error) {
      // Fail soft: a keeper failure changes nothing. A debug line (never
      // warn/error — this is a background convenience, not an incident)
      // means an operator chasing "why didn't my plan update" can still
      // find out why, without the failure ever surfacing to the session.
      console.debug("[plan-keeper] run failed, applying nothing:", error);
    } finally {
      this.running = false;
      if (this.pendingRerun) {
        this.pendingRerun = false;
        this.scheduleRun();
      }
    }
  }

  /**
   * The agent's own `todo` call, read off the wire. Its result is the whole
   * list as the agent left it, which settles three things no later guess
   * could: which tasks the agent itself decided are NOT done (so Cody stops
   * holding a check-off for them), which ones it completed (so a later
   * rebuild of the engine's list cannot quietly undo that), and from which
   * point in the log a new or reopened task may be proven.
   *
   * Runs even while the keeper is switched off: an overlay that still claims
   * a task the agent reopened would show it finished.
   */
  private noteAgentTodo(args: unknown, result: unknown, failed: boolean): void {
    const details = isRecord(result) && isRecord(result.details) ? result.details : null;
    const phases = details ? readPhases(details.phases) : null;
    const op = typeof details?.op === "string" ? details.op : null;
    if (failed || !phases || op === "view") return;

    this.todoEpoch += 1;
    if (this.settingTodos || (this.lastSetAt !== null && this.clock.now() - this.lastSetAt < WRITE_RACE_MS)) this.rebaseOnto = phases;

    const request = isRecord(args) ? args : {};
    const named = typeof request.task === "string" ? request.task : null;
    const status = new Map<string, TodoItem["status"]>();
    const contents = new Set<string>();
    let started: string | null = null;
    for (const phase of phases) {
      for (const task of phase.tasks) {
        const key = planTaskKey(phase.name, task.content);
        status.set(key, task.status);
        contents.add(task.content);
        if (task.status === "in_progress") started = key;
      }
    }
    const appended = new Set<string>();
    if (op === "append" && typeof request.phase === "string" && Array.isArray(request.items)) {
      for (const item of request.items) if (typeof item === "string") appended.add(planTaskKey(request.phase, item));
    }
    // The agent itself just said this task is not done: a new plan, the task
    // removed or dropped, the task named by an op that left it open (`start`
    // is how a finished task is reopened), or the same text added again as
    // new work. A task that is merely open in this result is NOT that — the
    // engine may simply have lost the check-off before the agent's call.
    const withdrawn = (entry: string): boolean => {
      if (op === "init") return true;
      const cut = entry.indexOf("\u0000");
      const content = cut === -1 ? entry : entry.slice(cut + 1);
      if (cut === -1) return !contents.has(content) || named === content;
      const now = status.get(entry);
      if (now === undefined || now === "abandoned" || appended.has(entry)) return true;
      return now !== "completed" && (named === null ? op === "start" && started === entry : named === content);
    };

    const reopened = new Set<string>();
    const overlay = readPlanOverlay(this.hooks.sessionId);
    if (overlay) {
      const kept = overlay.autoCompleted.filter((entry) => {
        if (!withdrawn(entry)) return true;
        reopened.add(entry);
        return false;
      });
      if (kept.length !== overlay.autoCompleted.length) {
        const next: PlanOverlay = { ...overlay, autoCompleted: kept, updatedAt: this.clock.now() };
        writePlanOverlay(this.hooks.sessionId, next);
        this.hooks.emit({ type: "plan_overlay_update", overlay: next });
      }
    }
    for (const key of [...this.agentDone]) {
      if (!withdrawn(key)) continue;
      reopened.add(key);
      this.agentDone.delete(key);
    }

    if (op === "init") this.taskSince.clear();
    for (const key of [...this.taskSince.keys()]) if (!status.has(key)) this.taskSince.delete(key);
    for (const [key, now] of status) {
      if (now === "completed") this.agentDone.add(key);
      if (!this.taskSince.has(key) || reopened.has(key)) this.taskSince.set(key, this.seq);
    }
  }

  /**
   * Make the engine's list hold every check-off Cody has for it: the ones in
   * the overlay, the agent's own completions seen on the wire, and `claims`
   * (task key -> the log entry that proved it) from the model call that just
   * returned. Reads the list fresh, changes nothing but the status of those
   * tasks, and writes only when something has to change — so on a quiet list
   * this is one read.
   *
   * `set_todos` replaces the engine's whole list. When the agent's own
   * `todo` call lands around the same moment, whichever was applied second
   * erased the other; the agent's result (rebaseOnto) is then the list to
   * build on, and the write is redone on top of it.
   */
  private async syncEngine(claims: ReadonlyMap<string, number>): Promise<{ phases: TodoPhase[]; changed: boolean; checked: string[] }> {
    const checked = new Set<string>();
    let changed = false;
    let phases: TodoPhase[] = [];
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
      const epoch = this.todoEpoch;
      const memory = await this.hooks.getTodoPhases();
      if (this.todoEpoch !== epoch) continue; // the agent changed the list during the read: read again.
      const base = this.rebaseOnto;
      this.rebaseOnto = null;

      const wanted = new Set([...checkedTaskKeys(readPlanOverlay(this.hooks.sessionId)), ...this.agentDone]);
      for (const [key, evidenceSeq] of claims) {
        // Proof older than the task itself (or than the agent reopening it)
        // is proof of something else.
        if (evidenceSeq > (this.taskSince.get(key) ?? 0)) wanted.add(key);
      }
      const target = completeTasks(base ?? memory, wanted);
      phases = target.phases;
      if (base ? samePhases(memory, target.phases) : target.completed.length === 0) break;

      const wasOpen = new Set<string>();
      for (const phase of memory) {
        for (const task of phase.tasks) if (isOpenTask(task)) wasOpen.add(planTaskKey(phase.name, task.content));
      }
      this.settingTodos = true;
      try {
        await this.hooks.setTodoPhases(target.phases);
      } finally {
        this.settingTodos = false;
      }
      this.lastSetAt = this.clock.now();
      changed = true;
      for (const key of target.completed) if (claims.has(key) && wasOpen.has(key)) checked.add(key);
      if (this.todoEpoch === epoch) break;
    }
    return { phases, changed, checked: [...checked] };
  }

  private async callModel(systemPrompt: string, prompt: string): Promise<string | null> {
    const harnessId = getHarness().id;
    let runner = this.runnerOverride;
    if (!runner) {
      const engine = planKeeperEngine();
      if (engine.status !== "ready") return null;
      runner = engineRunner(engine.bin, ownerTimeZone(this.hooks.sessionId), this.hooks.sessionId);
    }
    for (const model of modelChain(harnessId)) {
      const result = await runner({ model, systemPrompt, prompt, timeoutMs: RUN_TIMEOUT_MS });
      if (result.text?.trim()) return result.text;
    }
    return null;
  }

  private async runNow(): Promise<void> {
    if (this.disposed || !readPlanKeeperConfig().enabled) return;

    // First, and on every run: put back what the engine lost.
    const synced = await this.syncEngine(NO_CLAIMS);
    if (synced.changed) this.hooks.emit({ type: "todo_auto_update" });
    const phases = synced.phases;

    const open: PlanKeeperOpenTask[] = [];
    for (const phase of phases) {
      for (const task of phase.tasks) {
        const key = planTaskKey(phase.name, task.content);
        // Already on the list when the keeper first looked, so the whole log may prove it.
        if (!this.taskSince.has(key)) this.taskSince.set(key, 0);
        if (isOpenTask(task)) open.push({ id: `T${open.length + 1}`, key, phase: phase.name, task });
      }
    }
    const overlay = readPlanOverlay(this.hooks.sessionId) ?? emptyPlanOverlay();
    const groups = planFoldsToSummarise(phases, overlay)
      .filter((group) => (this.asked.get(`${group.key}\u0000${group.tasks.length}`) ?? 0) < MAX_ASKS)
      .slice(0, MAX_GROUPS_PER_RUN)
      .map((group, index) => ({ ...group, id: `G${index + 1}` }));

    // Nothing new in the log means the model would only repeat its last
    // answer. A finished group still waiting for its summary is worth a call
    // of its own, or a plan that just finished would keep its bare counts.
    const judging = open.length > 0 && this.seq > this.judgedSeq;
    if (!judging && groups.length === 0) return;

    const wait = this.turnOver || this.lastModelCallAt === null ? 0 : MODEL_INTERVAL_MS - (this.clock.now() - this.lastModelCallAt);
    if (wait > 0) {
      this.scheduleRun(wait);
      return;
    }
    this.turnOver = false;
    this.lastModelCallAt = this.clock.now();

    const labelTargets = judging
      ? open
        .filter((item) => item.task.content.length > LABEL_MIN_CHARS && !overlay.labels[item.task.content] && (this.asked.get(item.task.content) ?? 0) < MAX_ASKS)
        .slice(0, MAX_LABELS_PER_RUN)
      : [];
    for (const key of [...groups.map((group) => `${group.key}\u0000${group.tasks.length}`), ...labelTargets.map((item) => item.task.content)]) {
      this.asked.set(key, (this.asked.get(key) ?? 0) + 1);
    }
    const run: PlanKeeperRun = { phases, open: judging ? open : [], digest: judging ? [...this.digest] : [], groups, labelTargets };
    const upTo = this.seq;
    const { systemPrompt, prompt } = buildPlanKeeperPrompt({
      open: run.open,
      subtasks: overlay.subtasks,
      labelIds: labelTargets.map((item) => item.id),
      groups,
      digest: run.digest,
    });

    const answerText = await this.callModel(systemPrompt, prompt);
    const answer = answerText ? parsePlanKeeperAnswer(answerText) : null;
    if (!answer) {
      // Every attempt in the chain failed, or answered without JSON. The last
      // pass of a turn has nothing after it that would try again, so this log
      // gets ONE more try; after that it waits for new activity.
      if (this.retriedSeq !== upTo) {
        this.retriedSeq = upTo;
        this.scheduleRun(MODEL_INTERVAL_MS);
      }
      return;
    }

    await this.apply(run, answer);
    // Only once applied: a write the engine refused must not cost the
    // evidence its hearing.
    if (judging) this.judgedSeq = upTo;
  }

  private async apply(run: PlanKeeperRun, answer: PlanKeeperAnswer): Promise<void> {
    // A check-off counts only when it names an open task, quotes words that
    // really are in the log and, for a task with its own acceptance bar, that
    // entry shows the bar met.
    const claims = new Map<string, number>();
    const named = new Set<string>();
    for (const claim of answer.done) {
      const target = resolveClaimedTask(claim.ref, run.open);
      if (!target) continue;
      named.add(target.key);
      const evidence = findEvidence(claim, run.digest);
      if (!evidence) continue;
      if (isGatedTask(target.task.content) && !passesGate(evidence, run.digest)) continue;
      claims.set(target.key, Math.max(evidence.seq, claims.get(target.key) ?? 0));
    }
    const synced = claims.size > 0 ? await this.syncEngine(claims) : null;

    const overlay = readPlanOverlay(this.hooks.sessionId) ?? emptyPlanOverlay();
    const next: PlanOverlay = {
      subtasks: { ...overlay.subtasks },
      autoCompleted: [...overlay.autoCompleted],
      labels: { ...overlay.labels },
      folds: { ...overlay.folds },
      updatedAt: this.clock.now(),
    };
    let touched = false;

    for (const key of synced?.checked ?? []) {
      if (next.autoCompleted.includes(key)) continue;
      next.autoCompleted.push(key);
      touched = true;
    }

    // Subtasks belong to the ONE task in progress, and only while the model
    // is not also calling that task finished.
    const inProgress = run.open.find((item) => item.task.status === "in_progress");
    if (inProgress && !named.has(inProgress.key)) {
      const content = inProgress.task.content;
      const existing = next.subtasks[content] ?? [];
      const have = new Set(existing.map((subtask) => subtask.content));
      const added: PlanOverlaySubtask[] = [];
      for (const [ref, items] of Object.entries(answer.subtasks)) {
        if (resolveClaimedTask(ref, run.open) !== inProgress) continue;
        for (const item of items) {
          if (have.has(item)) continue;
          have.add(item);
          added.push({ content: item, status: "pending" });
        }
      }
      const finished = new Set(answer.subtasksDone);
      const list = [...existing, ...added].slice(0, MAX_SUBTASKS);
      let subtasksTouched = list.length > existing.length;
      const marked = list.map((subtask): PlanOverlaySubtask => {
        if (subtask.status === "completed" || !finished.has(subtask.content)) return subtask;
        subtasksTouched = true;
        return { ...subtask, status: "completed" };
      });
      if (subtasksTouched) {
        next.subtasks[content] = marked;
        touched = true;
      }
    }

    for (const [ref, label] of Object.entries(answer.labels)) {
      const target = resolveClaimedTask(ref, run.labelTargets);
      // A label that is no shorter than the text it stands for is not one.
      if (!target || label.length >= target.task.content.length) continue;
      next.labels[target.task.content] = label;
      touched = true;
    }

    const summaries = new Map(Object.entries(answer.summaries).map(([id, summary]) => [id.toUpperCase(), summary]));
    for (const group of run.groups) {
      const summary = summaries.get(group.id);
      if (!summary) continue;
      next.folds[group.key] = { summary, count: group.tasks.length };
      touched = true;
    }

    if (touched) {
      const pruned = prunePlanOverlay(next, synced?.phases ?? run.phases);
      writePlanOverlay(this.hooks.sessionId, pruned);
      this.hooks.emit({ type: "plan_overlay_update", overlay: pruned });
    }
    if (synced?.changed) {
      // Only when set_todos actually ran: a subtask, label or summary change
      // has no new todoPhases for the browser to refetch.
      this.hooks.emit({ type: "todo_auto_update" });
      // What was just checked off may have completed a group that now wants
      // its summary, and a session going quiet has no later trigger for it.
      this.scheduleRun();
    }
  }
}
