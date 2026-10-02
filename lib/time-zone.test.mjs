import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const tz = await jiti.import("./time-zone.ts");

test("a zone is canonicalised, and anything that is not a plain IANA name is refused", () => {
  assert.equal(tz.normalizeTimeZone("America/New_York"), "America/New_York");
  assert.equal(tz.normalizeTimeZone("  asia/tokyo "), "Asia/Tokyo", "case and padding are forgiven so two spellings compare equal");
  assert.equal(tz.normalizeTimeZone(":Europe/Paris"), "Europe/Paris", "a POSIX-style TZ value keeps working");
  assert.equal(tz.normalizeTimeZone("UTC"), "UTC");

  // These would either mean something else as a TZ or never be a zone at all.
  for (const bad of ["", "   ", "Mars/Phobos", "+05:00", "UTC+5", "../etc/localtime", "America/New_York; rm -rf /", "a".repeat(80), null, undefined, 7, {}]) {
    assert.equal(tz.normalizeTimeZone(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("the server zone is its TZ, then the system zone, never an unusable value", () => {
  assert.equal(tz.serverTimeZone({ TZ: "Asia/Tokyo" }), "Asia/Tokyo");
  // A garbage TZ is not trusted: the runtime's own zone answers instead.
  assert.equal(tz.serverTimeZone({ TZ: "not/a-zone" }), tz.detectDeviceTimeZone() ?? "UTC");
  assert.equal(tz.serverTimeZone({}), tz.detectDeviceTimeZone() ?? "UTC");
});

test("two names for one zone compare equal once canonicalised, so a spelling change never looks like a trip", () => {
  // ICU files Kolkata under its older name; whichever it picks, both spellings must agree.
  assert.equal(tz.normalizeTimeZone("Asia/Kolkata"), tz.normalizeTimeZone("Asia/Calcutta"));
  assert.equal(tz.normalizeTimeZone("Etc/UTC"), tz.normalizeTimeZone("UTC"));
});

test("zone resolution: chosen beats this device beats last seen beats the server beats UTC", () => {
  const all = { explicit: "Europe/Paris", device: "Asia/Tokyo", lastSeen: "America/New_York", server: "Australia/Sydney" };
  assert.deepEqual(tz.resolveTimeZone(all), { zone: "Europe/Paris", source: "explicit" });
  assert.deepEqual(tz.resolveTimeZone({ ...all, explicit: undefined }), { zone: "Asia/Tokyo", source: "device" });
  assert.deepEqual(tz.resolveTimeZone({ ...all, explicit: null, device: undefined }), { zone: "America/New_York", source: "last-seen" });
  assert.deepEqual(tz.resolveTimeZone({ server: "Australia/Sydney" }), { zone: "Australia/Sydney", source: "server" });
  assert.deepEqual(tz.resolveTimeZone({}), { zone: "UTC", source: "utc" });
});

test("an invalid zone in any layer is skipped, not trusted and not fatal", () => {
  assert.deepEqual(
    tz.resolveTimeZone({ explicit: "Nowhere/Land", device: "Asia/Tokyo", lastSeen: "America/New_York" }),
    { zone: "Asia/Tokyo", source: "device" },
    "a stale explicit choice falls through to the device",
  );
  assert.deepEqual(
    tz.resolveTimeZone({ explicit: 42, device: "; reboot", lastSeen: "", server: "../../etc" }),
    { zone: "UTC", source: "utc" },
    "every layer bad leaves UTC",
  );
});

test("local timestamps always state their offset: an abbreviation where the zone has one, the numeric offset where it does not", () => {
  const instant = "2026-10-01T23:31:39.753Z";
  assert.equal(tz.formatLocalTime(instant, "America/New_York"), "2026-10-01 19:31 EDT");
  assert.equal(tz.formatLocalTime(instant, "America/Los_Angeles"), "2026-10-01 16:31 PDT");
  assert.equal(tz.formatLocalTime(instant, "Asia/Tokyo"), "2026-10-02 08:31 UTC+09:00", "the date rolls forward with the zone");
  assert.equal(tz.formatLocalTime(instant, "Asia/Kolkata"), "2026-10-02 05:01 UTC+05:30", "half-hour offsets survive");
  assert.equal(tz.formatLocalTime(instant, "UTC"), "2026-10-01 23:31 UTC");
  // Same zone, either side of the autumn change: the label follows the date.
  assert.equal(tz.formatLocalTime("2026-12-15T12:00:00Z", "America/New_York"), "2026-12-15 07:00 EST");
  assert.equal(tz.formatLocalTime(Date.parse(instant), "America/New_York"), "2026-10-01 19:31 EDT", "epoch milliseconds are accepted");
});

test("midnight prints as 00:xx, never 24:xx", () => {
  assert.equal(tz.formatLocalTime("2026-10-02T04:05:00Z", "America/New_York"), "2026-10-02 00:05 EDT");
  assert.match(tz.describeLocalNow("2026-10-02T04:05:00Z", "America/New_York"), /, 00:05 EDT /);
});

test("a value that is not an instant, or a zone that is not known, comes back as given instead of a blank", () => {
  assert.equal(tz.formatLocalTime("yesterday", "America/New_York"), "yesterday");
  assert.equal(tz.formatLocalTime("2026-10-01T23:31:39Z", "Nowhere/Land"), "2026-10-01T23:31:39Z");
});

test("the line a model is told names the weekday, spells the month and states both zone and offset", () => {
  const nowEastern = tz.describeLocalNow("2026-10-02T18:58:00Z", "America/New_York");
  assert.equal(nowEastern, "Friday 2 October 2026, 14:58 EDT (America/New_York, UTC-04:00)");
  const nowTokyo = tz.describeLocalNow("2026-10-02T18:58:00Z", "Asia/Tokyo");
  assert.equal(nowTokyo, "Saturday 3 October 2026, 03:58 (Asia/Tokyo, UTC+09:00)", "no abbreviation to repeat the offset with");
  assert.equal(tz.describeLocalNow("2026-10-02T18:58:00Z", "UTC"), "Friday 2 October 2026, 18:58 UTC (UTC, UTC+00:00)");
});

test("the picker list is whole, sorted and always offers UTC", () => {
  const zones = tz.listTimeZones();
  assert.ok(zones.includes("UTC"));
  assert.ok(zones.includes("America/New_York"));
  assert.ok(zones.includes("Asia/Tokyo"));
  assert.deepEqual(zones, [...zones].sort((a, b) => a.localeCompare(b)));
  assert.equal(new Set(zones).size, zones.length, "no duplicates");
  for (const zone of zones) assert.equal(tz.normalizeTimeZone(zone) !== null, true, `${zone} must be a zone the server accepts back`);
});

test("the hidden per-prompt line is exactly what every transcript reader drops", async () => {
  const { isHiddenFromTranscript } = await jiti.import("./message-display.ts");
  assert.equal(isHiddenFromTranscript({ role: "custom", customType: tz.LOCAL_TIME_CUSTOM_TYPE }), true);
  // Neither another hidden engine message nor a user message that merely says so.
  assert.equal(isHiddenFromTranscript({ role: "custom", customType: "eager-todo-prelude" }), false);
  assert.equal(isHiddenFromTranscript({ role: "user", customType: tz.LOCAL_TIME_CUSTOM_TYPE }), false);
});
