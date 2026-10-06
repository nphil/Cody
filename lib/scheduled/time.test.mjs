import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseInstant, describeDelay } = await jiti.import("./time.ts");

const iso = (parsed) => {
  assert.ok(parsed.ok, "expected the time to parse");
  return new Date(parsed.at).toISOString();
};

test("a time with an offset is exact and needs no zone; one without is the wall clock of the zone it is read in", () => {
  assert.equal(iso(parseInstant("2026-10-06T09:00:00Z", "America/New_York")), "2026-10-06T09:00:00.000Z");
  assert.equal(iso(parseInstant("2026-10-06T09:00:00-04:00", "Asia/Tokyo")), "2026-10-06T13:00:00.000Z");
  assert.equal(iso(parseInstant("2026-10-06T09:00+0530", "UTC")), "2026-10-06T03:30:00.000Z");
  assert.equal(iso(parseInstant("2026-10-06T09:00", "America/New_York")), "2026-10-06T13:00:00.000Z", "9 AM in New York, not 9 AM UTC");
  assert.equal(iso(parseInstant("2026-10-06 09:00", "Asia/Kolkata")), "2026-10-06T03:30:00.000Z", "a space instead of T is what models write");
  assert.equal(parseInstant("2026-10-06T09:00", "UTC").hadOffset, false);
  assert.equal(parseInstant("2026-10-06T09:00Z", "UTC").hadOffset, true);
});

test("seconds and fractions are read, and a fraction never shifts the minute", () => {
  assert.equal(iso(parseInstant("2026-10-06T09:00:30.5Z", "UTC")), "2026-10-06T09:00:30.500Z");
  assert.equal(iso(parseInstant("2026-10-06T09:00:30.123456Z", "UTC")), "2026-10-06T09:00:30.123Z");
});

test("a daylight-saving gap reads as the later instant and an hour that happens twice as the first", () => {
  // 2 AM → 3 AM on 2026-03-08 in New York: 02:30 does not exist, a calendar shows it as 03:30 EDT.
  assert.equal(iso(parseInstant("2026-03-08T02:30", "America/New_York")), "2026-03-08T07:30:00.000Z");
  // 2 AM → 1 AM on 2026-11-01: 01:30 happens twice; the first is still EDT.
  assert.equal(iso(parseInstant("2026-11-01T01:30", "America/New_York")), "2026-11-01T05:30:00.000Z");
  // A zone with no daylight saving is unaffected.
  assert.equal(iso(parseInstant("2026-03-08T02:30", "Asia/Tokyo")), "2026-03-07T17:30:00.000Z");
});

test("anything that is not a real date and time is refused, never guessed", () => {
  for (const bad of [
    "",
    "tomorrow 9am",
    "2026-10-06", // a date is not a time
    "09:00",
    "2026-02-30T10:00", // Feb 30 would silently roll over to March
    "2026-13-01T10:00",
    "2026-10-06T25:00",
    "2026-10-06T09:60",
    "2026-10-06T09:00:61",
    "2026-10-06T09:00+25:00",
    "2026-10-06T09:00 PST",
    "2026-10-06T09:00;rm -rf /",
  ]) {
    assert.deepEqual(parseInstant(bad, "UTC"), { ok: false }, JSON.stringify(bad));
  }
  assert.deepEqual(parseInstant("2026-10-06T09:00", "Not/AZone"), { ok: false }, "a time that needs a zone and has none is refused");
  assert.equal(parseInstant("2026-10-06T09:00Z", "Not/AZone").ok, true, "an exact instant does not need one");
});

test("how far away a time is reads the way a person would say it", () => {
  const minute = 60_000;
  assert.equal(describeDelay(10_000, 0), "now");
  assert.equal(describeDelay(45 * minute, 0), "in 45 min");
  assert.equal(describeDelay(60 * minute, 0), "in 1 h");
  assert.equal(describeDelay(192 * minute, 0), "in 3 h 12 min");
  assert.equal(describeDelay(26 * 60 * minute, 0), "in 1 day 2 h");
  assert.equal(describeDelay(48 * 60 * minute, 0), "in 2 days");
  assert.equal(describeDelay(-minute * 5, 0), "now", "a time already past is just now");
});
