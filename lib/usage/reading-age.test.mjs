import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const {
  READING_OUTDATED_AFTER_MS,
  isReadingOutdated,
  newestReadingTime,
  readingTimeOf,
  withOutdatedReadings,
  withoutElapsedWindows,
} = await jiti.import("./reading-age.ts");

/**
 * When a reading stops being the present. `omp usage --json` re-serves the
 * report it last saved for a login whose live fetch fails, so the age of the
 * numbers is the report's own `fetchedAt` (`measuredAt` on an account) and
 * never the moment Cody asked. Everything is clock-free: `now` is passed in.
 */

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MINUTE = 60_000;

const win = (overrides = {}) => ({ id: "w", label: "w", utilization: 10, resetsAt: null, state: "ok", windowMs: null, tier: null, shared: true, ...overrides });
const acct = (overrides = {}) => ({
  provider: "anthropic",
  id: "a",
  identity: null,
  credentialId: null,
  label: "Anthropic",
  planType: null,
  unlimited: false,
  windows: [win({ resetsAt: iso(T0 + 3 * 3_600_000) })],
  ...overrides,
});
const snap = (accounts, overrides = {}) => ({ available: true, accounts, fetchedAt: iso(T0), stale: false, ...overrides });

test("an account is as old as omp's own report time, with the carry-over stamp as the fallback", () => {
  assert.equal(readingTimeOf(acct({ measuredAt: iso(T0) })), T0);
  assert.equal(readingTimeOf(acct({ windowsStaleSince: iso(T0 - MINUTE) })), T0 - MINUTE);
  assert.equal(readingTimeOf(acct({ measuredAt: iso(T0), windowsStaleSince: iso(T0 - 10 * MINUTE) })), T0, "the measurement outranks the carry-over stamp");
  assert.equal(readingTimeOf(acct()), null, "an engine that prints no time makes no claim");
  assert.equal(readingTimeOf(acct({ measuredAt: "not a date" })), null);
  assert.equal(readingTimeOf(acct({ measuredAt: null })), null);
});

test("a snapshot is as current as its freshest enabled account", () => {
  const old = acct({ id: "old", measuredAt: iso(T0 - 5 * 24 * 60 * MINUTE) });
  const fresh = acct({ id: "fresh", measuredAt: iso(T0 - MINUTE) });
  const parked = acct({ id: "parked", measuredAt: iso(T0 + MINUTE), disabled: { cause: "logged out by user" } });
  assert.equal(newestReadingTime(snap([old, fresh, parked])), T0 - MINUTE, "a disabled login's time is not a reading");
  assert.equal(newestReadingTime(snap([old])), T0 - 5 * 24 * 60 * MINUTE);
  assert.equal(newestReadingTime(snap([acct()])), null);
  assert.equal(newestReadingTime(snap([])), null);
});

test("a reading is current for half an hour and out of date after it", () => {
  assert.equal(READING_OUTDATED_AFTER_MS, 30 * MINUTE);
  const account = acct({ measuredAt: iso(T0) });
  assert.equal(isReadingOutdated(account, T0), false);
  assert.equal(isReadingOutdated(account, T0 + READING_OUTDATED_AFTER_MS), false, "right at the limit it still stands");
  assert.equal(isReadingOutdated(account, T0 + READING_OUTDATED_AFTER_MS + 1), true);
});

test("a login with nothing to age is never called out of date", () => {
  const ancient = iso(T0 - 400 * 24 * 60 * MINUTE);
  assert.equal(isReadingOutdated(acct({ measuredAt: ancient, disabled: { cause: null } }), T0), false, "a disabled login carries no reading");
  assert.equal(isReadingOutdated(acct({ measuredAt: ancient, unlimited: true, windows: [] }), T0), false, "an unmetered login has no meter to age");
  assert.equal(isReadingOutdated(acct(), T0), false, "no recorded time, no claim");
});

test("windows whose reset has passed are dropped, and an account with none keeps its identity", () => {
  const spent = win({ id: "spent", resetsAt: iso(T0 - 1) });
  const running = win({ id: "running", resetsAt: iso(T0 + 1) });
  const open = win({ id: "open", resetsAt: null });
  const odd = win({ id: "odd", resetsAt: "not a date" });
  const account = acct({ windows: [spent, running, open, odd] });
  const live = withoutElapsedWindows(account, T0);
  assert.deepEqual(live.windows.map((window) => window.id), ["running", "open", "odd"], "a window with no usable reset time is kept: nothing says it ended");
  assert.equal(live.id, account.id);
  assert.equal(account.windows.length, 4, "the input is not mutated");
  assert.equal(withoutElapsedWindows(acct({ windows: [running] }), T0).windows.length, 1);
  const unchanged = acct({ windows: [running] });
  assert.equal(withoutElapsedWindows(unchanged, T0), unchanged, "nothing to drop returns the same account");
  assert.deepEqual(withoutElapsedWindows(acct({ windows: [spent] }), T0).windows, []);
  assert.deepEqual(withoutElapsedWindows({ ...acct(), windows: undefined }, T0).windows ?? [], []);
});

test("an out-of-date account is marked and loses the windows that have since reset", () => {
  const stale = acct({
    id: "stale",
    measuredAt: iso(T0 - 5 * 24 * 60 * MINUTE),
    windows: [
      win({ id: "anthropic:5h", resetsAt: iso(T0 - 5 * 24 * 60 * MINUTE + 3_600_000) }),
      win({ id: "anthropic:7d", resetsAt: iso(T0 + 2 * 24 * 60 * MINUTE) }),
    ],
  });
  const fresh = acct({ id: "fresh", measuredAt: iso(T0 - MINUTE) });
  const marked = withOutdatedReadings(snap([stale, fresh]), T0);
  assert.equal(marked.accounts[0].outdated, true);
  assert.deepEqual(marked.accounts[0].windows.map((window) => window.id), ["anthropic:7d"], "what is left is only what was last known");
  assert.equal(marked.accounts[1], fresh, "a current account is the very same object");
  assert.equal(stale.outdated, undefined, "the input is not mutated");
  assert.equal(stale.windows.length, 2);
});

test("an out-of-date account may end with no window at all, which is not a zero", () => {
  const marked = withOutdatedReadings(snap([acct({ measuredAt: iso(T0 - 3_600_000), windows: [win({ resetsAt: iso(T0 - 60_000) })] })]), T0);
  assert.equal(marked.accounts[0].outdated, true);
  assert.deepEqual(marked.accounts[0].windows, []);
});

test("marking changes nothing when every reading is current, and hands back the same snapshot", () => {
  const current = snap([acct({ measuredAt: iso(T0 - MINUTE) }), acct({ id: "no-time" })]);
  assert.equal(withOutdatedReadings(current, T0), current);
  const failed = { available: false, accounts: [], fetchedAt: iso(T0), stale: false, reason: "down" };
  assert.equal(withOutdatedReadings(failed, T0 + 99 * 24 * 60 * MINUTE), failed, "a failure has nothing to mark");
});

test("marking again later never resurrects a spent meter or marks anything twice", () => {
  const account = acct({
    measuredAt: iso(T0 - 40 * MINUTE),
    windows: [win({ id: "soon", resetsAt: iso(T0 + 10 * MINUTE) }), win({ id: "later", resetsAt: iso(T0 + 3_600_000) })],
  });
  const first = withOutdatedReadings(snap([account]), T0);
  assert.deepEqual(first.accounts[0].windows.map((window) => window.id), ["soon", "later"]);
  const second = withOutdatedReadings(first, T0 + 20 * MINUTE);
  assert.deepEqual(second.accounts[0].windows.map((window) => window.id), ["later"], "the window that reset in between is gone");
  assert.equal(second.accounts[0].outdated, true);
  assert.equal(withOutdatedReadings(second, T0 + 21 * MINUTE), second, "nothing further to drop: the same snapshot");
});

test("an account carried over from an earlier read ages by the reading it came from", () => {
  const carried = acct({ windowsStaleSince: iso(T0 - 45 * MINUTE) });
  const marked = withOutdatedReadings(snap([carried]), T0);
  assert.equal(marked.accounts[0].outdated, true);
  assert.equal(withOutdatedReadings(snap([acct({ windowsStaleSince: iso(T0 - 5 * MINUTE) })]), T0).accounts[0].outdated, undefined);
});
