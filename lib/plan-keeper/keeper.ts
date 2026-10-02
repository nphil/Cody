import { getHarness } from "../harness";
import { runOneShotModel } from "../model-plan/one-shot";
import { readModelRoles } from "../omp/model-roles";
import { ownerTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import type { PlanOverlay, PlanOverlaySubtask, PlanOverlayUpdateFrame, TodoAutoUpdateFrame, TodoItem, TodoPhase } from "../pi-types";
import { readPlanKeeperConfig } from "./config";
import { emptyPlanOverlay, prunePlanOverlay, readPlanOverlay, writePlanOverlay } from "./overlay";
import { buildPlanKeeperPrompt, MAX_SUBTASKS, parsePlanKeeperAnswer, type PlanKeeperAnswer, type PlanKeeperDigestEntry } from "./prompts";

/**
 * Keeps the composer-attached plan LIVE without the main model having to
 * remember to mark tasks done: watches a rolling digest of session activity
 * and, on a handful of triggers, asks a cheap model what changed, then
 * applies ONLY what its own guards accept.
 *
 * One instance per live rpc-dialect session (lib/rpc-manager.ts owns the
 * lifecycle). Every public `notify*` method is a fire-and-forget entry point:
 * it never throws and the caller never awaits it for correctness — digest
 * recording is synchronous, and the eventual model call/apply is fully
 * internal. FAIL SOFT is the organizing rule, the same one Distill and the
 * session namer follow: any failure anywhere in a run — a missing binary, an
 * engine no longer knowing a role's model, a timeout, an answer with no JSON
 * in it — means this run applies nothing, not a broken todo list.
 */

const DIGEST_CAP = 40;
const DEBOUNCE_MS = 2_000;
const MIN_INTERVAL_MS = 10_000;
const TOOL_TRIGGER_EVERY = 4;
/** Generous enough for a cold engine spawn, short enough that a wedged child
 * is abandoned while the answer is still useful (lib/session-namer.ts uses
 * the same reasoning for its own one-shot call). */
const RUN_TIMEOUT_MS = 45_000;
const MAX_ARGS_CHARS = 120;
const MAX_RESULT_CHARS = 240;
const MAX_MESSAGE_CHARS = 400;

// ---------------------------------------------------------------- clock ---

/** Schedules `fn` and returns a cancel function; `fn` may return a promise so
 * a manual test clock can await the work it triggers (production's real
 * setTimeout ignores the return value either way). Same injection shape as
 * lib/message-update-coalescer.ts's FlushScheduler, extended with `now()` for
 * the min-interval rule. */
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

function engineRunner(bin: string, timeZone: string): PlanKeeperRunner {
  return (input) => runOneShotModel({
    bin,
    model: input.model,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    timeZone,
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

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** `args.i` is the concise-intent convention every built-in tool follows
 * (bash, read, write, edit, …); falling back to the raw args keeps a digest
 * entry for tools that predate or skip that convention. */
function summarizeArgs(args: unknown): string {
  if (isRecord(args) && typeof args.i === "string" && args.i.trim()) return truncate(args.i, MAX_ARGS_CHARS);
  try {
    return truncate(JSON.stringify(args) ?? "", MAX_ARGS_CHARS);
  } catch {
    return "";
  }
}

/** A tool result can be a bare string, an MCP-style `{content:[{type:"text",
 * text}]}` block array, a `{text}` object, or anything else a tool chooses to
 * return — this tries the shapes actually seen on the wire before falling
 * back to a raw dump, same spirit as lib/reply-question.ts's block-joining. */
function summarizeResult(result: unknown): string {
  if (typeof result === "string") return truncate(result, MAX_RESULT_CHARS);
  if (isRecord(result)) {
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) return truncate(text, MAX_RESULT_CHARS);
    }
    if (typeof result.text === "string" && result.text.trim()) return truncate(result.text, MAX_RESULT_CHARS);
  }
  try {
    return truncate(JSON.stringify(result) ?? "", MAX_RESULT_CHARS);
  } catch {
    return truncate(String(result), MAX_RESULT_CHARS);
  }
}

function findInProgress(phases: readonly TodoPhase[]): TodoItem | null {
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "in_progress") return task;
    }
  }
  return null;
}

// -------------------------------------------------------------- guards ---

const GATED_KEYWORDS = ["verify", "test", "gate", "publish", "release"];

/** A task naming its own acceptance bar (verify/test/gate/publish/release)
 * needs corroborating evidence before the keeper marks it done — see
 * hasPassingEvidence. Substring match on purpose: it also catches
 * "verification", "testing", "gated", "publishing", "released". */
function isGatedTask(content: string): boolean {
  const lower = content.toLowerCase();
  return GATED_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** Stripped out before the failure check runs: "0 failed", "0 errors", "no
 * failures" are PASSING phrasing that happens to contain the word "failed"
 * or "error" — the single most common false positive a naive scan hits. Uses
 * `.replace()` only (never `.test()`/`.exec()` on this object), so the
 * global flag's lastIndex statefulness never leaks between calls. */
const ZERO_COUNT_RE = /\b(?:0|no)\s+(?:failed|failing|failures?|errors?)\b/gi;
const FAIL_EVIDENCE_RE = /\b(?:failed|failing|failure|error|errors|broken)\b/i;
const PASS_EVIDENCE_RE = /\b(?:passed|passing|succeeded|success(?:ful)?|green|0\s+failing|no\s+failures?)\b/i;
const PUSH_EVIDENCE_RE = /\b(?:pushed|published|released|deployed|shipped|tagged)\b/i;

/**
 * A gated task is completed only when the digest shows a passing result (for
 * verify/test/gate) or a push/release actually happening (for
 * publish/release) — never on the model's say-so alone. A failure signal
 * anywhere in the digest wins over a pass/push signal: a mixed digest (ran
 * once, it failed, more work happened since) must not read as evidence, and
 * the safe failure mode here is under-completing, never over-completing.
 */
function hasPassingEvidence(digestText: string): boolean {
  if (FAIL_EVIDENCE_RE.test(digestText.replace(ZERO_COUNT_RE, ""))) return false;
  return PASS_EVIDENCE_RE.test(digestText) || PUSH_EVIDENCE_RE.test(digestText);
}

// ---------------------------------------------------------------- class ---

export interface PlanKeeperHooks {
  sessionId: string;
  /** Fresh todoPhases for THIS instant — the keeper never caches its own
   * copy, so it always diffs against what the engine actually holds. */
  getTodoPhases: () => Promise<TodoPhase[]>;
  /** Sends `set_todos` to the engine. Only called when a completion or a
   * promotion actually changed a top-level task's status. */
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

export class PlanKeeper {
  private readonly hooks: PlanKeeperHooks;
  private readonly runnerOverride: PlanKeeperRunner | undefined;
  private readonly clock: PlanKeeperClock;

  private digest: PlanKeeperDigestEntry[] = [];
  private toolEndCount = 0;
  private scheduledCancel: (() => void) | null = null;
  private running = false;
  private pendingRerun = false;
  private lastRunStartedAt: number | null = null;
  private disposed = false;

  constructor(hooks: PlanKeeperHooks, options: PlanKeeperOptions = {}) {
    this.hooks = hooks;
    this.runnerOverride = options.runner;
    this.clock = options.clock ?? REAL_CLOCK;
  }

  private pushDigest(entry: PlanKeeperDigestEntry): void {
    this.digest.push(entry);
    if (this.digest.length > DIGEST_CAP) this.digest.splice(0, this.digest.length - DIGEST_CAP);
  }

  /** Test/inspection only: never used for a trigger decision. */
  digestSnapshot(): readonly PlanKeeperDigestEntry[] {
    return this.digest;
  }

  notifyToolExecutionEnd(toolName: string, args: unknown, result: unknown): void {
    if (this.disposed) return;
    this.pushDigest({ kind: "tool", at: this.clock.now(), text: `${toolName}: ${summarizeArgs(args)} -> ${summarizeResult(result)}` });
    this.toolEndCount += 1;
    if (this.toolEndCount % TOOL_TRIGGER_EVERY === 0) this.scheduleRun();
  }

  notifySubagentTerminal(info: { agent?: string; description?: string; status: string }): void {
    if (this.disposed) return;
    const task = info.description?.trim() || info.agent || "subagent";
    this.pushDigest({ kind: "subagent", at: this.clock.now(), text: `${truncate(task, MAX_RESULT_CHARS)} -> ${info.status}` });
    this.scheduleRun();
  }

  notifyMessageEnd(text: string): void {
    if (this.disposed) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.pushDigest({ kind: "message", at: this.clock.now(), text: truncate(trimmed, MAX_MESSAGE_CHARS) });
  }

  notifyTurnEnd(): void {
    if (this.disposed) return;
    this.pushDigest({ kind: "turn_end", at: this.clock.now() });
    this.scheduleRun();
  }

  /** The last chance before the session may go idle. Bypasses the debounce
   * (there is no more activity left to batch with) but still goes through
   * the same running/min-interval coalesce as every other trigger. Returns
   * the run so a caller that needs to (tests) can await it; production fires
   * it and forgets. */
  notifyTerminalAgentEnd(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pushDigest({ kind: "turn_end", at: this.clock.now() });
    this.scheduledCancel?.();
    this.scheduledCancel = null;
    return this.fire();
  }

  /** Cancels a pending debounce timer. An in-flight run is left to finish —
   * its own hooks already reject harmlessly once the session is torn down. */
  dispose(): void {
    this.disposed = true;
    this.scheduledCancel?.();
    this.scheduledCancel = null;
  }

  private scheduleRun(): void {
    if (this.disposed || this.scheduledCancel) return;
    this.scheduledCancel = this.clock.schedule(() => {
      this.scheduledCancel = null;
      return this.fire();
    }, DEBOUNCE_MS);
  }

  /** Never concurrent: a trigger while a run is in flight is remembered and
   * re-scheduled once it finishes, instead of running alongside it. */
  private async fire(): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.pendingRerun = true;
      return;
    }
    const now = this.clock.now();
    if (this.lastRunStartedAt !== null) {
      const elapsed = now - this.lastRunStartedAt;
      if (elapsed < MIN_INTERVAL_MS) {
        this.scheduledCancel?.();
        this.scheduledCancel = this.clock.schedule(() => {
          this.scheduledCancel = null;
          return this.fire();
        }, MIN_INTERVAL_MS - elapsed);
        return;
      }
    }
    this.running = true;
    this.lastRunStartedAt = now;
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

  private async callModel(systemPrompt: string, prompt: string): Promise<string | null> {
    const harnessId = getHarness().id;
    let runner = this.runnerOverride;
    if (!runner) {
      const engine = planKeeperEngine();
      if (engine.status !== "ready") return null;
      runner = engineRunner(engine.bin, ownerTimeZone(this.hooks.sessionId));
    }
    for (const model of modelChain(harnessId)) {
      const result = await runner({ model, systemPrompt, prompt, timeoutMs: RUN_TIMEOUT_MS });
      if (result.text?.trim()) return result.text;
    }
    return null;
  }

  private async runNow(): Promise<void> {
    if (this.disposed || !readPlanKeeperConfig().enabled) return;

    const phases = await this.hooks.getTodoPhases();
    const hasOpenTasks = phases.some((phase) => phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"));
    if (!hasOpenTasks) return;

    const overlay = readPlanOverlay(this.hooks.sessionId) ?? emptyPlanOverlay();
    const inProgress = findInProgress(phases);
    const { systemPrompt, prompt } = buildPlanKeeperPrompt(phases, overlay, this.digest);

    const answerText = await this.callModel(systemPrompt, prompt);
    if (!answerText) return; // every attempt in the chain failed or was empty.

    const answer = parsePlanKeeperAnswer(answerText);
    if (!answer) return;

    await this.apply(phases, overlay, inProgress, answer);
  }

  private async apply(phases: TodoPhase[], overlay: PlanOverlay, inProgress: TodoItem | null, answer: PlanKeeperAnswer): Promise<void> {
    const digestText = this.digest.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
    const evidenced = hasPassingEvidence(digestText);
    const completedSet = new Set(answer.completed);
    const newlyCompleted: string[] = [];

    const nextPhases: TodoPhase[] = phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task): TodoItem => {
        const eligible = task.status === "pending" || task.status === "in_progress";
        if (!eligible || !completedSet.has(task.content)) return task;
        if (isGatedTask(task.content) && !evidenced) return task; // guard: no evidence, no completion.
        newlyCompleted.push(task.content);
        return { ...task, status: "completed" };
      }),
    }));

    let promoted = false;
    if (!nextPhases.some((phase) => phase.tasks.some((task) => task.status === "in_progress"))) {
      outer: for (const phase of nextPhases) {
        for (let index = 0; index < phase.tasks.length; index += 1) {
          if (phase.tasks[index].status === "pending") {
            phase.tasks[index] = { ...phase.tasks[index], status: "in_progress" };
            promoted = true;
            break outer;
          }
        }
      }
    }

    const overlaySubtasks = { ...overlay.subtasks };
    let subtasksTouched = false;
    if (inProgress && !completedSet.has(inProgress.content)) {
      const proposed = answer.subtasks[inProgress.content] ?? [];
      const existing = overlaySubtasks[inProgress.content] ?? [];
      if (proposed.length > 0 && existing.length < MAX_SUBTASKS) {
        const existingContents = new Set(existing.map((subtask) => subtask.content));
        const added: PlanOverlaySubtask[] = proposed
          .filter((content) => !existingContents.has(content))
          .map((content) => ({ content, status: "pending" }));
        if (added.length > 0) {
          overlaySubtasks[inProgress.content] = [...existing, ...added].slice(0, MAX_SUBTASKS);
          subtasksTouched = true;
        }
      }
      if (answer.subtasksCompleted.length > 0) {
        const list = overlaySubtasks[inProgress.content];
        if (list) {
          const done = new Set(answer.subtasksCompleted);
          const nextList = list.map((subtask): PlanOverlaySubtask => (done.has(subtask.content) && subtask.status !== "completed" ? { ...subtask, status: "completed" } : subtask));
          if (nextList.some((subtask, index) => subtask.status !== list[index].status)) {
            overlaySubtasks[inProgress.content] = nextList;
            subtasksTouched = true;
          }
        }
      }
    }

    const phasesChanged = newlyCompleted.length > 0 || promoted;
    if (!phasesChanged && !subtasksTouched) return; // nothing the digest evidenced: no commit, no frames.

    const liveContents = new Set(nextPhases.flatMap((phase) => phase.tasks.map((task) => task.content)));
    const nextOverlay = prunePlanOverlay(
      { subtasks: overlaySubtasks, autoCompleted: [...overlay.autoCompleted, ...newlyCompleted], updatedAt: this.clock.now() },
      liveContents,
    );

    if (phasesChanged) await this.hooks.setTodoPhases(nextPhases);
    writePlanOverlay(this.hooks.sessionId, nextOverlay);
    this.hooks.emit({ type: "plan_overlay_update", overlay: nextOverlay });
    // Only when set_todos actually ran: a subtask-only change has no new
    // todoPhases for the browser to refetch, and plan_overlay_update above
    // already carries the subtask change directly.
    if (phasesChanged) this.hooks.emit({ type: "todo_auto_update" });
  }
}
