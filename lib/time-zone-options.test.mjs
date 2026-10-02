import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AUTOMATIC_TIME_ZONE, timeZoneOptions } = await jiti.import("./time-zone-options.ts");
const { listTimeZones, normalizeTimeZone } = await jiti.import("./time-zone.ts");

const ZONES = ["America/New_York", "Asia/Kolkata", "Asia/Tokyo", "UTC"];
const AUTOMATIC_LABEL = "Automatic (this device: Asia/Tokyo)";

test("Automatic is the first row, a real choice of its own, and selected until a zone is pinned", () => {
  const { options, value } = timeZoneOptions({ zones: ZONES, explicit: null, automaticLabel: AUTOMATIC_LABEL });
  assert.deepEqual(options[0], { value: AUTOMATIC_TIME_ZONE, label: AUTOMATIC_LABEL });
  assert.equal(value, AUTOMATIC_TIME_ZONE);
  assert.deepEqual(options.slice(1).map((option) => option.value), ZONES, "every zone follows, in the order given");
  assert.equal(options.filter((option) => option.value === AUTOMATIC_TIME_ZONE).length, 1, "no zone can be mistaken for Automatic");
});

test("a pinned zone is the selected row and adds none", () => {
  const { options, value } = timeZoneOptions({ zones: ZONES, explicit: "Asia/Tokyo", automaticLabel: AUTOMATIC_LABEL });
  assert.equal(value, "Asia/Tokyo");
  assert.equal(options.length, ZONES.length + 1);
});

test("the saved choice still shows as selected when the server names the zone differently", () => {
  // The picker lists Asia/Kolkata; the server's runtime stored the name it
  // reports for the same zone. Same zone, two names — one row must be selected.
  assert.equal(normalizeTimeZone("Asia/Kolkata"), normalizeTimeZone("Asia/Calcutta"), "premise: this runtime links the two names");
  const pinnedBySpelling = timeZoneOptions({ zones: ZONES, explicit: "Asia/Calcutta", automaticLabel: AUTOMATIC_LABEL });
  assert.equal(pinnedBySpelling.value, "Asia/Kolkata");
  assert.equal(pinnedBySpelling.options.length, ZONES.length + 1, "no duplicate row for the alias");

  // The legacy region alias a script or an old install may have saved.
  const withLosAngeles = [...ZONES, "America/Los_Angeles"];
  const legacy = timeZoneOptions({ zones: withLosAngeles, explicit: "US/Pacific", automaticLabel: AUTOMATIC_LABEL });
  assert.equal(legacy.value, "America/Los_Angeles");
});

test("a saved zone this browser does not list gets a row of its own right after Automatic", () => {
  for (const explicit of ["Mars/Olympus_Mons", "US/Pacific"]) {
    const { options, value } = timeZoneOptions({ zones: ZONES, explicit, automaticLabel: AUTOMATIC_LABEL });
    assert.equal(value, explicit);
    assert.deepEqual(options[1], { value: explicit, label: explicit });
    assert.deepEqual(options.slice(2).map((option) => option.value), ZONES, explicit);
  }
});

test("every zone the picker itself lists is found again when it is saved", () => {
  const zones = listTimeZones();
  assert.ok(zones.length > 20, "premise: a real zone list");
  for (const zone of zones) {
    const { options, value } = timeZoneOptions({ zones, explicit: zone, automaticLabel: AUTOMATIC_LABEL });
    assert.equal(value, zone);
    assert.equal(options.length, zones.length + 1, `${zone} must not add a row`);
  }
});
