/**
 * What counts as "actively using Cody", as plain logic with the clock and the
 * network passed in. The browser hook (`hooks/useDailyLimit.ts`) only turns DOM
 * events into the calls below; everything that decides what is counted is here
 * so a unit test can run a whole afternoon in a millisecond.
 *
 * THE RULE. A second counts when the page can be seen AND has focus AND there
 * was real user input within the last `ACTIVE_GRACE_MS` (60 s). The grace is
 * what lets reading a long reply — no key, no click — keep counting; the
 * conditions are what stop everything else:
 *   - an agent streaming into a tab nobody touches: no input, so no time;
 *   - a hidden tab, a blurred window, a locked screen: not present, so no time
 *     (and input that arrives anyway, such as a pointer moving over an
 *     unfocused window, is ignored rather than banked);
 *   - an idle screen: the grace runs out and counting stops by itself.
 *
 * A person who looks away stops counting AT THAT INSTANT, not a minute later:
 * hiding or blurring closes the running stretch there. Coming back counts
 * nothing until the first real input (switching tabs is not input).
 *
 * WHAT IS REPORTED. Never "I was active", always a finished piece of time
 * measured on this device's own clock: `{ activeSeconds, endedSecondsAgo }` —
 * how long, and how long before the moment of sending it ended. The server
 * places it on ITS clock (`end = now - endedSecondsAgo`), so a tablet whose
 * clock is minutes off still lands on the right wall-clock seconds, and two
 * devices' reports can be merged into one union (`ledger.ts`).
 */

/** Input within this long keeps a visible, focused page counting. */
export const ACTIVE_GRACE_MS = 60_000;

/** How often an active page reports. Small enough that a closed tab loses
 * little, large enough that a day of use is a few hundred cheap requests. */
export const BEAT_INTERVAL_MS = 15_000;

/** One finished piece of active time, as it goes over the wire. */
export interface ActivityReport {
  /** How long the person was active, in seconds (never more than the server's cap). */
  activeSeconds: number;
  /** How long before this report is sent that stretch ended, in seconds. 0 when
   * the person is active right now. */
  endedSecondsAgo: number;
}

export interface ActivityTracker {
  /** Real user input at `at`. Ignored while the page is not present. The
   * report, if any, is a stretch that had already lapsed before this input. */
  input(at: number): ActivityReport | null;
  /** The page became (or stopped being) visible and focused at `at`. Going
   * away closes the running stretch there and returns what it had not reported. */
  setPresent(present: boolean, at: number): ActivityReport | null;
  /** What has been active since the last report, up to `now` or the end of the
   * grace, whichever comes first. Null when there is nothing new. */
  flush(now: number): ActivityReport | null;
  /** Whether a report could still be owed: present, and inside the grace. */
  isActive(now: number): boolean;
}

export function createActivityTracker(graceMs: number = ACTIVE_GRACE_MS): ActivityTracker {
  let present = false;
  /** The first input of the stretch being counted; null between stretches. */
  let stretchStart: number | null = null;
  /** The last input plus the grace: the stretch's end if nothing else happens. */
  let activeUntil = 0;
  /** How far this tracker has already reported. */
  let reportedUntil = 0;

  /** Report what is unreported up to `now`; end the stretch if its grace is spent. */
  const take = (now: number): ActivityReport | null => {
    if (stretchStart === null) return null;
    const to = Math.min(now, activeUntil);
    const from = Math.max(reportedUntil, stretchStart);
    if (now >= activeUntil) stretchStart = null;
    if (to <= from) return null;
    reportedUntil = to;
    return { activeSeconds: (to - from) / 1000, endedSecondsAgo: (now - to) / 1000 };
  };

  return {
    input(at) {
      if (!present) return null;
      let lapsed: ActivityReport | null = null;
      // The earlier stretch ran out before this input: close it at its own
      // end first, so the quiet in between is never counted.
      if (stretchStart !== null && at >= activeUntil) lapsed = take(at);
      if (stretchStart === null) {
        stretchStart = at;
        activeUntil = at + graceMs;
      } else {
        activeUntil = Math.max(activeUntil, at + graceMs);
      }
      return lapsed;
    },
    setPresent(next, at) {
      if (next === present) return null;
      present = next;
      if (next) return null;
      const closed = take(at);
      stretchStart = null;
      return closed;
    },
    flush: take,
    isActive(now) {
      return present && stretchStart !== null && now < activeUntil;
    },
  };
}

export interface BeatControllerOptions {
  now: () => number;
  /** Run `fn` every `ms` until the returned function is called. */
  every: (ms: number, fn: () => void) => () => void;
  /** Hand a report to the network. `final` is true when the page is going away
   * (hidden, blurred, closing), which is when a plain request may not survive. */
  send: (report: ActivityReport, final: boolean) => void;
  intervalMs?: number;
  graceMs?: number;
}

export interface BeatController {
  /** A real user input just happened. */
  input(): void;
  /** The page is now visible and focused (true) or is not (false). */
  setPresent(present: boolean): void;
  /** Stop for good, reporting what is owed. */
  dispose(): void;
  /** Whether the repeating timer is running — it must not be while the page is hidden or idle. */
  timerRunning(): boolean;
}

/**
 * Wires a tracker to a clock and a timer. The timer exists ONLY while a stretch
 * can still be reported: it starts at the first input, and stops as soon as the
 * stretch ends (the grace ran out, or the page was hidden or blurred). A hidden
 * or idle tab therefore owns no timer at all.
 */
export function createBeatController(options: BeatControllerOptions): BeatController {
  const tracker = createActivityTracker(options.graceMs);
  const intervalMs = options.intervalMs ?? BEAT_INTERVAL_MS;
  let cancel: (() => void) | null = null;

  const syncTimer = () => {
    if (tracker.isActive(options.now())) {
      if (!cancel) cancel = options.every(intervalMs, tick);
    } else if (cancel) {
      cancel();
      cancel = null;
    }
  };
  function tick() {
    const report = tracker.flush(options.now());
    if (report) options.send(report, false);
    syncTimer();
  }

  return {
    input() {
      const report = tracker.input(options.now());
      if (report) options.send(report, false);
      syncTimer();
    },
    setPresent(present) {
      const report = tracker.setPresent(present, options.now());
      if (report) options.send(report, true);
      syncTimer();
    },
    dispose() {
      const report = tracker.setPresent(false, options.now());
      if (report) options.send(report, true);
      syncTimer();
    },
    timerRunning: () => cancel !== null,
  };
}
