import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { QUOTA_HISTORY_MAX_AGE_MS, parseQuotaHistory, pruneQuotaHistory, readQuotaHistory, recordQuotaReadings } = await jiti.import("./quota-history.ts");
const { calibrateQuota } = await jiti.import("./quota-calibration.ts");

/**
 * The quota calibration history (a bounded log of percent used per account window) and the calculator that turns it,
 * with token rows, into tokens per percent. Everything is clock-free: `readAt` and `now` are passed in.
 */

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-quota-history-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const freshFile = () => path.join(dir, `history-${(counter += 1)}.jsonl`);

const win = (overrides = {}) => ({ id: "anthropic:5h", label: "5-hour window", utilization: 10, resetsAt: iso(T0 + 4 * HOUR), state: "ok", windowMs: 5 * HOUR, tier: null, shared: true, ...overrides });
const acct = (overrides = {}) => ({
  provider: "anthropic",
  id: "acct-a",
  identity: null,
  credentialId: 11,
  label: "Anthropic",
  planType: null,
  unlimited: false,
  windows: [win()],
  measuredAt: iso(T0),
  ...overrides,
});
const snap = (accounts, overrides = {}) => ({ available: true, accounts, fetchedAt: iso(T0), stale: false, ...overrides });

// ---- the store -----------------------------------------------------------------------------------------------

test("a fresh reading is written once, and an unchanged re-served one is not written again", () => {
  const file = freshFile();
  assert.equal(recordQuotaReadings(snap([acct()]), T0, file), 1);
  assert.equal(recordQuotaReadings(snap([acct()]), T0 + MIN, file), 0, "the same report, measured at the same time");
  assert.equal(recordQuotaReadings(snap([acct({ measuredAt: iso(T0 + MIN) })]), T0 + MIN, file), 0, "newer measurement, same numbers");
  assert.equal(recordQuotaReadings(snap([acct({ measuredAt: iso(T0 + 2 * MIN), windows: [win({ utilization: 12 })] })]), T0 + 2 * MIN, file), 1);
  const points = readQuotaHistory({ file });
  assert.deepEqual(points.map((point) => [point.t, point.u]), [[T0, 10], [T0 + 2 * MIN, 12]]);
  assert.deepEqual(points[0], { t: T0, p: "anthropic", a: "acct-a", c: 11, w: "anthropic:5h", u: 10, r: T0 + 4 * HOUR });
});

test("a reading is never written when it is old, carried over, blocked, disabled, unlimited, or older than the one kept", () => {
  const file = freshFile();
  const readAt = T0 + 2 * HOUR;
  const none = (account) => assert.equal(recordQuotaReadings(snap([account]), readAt, file), 0);
  none(acct({ measuredAt: iso(T0) }));
  none(acct({ measuredAt: iso(readAt), windowsStaleSince: iso(readAt - MIN) }));
  none(acct({ measuredAt: iso(readAt), outdated: true }));
  none(acct({ measuredAt: iso(readAt), disabled: { cause: "auth" } }));
  none(acct({ measuredAt: iso(readAt), unlimited: true }));
  none(acct({ measuredAt: iso(readAt), windows: [win({ source: "block", utilization: 100 })] }));
  none(acct({ measuredAt: iso(readAt + HOUR) }));
  assert.equal(recordQuotaReadings(snap([], { available: false }), readAt, file), 0);
  assert.equal(recordQuotaReadings(snap([acct({ measuredAt: iso(readAt) })]), readAt, file), 1);
  assert.equal(recordQuotaReadings(snap([acct({ measuredAt: iso(readAt - MIN), windows: [win({ utilization: 3 })] })]), readAt, file), 0, "never back in time");
  assert.equal(readQuotaHistory({ file }).length, 1);
});

test("a reading without a measurement time counts from when it was read", () => {
  const file = freshFile();
  assert.equal(recordQuotaReadings(snap([acct({ measuredAt: null })]), T0, file), 1);
  assert.equal(readQuotaHistory({ file })[0].t, T0);
});

test("a reset is written even when the percentage did not change, and a reset time that only rounds is not", () => {
  const file = freshFile();
  const reading = (minutes, utilization, resetsAt) => snap([acct({ measuredAt: iso(T0 + minutes * MIN), windows: [win({ utilization, resetsAt: resetsAt === null ? null : iso(resetsAt) })] })]);
  recordQuotaReadings(reading(0, 80, T0 + HOUR), T0, file);
  assert.equal(recordQuotaReadings(reading(1, 80, T0 + HOUR + 20_000), T0 + MIN, file), 0, "a 20 s drift of the reset time is the same reset");
  assert.equal(recordQuotaReadings(reading(70, 3, T0 + 6 * HOUR), T0 + 70 * MIN, file), 1, "the window reset and started again");
  assert.equal(recordQuotaReadings(reading(80, 3, T0 + 12 * HOUR), T0 + 80 * MIN, file), 1, "same percentage, a new reset time");
  assert.deepEqual(readQuotaHistory({ file }).map((point) => point.u), [80, 3, 3]);
});

test("each account and window is tracked on its own", () => {
  const file = freshFile();
  const both = snap([
    acct({ windows: [win(), win({ id: "anthropic:7d", utilization: 40 })] }),
    acct({ id: "acct-b", credentialId: 12, windows: [win({ utilization: 10 })] }),
  ]);
  assert.equal(recordQuotaReadings(both, T0, file), 3);
  assert.equal(recordQuotaReadings(both, T0 + MIN, file), 0);
  const moved = snap([acct({ measuredAt: iso(T0 + MIN), windows: [win(), win({ id: "anthropic:7d", utilization: 41 })] }), acct({ id: "acct-b", credentialId: 12, measuredAt: iso(T0 + MIN), windows: [win({ utilization: 10 })] })]);
  assert.equal(recordQuotaReadings(moved, T0 + MIN, file), 1);
});

test("what was written last is learned from the file, so a restart does not repeat it", () => {
  const file = freshFile();
  recordQuotaReadings(snap([acct()]), T0, file);
  delete globalThis.__codyQuotaHistoryLast;
  assert.equal(recordQuotaReadings(snap([acct({ measuredAt: iso(T0 + MIN) })]), T0 + MIN, file), 0);
});

test("pruning drops what is older than 90 days, then the oldest lines past the size limit, and never touches a file inside its bounds", () => {
  const file = freshFile();
  const now = T0 + 100 * 24 * HOUR;
  const line = (t, u) => JSON.stringify({ t, p: "anthropic", a: "acct-a", c: 11, w: "anthropic:5h", u, r: null });
  fs.writeFileSync(file, [line(now - 95 * 24 * HOUR, 1), line(now - 91 * 24 * HOUR, 2), line(now - 80 * 24 * HOUR, 3), line(now - HOUR, 4), "not json", '{"t":1}'].join("\n") + "\n");
  assert.deepEqual(pruneQuotaHistory(now, { file }), { kept: 2, dropped: 4 });
  assert.deepEqual(readQuotaHistory({ file }).map((point) => point.u), [3, 4]);
  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(pruneQuotaHistory(now, { file }), { kept: 2, dropped: 0 });
  assert.equal(fs.statSync(file).mtimeMs, before, "nothing to drop, nothing rewritten");

  const big = freshFile();
  const lines = Array.from({ length: 200 }, (_, index) => line(now - (200 - index) * MIN, index % 100));
  fs.writeFileSync(big, `${lines.join("\n")}\n`);
  const limit = lines.slice(-50).reduce((sum, text) => sum + Buffer.byteLength(text) + 1, 0);
  const result = pruneQuotaHistory(now, { file: big, maxBytes: limit });
  assert.equal(result.kept, 50);
  const kept = readQuotaHistory({ file: big });
  assert.equal(kept.length, 50);
  assert.equal(kept.at(-1).t, now - MIN, "the newest lines are the ones kept");
  assert.ok(fs.statSync(big).size <= limit);
  assert.equal(QUOTA_HISTORY_MAX_AGE_MS, 90 * 24 * HOUR);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("appending stops at twice the size limit until the next prune", () => {
  const file = freshFile();
  fs.writeFileSync(file, "x".repeat(8 * 1024 * 1024 + 1));
  assert.equal(recordQuotaReadings(snap([acct()]), T0, file), 0);
  assert.equal(fs.statSync(file).size, 8 * 1024 * 1024 + 1);
  fs.writeFileSync(file, "");
  assert.equal(recordQuotaReadings(snap([acct()]), T0, file), 1, "a failed write is not remembered as written");
});

test("a torn last line is skipped when the history is read", () => {
  const good = JSON.stringify({ t: T0, p: "anthropic", a: "a", c: null, w: "w", u: 1, r: null });
  assert.equal(parseQuotaHistory(`${good}\n{"t":123,"p":"ant`).length, 1);
});

// ---- the calculator ------------------------------------------------------------------------------------------

const point = (minutes, u, overrides = {}) => ({ t: T0 + minutes * MIN, p: "anthropic", a: "acct-a", c: 11, w: "anthropic:5h", u, r: T0 + 5 * HOUR, ...overrides });
const row = (minutes, overrides = {}) => ({ at: T0 + minutes * MIN, provider: "anthropic", credentialId: 11, input: 100, output: 200, cacheRead: 3000, cacheWrite: 400, ...overrides });
const only = (results) => {
  assert.equal(results.length, 1);
  return results[0];
};

test("tokens per percent are the tokens between the readings divided by the points the window moved", () => {
  const history = [point(0, 10), point(30, 14), point(60, 20)];
  const rows = [row(10), row(20), row(40), row(50), row(55)];
  const result = only(calibrateQuota(history, rows));
  assert.equal(result.status, "ok");
  assert.equal(result.percentSpan, 10);
  assert.deepEqual(result.tokens, { input: 500, output: 1000, cacheRead: 15000, cacheWrite: 2000 });
  assert.deepEqual(result.perPercent, { input: 50, output: 100, cacheRead: 1500, cacheWrite: 200, total: 1850 });
  assert.deepEqual([result.stretches, result.from, result.to], [1, T0, T0 + 60 * MIN]);
});

test("a row before the first reading or after the last one is not counted", () => {
  const history = [point(10, 10), point(40, 20)];
  const result = only(calibrateQuota(history, [row(5), row(10), row(25), row(40), row(41)], { minPercentSpan: 5 }));
  assert.equal(result.status, "ok");
  assert.equal(result.tokens.input, 200, "rows at 25 and 40: the interval is open at its start and closed at its end");
});

test("a reset ends one stretch and starts another, and the interval across the reset is dropped", () => {
  const history = [point(0, 10, { r: T0 + 2 * HOUR }), point(60, 30, { r: T0 + 2 * HOUR }), point(130, 2, { r: T0 + 7 * HOUR }), point(190, 12, { r: T0 + 7 * HOUR })];
  const rows = [row(30), row(45), row(100), row(120), row(150), row(170)];
  const result = only(calibrateQuota(history, rows));
  assert.equal(result.status, "ok");
  assert.equal(result.stretches, 2);
  assert.equal(result.percentSpan, 30, "20 points before the reset and 10 after");
  assert.equal(result.tokens.input, 400, "four rows inside the two stretches; the two across the reset are dropped");
  assert.equal(result.perPercent.input, 400 / 30);
});

test("a reset is told from the reset time passing, even when the percentage climbs back above where it was", () => {
  const history = [point(0, 10, { r: T0 + 60 * MIN }), point(50, 12, { r: T0 + 60 * MIN }), point(70, 50, { r: T0 + 6 * HOUR }), point(100, 58, { r: T0 + 6 * HOUR })];
  const result = only(calibrateQuota(history, [row(20), row(80), row(90)], { minPercentSpan: 5 }));
  assert.equal(result.status, "ok");
  assert.equal(result.stretches, 2);
  assert.equal(result.percentSpan, 10);
});

test("two accounts are calibrated apart by credential, and a row of the other account never counts", () => {
  const history = [point(0, 10), point(60, 20), point(0, 5, { a: "acct-b", c: 12 }), point(60, 35, { a: "acct-b", c: 12 })];
  const rows = [row(10), row(20), row(30, { credentialId: 12, input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }), row(40, { credentialId: 12, input: 2000, output: 0, cacheRead: 0, cacheWrite: 0 })];
  const results = calibrateQuota(history, rows);
  assert.equal(results.length, 2);
  const [a, b] = results;
  assert.equal(a.account, "acct-a");
  assert.equal(a.status, "ok");
  assert.equal(a.tokens.input, 200);
  assert.equal(b.account, "acct-b");
  assert.equal(b.status, "ok");
  assert.equal(b.tokens.input, 3000);
  assert.equal(b.perPercent.input, 100);
});

test("with several accounts, requests that name no account cannot be told apart: no answer, not a guess", () => {
  const history = [point(0, 10), point(60, 25), point(0, 5, { a: "acct-b", c: 12 }), point(60, 20, { a: "acct-b", c: 12 })];
  const rows = [row(10, { credentialId: null }), row(20, { credentialId: undefined }), row(30, { credentialId: null }), row(40)];
  const results = calibrateQuota(history, rows);
  assert.ok(results.every((result) => result.status === "not-enough-data"));
  assert.match(results[0].reason, /which account/);
  const single = calibrateQuota([point(0, 10), point(60, 25)], [row(10, { credentialId: null }), row(20, { credentialId: null })]);
  assert.equal(only(single).status, "ok", "a provider with one account owns every row");
});

test("it answers not enough data, with the reason, instead of guessing", () => {
  const reason = (history, rows, options) => {
    const result = only(calibrateQuota(history, rows, options));
    assert.equal(result.status, "not-enough-data");
    return result.reason;
  };
  assert.match(reason([], [row(1)]), /no quota readings/);
  assert.match(reason([point(0, 10)], [row(1)]), /fewer than two readings/);
  assert.match(reason([point(0, 10), point(30, 10)], [row(10)]), /did not move/);
  assert.match(reason([point(0, 10), point(30, 12)], [row(10)]), /moved only 2 percentage points/);
  assert.match(reason([point(0, 10), point(30, 30)], []), /no token rows/);
  assert.match(reason([point(0, 10), point(30, 30)], [row(10, { provider: "openai-codex" })]), /no token rows/);
  assert.match(reason([point(0, 10), point(30, 30)], [row(100)]), /no token rows/);
  assert.equal(only(calibrateQuota([point(0, 10), point(30, 12)], [row(10)], { minPercentSpan: 2 })).status, "ok");
});

test("history out of order gives the same answer, and windows of one account are separate answers", () => {
  const history = [point(60, 20), point(0, 10), point(0, 0, { w: "anthropic:7d" }), point(60, 6, { w: "anthropic:7d" })];
  const results = calibrateQuota(history, [row(30)]);
  assert.deepEqual(results.map((result) => [result.windowId, result.status]), [["anthropic:5h", "ok"], ["anthropic:7d", "ok"]]);
  assert.equal(results[0].perPercent.input, 10);
  assert.equal(results[1].perPercent.input, calibrateQuota([point(0, 0, { w: "anthropic:7d" }), point(60, 6, { w: "anthropic:7d" })], [row(30)])[0].perPercent.input);
});
