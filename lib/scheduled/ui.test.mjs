import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const ui = await jiti.import("./ui.ts");
const { SCHEDULED_ERROR_CODES, SCHEDULED_LIMITS } = await jiti.import("./types.ts");
const { ScheduledRequestError } = await jiti.import("./client.ts");

const {
  HOUR_MS,
  DAY_MS,
  SCHEDULE_BLOCK_KEYS,
  SCHEDULED_REFRESH,
  SCHEDULED_ROWS_COLLAPSED,
  checkPickedTime,
  createLongPress,
  describeScheduledItem,
  formatScheduledWhen,
  localDayOffset,
  nextDueTransition,
  nextMenuIndex,
  parseLocalInput,
  phoneBudget,
  pickBounds,
  placeScheduleMenu,
  planScheduledRefresh,
  previewMessage,
  quotaRowModel,
  resolveChipAt,
  scheduleBlock,
  scheduleChipLabel,
  scheduleChips,
  scheduleErrorMessage,
  toLocalInputValue,
  visibleScheduledRows,
} = ui;

/** A translator that needs no locale file: the key, then its variables in a fixed order. */
const t = (key, vars) =>
  vars ? `${key}|${Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",")}` : key;

/** An instant on the device's wall clock (month is 1-based). */
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
/** Wall-clock fields of an instant on the device's clock. */
const fields = (ms) => {
  const date = new Date(ms);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
};
/** Intl writes a narrow no-break space before "PM" in newer ICU; the tests care about the words, not which space. */
const plain = (text) => text.replace(/\s/g, " ");

/* ───────────────────────────────── time chips ───────────────────────────────── */

test("chips: 'In 1 hour' is always offered and is exactly an hour out", () => {
  for (const now of [local(2026, 10, 6, 0, 0), local(2026, 10, 6, 10), local(2026, 10, 6, 22, 59), local(2026, 10, 6, 23, 30)]) {
    const chip = scheduleChips(now).find((entry) => entry.id === "in-1h");
    assert.ok(chip, `missing at ${new Date(now).toString()}`);
    assert.equal(chip.at, now + HOUR_MS);
  }
});

test("chips: 'Tonight 11 PM' is offered before 11 PM local and gone from 11 PM on", () => {
  const ids = (now) => scheduleChips(now).map((chip) => chip.id);
  assert.deepEqual(ids(local(2026, 10, 6, 10)), ["in-1h", "tonight", "tomorrow"]);
  assert.deepEqual(ids(local(2026, 10, 6, 0, 0)), ["in-1h", "tonight", "tomorrow"]);
  assert.deepEqual(ids(local(2026, 10, 6, 22, 59, 59) + 999), ["in-1h", "tonight", "tomorrow"]);
  // At 11:00:00.000 sharp the time is "now", not ahead of us.
  assert.deepEqual(ids(local(2026, 10, 6, 23, 0)), ["in-1h", "tomorrow"]);
  assert.deepEqual(ids(local(2026, 10, 6, 23, 30)), ["in-1h", "tomorrow"]);
  const tonight = scheduleChips(local(2026, 10, 6, 10)).find((chip) => chip.id === "tonight");
  assert.deepEqual(fields(tonight.at), [2026, 10, 6, 23, 0]);
});

test("chips: 'Tomorrow 9 AM' is 9:00 on the next calendar day, whatever the hour now", () => {
  for (const now of [local(2026, 10, 6, 0, 0), local(2026, 10, 6, 8, 59), local(2026, 10, 6, 9, 1), local(2026, 10, 6, 23, 59)]) {
    const tomorrow = scheduleChips(now).find((chip) => chip.id === "tomorrow");
    assert.deepEqual(fields(tomorrow.at), [2026, 10, 7, 9, 0]);
  }
  // Across a month and a year boundary.
  assert.deepEqual(fields(scheduleChips(local(2026, 12, 31, 12)).find((c) => c.id === "tomorrow").at), [2027, 1, 1, 9, 0]);
});

test("resolveChipAt: 'In 1 hour' is an hour from the moment it is chosen; the wall-clock chips keep their instant", () => {
  const opened = local(2026, 10, 6, 10);
  const chips = scheduleChips(opened);
  const chosen = opened + 10 * 60 * 1000;
  const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip]));
  assert.equal(resolveChipAt(byId["in-1h"], chosen), chosen + HOUR_MS);
  assert.equal(resolveChipAt(byId.tonight, chosen), byId.tonight.at);
  assert.equal(resolveChipAt(byId.tomorrow, chosen), byId.tomorrow.at);
});

test("chip labels: the hour is written the way the language writes it", () => {
  const now = local(2026, 10, 6, 10);
  const byId = Object.fromEntries(scheduleChips(now).map((chip) => [chip.id, chip]));
  assert.equal(scheduleChipLabel(byId["in-1h"], "en-US", t), "schedule.chipInHour");
  assert.equal(plain(scheduleChipLabel(byId.tonight, "en-US", t)), "schedule.chipTonight|time=11 PM");
  assert.equal(plain(scheduleChipLabel(byId.tomorrow, "en-US", t)), "schedule.chipTomorrow|time=9 AM");
  assert.equal(scheduleChipLabel(byId.tonight, "ja-JP", t), "schedule.chipTonight|time=23時");
  assert.equal(scheduleChipLabel(byId.tomorrow, "zh-CN", t), "schedule.chipTomorrow|time=9时");
});

/* The device zone decides what "tomorrow" is, and a daylight-saving day is 23 or 25 hours long. The host's own zone
   may have no such change, so each case runs in a child process whose zone is fixed before its first Date. */

function inZone(zone, script) {
  const uiPath = fileURLToPath(new URL("./ui.ts", import.meta.url));
  const source = `
    import { createJiti } from "jiti";
    const jiti = createJiti(${JSON.stringify(import.meta.url)}, { tsconfigPaths: true });
    const ui = await jiti.import(${JSON.stringify(uiPath)});
    const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
    const fields = (ms) => { const x = new Date(ms); return [x.getFullYear(), x.getMonth() + 1, x.getDate(), x.getHours(), x.getMinutes()]; };
    const out = await (${script})(ui, local, fields);
    console.log(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, TZ: zone },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test("daylight saving: the zone override really takes effect in the child (the DST cases below are not run in the host zone)", () => {
  const offsets = inZone("America/New_York", `(ui, local) => [
    new Date(2026, 0, 15, 12).getTimezoneOffset(), new Date(2026, 6, 15, 12).getTimezoneOffset(),
    new Date(2026, 2, 7, 12).getTimezoneOffset(), new Date(2026, 2, 8, 12).getTimezoneOffset(),
  ]`);
  assert.deepEqual(offsets, [300, 240, 300, 240]);
});

test("daylight saving, New York: 'Tonight' and 'Tomorrow' keep their wall-clock hour on the 23- and 25-hour days", () => {
  const got = inZone("America/New_York", `(ui, local, fields) => {
    const pick = (now) => Object.fromEntries(ui.scheduleChips(now).map((c) => [c.id, fields(c.at)]));
    return {
      // Saturday noon, the night before the clocks go forward.
      eve: pick(local(2026, 3, 7, 12)),
      // 1:30 AM on the 23-hour day itself.
      springDay: pick(local(2026, 3, 8, 1, 30)),
      // Friday noon before the clocks go back.
      fallEve: pick(local(2026, 10, 31, 12)),
      // 12:30 AM on the 25-hour day itself.
      fallDay: pick(local(2026, 11, 1, 0, 30)),
    };
  }`);
  assert.deepEqual(got.eve.tonight, [2026, 3, 7, 23, 0]);
  assert.deepEqual(got.eve.tomorrow, [2026, 3, 8, 9, 0]);
  assert.deepEqual(got.springDay.tonight, [2026, 3, 8, 23, 0]);
  assert.deepEqual(got.springDay.tomorrow, [2026, 3, 9, 9, 0]);
  assert.deepEqual(got.fallEve.tomorrow, [2026, 11, 1, 9, 0]);
  assert.deepEqual(got.fallDay.tonight, [2026, 11, 1, 23, 0]);
  assert.deepEqual(got.fallDay.tomorrow, [2026, 11, 2, 9, 0]);
});

test("daylight saving, Auckland (southern hemisphere): 'Tomorrow 9 AM' is still 9:00 the next day", () => {
  const got = inZone("Pacific/Auckland", `(ui, local, fields) => {
    const tomorrow = (now) => fields(ui.scheduleChips(now).find((c) => c.id === "tomorrow").at);
    return { fallBack: tomorrow(local(2026, 4, 4, 12)), springForward: tomorrow(local(2026, 9, 26, 12)) };
  }`);
  assert.deepEqual(got.fallBack, [2026, 4, 5, 9, 0]);
  assert.deepEqual(got.springForward, [2026, 9, 27, 9, 0]);
});

test("daylight saving: a calendar day counts as one day whether it lasts 23, 24 or 25 hours", () => {
  const got = inZone("America/New_York", `(ui, local) => ({
    // 24 h 40 min later but still the same calendar day (the 25-hour day).
    fallSame: ui.localDayOffset(local(2026, 11, 1, 23, 50), local(2026, 11, 1, 0, 10)),
    fallNext: ui.localDayOffset(local(2026, 11, 2, 0, 30), local(2026, 11, 1, 0, 10)),
    // 23 h 55 min later and already the next calendar day (the 23-hour day).
    springNext: ui.localDayOffset(local(2026, 3, 9, 0, 5), local(2026, 3, 8, 0, 10)),
    springSame: ui.localDayOffset(local(2026, 3, 8, 23, 50), local(2026, 3, 8, 0, 10)),
    tomorrowWord: ui.formatScheduledWhen(local(2026, 3, 9, 0, 5), local(2026, 3, 8, 0, 10), "en-US", (k) => k),
  })`);
  assert.deepEqual(got, {
    fallSame: 0,
    fallNext: 1,
    springNext: 1,
    springSame: 0,
    tomorrowWord: "schedule.tomorrowTime",
  });
});

/* ──────────────────────────────── the "Pick…" time ──────────────────────────────── */

test("datetime-local: an instant survives the round trip to the field and back", () => {
  for (const ms of [local(2026, 10, 6, 9, 30), local(2026, 1, 1, 0, 0), local(2026, 12, 31, 23, 59), local(2028, 2, 29, 12, 5)]) {
    const value = toLocalInputValue(ms);
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(parseLocalInput(value), ms);
  }
  assert.equal(toLocalInputValue(local(2026, 10, 6, 9, 5)), "2026-10-06T09:05");
  assert.equal(parseLocalInput(" 2026-10-06T09:05 "), local(2026, 10, 6, 9, 5));
  assert.equal(parseLocalInput("2026-10-06T09:05:30"), local(2026, 10, 6, 9, 5, 30));
});

test("datetime-local: empty, malformed and impossible dates are not a time", () => {
  for (const value of ["", "   ", "tomorrow", "2026-10-06", "2026-10-06 09:30", "26-10-06T09:30"]) {
    assert.equal(parseLocalInput(value), null, JSON.stringify(value));
  }
  // Impossible dates do not quietly become the next real one.
  for (const value of ["2026-02-30T10:00", "2026-02-29T10:00", "2026-04-31T10:00", "2026-13-01T10:00", "2026-00-10T10:00", "2026-10-00T10:00", "2026-10-06T24:00", "2026-10-06T25:00"]) {
    assert.equal(parseLocalInput(value), null, value);
  }
  assert.equal(parseLocalInput("2028-02-29T10:00"), local(2028, 2, 29, 10, 0));
});

test("pickBounds: the field opens an hour out and offers the next whole minute to 30 days ahead", () => {
  const now = local(2026, 1, 10, 12, 0, 30);
  assert.deepEqual(pickBounds(now), { min: "2026-01-10T12:01", initial: "2026-01-10T13:00", max: "2026-02-09T12:00" });
  assert.equal(pickBounds(now, 1).max, "2026-01-11T12:00");
  // On the dot, "now" itself is already too early for the field.
  assert.equal(pickBounds(local(2026, 1, 10, 12, 0)).min, "2026-01-10T12:01");
});

test("checkPickedTime: empty, past, and beyond the window are refused with their own reason", () => {
  const now = local(2026, 1, 10, 12, 0, 30);
  assert.deepEqual(checkPickedTime("", now), { ok: false, problem: "empty" });
  assert.deepEqual(checkPickedTime("not a time", now), { ok: false, problem: "empty" });
  assert.equal(checkPickedTime("2026-02-30T10:00", now).ok, false);
  assert.deepEqual(checkPickedTime("2026-01-10T11:59", now), { ok: false, problem: "past" });
  assert.deepEqual(checkPickedTime("2025-12-31T12:00", now), { ok: false, problem: "past" });
});

test("checkPickedTime: the edges - the current minute is past, the next is fine; 30 days exactly is fine, a minute more is not", () => {
  const now = local(2026, 1, 10, 12, 0, 30);
  assert.deepEqual(checkPickedTime("2026-01-10T12:00", now), { ok: false, problem: "past" });
  assert.deepEqual(checkPickedTime("2026-01-10T12:01", now), { ok: true, at: local(2026, 1, 10, 12, 1) });
  const onTheDot = local(2026, 1, 10, 12, 0);
  assert.deepEqual(checkPickedTime("2026-01-10T12:00", onTheDot), { ok: false, problem: "past" });
  assert.deepEqual(checkPickedTime("2026-02-09T12:00", onTheDot), { ok: true, at: local(2026, 2, 9, 12, 0) });
  assert.deepEqual(checkPickedTime("2026-02-09T12:01", onTheDot), { ok: false, problem: "far" });
  assert.deepEqual(checkPickedTime("2026-01-11T12:00", onTheDot, 1), { ok: true, at: local(2026, 1, 11, 12, 0) });
  assert.deepEqual(checkPickedTime("2026-01-11T12:01", onTheDot, 1), { ok: false, problem: "far" });
});

test("pickBounds and checkPickedTime agree: what the field offers is always accepted", () => {
  for (const now of [local(2026, 1, 10, 12, 0, 30), local(2026, 1, 10, 12, 0), local(2026, 1, 10, 23, 59, 59), local(2026, 1, 10, 0, 0, 1)]) {
    const bounds = pickBounds(now);
    for (const value of [bounds.min, bounds.initial, bounds.max]) {
      assert.equal(checkPickedTime(value, now).ok, true, `${value} at ${now}`);
    }
  }
});

/* ─────────────────────────────────── row text ─────────────────────────────────── */

test("localDayOffset: calendar days from now, across midnight, months and years", () => {
  const now = local(2026, 10, 6, 10);
  assert.equal(localDayOffset(local(2026, 10, 6, 0, 0), now), 0);
  assert.equal(localDayOffset(local(2026, 10, 6, 23, 59), now), 0);
  assert.equal(localDayOffset(local(2026, 10, 7, 0, 0), now), 1);
  assert.equal(localDayOffset(local(2026, 10, 5, 23, 59), now), -1);
  assert.equal(localDayOffset(local(2026, 10, 13, 9), now), 7);
  assert.equal(localDayOffset(local(2027, 1, 1, 9), local(2026, 12, 31, 23, 59)), 1);
});

test("formatScheduledWhen (English): clock time today, 'tomorrow', weekday this week, short date beyond or before today", () => {
  const now = local(2026, 10, 6, 10); // a Tuesday
  const when = (at) => plain(formatScheduledWhen(at, now, "en-US", t));
  assert.equal(when(local(2026, 10, 6, 23, 40)), "11:40 PM");
  assert.equal(when(local(2026, 10, 7, 9)), "schedule.tomorrowTime|time=9:00 AM");
  assert.equal(when(local(2026, 10, 8, 9)), "Thu 9:00 AM");
  assert.equal(when(local(2026, 10, 12, 9)), "Mon 9:00 AM");
  assert.equal(when(local(2026, 10, 13, 9)), "Oct 13, 9:00 AM");
  assert.equal(when(local(2026, 12, 1, 9)), "Dec 1, 9:00 AM");
  // Yesterday is not "tomorrow" and a weekday would be ambiguous.
  assert.equal(when(local(2026, 10, 5, 23, 40)), "Oct 5, 11:40 PM");
});

test("formatScheduledWhen (Japanese and Chinese): the same rules in the language's own clock and calendar", () => {
  const now = local(2026, 10, 6, 10);
  assert.equal(formatScheduledWhen(local(2026, 10, 6, 23, 40), now, "ja-JP", t), "23:40");
  assert.equal(formatScheduledWhen(local(2026, 10, 7, 9), now, "ja-JP", t), "schedule.tomorrowTime|time=9:00");
  assert.equal(formatScheduledWhen(local(2026, 10, 9, 9), now, "ja-JP", t), "9:00 (金)");
  assert.equal(formatScheduledWhen(local(2026, 10, 13, 9), now, "ja-JP", t), "10月13日 9:00");
  assert.equal(formatScheduledWhen(local(2026, 10, 6, 23, 40), now, "zh-CN", t), "23:40");
  assert.equal(formatScheduledWhen(local(2026, 10, 9, 9), now, "zh-CN", t), "周五09:00");
  assert.equal(formatScheduledWhen(local(2026, 10, 13, 9), now, "zh-CN", t), "10月13日 9:00");
});

test("previewMessage: one line - whitespace collapsed, trimmed, capped with an ellipsis", () => {
  assert.equal(previewMessage("  run\n\n  the\tbuild \r\n now  "), "run the build now");
  assert.equal(previewMessage(""), "");
  assert.equal(previewMessage("short"), "short");
  const exact = "x".repeat(240);
  assert.equal(previewMessage(exact), exact);
  const capped = previewMessage("x".repeat(241));
  assert.equal(capped.length, 240);
  assert.ok(capped.endsWith("…"));
  assert.equal(previewMessage("x".repeat(1_000), 10), `${"x".repeat(9)}…`);
});

test("previewMessage: a cut never leaves a space before the ellipsis, and a long message is never copied whole", () => {
  assert.equal(previewMessage(`${"word ".repeat(100)}end`, 11), "word word…");
  assert.ok(previewMessage("y".repeat(64 * 1024)).length <= 240);
});

const item = (overrides = {}) => ({
  id: "s1",
  sessionId: "chat-1",
  message: "run the build",
  mode: "at",
  at: new Date(local(2026, 10, 6, 23, 40)).toISOString(),
  source: "user",
  status: "pending",
  createdAt: new Date(local(2026, 10, 6, 9)).toISOString(),
  ...overrides,
});

test("describeScheduledItem: a waiting time message reads 'at <clock>' today and the plain date text later", () => {
  const now = local(2026, 10, 6, 10);
  const describe = (overrides) => {
    const row = describeScheduledItem(item(overrides), now, "en-US", t);
    return { ...row, when: plain(row.when) };
  };
  const today = describe({});
  assert.equal(today.state, "pending");
  assert.equal(today.when, "schedule.rowAt|time=11:40 PM");
  assert.equal(today.byAgent, false);
  assert.equal(today.note, null);
  assert.equal(today.quotaLabel, null);
  assert.equal(today.preview, "run the build");
  assert.equal(describe({ at: new Date(local(2026, 10, 7, 9)).toISOString() }).when, "schedule.tomorrowTime|time=9:00 AM");
  assert.equal(describe({ at: new Date(local(2026, 10, 9, 9)).toISOString() }).when, "Fri 9:00 AM");
});

test("describeScheduledItem: a time message that is overdue is still just pending; sending says so", () => {
  const now = local(2026, 10, 6, 23, 41);
  assert.equal(describeScheduledItem(item(), now, "en-US", t).state, "pending");
  const sending = describeScheduledItem(item({ status: "sending" }), now, "en-US", t);
  assert.equal(sending.state, "sending");
  assert.equal(sending.when, "schedule.rowSending");
});

test("describeScheduledItem: a quota message shows its refill time, then 'checking quota' once that has passed", () => {
  const quota = { label: "Claude · Secondary", giveUpAt: new Date(local(2026, 10, 7, 23, 40)).toISOString() };
  const waiting = describeScheduledItem(item({ mode: "quota", quota }), local(2026, 10, 6, 10), "en-US", t);
  assert.equal(waiting.state, "pending");
  assert.equal(plain(waiting.when), "schedule.rowQuota|time=11:40 PM");
  assert.equal(waiting.quotaLabel, "Claude · Secondary");

  const atTheMoment = describeScheduledItem(item({ mode: "quota", quota }), local(2026, 10, 6, 23, 40), "en-US", t);
  assert.equal(atTheMoment.state, "checking");
  assert.equal(atTheMoment.when, "schedule.rowQuotaChecking");
  const later = describeScheduledItem(item({ mode: "quota", quota }), local(2026, 10, 6, 23, 55), "en-US", t);
  assert.equal(later.state, "checking");

  // Only a PENDING quota item is "checking": on its way or given up, it says that instead.
  assert.equal(describeScheduledItem(item({ mode: "quota", quota, status: "sending" }), local(2026, 10, 6, 23, 55), "en-US", t).state, "sending");
  assert.equal(describeScheduledItem(item({ mode: "quota", quota, status: "failed" }), local(2026, 10, 6, 23, 55), "en-US", t).state, "failed");
});

test("describeScheduledItem: a failed row carries the server's sentence; a blank one is no note", () => {
  const now = local(2026, 10, 6, 10);
  const failed = describeScheduledItem(item({ status: "failed", error: "  The quota did not come back in time.  " }), now, "en-US", t);
  assert.equal(failed.state, "failed");
  assert.equal(failed.note, "The quota did not come back in time.");
  assert.equal(describeScheduledItem(item({ status: "failed", error: "   " }), now, "en-US", t).note, null);
  // A pending item after a failed attempt keeps its note too.
  assert.equal(describeScheduledItem(item({ error: "Retrying after a disconnect." }), now, "en-US", t).note, "Retrying after a disconnect.");
});

test("describeScheduledItem: rows made by the agent are marked, and the label is whatever the server sent", () => {
  const now = local(2026, 10, 6, 10);
  assert.equal(describeScheduledItem(item({ source: "agent" }), now, "en-US", t).byAgent, true);
  assert.equal(describeScheduledItem(item({ source: "user" }), now, "en-US", t).byAgent, false);
  // A time message has no quota label even if one is attached; a quota message without one has none.
  const quota = { label: "Claude", giveUpAt: new Date(now).toISOString() };
  assert.equal(describeScheduledItem(item({ quota }), now, "en-US", t).quotaLabel, null);
  assert.equal(describeScheduledItem(item({ mode: "quota" }), now, "en-US", t).quotaLabel, null);
});

test("describeScheduledItem: a huge message is cut for the row and for its title tooltip", () => {
  const row = describeScheduledItem(item({ message: `line one\n\n${"z".repeat(64 * 1024)}` }), local(2026, 10, 6, 10), "en-US", t);
  assert.ok(row.preview.startsWith("line one z"));
  assert.equal(row.preview.length, 240);
  assert.equal(row.title.length, 600);
});

/* ──────────────────────── why a menu row is switched off ──────────────────────── */

test("scheduleBlock: nothing blocks a full message in a real chat", () => {
  assert.equal(scheduleBlock({ hasSession: true, hasImages: false, hasContent: true, preparing: false, shellMode: false }), null);
});

test("scheduleBlock: one reason, the most basic one first", () => {
  const all = { hasSession: false, hasImages: true, hasContent: false, preparing: true, shellMode: true };
  assert.equal(scheduleBlock(all), "preparing");
  assert.equal(scheduleBlock({ ...all, preparing: false }), "empty");
  assert.equal(scheduleBlock({ ...all, preparing: false, hasContent: true }), "no-session");
  assert.equal(scheduleBlock({ ...all, preparing: false, hasContent: true, hasSession: true }), "images");
  assert.equal(scheduleBlock({ ...all, preparing: false, hasContent: true, hasSession: true, hasImages: false }), "shell");
  // A picture alone is still "nothing to schedule" only when there is no text: the caller decides what counts as content.
  assert.equal(scheduleBlock({ hasSession: true, hasImages: true, hasContent: false, preparing: false, shellMode: false }), "empty");
});

test("scheduleBlock: every reason has its own sentence key", () => {
  const reasons = ["preparing", "empty", "no-session", "images", "shell"];
  assert.deepEqual(Object.keys(SCHEDULE_BLOCK_KEYS).sort(), [...reasons].sort());
  assert.equal(new Set(Object.values(SCHEDULE_BLOCK_KEYS)).size, reasons.length);
});

/* ─────────────────────────────────── the row list ─────────────────────────────────── */

test("visibleScheduledRows: a short list shows in full, and so does one only a row longer than the fold", () => {
  const rows = (count) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));
  for (const count of [0, 1, 3, 4]) {
    const view = visibleScheduledRows(rows(count), false);
    assert.equal(view.shown.length, count, `${count} rows`);
    assert.equal(view.hidden, 0, `${count} rows`);
  }
});

test("visibleScheduledRows: a longer list folds to the soonest rows and counts the rest; expanding shows everything", () => {
  const all = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}` }));
  const folded = visibleScheduledRows(all, false);
  assert.deepEqual(folded.shown.map((row) => row.id), ["row-0", "row-1", "row-2"]);
  assert.equal(folded.hidden, 17);
  assert.equal(SCHEDULED_ROWS_COLLAPSED, 3);
  const open = visibleScheduledRows(all, true);
  assert.equal(open.shown.length, 20);
  assert.equal(open.hidden, 0);
  assert.equal(visibleScheduledRows(all.slice(0, 5), false).hidden, 2);
});

test("nextDueTransition: the wait is until the soonest pending row is due, plus the grace", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const rows = [
    { status: "pending", at: at(90) },
    { status: "pending", at: at(30) },
    { status: "sending", at: at(5) },
    { status: "failed", at: at(-5) },
    { status: "pending", at: at(-5) },
  ];
  assert.equal(nextDueTransition(rows, now), 30 * 60_000 + SCHEDULED_REFRESH.graceMs);
});

test("nextDueTransition: nothing pending ahead means nothing to wait for, and a far time is re-checked within the cap", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  assert.equal(nextDueTransition([], now), null);
  assert.equal(nextDueTransition([{ status: "pending", at: new Date(now - 1000).toISOString() }], now), null);
  assert.equal(nextDueTransition([{ status: "failed", at: new Date(now + 60_000).toISOString() }], now), null);
  assert.equal(nextDueTransition([{ status: "pending", at: "garbage" }], now), null);
  assert.equal(nextDueTransition([{ status: "pending", at: new Date(now + 20 * DAY_MS).toISOString() }], now), SCHEDULED_REFRESH.maxTimerMs);
});

/* ─────────────────────────── "When quota resets" row ─────────────────────────── */

const quotaContext = (now) => ({
  now,
  t,
  brandName: (provider) => ({ anthropic: "Claude", openai: "Codex" })[provider] ?? provider,
  formatTime: (iso) => (Number.isFinite(Date.parse(iso)) ? `at:${iso.slice(11, 16)}` : null),
});

test("quotaRowModel: no reading, no reset time, or an unknown ring is switched off with the plain reason", () => {
  const context = quotaContext(Date.parse("2026-10-06T10:00:00Z"));
  const off = { available: false, reasonKey: "schedule.quotaUnavailable" };
  assert.deepEqual(quotaRowModel(null, context), off);
  assert.deepEqual(quotaRowModel({ known: false }, context), off);
  assert.deepEqual(quotaRowModel({ known: false, provider: "anthropic", resetsAt: "2026-10-06T23:40:00Z" }, context), off);
  assert.deepEqual(quotaRowModel({ known: true, provider: "anthropic" }, context), off);
  assert.deepEqual(quotaRowModel({ known: true, provider: "anthropic", resetsAt: null }, context), off);
});

test("quotaRowModel: a reset already behind us, or one that cannot be read, is not offered", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const off = { available: false, reasonKey: "schedule.quotaUnavailable" };
  assert.deepEqual(quotaRowModel({ known: true, provider: "anthropic", resetsAt: "2026-10-06T09:59:59Z" }, quotaContext(now)), off);
  assert.deepEqual(quotaRowModel({ known: true, provider: "anthropic", resetsAt: "2026-10-06T10:00:00Z" }, quotaContext(now)), off);
  assert.deepEqual(quotaRowModel({ known: true, provider: "anthropic", resetsAt: "garbage" }, quotaContext(now)), off);
  const noText = { ...quotaContext(now), formatTime: () => null };
  assert.deepEqual(quotaRowModel({ known: true, provider: "anthropic", resetsAt: "2026-10-06T23:40:00Z" }, noText), off);
});

test("quotaRowModel: a known reset offers its instant and says whose and when", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const single = quotaRowModel({ known: true, provider: "anthropic", resetsAt: "2026-10-06T23:40:00Z" }, quotaContext(now));
  assert.deepEqual(single, { available: true, at: Date.parse("2026-10-06T23:40:00Z"), line: "schedule.quotaRefills|account=Claude,time=at:23:40" });
  const second = quotaRowModel(
    { known: true, provider: "openai", resetsAt: "2026-10-06T23:40:00Z", accounts: [{ label: "Secondary" }, { label: "Primary" }] },
    quotaContext(now),
  );
  assert.equal(second.available, true);
  assert.equal(second.line, "schedule.quotaRefills|account=Codex · Secondary,time=at:23:40");
});

test("quotaRowModel: the account position is only what the ring supplied - never invented", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const base = { known: true, provider: "anthropic", resetsAt: "2026-10-06T23:40:00Z" };
  // No accounts, or an empty list: the provider alone.
  assert.equal(quotaRowModel(base, quotaContext(now)).line, "schedule.quotaRefills|account=Claude,time=at:23:40");
  assert.equal(quotaRowModel({ ...base, accounts: [] }, quotaContext(now)).line, "schedule.quotaRefills|account=Claude,time=at:23:40");
  // No provider and no account: only the time.
  assert.equal(quotaRowModel({ known: true, resetsAt: base.resetsAt }, quotaContext(now)).line, "schedule.quotaRefillsAt|time=at:23:40");
  // An account label without a provider is shown as it is.
  assert.equal(quotaRowModel({ known: true, resetsAt: base.resetsAt, accounts: [{ label: "Account 3" }] }, quotaContext(now)).line, "schedule.quotaRefills|account=Account 3,time=at:23:40");
});

/* ─────────────────────────────── refusals in words ─────────────────────────────── */

test("scheduleErrorMessage: every server code maps to its own sentence", () => {
  for (const code of SCHEDULED_ERROR_CODES) {
    const text = scheduleErrorMessage(new ScheduledRequestError("boom", 400, code), t);
    assert.equal(text.split("|")[0], `schedule.error.${code}`);
  }
  // A plain `{ code }` body works as well as the client's error class.
  assert.equal(scheduleErrorMessage({ code: "time_in_past" }, t).split("|")[0], "schedule.error.time_in_past");
});

test("scheduleErrorMessage: the sentence is given the limits it quotes", () => {
  const limits = { perChat: 7, perAccount: 70, maxDays: 9, maxMessageBytes: 2048 };
  const vars = (code) => scheduleErrorMessage({ code }, t, limits).split("|")[1];
  assert.equal(vars("too_many_for_chat"), "count=7,days=9,limit=2 KB");
  assert.equal(vars("too_many_for_account"), "count=70,days=9,limit=2 KB");
  assert.equal(vars("time_too_far"), "count=7,days=9,limit=2 KB");
  assert.equal(scheduleErrorMessage({ code: "message_too_long" }, t), `schedule.error.message_too_long|count=${SCHEDULED_LIMITS.perChat},days=${SCHEDULED_LIMITS.maxDays},limit=64 KB`);
});

test("scheduleErrorMessage: a dead connection and an unknown failure get different, never raw, sentences", () => {
  assert.equal(scheduleErrorMessage(new ScheduledRequestError("Failed to fetch", 0), t), "schedule.error.network");
  assert.equal(scheduleErrorMessage(new ScheduledRequestError("<html>Bad gateway</html>", 502), t), "schedule.error.generic");
  assert.equal(scheduleErrorMessage(new ScheduledRequestError("odd", 400, null), t), "schedule.error.generic");
  assert.equal(scheduleErrorMessage(new Error("Failed to fetch"), t), "schedule.error.generic");
  assert.equal(scheduleErrorMessage({ code: "not_a_real_code", status: 0 }, t), "schedule.error.network");
  assert.equal(scheduleErrorMessage({ code: "not_a_real_code", status: 500 }, t), "schedule.error.generic");
  for (const odd of [null, undefined, "nope", 7]) assert.equal(scheduleErrorMessage(odd, t), "schedule.error.generic");
  // A known code outranks the transport status.
  assert.equal(scheduleErrorMessage({ code: "already_sending", status: 0 }, t).split("|")[0], "schedule.error.already_sending");
});

/* ───────────────────────────── the menu's position and keys ───────────────────────────── */

test("placeScheduleMenu: above the pill with its right edge on the pill's", () => {
  const placed = placeScheduleMenu({ top: 700, left: 1100, right: 1200, bottom: 740 }, { width: 1280, height: 800 });
  assert.equal(placed.width, 288);
  assert.equal(placed.left + placed.width, 1200);
  // The menu's bottom edge sits above the pill's top edge.
  assert.ok(800 - placed.bottom < 700);
  assert.ok(placed.maxHeight > 0 && placed.maxHeight < 700);
});

test("placeScheduleMenu: clamped to keep a margin from the right and the left edge", () => {
  const viewport = { width: 1280, height: 800 };
  const right = placeScheduleMenu({ top: 700, left: 1200, right: 1280, bottom: 740 }, viewport);
  assert.ok(right.left + right.width <= viewport.width - 8);
  assert.equal(right.width, 288);
  const left = placeScheduleMenu({ top: 700, left: 0, right: 60, bottom: 740 }, viewport);
  assert.equal(left.left, 8);
});

test("placeScheduleMenu: a phone narrower than the popover shrinks it to fit with margins on both sides", () => {
  const viewport = { width: 280, height: 640 };
  const placed = placeScheduleMenu({ top: 560, left: 200, right: 270, bottom: 600 }, viewport);
  assert.equal(placed.width, 264);
  assert.equal(placed.left, 8);
});

test("placeScheduleMenu: whatever the sizes, the menu stays inside the viewport and its room is never negative", () => {
  for (const width of [17, 100, 295, 296, 297, 320, 390, 1920]) {
    for (const right of [-50, 0, 10, width / 2, width - 5, width, width + 80]) {
      for (const top of [-20, 0, 3, 40, 300, 5000]) {
        const placed = placeScheduleMenu({ top, left: right - 40, right, bottom: top + 40 }, { width, height: 600 });
        const label = `viewport ${width}, anchor right ${right}, top ${top}`;
        assert.ok(placed.maxHeight >= 0, label);
        assert.ok(placed.width >= 0 && placed.width <= 288, label);
        assert.ok(placed.left >= 8, label);
        assert.ok(placed.left + placed.width <= width - 8, label);
      }
    }
  }
  assert.equal(placeScheduleMenu({ top: 2, left: 0, right: 10, bottom: 40 }, { width: 5, height: 5 }).maxHeight, 0);
  assert.equal(placeScheduleMenu({ top: 2, left: 0, right: 10, bottom: 40 }, { width: 5, height: 5 }).width, 0);
});

test("nextMenuIndex: arrows wrap around the list", () => {
  assert.equal(nextMenuIndex(0, "ArrowDown", 4), 1);
  assert.equal(nextMenuIndex(3, "ArrowDown", 4), 0);
  assert.equal(nextMenuIndex(0, "ArrowUp", 4), 3);
  assert.equal(nextMenuIndex(2, "ArrowUp", 4), 1);
  // Left and right move along the chip row the same way.
  assert.equal(nextMenuIndex(1, "ArrowRight", 4), 2);
  assert.equal(nextMenuIndex(3, "ArrowRight", 4), 0);
  assert.equal(nextMenuIndex(0, "ArrowLeft", 4), 3);
  assert.equal(nextMenuIndex(0, "ArrowDown", 1), 0);
});

test("nextMenuIndex: with nothing focused, down starts at the first and up at the last", () => {
  assert.equal(nextMenuIndex(-1, "ArrowDown", 4), 0);
  assert.equal(nextMenuIndex(-1, "ArrowRight", 4), 0);
  assert.equal(nextMenuIndex(-1, "ArrowUp", 4), 3);
  assert.equal(nextMenuIndex(-1, "ArrowLeft", 4), 3);
});

test("nextMenuIndex: Home and End jump, other keys and an empty menu say nothing", () => {
  assert.equal(nextMenuIndex(2, "Home", 4), 0);
  assert.equal(nextMenuIndex(-1, "End", 4), 3);
  assert.equal(nextMenuIndex(0, "End", 4), 3);
  for (const key of ["Enter", "Tab", "a", "", " ", "Escape"]) assert.equal(nextMenuIndex(1, key, 4), null, key);
  for (const key of ["ArrowDown", "Home", "End"]) assert.equal(nextMenuIndex(-1, key, 0), null, key);
});

/* ───────────────────────────────────── long press ───────────────────────────────────── */

function withTimers(body) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    return body(mock.timers);
  } finally {
    mock.timers.reset();
  }
}

test("long press: fires once after the delay, not before", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; } });
    press.start(100, 100);
    timers.tick(449);
    assert.equal(fired, 0);
    timers.tick(1);
    assert.equal(fired, 1);
    timers.tick(10_000);
    press.move(100, 100);
    assert.equal(fired, 1);
  });
});

test("long press: the delay can be changed", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; }, delayMs: 100 });
    press.start(0, 0);
    timers.tick(99);
    assert.equal(fired, 0);
    timers.tick(1);
    assert.equal(fired, 1);
  });
});

test("long press: a finger that wanders past the slop is scrolling, not holding", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; } });
    press.start(100, 100);
    timers.tick(100);
    press.move(111, 100);
    timers.tick(1_000);
    assert.equal(fired, 0);
    assert.equal(press.consumeClick(), false);
    // The diagonal counts as distance too.
    press.start(0, 0);
    press.move(8, 8);
    timers.tick(1_000);
    assert.equal(fired, 0);
  });
});

test("long press: a small tremor inside the slop still counts as holding", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; } });
    press.start(100, 100);
    press.move(103, 104);
    press.move(110, 100);
    timers.tick(450);
    assert.equal(fired, 1);
  });
});

test("long press: lifting early is a tap - nothing fires and the click is the person's", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; } });
    press.start(10, 10);
    timers.tick(200);
    press.end();
    timers.tick(2_000);
    assert.equal(fired, 0);
    assert.equal(press.consumeClick(), false);
  });
});

test("long press: the click after a press that opened the menu is swallowed exactly once", () => {
  withTimers((timers) => {
    const press = createLongPress({ onLongPress: () => {} });
    assert.equal(press.consumeClick(), false, "no press yet");
    press.start(10, 10);
    timers.tick(450);
    press.end();
    timers.tick(50);
    assert.equal(press.consumeClick(), true);
    assert.equal(press.consumeClick(), false);
  });
});

test("long press: a click that arrives long after the lift is a new click", () => {
  withTimers((timers) => {
    const press = createLongPress({ onLongPress: () => {} });
    press.start(10, 10);
    timers.tick(450);
    press.end();
    timers.tick(700);
    assert.equal(press.consumeClick(), false);
  });
});

test("long press: the next press starts clean, whatever happened to the last one", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; } });
    press.start(0, 0);
    timers.tick(450);
    press.end();
    // The unconsumed click of press one must not leak into press two.
    press.start(0, 0);
    timers.tick(100);
    press.end();
    assert.equal(press.consumeClick(), false);
    // Starting again while a press is still waiting restarts the wait rather than adding a second timer.
    press.start(0, 0);
    timers.tick(300);
    press.start(0, 0);
    timers.tick(300);
    assert.equal(fired, 1);
    timers.tick(150);
    assert.equal(fired, 2);
  });
});

test("long press: dispose drops a waiting press and a remembered one", () => {
  withTimers((timers) => {
    let fired = 0;
    const press = createLongPress({ onLongPress: () => { fired += 1; } });
    press.start(0, 0);
    timers.tick(100);
    press.dispose();
    timers.tick(1_000);
    assert.equal(fired, 0);

    press.start(0, 0);
    timers.tick(450);
    press.end();
    press.dispose();
    assert.equal(press.consumeClick(), false);
  });
});

/* ──────────────────────────── when to read the list again ──────────────────────────── */

const NOW = Date.parse("2026-10-06T10:00:00Z");
const entry = (status, offsetMs) => ({ status, at: new Date(NOW + offsetMs).toISOString() });
const plan = (items, overrides = {}) => planScheduledRefresh({ items, now: NOW, visible: true, followUps: 0, ...overrides });

test("planScheduledRefresh: a hidden tab arms nothing, whatever is waiting", () => {
  assert.deepEqual(plan([entry("pending", 60_000), entry("sending", 0), entry("pending", -5_000)], { visible: false }), { kind: "none" });
});

test("planScheduledRefresh: nothing waiting means no timer", () => {
  assert.deepEqual(plan([]), { kind: "none" });
  assert.deepEqual(plan([entry("failed", -60_000), entry("failed", 60_000)]), { kind: "none" });
  assert.deepEqual(plan([{ status: "pending", at: "not a date" }]), { kind: "none" });
});

test("planScheduledRefresh: one read at the soonest pending due time plus the grace", () => {
  const items = [entry("pending", 3_600_000), entry("pending", 120_000), entry("failed", 30_000), entry("pending", 900_000)];
  const result = plan(items);
  assert.equal(result.kind, "transition");
  assert.equal(result.delayMs, 120_000 + 1_500);
});

test("planScheduledRefresh: a message on its way or overdue is followed up at 5, 10 then 15 seconds", () => {
  for (const waiting of [entry("sending", 0), entry("pending", -1), entry("pending", 0)]) {
    assert.deepEqual(plan([waiting], { followUps: 0 }), { kind: "follow-up", delayMs: 5_000 });
    assert.deepEqual(plan([waiting], { followUps: 1 }), { kind: "follow-up", delayMs: 10_000 });
    assert.deepEqual(plan([waiting], { followUps: 2 }), { kind: "follow-up", delayMs: 15_000 });
    assert.deepEqual(plan([waiting], { followUps: 9 }), { kind: "follow-up", delayMs: 15_000 });
  }
});

test("planScheduledRefresh: follow-ups give up after twenty in a row", () => {
  const waiting = [entry("sending", 0)];
  assert.equal(plan(waiting, { followUps: 19 }).kind, "follow-up");
  assert.deepEqual(plan(waiting, { followUps: 20 }), { kind: "none" });
  assert.deepEqual(plan(waiting, { followUps: 500 }), { kind: "none" });
});

test("planScheduledRefresh: a later due time still gets its own read after the follow-ups have given up", () => {
  const items = [entry("sending", 0), entry("pending", 600_000)];
  assert.deepEqual(plan(items, { followUps: 20 }), { kind: "transition", delayMs: 601_500 });
});

test("planScheduledRefresh: the sooner of 'something is due' and 'follow up' wins", () => {
  // Due in 2 s (+1.5 s grace = 3.5 s) beats a 5 s follow-up.
  assert.deepEqual(plan([entry("sending", 0), entry("pending", 2_000)]), { kind: "transition", delayMs: 3_500 });
  // A tie goes to the due time.
  assert.deepEqual(plan([entry("sending", 0), entry("pending", 3_500)]), { kind: "transition", delayMs: 5_000 });
  // Due in 10 s loses to the 5 s follow-up.
  assert.deepEqual(plan([entry("sending", 0), entry("pending", 10_000)]), { kind: "follow-up", delayMs: 5_000 });
  // The backed-off follow-up is longer, so the same due time now wins.
  assert.deepEqual(plan([entry("sending", 0), entry("pending", 10_000)], { followUps: 2 }), { kind: "transition", delayMs: 11_500 });
});

test("planScheduledRefresh: a time weeks away is re-checked within six hours, not held for 30 days", () => {
  const result = plan([entry("pending", 29 * DAY_MS)]);
  assert.deepEqual(result, { kind: "transition", delayMs: 6 * HOUR_MS });
  assert.deepEqual(plan([entry("pending", 6 * HOUR_MS - 1_500)]), { kind: "transition", delayMs: 6 * HOUR_MS });
  assert.deepEqual(plan([entry("pending", 6 * HOUR_MS - 1_501)]), { kind: "transition", delayMs: 6 * HOUR_MS - 1 });
});

/* ─────────────────────────── the phone's one-line controls row ─────────────────────────── */

const NO_EXTRAS = { reasoning: false, ring: false, mode: false, autoSwitch: false };

test("phoneBudget: the model name's room on 360, 390 and 412 px phones with only attach and send", () => {
  // Row = viewport − 32 gutters − 2 border − 26 padding; attach and Send need 38 + 62, the model button and the row's
  // zero-width spacer bring three gaps of 4.
  assert.deepEqual(phoneBudget(360, NO_EXTRAS), { row: 300, fixed: 112, model: 188, name: 137 });
  assert.deepEqual(phoneBudget(390, NO_EXTRAS), { row: 330, fixed: 112, model: 218, name: 167 });
  assert.deepEqual(phoneBudget(412, NO_EXTRAS), { row: 352, fixed: 112, model: 240, name: 189 });
});

test("phoneBudget: attach, reasoning, the ring and Send leave 49, 79 and 101 px for the name — what Chromium measured", () => {
  const typical = { reasoning: true, ring: true, mode: false, autoSwitch: false };
  assert.equal(phoneBudget(360, typical).name, 49);
  assert.equal(phoneBudget(390, typical).name, 79);
  assert.equal(phoneBudget(412, typical).name, 101);
});

test("phoneBudget: each optional control costs one 38 px box and one 4 px gap; the ring keeps 4 px more to its right", () => {
  const base = phoneBudget(390, NO_EXTRAS).name;
  for (const control of ["reasoning", "mode", "autoSwitch"]) {
    assert.equal(phoneBudget(390, { ...NO_EXTRAS, [control]: true }).name, base - 42, control);
  }
  assert.equal(phoneBudget(390, { ...NO_EXTRAS, ring: true }).name, base - 46);
  assert.equal(phoneBudget(390, { reasoning: true, ring: true, mode: false, autoSwitch: false }).name, base - 88);
  assert.equal(phoneBudget(390, { reasoning: true, ring: true, mode: true, autoSwitch: true }).name, base - 172);
});

test("phoneBudget: a negative name means the row would spill", () => {
  const everything = { reasoning: true, ring: true, mode: true, autoSwitch: true };
  assert.equal(phoneBudget(360, everything).name, -35);
  assert.equal(phoneBudget(390, everything).name, -5);
  assert.equal(phoneBudget(412, everything).name, 17);
  assert.ok(phoneBudget(360, everything).name < 0);
  assert.ok(phoneBudget(360, { ...NO_EXTRAS, reasoning: true, ring: true }).name > 0);
});
