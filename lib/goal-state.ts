/**
 * Native goal mode (omp 18.4.11+), as Cody's browser sees it.
 *
 * The engine owns the goal: it creates it, counts the tokens and seconds spent
 * on it, pauses it when you press Stop, and writes it into the session file.
 * Cody only mirrors that state, so everything here is a pure reading of what
 * the engine reported — three carriers that all use the same shape:
 *
 *   - `get_state.goal` (always present on 18.4.11+, `null` when there is none;
 *     ABSENT on an older omp, pi and the ACP engines — absence is the
 *     capability probe, never "no goal");
 *   - the `goal_updated` frame (`{goal, state}`, on every change);
 *   - the `{goal, state}` answer of the `goal` command.
 *
 * Beyond the shared type guards nothing here imports anything at runtime:
 * `lib/rpc-manager.ts` (loaded by the server wrapper), the session reader and
 * the browser all share it.
 */

import { asCount, isRecord } from "./type-guards";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

/** omp's `Goal`, minus nothing: the fields are exactly the engine's. */
export interface EngineGoal {
  id: string;
  objective: string;
  status: GoalStatus;
  /** Absent: no budget. */
  tokenBudget?: number;
  /** Input + output + cache-write tokens spent while the goal was running. */
  tokensUsed: number;
  /** Whole seconds the goal was active (idle gaps count, paused time does not). */
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** omp's `GoalModeState`. `enabled` is true while the goal is being worked
 * (`active`, and `budget-limited` until it is dropped); `mode: "exiting"` marks
 * the one moment between "the agent called complete" and the engine clearing
 * the state at the end of that turn. */
export interface GoalModeState {
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  goal: EngineGoal;
}

export type GoalOp = "get" | "create" | "resume" | "pause" | "drop";

/** A goal on screen: the engine's state plus when we learned it. */
export interface GoalView {
  state: GoalModeState;
  /** Client clock (ms) at which this snapshot was adopted. */
  receivedAt: number;
  /** How stale the engine's own time accounting already was at that moment. */
  ageMs: number;
}

const GOAL_STATUS: Record<GoalStatus, true> = { active: true, paused: true, "budget-limited": true, complete: true, dropped: true };

/** True while the engine is counting this goal's time: a paused, finished or
 * dropped goal costs nothing. */
export function isAccountingStatus(status: GoalStatus): boolean {
  return status === "active" || status === "budget-limited";
}

/** Read one goal; anything that is not shaped like the engine's is no goal. */
export function parseGoal(raw: unknown): EngineGoal | null {
  if (!isRecord(raw)) return null;
  const { id, objective, status, tokenBudget } = raw;
  if (typeof id !== "string" || typeof objective !== "string" || typeof status !== "string" || !Object.hasOwn(GOAL_STATUS, status)) return null;
  const goal: EngineGoal = {
    id,
    objective,
    status: status as GoalStatus,
    tokensUsed: asCount(raw.tokensUsed),
    timeUsedSeconds: asCount(raw.timeUsedSeconds),
    createdAt: asCount(raw.createdAt),
    updatedAt: asCount(raw.updatedAt),
  };
  if (typeof tokenBudget === "number" && Number.isInteger(tokenBudget) && tokenBudget > 0) goal.tokenBudget = tokenBudget;
  return goal;
}

/** Read the engine's `GoalModeState`; `null` for none or for anything malformed. */
export function parseGoalModeState(raw: unknown): GoalModeState | null {
  if (!isRecord(raw)) return null;
  const goal = parseGoal(raw.goal);
  if (!goal) return null;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : isAccountingStatus(goal.status),
    mode: raw.mode === "exiting" ? "exiting" : "active",
    ...(raw.reason === "completed" ? { reason: "completed" as const } : {}),
    goal,
  };
}

/**
 * What a `goal_updated` frame says: a state, `null` (the engine has no goal),
 * or `undefined` for a frame that is not readable (ignore it). The frame
 * carries both `goal` and `state`; `state` is preferred, and a frame with only
 * a goal gets the state the engine would have built for it.
 */
export function readGoalUpdate(frame: { goal?: unknown; state?: unknown }): GoalModeState | null | undefined {
  const state = parseGoalModeState(frame.state);
  if (state) return state;
  if (frame.goal === null) return null;
  const goal = parseGoal(frame.goal);
  if (!goal) return undefined;
  return { enabled: isAccountingStatus(goal.status), mode: goal.status === "complete" ? "exiting" : "active", goal };
}

/**
 * How stale the engine's time accounting is. The engine adds elapsed seconds
 * to a goal only when something happens (a tool finishes, a turn ends, a
 * pause), stamping `updatedAt` each time, so a goal that has been waiting for
 * you since its last change is older than its `timeUsedSeconds` says. The
 * server answers this beside the goal because only it shares a clock with the
 * engine; the browser's own clock may be anywhere.
 */
export function goalAgeMs(state: GoalModeState | null | undefined, now: number): number {
  if (!state || !state.enabled || !isAccountingStatus(state.goal.status) || state.goal.updatedAt <= 0) return 0;
  return Math.max(0, now - state.goal.updatedAt);
}

export interface GoalUpdate {
  /** The engine's state; `null` when it reported no goal. */
  state: GoalModeState | null;
  /** Client clock (ms). */
  now: number;
  /** Staleness of the snapshot's time accounting (`goalAgeMs`); events and command answers are fresh. */
  ageMs?: number;
}

/**
 * Fold one report from the engine into what is on screen.
 *
 *   - a dropped goal leaves nothing behind;
 *   - the engine clears a COMPLETED goal's state at the end of the turn without
 *     announcing it, so `null` must not erase the finished card — it stays,
 *     showing what the goal cost, until it is dismissed or a new goal starts;
 *   - reports can arrive out of order (a state poll answered from cache racing
 *     a frame), and the engine stamps every change, so the newest stamp wins;
 *   - a finished goal never goes back to working.
 */
export function adoptGoal(prev: GoalView | null, update: GoalUpdate): GoalView | null {
  const { state, now } = update;
  if (state === null) return prev?.state.goal.status === "complete" ? prev : null;
  if (state.goal.status === "dropped") return null;
  if (prev && prev.state.goal.id === state.goal.id) {
    const before = prev.state.goal;
    if (before.status === "complete" && state.goal.status !== "complete") return prev;
    if (state.goal.updatedAt < before.updatedAt) return prev;
    if (state.goal.updatedAt === before.updatedAt && state.goal.tokensUsed < before.tokensUsed) return prev;
  }
  return { state, receivedAt: now, ageMs: Math.max(0, update.ageMs ?? 0) };
}

/** Whole seconds the goal has been running for, ticking between the engine's flushes. */
export function goalElapsedSeconds(view: GoalView, now: number): number {
  const { goal, enabled } = view.state;
  const base = Math.floor(goal.timeUsedSeconds);
  if (!enabled || !isAccountingStatus(goal.status)) return base;
  return base + Math.floor((view.ageMs + Math.max(0, now - view.receivedAt)) / 1000);
}

/** Share of the token budget spent (0–1), or `null` when the goal has no budget. */
export function goalTokenFraction(goal: EngineGoal): number | null {
  if (goal.tokenBudget === undefined) return null;
  return Math.min(1, Math.max(0, goal.tokensUsed / goal.tokenBudget));
}

/** "42s", "5m 07s", "1h 05m": seconds while it is short enough to watch tick. */
export function formatGoalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface GoalControls {
  pause: boolean;
  resume: boolean;
  drop: boolean;
  /** Only a finished goal is dismissed; every other status is ended with Drop. */
  dismiss: boolean;
}

/**
 * Which buttons a goal offers. A budget-limited goal can only be dropped: the
 * engine's `resume` leaves it exactly as it was, and the budget cannot be
 * raised over RPC, so Pause/Resume would only burn another turn.
 */
export function goalControls(status: GoalStatus): GoalControls {
  switch (status) {
    case "active": return { pause: true, resume: false, drop: true, dismiss: false };
    case "paused": return { pause: false, resume: true, drop: true, dismiss: false };
    case "budget-limited": return { pause: false, resume: false, drop: true, dismiss: false };
    case "complete": return { pause: false, resume: false, drop: false, dismiss: true };
    case "dropped": return { pause: false, resume: false, drop: false, dismiss: false };
  }
}

export interface ParsedGoalCommand {
  objective: string;
  tokenBudget?: number;
}

export type GoalCommandParse =
  | { ok: true; value: ParsedGoalCommand }
  | { ok: false; reason: "empty" | "budget" };

const BUDGET_RE = /^(\d[\d,_]*(?:\.\d+)?)([km])?$/i;

/** A token budget as typed: `200000`, `200k`, `1.5m`, `200,000`. `null` when it is not a whole number above zero. */
export function parseTokenBudget(text: string): number | null {
  const match = BUDGET_RE.exec(text.trim());
  if (!match) return null;
  const digits = Number(match[1].replace(/[,_]/g, ""));
  const suffix = match[2]?.toLowerCase();
  const value = digits * (suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The text after `/goal`: `[--budget N | --budget=N] <objective>`. The flag
 * must come first; everything after it is the objective, verbatim.
 */
export function parseGoalCommand(args: string): GoalCommandParse {
  const text = args.trim();
  const flag = /^--budget(?:=|\s+|$)/.exec(text);
  if (!flag) return text ? { ok: true, value: { objective: text } } : { ok: false, reason: "empty" };
  const rest = text.slice(flag[0].length);
  const split = /^(\S*)\s*([\s\S]*)$/.exec(rest);
  const budget = split ? parseTokenBudget(split[1]) : null;
  if (budget === null) return { ok: false, reason: "budget" };
  const objective = (split?.[2] ?? "").trim();
  return objective ? { ok: true, value: { objective, tokenBudget: budget } } : { ok: false, reason: "empty" };
}

/** What Cody forwards to the engine's `goal` command. */
export interface GoalRequest {
  type: "goal";
  op: GoalOp;
  objective?: string;
  token_budget?: number;
}

const GOAL_OPS: Record<GoalOp, true> = { get: true, create: true, resume: true, pause: true, drop: true };

/**
 * The `goal` command a browser (or any API caller) asked for, checked before it
 * reaches the engine and cut down to the fields the engine reads: only a
 * `create` carries an objective and a budget. The engine validates too, but
 * its answer for a malformed request is an exception message, and an engine
 * that predates goals would say "Unknown command" for all of it.
 */
export function validateGoalRequest(command: Record<string, unknown>): { ok: true; request: GoalRequest } | { ok: false; error: string } {
  const op = command.op;
  if (typeof op !== "string" || !Object.hasOwn(GOAL_OPS, op)) return { ok: false, error: "A goal command needs an op: get, create, resume, pause or drop." };
  if (op !== "create") return { ok: true, request: { type: "goal", op: op as GoalOp } };
  const objective = typeof command.objective === "string" ? command.objective.trim() : "";
  if (!objective) return { ok: false, error: "A goal needs an objective." };
  const budget = command.token_budget;
  if (budget === undefined || budget === null) return { ok: true, request: { type: "goal", op: "create", objective } };
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0) return { ok: false, error: "A goal's token budget must be a whole number above zero." };
  return { ok: true, request: { type: "goal", op: "create", objective, token_budget: budget } };
}

/**
 * The words to show for an engine refusal the person can act on, as a locale
 * key; `null` for any other message, which is shown exactly as the engine said
 * it. Matches the strings omp 18.7's goal controller throws (rpc-goal.ts).
 */
export function goalErrorKey(message: string): "goal.disabled" | "goal.alreadyActive" | null {
  if (/\(goal\.enabled\)|goal mode is disabled/i.test(message)) return "goal.disabled";
  if (/goal is already active|resume or drop the paused goal/i.test(message)) return "goal.alreadyActive";
  return null;
}

/** omp's own default for `goal.continuationModes`. */
export const DEFAULT_CONTINUATION_MODES: readonly string[] = ["interactive"];
/** The run mode Cody's engine child is in; the only one that makes goals carry on by themselves here. */
export const RPC_CONTINUATION_MODE = "rpc";

/** The persisted `goal.continuationModes`, or omp's default when it is absent or malformed. */
export function continuationModesOf(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [...DEFAULT_CONTINUATION_MODES];
}

/** Whether a goal keeps working by itself between replies. */
export function goalAutoContinues(value: unknown): boolean {
  return continuationModesOf(value).includes(RPC_CONTINUATION_MODE);
}

/**
 * The value to write for "Keep working automatically" on/off, leaving every
 * other mode as the user had it. `null` means "reset to omp's default" (the key
 * is removed rather than written out as a copy of the default); `undefined`
 * means the setting already says what was asked.
 */
export function nextContinuationModes(value: unknown, on: boolean): string[] | null | undefined {
  const modes = continuationModesOf(value);
  if (modes.includes(RPC_CONTINUATION_MODE) === on) return undefined;
  const next = on ? [...modes, RPC_CONTINUATION_MODE] : modes.filter((mode) => mode !== RPC_CONTINUATION_MODE);
  const isDefault = next.length === DEFAULT_CONTINUATION_MODES.length && next.every((mode, index) => mode === DEFAULT_CONTINUATION_MODES[index]);
  return isDefault ? null : next;
}

/**
 * What a session FILE says about the goal of a chat nobody is running. omp
 * records every goal change as a `mode_change` entry (`goal` while it is being
 * worked, `goal_paused`, `none` once it ended) and, the next time a process
 * opens the file, pauses a goal that was still active — so that is what an
 * idle chat shows too. Anything finished or dropped is no goal.
 */
export function goalFromPersistedMode(mode: unknown, data: unknown): GoalModeState | null {
  if (mode !== "goal" && mode !== "goal_paused") return null;
  const goal = parseGoal(isRecord(data) ? data.goal : undefined);
  if (!goal || goal.status === "complete" || goal.status === "dropped") return null;
  if (goal.status === "budget-limited" && mode === "goal") return { enabled: true, mode: "active", goal };
  return { enabled: false, mode: "active", goal: { ...goal, status: "paused" } };
}
