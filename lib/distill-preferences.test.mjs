import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname },
});
const {
  DEFAULT_DISTILL_PREFERENCES,
  DISTILL_REPLY_MODES,
  isDefaultDistillPreferences,
  normalizeDistillPreferences,
} = await jiti.import("./distill-preferences.ts");
const { STORAGE_KEYS } = await jiti.import("./storage-keys.ts");

test("distill is off for everyone who has not asked for it", () => {
  assert.deepEqual(DEFAULT_DISTILL_PREFERENCES, { replies: "off", thinking: false, plainLanguage: false });
  assert.equal(isDefaultDistillPreferences(DEFAULT_DISTILL_PREFERENCES), true);
  assert.deepEqual(normalizeDistillPreferences(DEFAULT_DISTILL_PREFERENCES), DEFAULT_DISTILL_PREFERENCES);
});

test("plainLanguage normalizes like thinking: a real boolean survives, anything else falls back to off", () => {
  assert.equal(normalizeDistillPreferences({ plainLanguage: true }).plainLanguage, true);
  for (const bad of ["yes", 1, null, undefined]) {
    assert.equal(normalizeDistillPreferences({ plainLanguage: bad }).plainLanguage, false);
  }
  assert.equal(isDefaultDistillPreferences({ replies: "off", thinking: false, plainLanguage: true }), false);
});

test("every declared reply mode survives a round trip", () => {
  for (const mode of DISTILL_REPLY_MODES) {
    assert.equal(normalizeDistillPreferences({ replies: mode, thinking: true }).replies, mode);
  }
});

test("a stored value the code does not know falls back to off, never through", () => {
  // The value comes from localStorage, so it is attacker- and typo-reachable:
  // an unknown mode must not reach the request body as a verbosity.
  for (const bad of ["verbose", "OFF", "", null, 3, { replies: "low" }]) {
    assert.equal(normalizeDistillPreferences({ replies: bad, thinking: true }).replies, "off");
  }
  assert.equal(normalizeDistillPreferences({ replies: "high", thinking: "yes" }).thinking, false);
});

test("non-object storage content yields the defaults instead of throwing", () => {
  for (const junk of [null, undefined, "half-written", 7, []]) {
    assert.deepEqual(normalizeDistillPreferences(junk), DEFAULT_DISTILL_PREFERENCES);
  }
});

test("a partial object keeps the untouched fields at their default", () => {
  assert.deepEqual(normalizeDistillPreferences({ thinking: true }), { replies: "off", thinking: true, plainLanguage: false });
  assert.deepEqual(normalizeDistillPreferences({ replies: "medium" }), { replies: "medium", thinking: false, plainLanguage: false });
});

test("the preference lives under the registered cody: key", () => {
  assert.equal(STORAGE_KEYS.distill, "cody:distill");
});
