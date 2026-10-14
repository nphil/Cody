import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The daily time limit's counting rules, with no browser, no server and no
 * real clock: the active window and its 60 s grace, what a hidden, blurred or
 * idle page counts (nothing), the union of two tabs or devices reporting the
 * same seconds, and the reset at local midnight in a time zone.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ACTIVE_GRACE_MS, BEAT_INTERVAL_MS, createActivityTracker, createBeatController } = await jiti.import("./active-time.ts");
const { DAY_MS, MERGE_GAP_MS, addInterval, localDayBounds, localDayKey, measureWithin, normalizeLedger, pruneLedger } = await jiti.import("./ledger.ts");
const { beatInterval, computeDailyLimitState, parseBeat } = await jiti.import("./state.ts");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// The active window and its grace
// ---------------------------------------------------------------------------

/** A tracker whose page is visible and focused. */
function present(graceMs) {
  const tracker = createActivityTracker(graceMs);
  tracker.setPresent(true, 0);
  return tracker;
}

test("one input makes the page active for exactly the 60 s grace, then counting stops by itself", () => {
  const tracker = present();
  assert.equal(ACTIVE_GRACE_MS, 60 * SECOND);
  assert.equal(tracker.input(10 * SECOND), null);
  assert.equal(tracker.isActive(10 * SECOND), true);
  assert.equal(tracker.isActive(69_999), true, "still inside the grace");
  assert.equal(tracker.isActive(70 * SECOND), false, "the grace is spent at last input + 60 s");

  // Looked at 30 s after it ran out: 60 s were active, and they ended 30 s ago.
  assert.deepEqual(tracker.flush(100 * SECOND), { activeSeconds: 60, endedSecondsAgo: 30 });
  assert.equal(tracker.flush(200 * SECOND), null, "nothing more is owed");
});

test("every further input pushes the end out, so reading with the odd scroll or key keeps counting", () => {
  const tracker = present();
  tracker.input(0);
  tracker.input(50 * SECOND);
  tracker.input(100 * SECOND);
  // Active from the first input to the last input + 60 s.
  assert.deepEqual(tracker.flush(500 * SECOND), { activeSeconds: 160, endedSecondsAgo: 340 });
});

test("a page that is visible and focused but gets no input counts nothing, however long it sits", () => {
  const tracker = present();
  for (const at of [1, 30 * SECOND, 5 * MINUTE, 3 * HOUR]) {
    assert.equal(tracker.flush(at), null);
    assert.equal(tracker.isActive(at), false);
  }
});

test("hiding or blurring the page stops counting at that instant, not a minute later", () => {
  const tracker = present();
  tracker.input(0);
  tracker.input(8 * SECOND);
  // The tab goes to the background 10 s in: only those 10 s are active.
  assert.deepEqual(tracker.setPresent(false, 10 * SECOND), { activeSeconds: 10, endedSecondsAgo: 0 });
  assert.equal(tracker.isActive(10 * SECOND), false);
  assert.equal(tracker.flush(5 * MINUTE), null, "the grace left over is NOT banked");
});

test("input that arrives while the page is hidden or blurred is ignored, and so is the grace it would have earned", () => {
  const tracker = createActivityTracker();
  // Never present: a pointer moving over a visible but unfocused window.
  assert.equal(tracker.input(5 * SECOND), null);
  assert.equal(tracker.flush(30 * SECOND), null);

  tracker.setPresent(true, 40 * SECOND);
  tracker.input(41 * SECOND);
  tracker.setPresent(false, 44 * SECOND);
  tracker.input(50 * SECOND);
  assert.equal(tracker.flush(300 * SECOND), null);
});

test("coming back counts nothing until the first real input: switching tabs is not input", () => {
  const tracker = present();
  tracker.input(0);
  tracker.setPresent(false, 10 * SECOND);
  assert.equal(tracker.setPresent(true, 5 * MINUTE), null);
  assert.equal(tracker.isActive(5 * MINUTE + 1), false);
  assert.equal(tracker.flush(6 * MINUTE), null);
  tracker.input(7 * MINUTE);
  assert.deepEqual(tracker.flush(7 * MINUTE + 20 * SECOND), { activeSeconds: 20, endedSecondsAgo: 0 });
});

test("a stretch that ran out before the next input is closed at its own end, so the quiet in between never counts", () => {
  const tracker = present();
  tracker.input(0);
  // 100 s later: the first stretch (0–60 s) lapsed 40 s ago and is reported now.
  assert.deepEqual(tracker.input(100 * SECOND), { activeSeconds: 60, endedSecondsAgo: 40 });
  assert.deepEqual(tracker.flush(130 * SECOND), { activeSeconds: 30, endedSecondsAgo: 0 });
  // 60 + 30 = 90 s of the 130 s on the clock.
});

test("reports from a 15 s heartbeat chain with no gap and no overlap, and add up to the stretch", () => {
  const tracker = present();
  tracker.input(0);
  let total = 0;
  for (const at of [15, 30, 45, 60, 75].map((s) => s * SECOND)) {
    const report = tracker.flush(at);
    if (report) total += report.activeSeconds;
  }
  assert.equal(total, 60);
});

test("a tracker given a shorter grace honours it", () => {
  const tracker = present(10 * SECOND);
  tracker.input(0);
  assert.deepEqual(tracker.flush(60 * SECOND), { activeSeconds: 10, endedSecondsAgo: 50 });
});

// ---------------------------------------------------------------------------
// A whole afternoon, against a fake clock and a fake network
// ---------------------------------------------------------------------------

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const timers = new Set();
  return {
    now: () => now,
    every(ms, fn) {
      const timer = { ms, fn, next: now + ms };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    /** Advance, running every timer that falls due on the way, in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.fn();
      }
      now = end;
    },
    timers: () => timers.size,
  };
}

/** A beat as the server places it: received at `serverNow`, merged into `ledger`. */
function land(ledger, report, serverNow) {
  const beat = parseBeat(report);
  const interval = beat && beatInterval(beat, serverNow);
  return interval ? addInterval(ledger, interval[0], interval[1]) : ledger;
}

/** One device: its own clock, a controller, and a shared server ledger it reports into. */
function device(clock, server, { skew = 0 } = {}) {
  const sent = [];
  const controller = createBeatController({
    now: () => clock.now() + skew,
    every: (ms, fn) => clock.every(ms, fn),
    send: (report, final) => {
      sent.push({ report, final });
      server.ledger = land(server.ledger, report, clock.now());
    },
  });
  return { controller, sent };
}

const counted = (server) => measureWithin(server.ledger, -Infinity, Infinity) / SECOND;

test("an active page reports every 15 s, and the server's total is exactly the active time plus the grace", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const tab = device(clock, server);
  tab.controller.setPresent(true);
  assert.equal(BEAT_INTERVAL_MS, 15 * SECOND);

  // Typing and clicking for 40 s: an input every 5 s.
  for (let i = 0; i < 9; i += 1) {
    tab.controller.input();
    clock.advance(5 * SECOND);
  }
  clock.advance(10 * MINUTE);
  // Inputs at 0, 5 … 40 s: the stretch runs from the first input to the last
  // one + 60 s grace, so 0 → 100 s.
  assert.equal(counted(server), 100);
  assert.ok(tab.sent.every(({ report }) => report.activeSeconds <= 15), "each report is one beat or less");
  assert.equal(server.ledger.length, 1, "consecutive beats merge into one stretch");
});

test("no timer exists while the page is idle or hidden", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const tab = device(clock, server);
  tab.controller.setPresent(true);
  assert.equal(tab.controller.timerRunning(), false, "visible and focused but untouched: no timer");
  assert.equal(clock.timers(), 0);

  tab.controller.input();
  assert.equal(tab.controller.timerRunning(), true);
  assert.equal(clock.timers(), 1);

  // The grace runs out; the next tick sees it and stops the timer.
  clock.advance(ACTIVE_GRACE_MS + BEAT_INTERVAL_MS);
  assert.equal(tab.controller.timerRunning(), false);
  assert.equal(clock.timers(), 0);
  assert.equal(counted(server), 60);

  tab.controller.input();
  assert.equal(clock.timers(), 1);
  tab.controller.setPresent(false); // the tab is hidden
  assert.equal(tab.controller.timerRunning(), false, "hiding takes the timer with it");
  assert.equal(clock.timers(), 0);
  const before = tab.sent.length;
  clock.advance(HOUR);
  assert.equal(tab.sent.length, before, "an hour in the background reports nothing");
});

test("an agent streaming into a page nobody is touching counts nothing", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const tab = device(clock, server);
  tab.controller.setPresent(true);
  // The chat's own auto-scroll and the streamed words are not user input, so
  // the controller is never told about any of it. Three hours go by.
  clock.advance(3 * HOUR);
  assert.equal(counted(server), 0);
  assert.equal(tab.sent.length, 0);
  assert.equal(clock.timers(), 0);
});

test("a blurred window and a hidden tab count nothing even while the pointer moves over them", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const tab = device(clock, server);
  tab.controller.setPresent(true);
  tab.controller.input();
  clock.advance(5 * SECOND);
  tab.controller.setPresent(false); // focus moved to another window
  for (let i = 0; i < 100; i += 1) {
    tab.controller.input(); // the pointer over the still-visible window
    clock.advance(SECOND);
  }
  assert.equal(counted(server), 5);
});

test("closing the page reports what is owed, marked final so it can go as a beacon", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const tab = device(clock, server);
  tab.controller.setPresent(true);
  tab.controller.input();
  clock.advance(7 * SECOND);
  tab.controller.dispose();
  assert.equal(counted(server), 7);
  assert.equal(tab.sent.at(-1).final, true);
  assert.equal(clock.timers(), 0);
});

// ---------------------------------------------------------------------------
// Two tabs, two devices: one union
// ---------------------------------------------------------------------------

test("two tabs active at overlapping times count each wall-clock second once", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const first = device(clock, server);
  const second = device(clock, server);
  first.controller.setPresent(true);
  second.controller.setPresent(true);

  // Tab A: inputs at 0, 20, 40 s → active 0–100 s. Tab B: inputs at 30, 50, 70 s → active 30–130 s.
  const script = [[0, first], [20, first], [30, second], [40, first], [50, second], [70, second]];
  let at = 0;
  for (const [second_, tab] of script) {
    clock.advance((second_ - at) * SECOND);
    at = second_;
    tab.controller.input();
  }
  clock.advance(10 * MINUTE);

  assert.equal(counted(server), 130, "the union of 0–100 and 30–130, not their 200 s sum");
});

test("the same seconds reported by two devices add nothing, even when one device's clock is ten minutes off", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const pc = device(clock, server);
  const tablet = device(clock, server, { skew: 10 * MINUTE });
  pc.controller.setPresent(true);
  tablet.controller.setPresent(true);
  for (let i = 0; i < 12; i += 1) {
    pc.controller.input();
    tablet.controller.input();
    clock.advance(5 * SECOND);
  }
  clock.advance(10 * MINUTE);
  // Reports are durations ("how long, and how long ago"), so a wrong device
  // clock cannot move them: 55 s of inputs + the 60 s grace, counted once.
  assert.equal(counted(server), 115);
});

test("the tablet and the PC in turn add up", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const pc = device(clock, server);
  const tablet = device(clock, server);
  pc.controller.setPresent(true);
  tablet.controller.setPresent(true);
  pc.controller.input();
  clock.advance(20 * SECOND);
  pc.controller.setPresent(false); // walks away from the PC after 20 s
  tablet.controller.input();
  clock.advance(30 * SECOND);
  tablet.controller.setPresent(false);
  clock.advance(HOUR);
  assert.equal(counted(server), 50);
});

test("a report that lands late is placed where it was, not where it arrived", () => {
  const clock = makeClock();
  const server = { ledger: [] };
  const end = clock.now();
  // A 20 s stretch that ended 45 s ago, reaching the server now.
  server.ledger = land(server.ledger, { activeSeconds: 20, endedSecondsAgo: 45 }, end);
  assert.deepEqual(server.ledger, [[end - 65 * SECOND, end - 45 * SECOND]]);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("addInterval merges overlaps and neighbours within a second, keeps real gaps, and never changes its input", () => {
  const base = Object.freeze([[0, 10_000], [30_000, 40_000]].map((entry) => Object.freeze(entry)));
  assert.deepEqual(addInterval(base, 5_000, 20_000), [[0, 20_000], [30_000, 40_000]]);
  assert.deepEqual(addInterval(base, 10_000 + MERGE_GAP_MS, 12_000), [[0, 12_000], [30_000, 40_000]], "touching within the gap merges");
  assert.deepEqual(addInterval(base, 10_000 + MERGE_GAP_MS + 1, 12_000), [[0, 10_000], [11_001, 12_000], [30_000, 40_000]], "a bigger gap stays a gap");
  assert.deepEqual(addInterval(base, 9_000, 35_000), [[0, 40_000]], "one interval bridging two");
  assert.deepEqual(addInterval(base, -5_000, -2_000), [[-5_000, -2_000], [0, 10_000], [30_000, 40_000]], "before everything");
  assert.deepEqual(addInterval(base, 50_000, 60_000), [[0, 10_000], [30_000, 40_000], [50_000, 60_000]], "after everything");
  assert.deepEqual(addInterval(base, 1_000, 2_000), [[0, 10_000], [30_000, 40_000]], "inside one: nothing new");
  assert.deepEqual(addInterval(base, 20_000, 20_000), [[0, 10_000], [30_000, 40_000]], "empty");
  assert.deepEqual(addInterval(base, 20_000, 10_000), [[0, 10_000], [30_000, 40_000]], "backwards");
  assert.deepEqual(addInterval([], 1_000, 2_000), [[1_000, 2_000]]);
  assert.deepEqual(base, [[0, 10_000], [30_000, 40_000]]);
});

test("a day of beats stays a handful of intervals, however the network delays them", () => {
  let ledger = [];
  let at = 1_700_000_000_000;
  // 8 hours of 15 s beats whose arrival jitters by up to ±300 ms each way.
  for (let i = 0; i < (8 * HOUR) / (15 * SECOND); i += 1) {
    const jitter = ((i * 7919) % 600) - 300;
    ledger = addInterval(ledger, at + jitter, at + 15 * SECOND + jitter);
    at += 15 * SECOND;
  }
  assert.equal(ledger.length, 1);
});

test("pruneLedger drops what is older than the window, clips what straddles it, and caps the count", () => {
  const now = 100 * DAY_MS;
  const ledger = [
    [now - 20 * DAY_MS, now - 19 * DAY_MS],
    [now - 14 * DAY_MS - HOUR, now - 14 * DAY_MS + HOUR],
    [now - 2 * DAY_MS, now - 2 * DAY_MS + HOUR],
  ];
  assert.deepEqual(pruneLedger(ledger, now), [
    [now - 14 * DAY_MS, now - 14 * DAY_MS + HOUR],
    [now - 2 * DAY_MS, now - 2 * DAY_MS + HOUR],
  ]);
  const many = Array.from({ length: 10 }, (_, i) => [now - (10 - i) * HOUR, now - (10 - i) * HOUR + MINUTE]);
  assert.deepEqual(pruneLedger(many, now, DAY_MS, 3), many.slice(-3));
});

test("normalizeLedger turns anything into a clean ledger without throwing", () => {
  const now = 1_000_000;
  assert.deepEqual(normalizeLedger(undefined, now), []);
  assert.deepEqual(normalizeLedger("nope", now), []);
  assert.deepEqual(
    normalizeLedger([[500, 900], [100, 300], [250, 400], ["a", 5], [1, Number.NaN], [7], null, [900, 800], [now - 10, now + 5_000]], now),
    [[100, 400], [500, 900], [now - 10, now]],
    "unsorted and overlapping intervals merge, junk and backwards ones go, nothing reaches into the future",
  );
});

// ---------------------------------------------------------------------------
// What a beat may claim
// ---------------------------------------------------------------------------

test("a beat is capped at 90 s, never ends in the future, and a nonsense one is refused", () => {
  assert.deepEqual(parseBeat({ activeSeconds: 15 }), { activeMs: 15_000, endedAgoMs: 0 });
  assert.deepEqual(parseBeat({ activeSeconds: 500 }), { activeMs: 90_000, endedAgoMs: 0 }, "capped, not refused");
  assert.deepEqual(parseBeat({ activeSeconds: 12.3456, endedSecondsAgo: 3.2 }), { activeMs: 12_346, endedAgoMs: 3_200 });
  assert.deepEqual(parseBeat({ activeSeconds: 5, endedSecondsAgo: 99_999 }), { activeMs: 5_000, endedAgoMs: 120_000 });
  for (const bad of [null, undefined, "x", 4, [], {}, { activeSeconds: 0 }, { activeSeconds: -3 }, { activeSeconds: Number.NaN }, { activeSeconds: Infinity }, { activeSeconds: "9" }, { activeSeconds: 5, endedSecondsAgo: -1 }, { activeSeconds: 5, endedSecondsAgo: "1" }]) {
    assert.equal(parseBeat(bad), null, JSON.stringify(bad));
  }
  const now = 1_700_000_000_000;
  assert.deepEqual(beatInterval({ activeMs: 15_000, endedAgoMs: 0 }, now), [now - 15_000, now]);
  assert.deepEqual(beatInterval({ activeMs: 15_000, endedAgoMs: 4_000 }, now), [now - 19_000, now - 4_000]);
});

// ---------------------------------------------------------------------------
// The day, and the reset at local midnight
// ---------------------------------------------------------------------------

test("the same instant is a different day in different zones, and the day's edges are exact", () => {
  const instant = Date.UTC(2026, 9, 13, 3, 30); // 03:30 UTC
  assert.equal(localDayKey(instant, "UTC"), "2026-10-13");
  assert.equal(localDayKey(instant, "Asia/Tokyo"), "2026-10-13", "12:30 in Tokyo");
  assert.equal(localDayKey(instant, "America/New_York"), "2026-10-12", "23:30 the evening before in New York");

  const tokyo = localDayBounds(instant, "Asia/Tokyo");
  assert.deepEqual(tokyo, { day: "2026-10-13", start: Date.UTC(2026, 9, 12, 15), end: Date.UTC(2026, 9, 13, 15) });
  assert.equal(localDayKey(tokyo.start - 1, "Asia/Tokyo"), "2026-10-12", "one millisecond before midnight is yesterday");
  assert.equal(localDayKey(tokyo.start, "Asia/Tokyo"), "2026-10-13");
  assert.equal(localDayKey(tokyo.end - 1, "Asia/Tokyo"), "2026-10-13");
  assert.equal(localDayKey(tokyo.end, "Asia/Tokyo"), "2026-10-14");

  const newYork = localDayBounds(instant, "America/New_York");
  assert.deepEqual(newYork, { day: "2026-10-12", start: Date.UTC(2026, 9, 12, 4), end: Date.UTC(2026, 9, 13, 4) });

  const kolkata = localDayBounds(instant, "Asia/Kolkata");
  assert.equal(kolkata.start, Date.UTC(2026, 9, 12, 18, 30), "a half-hour zone's midnight is 18:30 UTC");
});

test("a day is 25 or 23 hours long when the clocks change, and its edges still land on local midnight", () => {
  const fallBack = localDayBounds(Date.UTC(2026, 10, 1, 12), "America/New_York");
  assert.equal(fallBack.day, "2026-11-01");
  assert.equal((fallBack.end - fallBack.start) / HOUR, 25);
  assert.equal(fallBack.start, Date.UTC(2026, 10, 1, 4), "midnight EDT");
  assert.equal(fallBack.end, Date.UTC(2026, 10, 2, 5), "the next midnight is EST");

  const springForward = localDayBounds(Date.UTC(2026, 2, 8, 20), "America/New_York");
  assert.equal(springForward.day, "2026-03-08");
  assert.equal((springForward.end - springForward.start) / HOUR, 23);

  // Havana's clocks change at midnight itself: a date can start late, or twice.
  const havana = localDayBounds(Date.UTC(2026, 2, 8, 12), "America/Havana");
  assert.equal(localDayKey(havana.start, "America/Havana"), havana.day);
  assert.notEqual(localDayKey(havana.start - 1, "America/Havana"), havana.day);
  assert.notEqual(localDayKey(havana.end, "America/Havana"), havana.day);
});

const SETTINGS = { enabled: true, limitMinutes: 120 };

test("usage resets at local midnight: an interval across it counts yesterday's part yesterday and only the rest today", () => {
  const zone = "Asia/Tokyo";
  const midnight = Date.UTC(2026, 9, 12, 15); // 00:00 on the 13th in Tokyo
  const ledger = addInterval([], midnight - 4 * MINUTE, midnight + 3 * MINUTE); // 23:56 → 00:03
  const stateAt = (now) => computeDailyLimitState({ settings: SETTINGS, ledger, days: {}, now, zone });

  const before = stateAt(midnight - 30 * SECOND);
  assert.equal(before.day, "2026-10-12");
  assert.equal(before.usedSeconds, 210, "23:56:00 → 23:59:30");

  const after = stateAt(midnight + 5 * MINUTE);
  assert.equal(after.day, "2026-10-13");
  assert.equal(after.usedSeconds, 180, "only 00:00 → 00:03 belongs to the new day");
  assert.equal(after.remainingSeconds, 120 * 60 - 180);

  const later = stateAt(midnight + 6 * HOUR);
  assert.equal(later.usedSeconds, 180);
  assert.equal(stateAt(midnight + 24 * HOUR + MINUTE).usedSeconds, 0, "and the day after starts from nothing");
});

test("the day follows the person's zone: New York has reset while it is still the same day in Tokyo", () => {
  const ledger = [[Date.UTC(2026, 9, 13, 2), Date.UTC(2026, 9, 13, 3, 30)]]; // 1.5 h
  const read = (now, zone) => computeDailyLimitState({ settings: SETTINGS, ledger, days: {}, now, zone });

  const before = Date.UTC(2026, 9, 13, 3, 45); // 23:45 on the 12th in New York, 12:45 on the 13th in Tokyo
  assert.equal(read(before, "America/New_York").day, "2026-10-12");
  assert.equal(read(before, "America/New_York").usedSeconds, 5400);
  assert.equal(read(before, "Asia/Tokyo").day, "2026-10-13");
  assert.equal(read(before, "Asia/Tokyo").usedSeconds, 5400);

  const after = Date.UTC(2026, 9, 13, 4, 15); // 00:15 on the 13th in New York
  assert.equal(read(after, "America/New_York").day, "2026-10-13");
  assert.equal(read(after, "America/New_York").usedSeconds, 0, "New York's midnight has passed: a fresh day");
  assert.equal(read(after, "Asia/Tokyo").usedSeconds, 5400, "Tokyo is mid-afternoon of the same day");
});

test("the limit, what is left, 'Add 15 minutes' and the notice, as the day goes", () => {
  const zone = "UTC";
  const dayStart = Date.UTC(2026, 9, 13);
  const at = (hours) => dayStart + hours * HOUR;
  const state = (used, days = {}, settings = SETTINGS) => computeDailyLimitState({ settings, ledger: used ? [[at(8), at(8) + used * SECOND]] : [], days, now: at(20), zone });

  assert.deepEqual(
    [state(0).usedSeconds, state(0).limitSeconds, state(0).remainingSeconds, state(0).noticeDue],
    [0, 7200, 7200, false],
  );
  assert.equal(state(6000).remainingSeconds, 1200);
  assert.equal(state(7200).remainingSeconds, 0);
  assert.equal(state(7200).noticeDue, true, "reached: the notice is due");
  assert.equal(state(7920).remainingSeconds, -720, "12 minutes over");

  // "Done for today" at the 2 h limit: it stays dismissed while that is the limit…
  const done = { "2026-10-13": { extraSeconds: 0, noticeDismissedAtSeconds: 7200 } };
  assert.equal(state(7920, done).noticeDue, false);
  // …"Add 15 minutes" raises today's limit, which is no longer reached…
  const added = { "2026-10-13": { extraSeconds: 900, noticeDismissedAtSeconds: 7200 } };
  assert.equal(state(7920, added).limitSeconds, 8100);
  assert.equal(state(7920, added).remainingSeconds, 180);
  assert.equal(state(7920, added).noticeDue, false);
  // …and reaching the NEW limit is a new occasion for the notice.
  assert.equal(state(8100, added).noticeDue, true);
  // A different day inherits neither the extra time nor the dismissal.
  assert.equal(computeDailyLimitState({ settings: SETTINGS, ledger: [], days: added, now: at(20) + DAY_MS, zone }).limitSeconds, 7200);
  // Switched off: no notice, whatever was used.
  assert.equal(state(7200, {}, { enabled: false, limitMinutes: 120 }).noticeDue, false);
});
