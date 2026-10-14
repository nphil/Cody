import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The daily-limit store: one JSON file in the accounts directory, one record per
 * account (plus `__instance`), a wall-clock ledger whose UNION is what counts.
 * Every test gets its own accounts directory, so none depends on another.
 */
const root = mkdtempSync(join(tmpdir(), "cody-daily-limit-store-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.TZ = "UTC";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./store.ts");
const state = await jiti.import("./state.ts");
const users = await jiti.import("../auth/users.ts");

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const ZONE = "UTC";

let counter = 0;
/** A new, not-yet-existing accounts directory; returns the daily-limit file path. */
function fresh() {
  const dir = join(root, `t${counter++}`, "accounts");
  process.env.CODY_ACCOUNTS_DIR = dir;
  return { dir, file: join(dir, "daily-limit.json") };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const beat = (seconds, endedAgoSeconds = 0) => ({ activeMs: seconds * SECOND, endedAgoMs: endedAgoSeconds * SECOND });
const enable = (user = null, limitMinutes) =>
  store.updateDailyLimit(user, { enabled: true, ...(limitMinutes ? { limitMinutes } : {}) }, ZONE, NOW);

test("a fresh instance is off at 120 minutes with nothing used, and reading writes nothing", () => {
  const { file } = fresh();
  const s = store.readDailyLimitState(null, ZONE, NOW);
  assert.equal(s.enabled, false);
  assert.equal(s.limitMinutes, 120);
  assert.equal(s.usedSeconds, 0);
  assert.equal(s.extraSeconds, 0);
  assert.equal(s.limitSeconds, 7200);
  assert.equal(s.noticeDue, false);
  assert.equal(s.day, "2026-10-13");
  assert.equal(s.serverNow, NOW);
  assert.equal(fs.existsSync(file), false);
});

test("updateDailyLimit refuses bad values with invalid_daily_limit and writes nothing", () => {
  const { file } = fresh();
  const bad = [
    { limitMinutes: 4 },
    { limitMinutes: 1441 },
    { limitMinutes: 90.5 },
    { limitMinutes: "60" },
    { enabled: "yes" },
    { addMinutes: 0 },
    { addMinutes: 241 },
    { dismissNotice: false },
    {},
    { unknown: 1 },
    null,
    "enabled",
    42,
    [],
  ];
  for (const patch of bad) {
    assert.throws(
      () => store.updateDailyLimit(null, patch, ZONE, NOW),
      (error) => error instanceof store.InvalidDailyLimitError && error.code === "invalid_daily_limit" && error.message.length > 0,
      JSON.stringify(patch),
    );
  }
  assert.equal(fs.existsSync(file), false);
});

test("a bad value next to a good one refuses the whole patch", () => {
  const { file } = fresh();
  assert.throws(() => store.updateDailyLimit(null, { enabled: true, limitMinutes: 3 }, ZONE, NOW), store.InvalidDailyLimitError);
  assert.equal(fs.existsSync(file), false);
});

test("unknown extra keys are ignored when a valid key is present", () => {
  fresh();
  const s = store.updateDailyLimit(null, { enabled: true, colour: "red", limitMinutes: 90 }, ZONE, NOW);
  assert.equal(s.enabled, true);
  assert.equal(s.limitMinutes, 90);
  assert.equal(s.limitSeconds, 5400);
});

test("every accepted limit at the edges and presets is saved", () => {
  fresh();
  for (const minutes of [5, 60, 90, 1440]) {
    assert.equal(store.updateDailyLimit(null, { limitMinutes: minutes }, ZONE, NOW).limitMinutes, minutes);
  }
});

test("a beat is ignored while the limit is off, and counted once it is on", () => {
  const { file } = fresh();
  let s = store.recordBeat(null, beat(15), ZONE, NOW);
  assert.equal(s.enabled, false);
  assert.equal(s.usedSeconds, 0);
  assert.equal(fs.existsSync(file), false, "an ignored beat does not even create the file");

  store.updateDailyLimit(null, { enabled: false }, ZONE, NOW);
  const off = fs.readFileSync(file, "utf8");
  s = store.recordBeat(null, beat(15), ZONE, NOW);
  assert.equal(s.usedSeconds, 0);
  assert.equal(fs.readFileSync(file, "utf8"), off, "and the file is untouched");

  store.updateDailyLimit(null, { enabled: true }, ZONE, NOW);
  assert.equal(readJson(file).accounts.__instance.intervals.length, 0);
  s = store.recordBeat(null, beat(15), ZONE, NOW);
  assert.equal(s.usedSeconds, 15);
  assert.deepEqual(readJson(file).accounts.__instance.intervals, [[NOW - 15 * SECOND, NOW]]);
});

test("two devices reporting overlapping seconds count the union, not the sum", () => {
  const { file } = fresh();
  enable();
  // Device A covers 12:00:00-12:00:15 and reports at 12:00:15.
  assert.deepEqual(state.beatInterval(beat(15), NOW + 15 * SECOND), [NOW, NOW + 15 * SECOND]);
  store.recordBeat(null, beat(15), ZONE, NOW + 15 * SECOND);

  // Device B covers 12:00:10-12:00:25 but its report only arrives at 12:00:30.
  assert.deepEqual(state.beatInterval(beat(15, 5), NOW + 30 * SECOND), [NOW + 10 * SECOND, NOW + 25 * SECOND]);
  const s = store.recordBeat(null, beat(15, 5), ZONE, NOW + 30 * SECOND);

  assert.equal(s.usedSeconds, 25);
  assert.deepEqual(readJson(file).accounts.__instance.intervals, [[NOW, NOW + 25 * SECOND]]);
});

test("endedAgoMs places the stretch in the past", () => {
  const { file } = fresh();
  enable();
  const s = store.recordBeat(null, beat(20, 60), ZONE, NOW);
  assert.equal(s.usedSeconds, 20);
  assert.deepEqual(readJson(file).accounts.__instance.intervals, [[NOW - 80 * SECOND, NOW - 60 * SECOND]]);
});

test("a beat that adds nothing new does not rewrite the file", () => {
  const { file } = fresh();
  enable();
  store.recordBeat(null, beat(15), ZONE, NOW);
  const inode = fs.statSync(file).ino;
  const contents = fs.readFileSync(file, "utf8");

  const same = store.recordBeat(null, beat(15), ZONE, NOW);
  assert.equal(same.usedSeconds, 15);
  const inside = store.recordBeat(null, beat(5, 5), ZONE, NOW);
  assert.equal(inside.usedSeconds, 15, "a stretch inside an existing one adds nothing");

  assert.equal(fs.statSync(file).ino, inode, "an atomic rewrite would have replaced the file");
  assert.equal(fs.readFileSync(file, "utf8"), contents);

  store.recordBeat(null, beat(15), ZONE, NOW + 60 * SECOND);
  assert.notEqual(fs.statSync(file).ino, inode, "new time does rewrite");
});

test("the file is 0600 in a 0700 directory, parses, and leaves no temp files", () => {
  const { dir, file } = fresh();
  enable();
  for (let i = 0; i < 40; i++) store.recordBeat(null, beat(10), ZONE, NOW + i * MINUTE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const parsed = readJson(file);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.accounts.__instance.settings.enabled, true);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(fs.readdirSync(dir), ["daily-limit.json"]);
});

test("each account has its own settings and ledger; no account uses __instance", () => {
  const { file } = fresh();
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
  assert.equal(store.limitKeyFor(null), "__instance");
  assert.equal(store.INSTANCE_KEY, "__instance");
  assert.equal(store.limitKeyFor(alice), alice.id);

  store.updateDailyLimit(alice, { enabled: true, limitMinutes: 60 }, ZONE, NOW);
  store.recordBeat(alice, beat(30), ZONE, NOW);

  const forBob = store.readDailyLimitState(bob, ZONE, NOW);
  assert.equal(forBob.enabled, false);
  assert.equal(forBob.limitMinutes, 120);
  assert.equal(forBob.usedSeconds, 0);
  const forInstance = store.readDailyLimitState(null, ZONE, NOW);
  assert.equal(forInstance.enabled, false);
  assert.equal(forInstance.usedSeconds, 0);
  const forAlice = store.readDailyLimitState(alice, ZONE, NOW);
  assert.equal(forAlice.usedSeconds, 30);
  assert.equal(forAlice.limitMinutes, 60);

  store.updateDailyLimit(bob, { enabled: true }, ZONE, NOW);
  store.recordBeat(bob, beat(45), ZONE, NOW);
  assert.equal(store.readDailyLimitState(alice, ZONE, NOW).usedSeconds, 30);
  assert.equal(store.readDailyLimitState(bob, ZONE, NOW).usedSeconds, 45);
  assert.deepEqual(Object.keys(readJson(file).accounts).sort(), [alice.id, bob.id].sort());
});

test("a deleted account's record is dropped on the next save; __instance never is", () => {
  const { file } = fresh();
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
  store.updateDailyLimit(null, { enabled: true }, ZONE, NOW);
  store.updateDailyLimit(alice, { enabled: true }, ZONE, NOW);
  store.updateDailyLimit(bob, { enabled: true }, ZONE, NOW);
  assert.equal(Object.keys(readJson(file).accounts).length, 3);

  users.deleteUser(bob.id);
  assert.ok(readJson(file).accounts[bob.id], "nothing happens until someone saves");
  store.updateDailyLimit(alice, { limitMinutes: 30 }, ZONE, NOW);
  assert.deepEqual(Object.keys(readJson(file).accounts).sort(), ["__instance", alice.id].sort());
});

test("nothing is pruned while there are no accounts at all", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: {
        __instance: { settings: { enabled: true, limitMinutes: 120 }, days: {}, intervals: [] },
        "someone-else": { settings: { enabled: true, limitMinutes: 45 }, days: {}, intervals: [] },
      },
    }),
  );
  store.recordBeat(null, beat(10), ZONE, NOW);
  const accounts = readJson(file).accounts;
  assert.deepEqual(Object.keys(accounts).sort(), ["__instance", "someone-else"]);
  assert.equal(accounts["someone-else"].settings.limitMinutes, 45);
});

test("intervals older than 14 days are dropped, and one straddling the edge is clipped", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const floor = NOW - 14 * DAY;
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: {
        __instance: {
          settings: { enabled: true, limitMinutes: 120 },
          days: {},
          intervals: [
            [NOW - 20 * DAY, NOW - 20 * DAY + MINUTE],
            [floor - 30 * SECOND, floor + 30 * SECOND],
            [NOW - 3 * DAY, NOW - 3 * DAY + MINUTE],
          ],
        },
      },
    }),
  );
  store.recordBeat(null, beat(10), ZONE, NOW);
  const intervals = readJson(file).accounts.__instance.intervals;
  assert.deepEqual(intervals, [
    [floor, floor + 30 * SECOND],
    [NOW - 3 * DAY, NOW - 3 * DAY + MINUTE],
    [NOW - 10 * SECOND, NOW],
  ]);
});

test("the days map keeps only the newest 14 days", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const days = {};
  for (let d = 1; d <= 20; d++) days[`2026-09-${String(d).padStart(2, "0")}`] = { extraSeconds: 900, noticeDismissedAtSeconds: null };
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { __instance: { settings: { enabled: false, limitMinutes: 120 }, days, intervals: [] } } }));
  store.updateDailyLimit(null, { addMinutes: 15 }, ZONE, NOW);
  const kept = Object.keys(readJson(file).accounts.__instance.days).sort();
  assert.equal(kept.length, 14);
  assert.equal(kept[0], "2026-09-08");
  assert.equal(kept.at(-1), "2026-10-13", "today's record is the newest");
  assert.ok(!kept.includes("2026-09-07"));
});

test("more than 5000 intervals keeps the newest 5000", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const intervals = [];
  for (let i = 0; i < 5100; i++) intervals.push([NOW - 10 * DAY + i * 100 * SECOND, NOW - 10 * DAY + i * 100 * SECOND + SECOND]);
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { __instance: { settings: { enabled: true, limitMinutes: 120 }, days: {}, intervals } } }));
  store.recordBeat(null, beat(10), ZONE, NOW);
  const kept = readJson(file).accounts.__instance.intervals;
  assert.equal(kept.length, 5000);
  assert.deepEqual(kept.at(-1), [NOW - 10 * SECOND, NOW]);
  assert.deepEqual(kept[0], intervals[101], "the 101 oldest went");
});

test("a hand-edited file that is not JSON, or the wrong shape, reads as defaults", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  for (const content of ["{not json", "", "[]", "null", "42", '{"accounts":[]}', '{"accounts":"x"}', '{"version":1}']) {
    fs.writeFileSync(file, content);
    const s = store.readDailyLimitState(null, ZONE, NOW);
    assert.equal(s.enabled, false, content);
    assert.equal(s.limitMinutes, 120, content);
    assert.equal(s.usedSeconds, 0, content);
  }
  fs.writeFileSync(file, "{not json");
  const after = store.updateDailyLimit(null, { enabled: true }, ZONE, NOW);
  assert.equal(after.enabled, true, "a write recovers the file");
  assert.equal(readJson(file).accounts.__instance.settings.enabled, true);
});

test("hand-edited values degrade field by field to a clean ledger", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: {
        __instance: {
          settings: { enabled: "yes", limitMinutes: "60" },
          days: {
            "not-a-date": { extraSeconds: 900 },
            "2026-10-13": { extraSeconds: null, noticeDismissedAtSeconds: "x" },
            "2026-10-12": { extraSeconds: 1e12, noticeDismissedAtSeconds: null },
            "2026-10-11": "garbage",
          },
          intervals: [
            [NOW + 1e6, NOW + 2e6],
            ["a", 1],
            [1],
            null,
            [NOW - 20 * SECOND, NOW - 10 * SECOND],
            [NOW - 60 * SECOND, NOW - 30 * SECOND],
            [NOW - 45 * SECOND, NOW - 40 * SECOND],
            [NOW - 5 * SECOND, NOW - 20 * SECOND],
            [null, NOW],
          ],
        },
        broken: 7,
      },
    }),
  );
  const s = store.readDailyLimitState(null, ZONE, NOW);
  assert.equal(s.enabled, false);
  assert.equal(s.limitMinutes, 120);
  assert.equal(s.extraSeconds, 0);
  // [-60,-30] and [-20,-10] are the only good, forward stretches: 30 + 10 s. [-45,-40] sits inside the first.
  assert.equal(s.usedSeconds, 40);

  const yesterday = store.readDailyLimitState(null, ZONE, NOW - DAY);
  assert.equal(yesterday.extraSeconds, 16 * 3600, "a huge extra is capped, not trusted");

  const written = store.updateDailyLimit(null, { enabled: true }, ZONE, NOW);
  assert.equal(written.usedSeconds, 40);
  const saved = readJson(file).accounts.__instance;
  assert.deepEqual(saved.intervals, [
    [NOW - 60 * SECOND, NOW - 30 * SECOND],
    [NOW - 20 * SECOND, NOW - 10 * SECOND],
  ]);
  assert.deepEqual(Object.keys(saved.days).sort(), ["2026-10-12", "2026-10-13"]);
});

test("a future interval in the file counts for nothing", () => {
  const { dir, file } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { __instance: { settings: { enabled: true, limitMinutes: 120 }, days: {}, intervals: [[NOW + 60 * MINUTE, NOW + 120 * MINUTE]] } } }));
  assert.equal(store.readDailyLimitState(null, ZONE, NOW).usedSeconds, 0);
});

test("addMinutes raises today's limit, accumulates, and is capped", () => {
  fresh();
  enable(null, 60);
  let s = store.updateDailyLimit(null, { addMinutes: 15 }, ZONE, NOW);
  assert.equal(s.extraSeconds, 900);
  assert.equal(s.limitSeconds, 3600 + 900);
  assert.equal(s.limitMinutes, 60, "the saved length is untouched");
  s = store.updateDailyLimit(null, { addMinutes: 15 }, ZONE, NOW);
  assert.equal(s.extraSeconds, 1800);
  assert.equal(s.limitSeconds, 3600 + 1800);

  for (let i = 0; i < 6; i++) s = store.updateDailyLimit(null, { addMinutes: 240 }, ZONE, NOW);
  assert.equal(s.extraSeconds, state.MAX_EXTRA_SECONDS);
});

test("the next local day does not inherit added time", () => {
  fresh();
  enable(null, 60);
  store.updateDailyLimit(null, { addMinutes: 30 }, ZONE, NOW);
  const tomorrow = store.readDailyLimitState(null, ZONE, NOW + DAY);
  assert.equal(tomorrow.day, "2026-10-14");
  assert.equal(tomorrow.extraSeconds, 0);
  assert.equal(tomorrow.limitSeconds, 3600);
  assert.equal(store.readDailyLimitState(null, ZONE, NOW).extraSeconds, 1800, "and today keeps it");
});

test("dismissing the notice hides it until the new limit is reached", () => {
  fresh();
  enable(null, 5);
  assert.equal(store.readDailyLimitState(null, ZONE, NOW).noticeDue, false);

  let s = store.recordBeat(null, { activeMs: 5 * MINUTE, endedAgoMs: 0 }, ZONE, NOW);
  assert.equal(s.usedSeconds, 300);
  assert.equal(s.remainingSeconds, 0);
  assert.equal(s.noticeDue, true);

  s = store.updateDailyLimit(null, { dismissNotice: true }, ZONE, NOW);
  assert.equal(s.noticeDue, false);
  assert.equal(store.readDailyLimitState(null, ZONE, NOW + MINUTE).noticeDue, false, "stays hidden");

  s = store.updateDailyLimit(null, { addMinutes: 15 }, ZONE, NOW);
  assert.equal(s.limitSeconds, 1200);
  assert.equal(s.noticeDue, false);

  s = store.recordBeat(null, { activeMs: 15 * MINUTE, endedAgoMs: 0 }, ZONE, NOW + 15 * MINUTE);
  assert.equal(s.usedSeconds, 1200);
  assert.equal(s.noticeDue, true, "reaching the new limit is a new occasion");

  s = store.updateDailyLimit(null, { dismissNotice: true }, ZONE, NOW + 15 * MINUTE);
  assert.equal(s.noticeDue, false);
});

test("the notice is never due while the limit is off, and usage is kept", () => {
  fresh();
  enable(null, 5);
  store.recordBeat(null, { activeMs: 10 * MINUTE, endedAgoMs: 0 }, ZONE, NOW);
  assert.equal(store.readDailyLimitState(null, ZONE, NOW).noticeDue, true);
  const off = store.updateDailyLimit(null, { enabled: false }, ZONE, NOW);
  assert.equal(off.enabled, false);
  assert.equal(off.noticeDue, false);
  assert.equal(off.usedSeconds, 600, "turning it off keeps today's usage");
  const on = store.updateDailyLimit(null, { enabled: true }, ZONE, NOW);
  assert.equal(on.usedSeconds, 600);
  assert.equal(on.remainingSeconds, -300);
  assert.equal(on.noticeDue, true);
});

test("the same instants make a different day and total in Tokyo and New York", () => {
  fresh();
  enable();
  const at = Date.UTC(2026, 9, 13, 15, 30, 0); // 00:30 Oct 14 in Tokyo, 11:30 Oct 13 in New York
  const tokyo = store.recordBeat(null, { activeMs: 60 * MINUTE, endedAgoMs: 0 }, "Asia/Tokyo", at);
  assert.equal(tokyo.day, "2026-10-14");
  assert.equal(tokyo.zone, "Asia/Tokyo");
  assert.equal(tokyo.usedSeconds, 30 * 60, "only the half hour after Tokyo's midnight is today's");
  assert.equal(tokyo.dayStartsAt, Date.UTC(2026, 9, 13, 15, 0, 0));
  assert.equal(tokyo.dayEndsAt, Date.UTC(2026, 9, 14, 15, 0, 0));

  const newYork = store.readDailyLimitState(null, "America/New_York", at);
  assert.equal(newYork.day, "2026-10-13");
  assert.equal(newYork.usedSeconds, 60 * 60);
  assert.equal(newYork.dayStartsAt, Date.UTC(2026, 9, 13, 4, 0, 0));
});

test("an interval across local midnight splits between the two days", () => {
  fresh();
  enable();
  const at = Date.UTC(2026, 9, 13, 15, 30, 0);
  store.recordBeat(null, { activeMs: 60 * MINUTE, endedAgoMs: 0 }, "Asia/Tokyo", at);
  // Just before Tokyo's midnight the day is still Oct 13 and holds the first 29:59.
  const before = store.readDailyLimitState(null, "Asia/Tokyo", Date.UTC(2026, 9, 13, 14, 59, 59));
  assert.equal(before.day, "2026-10-13");
  assert.equal(before.usedSeconds, 29 * 60 + 59);
  // Reading Oct 13 in full from the other side of the line: the day ends at 15:00 UTC.
  const yesterdayEnd = store.readDailyLimitState(null, "Asia/Tokyo", Date.UTC(2026, 9, 13, 14, 59, 59, 999));
  assert.equal(yesterdayEnd.usedSeconds, 30 * 60);
  const after = store.readDailyLimitState(null, "Asia/Tokyo", at);
  assert.equal(after.day, "2026-10-14");
  assert.equal(after.usedSeconds, 30 * 60);
});
