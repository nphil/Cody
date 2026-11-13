import { engineCrashSentence, type EngineCrashNotice, type EngineCrashRecovery } from "../engine-crash";
import { publishEngineCrash, type EngineCrashEvent } from "../engine-crash-events";
import { recordEngineCrash } from "../engine-crash-log";
import { readEnv } from "../env";
import type { EngineEvent, EngineSession } from "../harness/types";
import { buildBody, buildTitle } from "../notifications/compose";
import { sendNotification, type NotificationDraft } from "../notifications/dispatch";
import { ownerTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import { BURN_LIMITS, describeBurn, detectBurn, type BurnEvent, type BurnLimits, type BurnVerdict } from "./burn-detect";
import { listHelperTrails, readTrail, statTrail, type HelperTrail, type TrailStamp } from "./burn-trail";
import { describeChat, type ChatDescription, type ChatHint } from "./notify";

/**
 * Stops a chat, or one helper of it, that is burning tokens, and says so.
 *
 * On 2026-11-12 four helpers compacted on every step for four hours and spent
 * about 1.35 billion tokens before anyone saw it. Nothing in Cody looked: the
 * engine's event stream carries a helper's token total but not its
 * compactions. This is the part that looks.
 *
 * How. While a chat's frames arrive, at most once every `scanEveryMs`, the
 * guard reads the end of the chat's transcript and of every helper transcript
 * beside it that changed (burn-trail.ts) and runs the rules over each
 * (burn-detect.ts). Frames are only the clock: a chat that is doing nothing
 * sends none and costs nothing to watch, and no timer exists to leak.
 *
 * On a verdict:
 * - A helper: omp's own `cancel_subagent` (the helper, else the top-level
 *   helper it runs under). The main agent is told in a steer message not to
 *   wake it again, which is what turned one bad helper into four hours.
 * - The main agent: the same Stop the person presses, so the run stays
 *   stopped (and is not "recovered") until they send a message.
 * - A third helper stopped in one chat inside an hour, or a helper that keeps
 *   burning after it could not be cancelled, stops the main run as well.
 * Each stop leaves a line in the chat (the engine-crash row, reason
 * `token_burn`) and a push in the Problems group; a stopped run also raises
 * the pop-up on every open page.
 *
 * Like the run supervisor it only OBSERVES (`observeEvents`, never a listener:
 * a listener would keep an idle session alive), keeps its state on
 * `globalThis` (the session manager lives in both the Next bundle and the
 * custom server) and never throws into the session it watches. Only omp
 * writes these transcripts; another engine's session has no `sessionFile` and
 * is simply never read. `CODY_BURN_GUARD=0` turns it off.
 */

export interface BurnGuardDeps {
  now: () => number;
  enabled: () => boolean;
  limits: BurnLimits;
  stat: (file: string) => Promise<TrailStamp | null>;
  listHelpers: (sessionFile: string) => Promise<HelperTrail[]>;
  readTrail: (file: string, maxBytes: number) => Promise<BurnEvent[]>;
  /** File the line that stays in the chat (lib/engine-crash-log.ts). */
  record: (sessionId: string, notice: EngineCrashNotice, now: number) => void;
  /** Raise the pop-up on every open page. */
  publish: (event: EngineCrashEvent) => void;
  describeChat: (sessionId: string, hint?: ChatHint) => Promise<ChatDescription>;
  notify: (draft: NotificationDraft) => unknown;
  zoneFor: (sessionId: string) => string;
}

export type BurnGuardOverrides = Partial<Omit<BurnGuardDeps, "limits">> & { limits?: Partial<BurnLimits> };

export interface BurnGuardState {
  deps: BurnGuardDeps;
  watched: WeakSet<EngineSession>;
}

declare global {
  var __codyBurnGuard: BurnGuardState | undefined;
}

function resolveDeps(overrides: BurnGuardOverrides): BurnGuardDeps {
  return {
    now: Date.now,
    enabled: () => readEnv("BURN_GUARD")?.trim() !== "0",
    stat: statTrail,
    listHelpers: listHelperTrails,
    readTrail,
    record: recordEngineCrash,
    publish: publishEngineCrash,
    describeChat,
    notify: (draft) => sendNotification(draft),
    zoneFor: ownerTimeZone,
    ...overrides,
    limits: { ...BURN_LIMITS, ...overrides.limits },
  };
}

function globalState(): BurnGuardState {
  if (!globalThis.__codyBurnGuard) globalThis.__codyBurnGuard = { deps: resolveDeps({}), watched: new WeakSet() };
  return globalThis.__codyBurnGuard;
}

/** `work`, but no longer than `ms`: an engine that does not answer must not hold the guard for ever. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: timedOut, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
  timer.unref?.();
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * The user turn that tells the main agent a helper of its was stopped. The
 * agent would otherwise see only "cancelled" and wake the helper again with
 * the same oversized history, which restarts the loop.
 */
export function burnNote(helperId: string, saw: string): string {
  return [
    "This is an automatic message from Cody, not from the user.",
    `Cody stopped your helper \`${helperId}\` because it was using tokens far faster than normal: ${saw}.`,
    "Do not resume, steer or message that helper again: it would start from the same oversized history and loop again.",
    "If its work is still needed, start a fresh helper with a short brief that says what is already done, or finish it yourself.",
    "Tell the user in one line that this happened.",
  ].join(" ");
}

/** What the guard remembers about one transcript. */
interface TrailMark {
  /** The file as it was last looked at; unchanged since means nothing new to judge. */
  stamp: TrailStamp | null;
  /** Events up to here are dealt with (see detectBurn). */
  since: number;
  /** Verdicts on this helper that ended with nothing stopped. */
  unstopped: number;
  /** Said once that it cannot be stopped; nothing more to do or say. */
  muted: boolean;
}

/** One watched chat. */
class BurnWatch {
  readonly state: BurnGuardState;
  readonly session: EngineSession;
  readonly marks = new Map<string, TrailMark>();
  /** When each helper of this chat was stopped, inside `escalateWindowMs`. */
  helperStops: number[] = [];
  /**
   * The moment before which nothing counts: when the watch began, then the
   * last Stop. What a transcript already held when this session was opened
   * was written by an engine that is gone, and its helpers with it; judging
   * it would stop a chat for something that ended before a restart.
   */
  since: number;
  lastScanAt = 0;
  scanning = false;
  unobserve: (() => void) | null = null;

  constructor(state: BurnGuardState, session: EngineSession) {
    this.state = state;
    this.session = session;
    this.since = state.deps.now();
  }

  handle(event: EngineEvent): void {
    const { deps } = this.state;
    if (!deps.enabled()) return;
    const now = deps.now();
    if (event.type === "cody_run_stopped") {
      // The person pressed Stop (or the guard did): what led up to it is dealt with, and their next message starts clean.
      this.since = now;
      for (const mark of this.marks.values()) mark.since = now;
      return;
    }
    if (this.scanning || now - this.lastScanAt < deps.limits.scanEveryMs) return;
    this.lastScanAt = now;
    this.scanning = true;
    this.scan()
      .catch((error: unknown) => console.warn("[burn-guard] could not look at a chat:", error instanceof Error ? error.message : error))
      .finally(() => { this.scanning = false; });
  }

  close(): void {
    this.unobserve?.();
    this.unobserve = null;
    this.marks.clear();
  }

  private markFor(file: string): TrailMark {
    let mark = this.marks.get(file);
    if (!mark) {
      mark = { stamp: null, since: this.since, unstopped: 0, muted: false };
      this.marks.set(file, mark);
    }
    return mark;
  }

  private async scan(): Promise<void> {
    const { deps } = this.state;
    const sessionFile = this.session.sessionFile;
    if (!sessionFile) return;
    const trails: Array<{ file: string; helper: HelperTrail | null; stamp: TrailStamp }> = [];
    const own = await deps.stat(sessionFile);
    if (own) trails.push({ file: sessionFile, helper: null, stamp: own });
    for (const helper of await deps.listHelpers(sessionFile)) trails.push({ file: helper.file, helper, stamp: helper.stamp });
    for (const trail of trails) {
      const mark = this.markFor(trail.file);
      const before = mark.stamp;
      mark.stamp = trail.stamp;
      if (before && before.size === trail.stamp.size && before.mtimeMs === trail.stamp.mtimeMs && before.ino === trail.stamp.ino) continue;
      // A transcript nobody has written to for the whole window holds nothing the rules would count.
      if (mark.muted || deps.now() - trail.stamp.mtimeMs > deps.limits.windowMs) continue;
      const events = await deps.readTrail(trail.file, deps.limits.tailBytes);
      if (!this.session.isAlive()) return;
      const verdict = detectBurn(events, deps.now(), deps.limits, mark.since);
      if (verdict) await this.stop(trail.helper, mark, verdict);
    }
  }

  private async stop(helper: HelperTrail | null, mark: TrailMark, verdict: BurnVerdict): Promise<void> {
    const { deps } = this.state;
    const now = deps.now();
    mark.since = now;
    if (!helper) {
      // Fresh evidence in a chat that is no longer running is its last run's final minutes: there is nothing left to stop.
      if (!this.session.isRunning()) return;
      const saw = describeBurn(verdict, "The main agent");
      console.warn(`[burn-guard] stopping the run of chat ${this.session.sessionId}: ${saw}`);
      if (await this.stopRun()) await this.announce("manual", saw, now);
      return;
    }

    const saw = describeBurn(verdict, `Helper ${helper.id}`);
    let cancelled = false;
    for (const id of new Set([helper.id, helper.root])) {
      cancelled = await this.cancelHelper(id);
      if (cancelled) break;
    }
    if (cancelled) {
      console.warn(`[burn-guard] stopped a helper of chat ${this.session.sessionId}: ${saw}`);
      this.helperStops = [...this.helperStops.filter((at) => now - at < deps.limits.escalateWindowMs), now];
      if (this.helperStops.length >= deps.limits.escalateStops && this.session.isRunning() && await this.stopRun()) {
        this.helperStops = [];
        // Short on purpose: the chat line keeps 160 characters, and the first helpers' own lines already say what each did.
        await this.announce("manual", `${deps.limits.escalateStops} helpers of this chat had to be stopped within the hour (the last one: ${helper.id})`, now);
        return;
      }
      if (this.session.isRunning()) await this.tellAgent(helper.id, saw, now);
      await this.announce("automatic", saw, now);
      return;
    }

    // Not cancelled: most often it had just ended on its own. Only a helper that goes on burning is worth more.
    mark.unstopped += 1;
    console.warn(`[burn-guard] could not cancel a helper of chat ${this.session.sessionId} (${mark.unstopped}): ${saw}`);
    if (mark.unstopped < 2) return;
    if (this.session.isRunning() && await this.stopRun()) {
      await this.announce("manual", `${saw} (it could not be stopped on its own)`, now);
      return;
    }
    mark.muted = true;
    await this.announce("gave_up", saw, now);
  }

  /** The person's own Stop: the main agent stops and stays stopped until they send again. */
  private async stopRun(): Promise<boolean> {
    try {
      await bounded(this.session.send({ type: "abort" }), this.state.deps.limits.sendBoundMs, "stopping the run");
      return true;
    } catch (error) {
      console.warn(`[burn-guard] could not stop the run of chat ${this.session.sessionId}:`, error instanceof Error ? error.message : error);
      return false;
    }
  }

  private async cancelHelper(id: string): Promise<boolean> {
    try {
      const result = await bounded(this.session.send({ type: "cancel_subagent", subagentId: id }), this.state.deps.limits.sendBoundMs, "cancelling a helper");
      return isRecord(result) && result.cancelled === true;
    } catch {
      return false;
    }
  }

  private async tellAgent(helperId: string, saw: string, now: number): Promise<void> {
    const sessionId = this.session.sessionId;
    try {
      await bounded(
        this.session.send({
          type: "prompt",
          message: burnNote(helperId, saw),
          streamingBehavior: "steer",
          clientMessageId: `burn-${sessionId}-${now}`,
          timeZone: this.state.deps.zoneFor(sessionId),
        }),
        this.state.deps.limits.sendBoundMs,
        "telling the agent",
      );
    } catch (error) {
      console.warn(`[burn-guard] could not tell the agent of chat ${sessionId}:`, error instanceof Error ? error.message : error);
    }
  }

  /**
   * The line in the chat and the push. `automatic`: a helper is gone and the
   * chat carries on. `manual`: the run is stopped until the person sends a
   * message. `gave_up`: nothing could be stopped, and the person has to.
   * Each way of saying it stands alone: a full disk must not cost the push.
   */
  private async announce(recovery: EngineCrashRecovery, saw: string, now: number): Promise<void> {
    const { deps } = this.state;
    const session = this.session;
    const sessionId = session.sessionId;
    const notice: EngineCrashNotice = { reason: "token_burn", detail: saw, disk: null, quota: false, code: null, signal: null, recovery, at: now };
    const message = engineCrashSentence(notice);
    const say = async (what: string, run: () => unknown): Promise<void> => {
      try {
        await run();
      } catch (error) {
        console.warn(`[burn-guard] could not ${what}:`, error instanceof Error ? error.message : error);
      }
    };
    // Filed before the frame goes out, so a page that reloads on it finds the line.
    if (sessionId) await say("file the chat line", () => deps.record(sessionId, notice, now));
    // Not `engine_exit`: nothing died, and the run supervisor would take that reason for a crash to recover from.
    await say("put the line in the open chat", () => session.announce?.({ type: "notice", level: "warning", reason: "token_burn", message, crash: notice }));
    if (!sessionId) return;
    // The pop-up reads "<chat> stopped": true of a run, not of a chat that lost one helper.
    if (recovery !== "automatic") await say("raise the pop-up", () => deps.publish({ sessionId, title: null, notice }));
    await say("send the push", async () => {
      const chat = await deps.describeChat(sessionId, { sessionFile: session.sessionFile, cwd: session.cwd });
      deps.notify({ event: "error", sessionId, title: buildTitle("error", chat.title), body: buildBody(message), tags: chat.project ? [chat.project] : [] });
    });
  }
}

/** A sidebar chat is a side panel with no helpers and no long runs: it is never watched. */
export interface BurnWatchOptions {
  kind?: "sidebar";
}

function watchIn(state: BurnGuardState, session: EngineSession, options: BurnWatchOptions): void {
  if (options.kind === "sidebar" || typeof session.observeEvents !== "function") return;
  if (state.watched.has(session)) return;
  state.watched.add(session);
  const watch = new BurnWatch(state, session);
  watch.unobserve = session.observeEvents((event) => watch.handle(event));
  // Registered after the observer is held, because a session that is already closed calls this at once.
  session.onClose(() => watch.close());
}

/**
 * Start watching a live chat session for a token burn. Called by the session
 * manager next to the run supervisor, for every main omp chat and never a
 * sidebar chat.
 */
export function watchForTokenBurn(session: EngineSession, options: BurnWatchOptions = {}): void {
  watchIn(globalState(), session, options);
}

export interface BurnGuard {
  watch(session: EngineSession, options?: BurnWatchOptions): void;
}

/** A guard with its own state and collaborators: what the tests drive. */
export function createBurnGuard(overrides: BurnGuardOverrides = {}): BurnGuard {
  const state: BurnGuardState = { deps: resolveDeps(overrides), watched: new WeakSet() };
  return { watch: (session, options = {}) => watchIn(state, session, options) };
}
