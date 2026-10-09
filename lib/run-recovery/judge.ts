import { isRecord } from "../type-guards";
import type { RunRecoveryLimits } from "./limits";

/**
 * Which tool calls in flight have outlived what they can honestly take.
 *
 * Pure: the supervisor hands it the main agent's tool calls (from
 * `tool_execution_start` / `_update` / `_end`) and the clock. Only omp's tools
 * are judged here, because only omp's deadlines are known; an engine that
 * names a tool `bash` too (pi's has no timeout at all) must not be held to
 * omp's, and the supervisor says so by not asking.
 */

export interface ToolFlight {
  id: string;
  name: string;
  args: unknown;
  /** When the call really began: what a person is told. */
  startedAt: number;
  /**
   * The instant its clock counts from: the start, moved later by any time the
   * chat spent waiting on the person or compacting, which is not the call's
   * time to answer.
   */
  clockStart: number;
  /** Starts equal to `clockStart`; moves on every `tool_execution_update`, and later by the same waits. */
  lastUpdateAt: number;
}

export interface OverdueTool {
  tool: string;
  /** When the call really began. */
  startedAt: number;
  /** The last sign of life on its clock: the start, or the newest update for a tool that streams them. */
  quietSince: number;
  /** How long it has gone without answering, from `quietSince` for a tool that streams updates and from its start otherwise. */
  sinceMs: number;
}

/**
 * What a call without a `timeout` argument gets, in seconds: omp's
 * `TOOL_TIMEOUTS` (src/tools/tool-timeouts.ts). The ceilings omp clamps a
 * larger request to are NOT copied here on purpose: they only ever make the
 * real deadline sooner, and a wrong guess at them would kill a call that is
 * honestly still inside its time.
 */
const OWN_TIMEOUT_SECONDS: Record<string, number> = {
  bash: 300,
  eval: 30,
  browser: 30,
  computer: 120,
  ssh: 60,
  fetch: 20,
  lsp: 20,
  debug: 30,
  ida: 120,
};

/** Tools that wait on other work by design: how long they take says nothing about whether the engine is stuck. */
const WAITS_BY_DESIGN: Record<string, true> = { wait: true, ask: true, task: true, yield: true, goal: true };

/**
 * Tools that finish in moments and have no timeout of their own. A call that
 * never answers is overdue; one that keeps reporting progress (`write
 * xd://github` watching a CI run posts an update per poll) is not.
 */
const QUICK_TOOLS: Record<string, true> = {
  read: true,
  edit: true,
  write: true,
  ast_grep: true,
  ast_edit: true,
  glob: true,
  grep: true,
  find: true,
  search: true,
  checkpoint: true,
  rewind: true,
  context_notes: true,
  todo: true,
  memory_edit: true,
  retain: true,
  recall: true,
  reflect: true,
  learn: true,
  manage_skill: true,
  think: true,
  web_search: true,
  github: true,
};

/** The `timeout` the call asked for, in seconds; undefined when it did not ask (or asked for nonsense). */
function requestedTimeoutSeconds(args: unknown): number | undefined {
  if (!isRecord(args)) return undefined;
  const raw = typeof args.timeout === "string" && args.timeout.trim() !== "" ? Number(args.timeout) : args.timeout;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * The instant a tool with its own timeout must be done by: its start plus the
 * timeout it asked for (or omp's default for it). `Infinity` for `timeout: 0`,
 * which omp reads as "no deadline". Null for a tool with no timeout of its own.
 */
function ownDeadlineAt(flight: ToolFlight): number | null {
  if (!Object.hasOwn(OWN_TIMEOUT_SECONDS, flight.name)) return null;
  const requested = requestedTimeoutSeconds(flight.args);
  if (requested === 0) return Infinity;
  return flight.clockStart + (requested ?? OWN_TIMEOUT_SECONDS[flight.name]!) * 1000;
}

/** The longest-running call that is past what it could take, or null. */
export function findOverdueTool(
  flights: Iterable<ToolFlight>,
  now: number,
  limits: Pick<RunRecoveryLimits, "toolGraceMs" | "quickToolMs">,
): OverdueTool | null {
  let worst: OverdueTool | null = null;
  for (const flight of flights) {
    if (Object.hasOwn(WAITS_BY_DESIGN, flight.name)) continue;
    let overdue: OverdueTool | null = null;
    const deadline = ownDeadlineAt(flight);
    if (deadline !== null) {
      if (now >= deadline + limits.toolGraceMs) {
        overdue = { tool: flight.name, startedAt: flight.startedAt, quietSince: flight.clockStart, sinceMs: now - flight.clockStart };
      }
    } else if (Object.hasOwn(QUICK_TOOLS, flight.name)) {
      const quietSince = Math.max(flight.clockStart, flight.lastUpdateAt);
      if (now - quietSince >= limits.quickToolMs) {
        overdue = { tool: flight.name, startedAt: flight.startedAt, quietSince, sinceMs: now - quietSince };
      }
    }
    if (overdue && (!worst || overdue.startedAt < worst.startedAt)) worst = overdue;
  }
  return worst;
}

/**
 * Whether some call is still inside the deadline it declared (or has none:
 * `timeout: 0`). Such a call is allowed to be silent, so silence alone does
 * not make the engine stalled.
 */
export function insideOwnDeadline(
  flights: Iterable<ToolFlight>,
  now: number,
  limits: Pick<RunRecoveryLimits, "toolGraceMs">,
): boolean {
  for (const flight of flights) {
    const deadline = ownDeadlineAt(flight);
    if (deadline !== null && now < deadline + limits.toolGraceMs) return true;
  }
  return false;
}
