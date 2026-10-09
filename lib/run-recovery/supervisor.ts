import { readEnv } from "../env";
import type { EngineEvent, EngineSession } from "../harness/types";
import { sendNotification, type NotificationDraft } from "../notifications/dispatch";
import { ownerTimeZone } from "../time-zone-prefs";
import { asString } from "../type-guards";
import * as journal from "./journal";
import { findOverdueTool, insideOwnDeadline, type ToolFlight } from "./judge";
import { RUN_RECOVERY_LIMITS, type RunRecoveryLimits } from "./limits";
import { describeChat, notifyRecovery, type ChatDescription, type ChatHint } from "./notify";
import { isServerShuttingDown } from "./shutdown";
import { describeCause, recoveryPrompt, type RunCause } from "./text";

/**
 * Keeps an unattended run alive: notices a chat's engine has stopped making
 * progress (or died, or was taken down with the server) and carries the run on.
 *
 * Two nights running a long run silently died. Once a tool call hung for four
 * and a half hours with the engine alive and saying nothing; once a server
 * restart killed every engine child and nobody picked the run up again. This is
 * the part of Cody that notices both.
 *
 * It attaches to every MAIN chat session (never a sidebar chat) through
 * `observeEvents` — an observer, not a listener: a listener would keep an idle
 * child alive and make host tools route to a page that may not exist. From the
 * frames it keeps two things:
 *
 *  - the run journal (journal.ts): an entry while a run is in flight, so a
 *    restart knows which chats were cut off;
 *  - what the watchdog needs: when the engine last said anything, and which
 *    tool calls the main agent is waiting on.
 *
 * One `unref`'d timer looks at every chat once a minute. A chat is stalled when
 *  1. a tool call is overdue (judge.ts: its own timeout plus a grace, or twenty
 *     minutes without a sign of life for a tool that has no timeout);
 *  2. the engine has said nothing for ten minutes and then did not answer a
 *     `get_state` for another ten; or
 *  3. nothing at all happened for an hour, and no tool is allowed to be quiet.
 * A stalled chat's engine is closed, the chat is started again from its own
 * session, and the agent is sent one user turn explaining what happened. The
 * run that turn starts is watched from the moment it is sent, so an engine that
 * wedges before it says the run began is caught the second time too. That is at
 * most three times per chat in twelve hours; then Cody tells the owner it gave
 * up. The same action runs when an engine dies on its own (after 30 seconds)
 * and, once, for every run the journal still holds when the server starts
 * (bin/cody-server.js).
 *
 * `CODY_RUN_RECOVERY=0` turns the watchdog, crash recovery and boot resume off;
 * the journal is still written.
 *
 * The state is on `globalThis`: the custom server owns the timer and the Next
 * bundle registers the sessions, and they are separate module instances.
 * Nothing here imports the session manager at load time — it imports THIS
 * module — so getting a session back goes through a lazy `import()`.
 */

/** Cody's own signals about a session (a Stop, a dialog that stopped waiting, a session move) say nothing about whether the engine is alive. */
const OWN_SIGNAL_PREFIX = "cody_";
/** A tool call that started and is still going: bounded, so a stream of unmatched starts cannot grow it. */
const MAX_TOOLS_IN_FLIGHT = 256;
/** The wrapper has said "not running" this many looks in a row while a run is open: the end was missed. */
const IDLE_LOOKS_BEFORE_FORGETTING = 3;
const WARN_EVERY_MS = 60_000;

export interface RunRecoveryDeps {
  now: () => number;
  /** When this server came up, for "Cody restarted at …". Defaults to the moment the supervisor started. */
  bootAt?: number;
  zoneFor: (sessionId: string) => string;
  /** The chat's live session, started if it has none; null when the chat can no longer be given one (it was deleted). */
  acquire: (sessionId: string, timeZone: string) => Promise<EngineSession | null>;
  send: (draft: NotificationDraft) => unknown;
  describeChat: (sessionId: string, hint?: ChatHint) => Promise<ChatDescription>;
  isShuttingDown: () => boolean;
  enabled: () => boolean;
  /** Run `run` once after `delayMs` without keeping the process alive. Returns how to cancel it. */
  schedule: (run: () => void, delayMs: number) => () => void;
  sleep: (ms: number) => Promise<void>;
  limits: RunRecoveryLimits;
}

export type RunRecoveryOverrides = Partial<Omit<RunRecoveryDeps, "limits">> & { limits?: Partial<RunRecoveryLimits> };

export interface SuperviseOptions {
  /** A sidebar chat is a side panel, not work: it is never supervised. */
  kind?: "sidebar";
  /** Judge its tool calls against omp's own deadlines. Set for omp only: another engine's tools of the same name carry other deadlines. */
  judgesTools?: boolean;
}

interface PendingRecovery {
  sessionId: string;
  cause: RunCause;
  hint?: ChatHint;
  /** Not before this instant: an engine that just died gets a moment (the page reconnects on its own), a failed attempt waits for the next look. */
  notBefore: number;
}

interface RecoveryRequest {
  sessionId: string;
  cause: RunCause;
  hint?: ChatHint;
  /** The stalled session to close first. Absent when its engine is already gone (a crash, a restart). */
  recycle?: RunTracker;
}

type RecoveryResult = "recovered" | "gave_up" | "skipped" | "failed";

export interface RunRecoveryState {
  deps: RunRecoveryDeps;
  bootAt: number;
  started: boolean;
  /** Moves when the supervisor is stopped, so a boot resume in progress stops with it. */
  generation: number;
  interval: NodeJS.Timeout | undefined;
  cancels: Set<() => void>;
  trackers: Set<RunTracker>;
  supervised: WeakSet<object>;
  pending: Map<string, PendingRecovery>;
  /** Chats a recovery is under way for: one at a time each. */
  recovering: Set<string>;
  warnedAt: Map<string, number>;
}

declare global {
  var __codyRunRecovery: RunRecoveryState | undefined;
}

function liveSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function liveSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  liveSchedule(resolve, ms);
  return promise;
}

/** The real collaborators. */
function liveDeps(): RunRecoveryDeps {
  return {
    now: Date.now,
    zoneFor: ownerTimeZone,
    acquire: async (sessionId, timeZone) => {
      // Dynamic on purpose: session-acquire imports the session manager, which imports this module.
      const { acquireSession, isSessionUnavailableError } = await import("../session-acquire");
      try {
        return await acquireSession(sessionId, timeZone);
      } catch (error) {
        if (isSessionUnavailableError(error)) return null;
        throw error;
      }
    },
    send: (draft) => sendNotification(draft),
    describeChat,
    isShuttingDown: isServerShuttingDown,
    enabled: () => readEnv("RUN_RECOVERY")?.trim() !== "0",
    schedule: liveSchedule,
    sleep: liveSleep,
    limits: { ...RUN_RECOVERY_LIMITS },
  };
}

function resolveDeps(overrides: RunRecoveryOverrides): RunRecoveryDeps {
  return { ...liveDeps(), ...overrides, limits: { ...RUN_RECOVERY_LIMITS, ...overrides.limits } };
}

function newState(deps: RunRecoveryDeps): RunRecoveryState {
  return {
    deps,
    bootAt: deps.bootAt ?? deps.now(),
    started: false,
    generation: 0,
    interval: undefined,
    cancels: new Set(),
    trackers: new Set(),
    supervised: new WeakSet(),
    pending: new Map(),
    recovering: new Set(),
    warnedAt: new Map(),
  };
}

function globalState(): RunRecoveryState {
  if (!globalThis.__codyRunRecovery) globalThis.__codyRunRecovery = newState(resolveDeps({}));
  return globalThis.__codyRunRecovery;
}

/** Say what went wrong — at most once a minute per `what`, because a disk that stays full must not fill the log. */
function warnThrottled(state: RunRecoveryState, what: string, error: unknown): void {
  const at = Date.now();
  if (at - (state.warnedAt.get(what) ?? 0) < WARN_EVERY_MS) return;
  state.warnedAt.set(what, at);
  console.warn(`[run-recovery] ${what} failed:`, error instanceof Error ? error.message : error);
}

/**
 * Run `run`; when it throws, say so and carry on. Writing the journal or
 * looking at a chat must never break the chat it watches.
 */
function safely<T>(state: RunRecoveryState, what: string, run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    warnThrottled(state, what, error);
    return undefined;
  }
}

/** `work`, but no longer than `ms`: a start or a send that hangs must not hold a chat's recovery for ever. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: timedOut, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
  timer.unref?.();
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// One chat's run
// ---------------------------------------------------------------------------

/**
 * What the supervisor knows about one live session: whether a run is in
 * flight, when the engine last spoke, and what the main agent is waiting on.
 * Plain field assignments, not TS parameter properties, so this runs under
 * Node's strip-only TypeScript mode like the rest of lib/.
 */
class RunTracker {
  readonly state: RunRecoveryState;
  readonly session: EngineSession;
  readonly judgesTools: boolean;
  closed = false;
  /** A run is in flight: agent_start seen, no terminal agent_end, no Stop. */
  runActive = false;
  /** Cody itself is closing this session to start it again, so its close keeps the journal entry. */
  recycling = false;
  /** A verdict was acted on: this session is about to be replaced. */
  actedOn = false;
  /** The cap was reached: this run is left to the person. */
  gaveUp = false;
  unobserve: () => void;
  private stopped = false;
  private crashedAt: number | null = null;
  /** The id the journal entry is filed under; moves with the session's own id. */
  private journaledAs: string | null = null;
  private lastHeartbeatAt = 0;
  /** The engine said anything at all (a side answer counts). */
  private lastAliveAt: number;
  /** The run made progress: any frame but a side answer. */
  private lastProgressAt: number;
  private lastJudgedAt: number;
  private idleLooks = 0;
  private readonly tools = new Map<string, ToolFlight>();
  private probeInFlight = false;
  private probeStartedAt: number | null = null;
  private probeAnsweredAt = 0;
  private anonymousTools = 0;

  constructor(state: RunRecoveryState, session: EngineSession, judgesTools: boolean) {
    this.state = state;
    this.session = session;
    this.judgesTools = judgesTools;
    this.unobserve = () => {};
    const now = state.deps.now();
    this.lastAliveAt = now;
    this.lastProgressAt = now;
    this.lastJudgedAt = now;
  }

  /** The session's id right now: it moves when omp moves the session to a new file. */
  currentId(): string {
    return this.session.sessionId || this.journaledAs || "";
  }

  handle(event: EngineEvent): void {
    if (this.closed) return;
    const type = event.type;
    try {
      const now = this.state.deps.now();
      this.followIdentity(now);
      switch (type) {
        // Warming the provider's prompt cache while idle is not the engine working.
        case "cache_warming_start":
        case "cache_warming_end":
          return;
        case "cody_run_stopped":
          this.stopRun();
          return;
        // A side question's answer proves the engine is there; it is not the run going anywhere.
        case "btw_delta":
        case "btw_record":
          this.lastAliveAt = now;
          this.probeStartedAt = null;
          return;
        case "agent_start":
          this.startRun(now);
          break;
        case "agent_end":
          // A pause inside a run (omp hands a "Steer now" over this way) is not the end.
          if (event.isTerminal !== false) this.endRun();
          break;
        case "notice":
          // The wrapper's own report that the child died. Its terminal agent_end follows, and must not read as the run finishing.
          if (event.reason === "engine_exit" && this.runActive) this.crashedAt = now;
          break;
        case "tool_execution_start":
          this.toolStarted(event, now);
          break;
        case "tool_execution_update":
          this.toolUpdated(event, now);
          break;
        case "tool_execution_end":
          this.tools.delete(asString(event.toolCallId) ?? "");
          break;
        default:
          if (typeof type === "string" && type.startsWith(OWN_SIGNAL_PREFIX)) return;
      }
      this.sawProgress(now);
    } catch (error) {
      warnThrottled(this.state, "watching a chat", error);
    }
  }

  private followIdentity(now: number): void {
    const id = this.session.sessionId;
    if (!this.journaledAs || !id || id === this.journaledAs) return;
    const from = this.journaledAs;
    this.journaledAs = id;
    safely(this.state, "journal", () => journal.rekeyRun(from, id, now));
  }

  private startRun(now: number): void {
    this.runActive = true;
    this.stopped = false;
    this.gaveUp = false;
    this.crashedAt = null;
    this.tools.clear();
    this.probeStartedAt = null;
    this.idleLooks = 0;
    this.lastJudgedAt = now;
    const id = this.session.sessionId;
    if (!id) return;
    this.journaledAs = id;
    this.lastHeartbeatAt = now;
    safely(this.state, "journal", () => journal.beginRun(id, now));
  }

  /**
   * Cody has just handed this session a recovery prompt: a run is about to
   * begin, whether or not its agent_start ever comes. An engine that wedges
   * before saying so would otherwise be the original incident again, unwatched.
   */
  expectRun(): void {
    if (!this.closed) this.startRun(this.state.deps.now());
  }

  /** The run is over, however it ended: its entry goes with it. */
  private endRun(): void {
    this.tools.clear();
    this.probeStartedAt = null;
    // The engine died, not the run: the entry stays for the recovery that follows the close.
    if (this.crashedAt !== null) return;
    this.runActive = false;
    this.forgetEntry();
  }

  /** The person pressed Stop: whatever the engine does while it winds down, this run is theirs to restart. */
  private stopRun(): void {
    if (!this.runActive) return;
    this.stopped = true;
    this.runActive = false;
    this.tools.clear();
    this.probeStartedAt = null;
    this.forgetEntry();
  }

  private forgetEntry(): void {
    const id = this.journaledAs;
    this.journaledAs = null;
    if (id) safely(this.state, "journal", () => journal.endRun(id, this.state.deps.now()));
  }

  private toolStarted(event: EngineEvent, now: number): void {
    if (this.tools.size >= MAX_TOOLS_IN_FLIGHT) {
      const oldest = this.tools.keys().next();
      if (!oldest.done) this.tools.delete(oldest.value);
    }
    const name = asString(event.toolName) ?? "";
    // A frame with no call id cannot be matched to its end; it still counts as a call in flight until the run ends.
    const id = asString(event.toolCallId) || `${name}#${(this.anonymousTools += 1)}`;
    this.tools.set(id, { id, name, args: event.args, startedAt: now, clockStart: now, lastUpdateAt: now });
  }

  private toolUpdated(event: EngineEvent, now: number): void {
    const id = asString(event.toolCallId) ?? "";
    const flight = this.tools.get(id);
    if (flight) flight.lastUpdateAt = now;
    else if (id) this.tools.set(id, { id, name: asString(event.toolName) ?? "", args: event.args, startedAt: now, clockStart: now, lastUpdateAt: now });
  }

  /** Any frame that is the run going somewhere: the clocks restart, the question to the engine is withdrawn, the journal's "last activity" moves. */
  private sawProgress(now: number): void {
    this.lastAliveAt = now;
    this.lastProgressAt = now;
    this.probeStartedAt = null;
    // A run Cody gave up on has no entry any more, and a late frame must not write one back.
    if (!this.runActive || this.gaveUp || !this.journaledAs || now - this.lastHeartbeatAt < this.state.deps.limits.heartbeatMs) return;
    const id = this.journaledAs;
    this.lastHeartbeatAt = now;
    safely(this.state, "journal", () => journal.touchRun(id, now));
  }

  /** The session closed, however it closed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unobserve();
    this.state.trackers.delete(this);
    const inFlight = this.runActive;
    this.runActive = false;
    this.tools.clear();
    // A run that ended (or was stopped) already took its entry with it.
    if (!inFlight) return;
    const { deps } = this.state;
    this.followIdentity(deps.now());
    const shuttingDown = deps.isShuttingDown();
    const crashedAt = this.crashedAt;
    // Cut off, not abandoned: the server is stopping, the engine died, or Cody is restarting it.
    // Any other close (the chat deleted or archived, the engine switched or updated, an idle child) was somebody's decision.
    if (shuttingDown || crashedAt !== null || this.recycling) {
      if (crashedAt !== null && !shuttingDown && !this.recycling) {
        scheduleCrashRecovery(this.state, this.currentId(), crashedAt, { sessionFile: this.session.sessionFile, cwd: this.session.cwd });
      }
      return;
    }
    this.forgetEntry();
  }

  // -------------------------------------------------------------------------
  // The watchdog
  // -------------------------------------------------------------------------

  /** One look. Returns the recovery it started, if it decided on one. */
  judge(now: number): Promise<void> | undefined {
    const waited = Math.max(0, now - this.lastJudgedAt);
    this.lastJudgedAt = now;
    if (this.closed || !this.runActive || this.stopped || this.gaveUp || this.actedOn) return undefined;
    // A chat that moved to a new file while the engine said nothing is found here, not at the next frame.
    this.followIdentity(now);
    const session = this.session;
    if (!session.isAlive()) return undefined;
    if (!session.isRunning()) {
      this.idleLooks += 1;
      if (this.idleLooks >= IDLE_LOOKS_BEFORE_FORGETTING) {
        // The wrapper says nothing is running and has for a while, yet this run never ended: its end was missed. A leftover entry would make the next boot resume a run that finished.
        this.runActive = false;
        this.tools.clear();
        this.forgetEntry();
      }
      return undefined;
    }
    this.idleLooks = 0;
    if (session.hasPendingInput?.() || session.livePhase?.().compacting) {
      this.holdClocks(now, waited);
      return undefined;
    }
    const cause = this.evaluate(now);
    if (!cause) return undefined;
    this.actedOn = true;
    const request: RecoveryRequest = {
      sessionId: this.currentId(),
      cause,
      hint: { sessionFile: session.sessionFile, cwd: session.cwd },
      recycle: this,
    };
    return recoverRun(this.state, request).then(
      (result) => {
        // Not acted on after all (the chat moved on, or another recovery had it): look again next time.
        if (result === "skipped") this.actedOn = false;
      },
      (error: unknown) => {
        this.actedOn = false;
        warnThrottled(this.state, "recovering a chat", error);
      },
    );
  }

  /**
   * The chat is waiting on the person (an approval, a question) or compacting:
   * that is not the engine's silence. The clocks stand still while it lasts, so
   * the minute after the answer is not judged against the hours before it.
   */
  private holdClocks(now: number, waited: number): void {
    this.lastAliveAt = now;
    this.lastProgressAt = now;
    this.probeStartedAt = null;
    for (const flight of this.tools.values()) {
      flight.clockStart += waited;
      flight.lastUpdateAt += waited;
    }
  }

  private evaluate(now: number): RunCause | null {
    const { limits } = this.state.deps;
    if (this.judgesTools) {
      const overdue = findOverdueTool(this.tools.values(), now, limits);
      if (overdue) return { kind: "tool", ...overdue };
    }
    if (this.probeInFlight && this.probeStartedAt !== null && now - this.probeStartedAt >= limits.probeBoundMs) {
      return { kind: "engine_silent", quietSince: this.lastAliveAt, sinceMs: now - this.lastAliveAt };
    }
    const quiet = now - this.lastProgressAt;
    if (quiet >= limits.silenceMs && !(this.judgesTools && insideOwnDeadline(this.tools.values(), now, limits))) {
      return { kind: "quiet", quietSince: this.lastProgressAt, sinceMs: quiet };
    }
    if (now - Math.max(this.lastAliveAt, this.probeAnsweredAt) >= limits.probeAfterMs) {
      // A question still unanswered from before the engine last spoke is not asked twice: its bound starts counting again.
      if (this.probeInFlight) this.probeStartedAt ??= now;
      else this.startProbe(now);
    }
    return null;
  }

  /** Ask the engine whether it is there. Any answer, even a refusal, proves it is. */
  private startProbe(now: number): void {
    this.probeInFlight = true;
    this.probeStartedAt = now;
    const answered = () => {
      this.probeInFlight = false;
      this.probeStartedAt = null;
      this.probeAnsweredAt = this.state.deps.now();
    };
    void Promise.resolve().then(() => this.session.send({ type: "get_state" })).then(answered, answered);
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function scheduleCrashRecovery(state: RunRecoveryState, sessionId: string, exitedAt: number, hint: ChatHint): void {
  const { deps } = state;
  if (!sessionId || !deps.enabled()) return;
  state.pending.set(sessionId, { sessionId, cause: { kind: "crash", exitedAt }, hint, notBefore: deps.now() + deps.limits.crashDelayMs });
  // The watchdog's own look would find it too, a minute late at worst; this makes it 30 seconds.
  const scheduled: { cancel?: () => void } = {};
  scheduled.cancel = deps.schedule(() => {
    if (scheduled.cancel) state.cancels.delete(scheduled.cancel);
    sweepPending(state).catch((error: unknown) => warnThrottled(state, "recovering a chat", error));
  }, deps.limits.crashDelayMs);
  state.cancels.add(scheduled.cancel);
}

/** The cap was reached: tell the owner once, and stop. */
async function giveUp(state: RunRecoveryState, sessionId: string, count: number, hint: ChatHint | undefined): Promise<void> {
  console.warn(`[run-recovery] giving up on chat ${sessionId}: its engine was restarted ${count} times in the last ${state.deps.limits.recoveryWindowMs / 3_600_000} hours`);
  safely(state, "journal", () => journal.endRun(sessionId, state.deps.now()));
  state.pending.delete(sessionId);
  await notifyRecovery(sessionId, { kind: "gave_up", count }, hint, state.deps);
}

/**
 * Carry a chat's run on: close the stalled engine (when there still is one),
 * start the chat again from its own session and send the agent one user turn
 * saying what happened. One recovery per chat at a time, and never more than
 * the cap allows. A failure to restart or to send counts as an attempt and is
 * tried again at the next look, until the cap says stop.
 */
async function recoverRun(state: RunRecoveryState, request: RecoveryRequest): Promise<RecoveryResult> {
  const { deps } = state;
  const { sessionId, cause, recycle, hint } = request;
  if (!sessionId || state.recovering.has(sessionId)) return "skipped";
  // The server is going down: an engine started now would only be killed with it. The entry stays for the next boot.
  if (deps.isShuttingDown()) return "skipped";
  // Still the session Cody was looking at, and still running: anything else means the chat moved on while this waited.
  if (recycle && (recycle.closed || !recycle.session.isAlive() || !recycle.session.isRunning())) return "skipped";
  state.recovering.add(sessionId);
  try {
    const now = deps.now();
    const history = journal.recentRecoveries(safely(state, "journal", () => journal.findRun(sessionId)) ?? null, now, deps.limits.recoveryWindowMs);
    if (history.length >= deps.limits.maxRecoveries) {
      if (recycle) recycle.gaveUp = true;
      await giveUp(state, sessionId, history.length, hint);
      return "gave_up";
    }
    const attempt = history.length + 1;
    const zone = deps.zoneFor(sessionId);
    const reason = describeCause(cause, zone);
    console.warn(`[run-recovery] restarting chat ${sessionId} (attempt ${attempt} of ${deps.limits.maxRecoveries}): ${reason}`);
    // Counted once, before the send: a recovered run that finishes in a blink would otherwise end its entry first and have this write one back.
    let counted = false;
    const countAttempt = () => {
      if (counted) return;
      counted = true;
      safely(state, "journal", () => journal.addRecovery(sessionId, { at: now, reason }, now));
    };
    try {
      if (recycle) {
        recycle.recycling = true;
        await recycle.session.destroyAndWait(`stalled: ${reason}`);
      }
      // The same, when the shutdown began while the stalled engine was closing.
      if (deps.isShuttingDown()) return "skipped";
      const session = await bounded(deps.acquire(sessionId, zone), deps.limits.acquireBoundMs, "starting the chat's engine");
      if (!session) {
        console.warn(`[run-recovery] chat ${sessionId} no longer exists, so its run was not picked up`);
        safely(state, "journal", () => journal.endRun(sessionId, deps.now()));
        return "skipped";
      }
      if (session.isRunning()) {
        console.warn(`[run-recovery] chat ${sessionId} is already working again, so it was left alone`);
        return "skipped";
      }
      if (session.sessionId && session.sessionId !== sessionId) safely(state, "journal", () => journal.rekeyRun(sessionId, session.sessionId, deps.now()));
      countAttempt();
      const restartedAt = deps.now();
      // The prompt starts a run, and the engine's own agent_start may be slow or never come: the watchdog counts from now.
      for (const tracker of state.trackers) if (tracker.session === session) tracker.expectRun();
      await bounded(
        session.send({
          type: "prompt",
          message: recoveryPrompt(cause, zone, restartedAt),
          streamingBehavior: "steer",
          clientMessageId: `recover-${sessionId}-${attempt}`,
          timeZone: zone,
        }),
        deps.limits.sendBoundMs,
        "handing the agent the recovery message",
      );
      await notifyRecovery(sessionId, { kind: "recovered", cause, at: restartedAt }, hint, deps);
      return "recovered";
    } catch (error) {
      countAttempt();
      console.warn(`[run-recovery] could not restart chat ${sessionId}:`, error instanceof Error ? error.message : error);
      state.pending.set(sessionId, { sessionId, cause, hint, notBefore: deps.now() + deps.limits.tickMs });
      return "failed";
    }
  } finally {
    state.recovering.delete(sessionId);
  }
}

/** Start every recovery that is due: an engine that died a little while ago, an attempt that failed. */
async function sweepPending(state: RunRecoveryState): Promise<void> {
  const { deps } = state;
  if (!deps.enabled()) {
    state.pending.clear();
    return;
  }
  const now = deps.now();
  const work: Promise<unknown>[] = [];
  for (const [sessionId, item] of [...state.pending]) {
    if (item.notBefore > now) continue;
    state.pending.delete(sessionId);
    work.push(recoverRun(state, { sessionId, cause: item.cause, hint: item.hint }).catch((error: unknown) => warnThrottled(state, "recovering a chat", error)));
  }
  await Promise.all(work);
}

/** One look at every chat, then whatever recoveries have come due. */
async function tick(state: RunRecoveryState): Promise<void> {
  if (!state.deps.enabled()) return;
  const now = state.deps.now();
  const work: Promise<unknown>[] = [];
  for (const tracker of [...state.trackers]) {
    const started = safely(state, "watching a chat", () => tracker.judge(now));
    if (started) work.push(started);
  }
  work.push(sweepPending(state));
  await Promise.allSettled(work);
}

function isWorkingNow(state: RunRecoveryState, sessionId: string): boolean {
  for (const tracker of state.trackers) {
    if (tracker.currentId() === sessionId && tracker.session.isAlive() && tracker.session.isRunning()) return true;
  }
  return false;
}

/**
 * At boot: every run the journal still holds was cut off by the restart.
 * Resume the recent ones, one chat at a time, and say so about the rest. A
 * chat that is already working again (somebody opened it in the first seconds)
 * is left alone. Returns how many were resumed.
 */
async function resumeInterrupted(state: RunRecoveryState): Promise<number> {
  const { deps } = state;
  if (!deps.enabled()) return 0;
  const generation = state.generation;
  const runs = safely(state, "journal", () => journal.listRuns()) ?? [];
  let resumed = 0;
  let acted = false;
  for (const entry of runs) {
    if (state.generation !== generation) break;
    if (isWorkingNow(state, entry.sessionId)) continue;
    // One chat at a time, a little apart: each one starts an engine.
    if (acted) await deps.sleep(deps.limits.bootSpacingMs);
    if (state.generation !== generation) break;
    acted = true;
    try {
      const now = deps.now();
      const history = journal.recentRecoveries(entry, now, deps.limits.recoveryWindowMs);
      if (now - entry.updatedAt > deps.limits.bootMaxAgeMs) {
        safely(state, "journal", () => journal.endRun(entry.sessionId, now));
        await notifyRecovery(entry.sessionId, { kind: "not_resumed", lastActivityAt: entry.updatedAt, at: now }, undefined, deps);
      } else if (history.length >= deps.limits.maxRecoveries) {
        await giveUp(state, entry.sessionId, history.length, undefined);
      } else {
        const result = await recoverRun(state, {
          sessionId: entry.sessionId,
          cause: { kind: "restart", restartedAt: state.bootAt, lastActivityAt: entry.updatedAt },
        });
        if (result === "recovered") resumed += 1;
      }
    } catch (error) {
      warnThrottled(state, "resuming a chat", error);
    }
  }
  return resumed;
}

function superviseIn(state: RunRecoveryState, session: EngineSession, options: SuperviseOptions): void {
  if (options.kind === "sidebar" || typeof session.observeEvents !== "function") return;
  if (state.supervised.has(session)) return;
  state.supervised.add(session);
  const tracker = new RunTracker(state, session, options.judgesTools === true);
  state.trackers.add(tracker);
  tracker.unobserve = session.observeEvents((event) => tracker.handle(event));
  // Registered after the observer is held, because a session that is already closed calls this at once.
  session.onClose(() => tracker.close());
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Start supervising a live chat session. Called by the session manager next to
 * the notification observer, for every main chat and never a sidebar chat.
 */
export function superviseRun(session: EngineSession, options: SuperviseOptions = {}): void {
  superviseIn(globalState(), session, options);
}

/**
 * Begin the watchdog and, a couple of seconds from now, resume the runs the
 * last shutdown cut off. Idempotent. `overrides` replaces the collaborators
 * (a test seam). Called from bin/cody-server.js beside the scheduled sender.
 */
export function startRunRecovery(overrides: RunRecoveryOverrides = {}): void {
  const state = globalState();
  if (state.started) return;
  state.started = true;
  state.generation += 1;
  state.deps = resolveDeps(overrides);
  state.bootAt = state.deps.bootAt ?? state.deps.now();
  const interval = setInterval(() => {
    tick(state).catch((error: unknown) => warnThrottled(state, "the watchdog", error));
  }, state.deps.limits.tickMs);
  interval.unref?.();
  state.interval = interval;
  state.cancels.add(state.deps.schedule(() => {
    resumeInterrupted(state).catch((error: unknown) => warnThrottled(state, "resuming interrupted runs", error));
  }, state.deps.limits.bootDelayMs));
}

/** Stop the watchdog and everything waiting on a timer. Idempotent. A recovery already under way finishes on its own. */
export function stopRunRecovery(): void {
  const state = globalThis.__codyRunRecovery;
  if (!state?.started) return;
  state.started = false;
  state.generation += 1;
  clearInterval(state.interval);
  state.interval = undefined;
  for (const cancel of state.cancels) cancel();
  state.cancels.clear();
  state.pending.clear();
}

/** A supervisor with its own private state and collaborators: what the tests drive. */
export interface RunRecovery {
  readonly state: RunRecoveryState;
  supervise(session: EngineSession, options?: SuperviseOptions): void;
  /** One watchdog look at every chat, and the recoveries that are due. Resolves when they are done. */
  tick(): Promise<void>;
  /** The boot resume. Resolves with how many runs were picked up. */
  resume(): Promise<number>;
}

export function createRunRecovery(overrides: RunRecoveryOverrides = {}): RunRecovery {
  const state = newState(resolveDeps(overrides));
  return {
    state,
    supervise: (session, options = {}) => superviseIn(state, session, options),
    tick: () => tick(state),
    resume: () => resumeInterrupted(state),
  };
}
