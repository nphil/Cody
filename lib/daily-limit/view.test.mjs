import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createJiti } from "jiti";

/**
 * How the limit looks: the phase and colour at each point of the day, the level
 * the ring fills to, and the words, in all three languages.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deriveView, formatDuration, ringLabel, TONE_COLOR } = await jiti.import("./view.ts");
const { DAILY_LIMIT_SETTINGS_ID } = await jiti.import("./state.ts");
const { translate } = await jiti.import("../i18n/index.tsx");

const MINUTE = 60;
const state = (usedSeconds, overrides = {}) => ({
  enabled: true,
  limitMinutes: 120,
  day: "2026-10-13",
  zone: "UTC",
  dayStartsAt: 0,
  dayEndsAt: 86_400_000,
  serverNow: 1,
  usedSeconds,
  extraSeconds: 0,
  limitSeconds: 7200,
  remainingSeconds: 7200 - usedSeconds,
  noticeDue: false,
  ...overrides,
});

test("nothing is drawn while the limit is off or not yet known", () => {
  assert.equal(deriveView(null), null);
  assert.equal(deriveView(state(0, { enabled: false })), null);
});

test("accent until 15 minutes are left, warning for the last 15, error once the limit is spent", () => {
  const at = (remainingMinutes) => deriveView(state(7200 - remainingMinutes * MINUTE));
  assert.deepEqual([at(120).phase, at(120).tone], ["normal", "accent"]);
  assert.deepEqual([at(16).phase, at(16).tone], ["normal", "accent"]);
  assert.deepEqual([at(15.016).phase, at(15.016).tone], ["normal", "accent"], "one second past the threshold is still normal");
  assert.deepEqual([at(15).phase, at(15).tone], ["warning", "warning"], "exactly 15 minutes left is the warning");
  assert.deepEqual([at(1).phase, at(1).tone], ["warning", "warning"]);
  assert.deepEqual([at(0).phase, at(0).tone], ["reached", "error"], "zero left is error, not warning");
  assert.deepEqual([at(-0.5).phase, at(-0.5).tone], ["reached", "error"], "under a minute over still reads as 'reached'");
  assert.deepEqual([at(-1).phase, at(-1).tone], ["over", "error"]);
  assert.deepEqual([at(-12).phase, at(-12).tone], ["over", "error"]);
});

test("the tones are design tokens, never colours", () => {
  assert.deepEqual(TONE_COLOR, { accent: "var(--accent)", warning: "var(--status-warning)", error: "var(--status-error)" });
});

test("the ring fills with the share of the limit used, from empty to full, and stays full when over", () => {
  assert.equal(deriveView(state(0)).level, 0);
  assert.equal(deriveView(state(1800)).level, 0.25);
  assert.equal(deriveView(state(3600)).level, 0.5);
  assert.equal(deriveView(state(7200)).level, 1);
  assert.equal(deriveView(state(9000)).level, 1, "12m over is a full ring, not an overflowing one");
  // Added time lowers the level: 2 h used of 2 h + 15 m.
  assert.equal(deriveView(state(7200, { extraSeconds: 900, limitSeconds: 8100, remainingSeconds: 900 })).level.toFixed(3), "0.889");
});

test("left and over are never negative, and the notice flag is the server's", () => {
  const over = deriveView(state(8000, { noticeDue: true }));
  assert.equal(over.leftSeconds, 0);
  assert.equal(over.overSeconds, 800);
  assert.equal(over.noticeDue, true);
  const normal = deriveView(state(100));
  assert.equal(normal.overSeconds, 0);
  assert.equal(normal.leftSeconds, 7100);
});

test("durations: ceil for what is left, floor for what was used", () => {
  const en = (seconds, round) => formatDuration(seconds, round, translate);
  assert.equal(en(4320, "ceil"), "1h 12m");
  assert.equal(en(7200, "floor"), "2h", "no '2h 0m'");
  assert.equal(en(45 * 60, "ceil"), "45m");
  assert.equal(en(59, "ceil"), "1m", "59 seconds left is '1m left', never '0m left' while time remains");
  assert.equal(en(59, "floor"), "<1m");
  assert.equal(en(0, "floor"), "0m");
  assert.equal(en(0, "ceil"), "0m");
  assert.equal(en(-5, "ceil"), "0m");
  assert.equal(en(3600 + 59, "floor"), "1h");
  assert.equal(en(3600 + 61, "ceil"), "1h 2m");
});

test("the tooltip and screen-reader name give the time left, then that it is gone, then how far over", () => {
  const label = (used) => ringLabel(deriveView(state(used)), translate);
  assert.equal(label(2880), "1h 12m left today");
  assert.equal(label(6300), "15m left today");
  assert.equal(label(7200), "Daily limit reached");
  assert.equal(label(7230), "Daily limit reached");
  assert.equal(label(7200 + 12 * 60), "12m over today's limit");
});

test("the Settings card's search id is what the popover links to", () => {
  const slug = "Daily time limit".toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  assert.equal(DAILY_LIMIT_SETTINGS_ID, slug);
});

test("every dailyLimit key the code asks for exists in all three languages, with the same placeholders", () => {
  const read = (locale) => JSON.parse(fs.readFileSync(new URL(`../i18n/locales/${locale}.json`, import.meta.url), "utf8"));
  const [en, ja, zh] = ["en", "ja", "zh-CN"].map(read);
  const used = new Set();
  for (const file of ["../../components/DailyLimitRing.tsx", "../../components/DailyLimitNotice.tsx", "./view.ts"]) {
    for (const match of fs.readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/"(dailyLimit\.[A-Za-z0-9]+)"/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 15);
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const key of used) {
    for (const [name, dictionary] of [["en", en], ["ja", ja], ["zh-CN", zh]]) assert.ok(dictionary[key], `${name} has ${key}`);
    assert.equal(placeholders(ja[key]), placeholders(en[key]), `ja ${key}`);
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `zh-CN ${key}`);
  }
});
