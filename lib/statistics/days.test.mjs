import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./test-helpers.mjs";

const days = await load("./days.ts");

test("presetPeriod ends today and reaches back days-1, across month and year boundaries", () => {
  assert.deepEqual(days.presetPeriod("today", "2026-11-12"), { from: "2026-11-12", to: "2026-11-12", days: 1, preset: "today" });
  assert.deepEqual(days.presetPeriod("7d", "2026-11-12"), { from: "2026-11-06", to: "2026-11-12", days: 7, preset: "7d" });
  assert.equal(days.presetPeriod("30d", "2026-03-05").from, "2026-02-04", "2026 is not a leap year");
  assert.equal(days.presetPeriod("7d", "2027-01-03").from, "2026-12-28");
  assert.equal(days.presetPeriod("90d", "2026-11-12").days, 90);
  assert.equal(days.daysBetween(days.presetPeriod("90d", "2026-11-12").from, "2026-11-12"), 89);
});

test("previousPeriod is the same length ending the day before", () => {
  assert.deepEqual(days.previousPeriod(days.presetPeriod("7d", "2026-11-12")), { from: "2026-10-30", to: "2026-11-05", days: 7, preset: null });
  assert.deepEqual(days.previousPeriod(days.presetPeriod("today", "2026-11-12")), { from: "2026-11-11", to: "2026-11-11", days: 1, preset: null });
  assert.deepEqual(days.previousPeriod(days.presetPeriod("7d", "2027-01-03")), { from: "2026-12-21", to: "2026-12-27", days: 7, preset: null });
  assert.deepEqual(days.previousPeriod(days.customPeriod("2026-03-01", "2026-03-03")), { from: "2026-02-26", to: "2026-02-28", days: 3, preset: null });
  assert.deepEqual(days.previousPeriod(days.customPeriod("2028-03-01", "2028-03-03")), { from: "2028-02-27", to: "2028-02-29", days: 3, preset: null }, "leap day");
  assert.deepEqual(days.previousPeriod(days.customPeriod("2027-01-01", "2027-12-31")), { from: "2026-01-01", to: "2026-12-31", days: 365, preset: null });
});

test("customPeriod accepts real ordered days only", () => {
  assert.deepEqual(days.customPeriod("2026-11-01", "2026-11-01"), { from: "2026-11-01", to: "2026-11-01", days: 1, preset: null });
  assert.equal(days.customPeriod("2026-11-02", "2026-11-01"), null);
  assert.equal(days.customPeriod("2026-02-30", "2026-03-01"), null);
  assert.equal(days.customPeriod("2026-1-1", "2026-03-01"), null);
  assert.equal(days.customPeriod(20261101, "2026-11-02"), null);
  assert.equal(days.customPeriod(undefined, undefined), null);
  assert.equal(days.customPeriod("2028-02-29", "2028-03-01")?.days, 2);
  assert.equal(days.customPeriod("2026-02-29", "2026-03-01"), null);
});

test("eachDay is inclusive and unaffected by daylight-saving dates", () => {
  assert.deepEqual(days.eachDay("2026-12-30", "2027-01-02"), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.deepEqual(days.eachDay("2028-02-27", "2028-03-01"), ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
  assert.equal(days.eachDay("2026-03-07", "2026-03-09").length, 3, "US spring-forward weekend");
  assert.equal(days.eachDay("2026-10-24", "2026-10-26").length, 3, "EU fall-back weekend");
  assert.deepEqual(days.eachDay("2026-11-05", "2026-11-04"), []);
  assert.deepEqual(days.eachDay("2026-11-05", "2026-11-05"), ["2026-11-05"]);
});

test("day labels and compact ints round-trip", () => {
  assert.equal(days.dayToInt("2026-11-12"), 20261112);
  assert.equal(days.intToDay(20261112), "2026-11-12");
  assert.equal(days.intToDay(days.dayToInt("2028-02-29")), "2028-02-29");
  assert.equal(days.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(days.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(days.daysBetween("2026-11-12", "2026-11-05"), -7);
  assert.equal(days.isRangePreset("30d"), true);
  assert.equal(days.isRangePreset("constructor"), false);
});

test("makeDayOf and todayIn use the zone, and know the day boundary", () => {
  const tokyo = days.makeDayOf("Asia/Tokyo");
  const utc = days.makeDayOf("UTC");
  const ny = days.makeDayOf("America/New_York");
  const ts = Date.parse("2026-11-10T15:00:00Z");
  assert.equal(tokyo(ts - 1), 20261110);
  assert.equal(tokyo(ts), 20261111);
  assert.equal(utc(ts), 20261110);
  assert.equal(ny(Date.parse("2026-11-10T04:59:59Z")), 20261109);
  assert.equal(ny(Date.parse("2026-11-10T05:00:00Z")), 20261110);
  assert.equal(days.todayIn("Asia/Tokyo", ts), "2026-11-11");
  assert.equal(days.todayIn("UTC", ts), "2026-11-10");
});
