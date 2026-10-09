import { formatToolTime } from "../tool-time";

/**
 * What Cody says when it picks a chat's run up again: to the agent, in the
 * journal and log, and to the owner's phone. One cause object feeds all three
 * so they can never tell different stories. Times are written the way a host
 * tool writes them (`formatToolTime`, in the chat owner's zone), because the
 * agent reads them and a bare UTC string would send it hunting for the wrong
 * hour.
 */

/** Why a chat's run is being picked up again. */
export type RunCause =
  /** A tool call outlived what it could take. */
  | { kind: "tool"; tool: string; startedAt: number; quietSince: number; sinceMs: number }
  /** The engine did not answer a question for as long as it was given. */
  | { kind: "engine_silent"; quietSince: number; sinceMs: number }
  /** Nothing at all happened while a run was supposedly in flight. */
  | { kind: "quiet"; quietSince: number; sinceMs: number }
  /** The engine process died on its own. */
  | { kind: "crash"; exitedAt: number }
  /** Cody's own server restarted while the run was in flight. */
  | { kind: "restart"; restartedAt: number; lastActivityAt: number };

/** What the owner is told about: a recovery, giving up, or a run that was not picked up. */
export type RecoveryOutcome =
  | { kind: "recovered"; cause: RunCause; at: number }
  | { kind: "gave_up"; count: number }
  | { kind: "not_resumed"; lastActivityAt: number; at: number };

/** "20 minutes", "90 minutes", "2.5 hours": whole minutes up to an hour and a half, then hours. */
export function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(ms / 360_000) / 10;
  return `${hours} hours`;
}

/** One line naming what went wrong, with no full stop: it is the reason in the journal and the cause in the prompt. */
export function describeCause(cause: RunCause, zone: string): string {
  switch (cause.kind) {
    case "tool":
      return `\`${cause.tool}\` had not answered for ${describeDuration(cause.sinceMs)} (it started at ${formatToolTime(cause.startedAt, zone)})`;
    case "engine_silent":
      return `the engine had stopped answering for ${describeDuration(cause.sinceMs)}`;
    case "quiet":
      return `nothing had happened for ${describeDuration(cause.sinceMs)}`;
    case "crash":
      return `the engine process exited unexpectedly at ${formatToolTime(cause.exitedAt, zone)}`;
    case "restart":
      return `Cody's server restarted at ${formatToolTime(cause.restartedAt, zone)} while this chat was working (last activity ${formatToolTime(cause.lastActivityAt, zone)})`;
  }
}

/**
 * The user turn Cody sends to carry a chat on. It says plainly that the
 * person did not write it, what went wrong, and what a restart destroyed, and
 * asks the agent to check before it trusts anything that was in flight.
 */
export function recoveryPrompt(cause: RunCause, zone: string, restartedAt: number): string {
  const what = describeCause(cause, zone);
  return [
    "This is an automatic message from Cody, not from the user.",
    `${what.charAt(0).toUpperCase()}${what.slice(1)}.`,
    `Cody restarted the engine at ${formatToolTime(restartedAt, zone)}.`,
    "Tool calls that were still running have unknown results, and any subagents or background jobs were stopped.",
    "Check what actually finished (files, git, job output), then carry on with the task you were working on.",
  ].join(" ");
}

/** The body of one push notification. */
export function noticeBody(outcome: RecoveryOutcome, zone: string): string {
  switch (outcome.kind) {
    case "gave_up":
      return `Cody restarted this chat's engine ${outcome.count} times in 12 hours and stopped trying. Open the chat to continue.`;
    case "not_resumed":
      return `Not resumed: Cody restarted ${describeDuration(outcome.at - outcome.lastActivityAt)} after this chat last did anything (${formatToolTime(outcome.lastActivityAt, zone)}).`;
    case "recovered": {
      const { cause } = outcome;
      const done = `Cody restarted the engine at ${formatToolTime(outcome.at, zone)} and asked the agent to carry on.`;
      switch (cause.kind) {
        case "tool":
          return `Stuck since ${formatToolTime(cause.quietSince, zone)}: \`${cause.tool}\` never answered. ${done}`;
        case "engine_silent":
          return `Stuck since ${formatToolTime(cause.quietSince, zone)}: the engine stopped answering. ${done}`;
        case "quiet":
          return `Stuck since ${formatToolTime(cause.quietSince, zone)}: nothing happened for ${describeDuration(cause.sinceMs)}. ${done}`;
        case "crash":
          return `The engine exited unexpectedly at ${formatToolTime(cause.exitedAt, zone)}. ${done}`;
        case "restart":
          return `Cody restarted at ${formatToolTime(cause.restartedAt, zone)} while this chat was working; it asked the agent to carry on.`;
      }
    }
  }
}
