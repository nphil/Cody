/**
 * Every number the run supervisor decides by, in one place. A test (or an
 * operator who really needs one) overrides them as a set through the
 * supervisor's `limits`; nothing else in lib/run-recovery has a literal
 * duration in it.
 */
export interface RunRecoveryLimits {
  /** How often the one watchdog looks at every supervised chat. */
  tickMs: number;
  /** A tool with its own timeout is overdue this long AFTER that timeout. */
  toolGraceMs: number;
  /** A tool with no timeout of its own is overdue after this long without a sign of life. */
  quickToolMs: number;
  /** No frame at all for this long: ask the engine whether it is there. */
  probeAfterMs: number;
  /** How long the engine has to answer that question. Above the 3-5 minutes omp is known to freeze on its own databases after a turn. */
  probeBoundMs: number;
  /** No frame at all for this long while running: stalled, unless a tool is inside its own deadline. */
  silenceMs: number;
  /** The journal's "last activity" is refreshed at most this often while frames arrive. */
  heartbeatMs: number;
  /** After an engine crash: how long before Cody restarts it. */
  crashDelayMs: number;
  /** How long the recovery prompt may take to be accepted before the attempt counts as failed. */
  sendBoundMs: number;
  /** How long getting the chat a live session may take. */
  acquireBoundMs: number;
  /** After boot: long enough for the server to start listening. */
  bootDelayMs: number;
  /** Between two chats resumed at boot. */
  bootSpacingMs: number;
  /** A run that was last alive longer ago than this is not resumed at boot. */
  bootMaxAgeMs: number;
  /** Restarts of one chat's engine allowed inside `recoveryWindowMs` before Cody stops trying. */
  maxRecoveries: number;
  recoveryWindowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RUN_RECOVERY_LIMITS: Readonly<RunRecoveryLimits> = {
  tickMs: MINUTE,
  toolGraceMs: 15 * MINUTE,
  quickToolMs: 20 * MINUTE,
  probeAfterMs: 10 * MINUTE,
  probeBoundMs: 10 * MINUTE,
  silenceMs: 60 * MINUTE,
  heartbeatMs: MINUTE,
  crashDelayMs: 30_000,
  sendBoundMs: 90_000,
  acquireBoundMs: 2 * MINUTE,
  bootDelayMs: 2_000,
  bootSpacingMs: 3_000,
  bootMaxAgeMs: 6 * HOUR,
  maxRecoveries: 3,
  recoveryWindowMs: 12 * HOUR,
};
