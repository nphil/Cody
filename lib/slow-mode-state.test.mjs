import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deriveSlowModeState, describeUsageLimit, readUsageLimit, sameUsageLimit, usageLimitStageToAnnounce } =
  await jiti.import("./slow-mode-state.ts");

const locales = Object.fromEntries(
  ["en", "ja", "zh-CN"].map((name) => [name, JSON.parse(readFileSync(new URL(`./i18n/locales/${name}.json`, import.meta.url), "utf8"))]),
);
const translatorFor = (messages) => (key, vars = {}) => {
  const template = messages[key];
  if (typeof template !== "string") return key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
};
const fakeT = (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ""}`;
const clock = () => "14:30";

test("slow switch is hidden unless the engine says the active model supports it", () => {
  assert.equal(deriveSlowModeState(undefined), null);
  assert.equal(deriveSlowModeState({}), null);
  assert.equal(deriveSlowModeState({ slowModeSupported: false, slowModeEnabled: true, slowModeScope: "global" }), null);
  assert.equal(deriveSlowModeState({ slowModeSupported: "true" }), null);
});

test("slow switch state reads the engine's flag, and an unknown scope never claims to reach other chats", () => {
  assert.deepEqual(deriveSlowModeState({ slowModeSupported: true, slowModeEnabled: true, slowModeScope: "global" }), { enabled: true, scope: "global" });
  assert.deepEqual(deriveSlowModeState({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }), { enabled: false, scope: "session" });
  assert.deepEqual(deriveSlowModeState({ slowModeSupported: true }), { enabled: false, scope: "session" });
  assert.deepEqual(deriveSlowModeState({ slowModeSupported: true, slowModeEnabled: true, slowModeScope: "everywhere" }), { enabled: true, scope: "session" });
});

test("readUsageLimit keeps only well-formed stages", () => {
  assert.equal(readUsageLimit(undefined), null);
  assert.equal(readUsageLimit("low_priority"), null);
  assert.equal(readUsageLimit({ stage: "mystery", resetsAtSec: 1_800_000_000 }), null);
  // A low-priority stage with no reset time is not one the engine ever sends.
  assert.equal(readUsageLimit({ stage: "low_priority" }), null);
  assert.equal(readUsageLimit({ stage: "low_priority", resetsAtSec: -5 }), null);
  assert.deepEqual(
    readUsageLimit({ stage: "low_priority", resetsAtSec: 1_800_000_000, allowanceLeftPercent: 130 }),
    { stage: "low_priority", resetsAtSec: 1_800_000_000, allowanceLeftPercent: 100 },
  );
  assert.deepEqual(
    readUsageLimit({ stage: "low_priority", resetsAtSec: 1_800_000_000, allowanceLeftPercent: "lots" }),
    { stage: "low_priority", resetsAtSec: 1_800_000_000 },
  );
  // Wrap-up may have no reset time, and extra usage is on only when it is literally true.
  assert.deepEqual(readUsageLimit({ stage: "wrap_up", extraUsage: true }), { stage: "wrap_up", extraUsage: true });
  assert.deepEqual(readUsageLimit({ stage: "wrap_up", resetsAtSec: 1_800_000_000, extraUsage: "yes" }), { stage: "wrap_up", resetsAtSec: 1_800_000_000, extraUsage: false });
});

test("sameUsageLimit tells a repeat poll from a real change", () => {
  const low = { stage: "low_priority", resetsAtSec: 100, allowanceLeftPercent: 20 };
  assert.equal(sameUsageLimit(null, null), true);
  assert.equal(sameUsageLimit(low, { ...low }), true);
  assert.equal(sameUsageLimit(low, { ...low, allowanceLeftPercent: 19 }), false);
  assert.equal(sameUsageLimit(low, { ...low, resetsAtSec: 101 }), false);
  assert.equal(sameUsageLimit(low, null), false);
  assert.equal(sameUsageLimit({ stage: "wrap_up", extraUsage: true }, { stage: "wrap_up", extraUsage: false }), false);
  assert.equal(sameUsageLimit(low, { stage: "wrap_up", resetsAtSec: 100, extraUsage: false }), false);
});

test("the chat is told when a stage starts or changes, never when it merely ends", () => {
  const low = { stage: "low_priority", resetsAtSec: 100 };
  const wrap = { stage: "wrap_up", extraUsage: false };
  // First read of a chat already past its limit: this is when someone asks why replies are slow.
  assert.equal(usageLimitStageToAnnounce(undefined, low), "low_priority");
  assert.equal(usageLimitStageToAnnounce(null, wrap), "wrap_up");
  // Same stage on the next poll: silent.
  assert.equal(usageLimitStageToAnnounce(low, { ...low, allowanceLeftPercent: 5 }), null);
  assert.equal(usageLimitStageToAnnounce(low, wrap), "wrap_up");
  // The field vanishes on a model switch too, so "back to normal" would be a false claim.
  assert.equal(usageLimitStageToAnnounce(low, null), null);
  assert.equal(usageLimitStageToAnnounce(undefined, null), null);
});

test("describeUsageLimit chooses wording by stage, time and extra usage", () => {
  const at = 1_800_000_000;
  const low = describeUsageLimit({ stage: "low_priority", resetsAtSec: at, allowanceLeftPercent: 12.4 }, fakeT, clock);
  assert.equal(low.notice, 'slowMode.noticeLowPriority{"time":"14:30"} slowMode.allowanceLeft{"percent":12}');
  assert.equal(low.line, 'slowMode.lineLowPriority \u00b7 slowMode.until{"time":"14:30"} \u00b7 slowMode.allowanceLeftShort{"percent":12}');

  const lowBare = describeUsageLimit({ stage: "low_priority", resetsAtSec: at }, fakeT, () => null);
  assert.equal(lowBare.notice, "slowMode.noticeLowPriorityNoTime");
  assert.equal(lowBare.line, "slowMode.lineLowPriority");

  const wrapOn = describeUsageLimit({ stage: "wrap_up", resetsAtSec: at, extraUsage: true }, fakeT, clock);
  assert.equal(wrapOn.notice, 'slowMode.noticeWrapUp{"time":"14:30"} slowMode.extraUsageOn');
  assert.equal(wrapOn.line, 'slowMode.lineWrapUp \u00b7 slowMode.until{"time":"14:30"} \u00b7 slowMode.extraUsageOnShort');

  const wrapOff = describeUsageLimit({ stage: "wrap_up", extraUsage: false }, fakeT, clock);
  assert.equal(wrapOff.notice, "slowMode.noticeWrapUpNoTime slowMode.extraUsageOff");
  assert.equal(wrapOff.line, "slowMode.lineWrapUp \u00b7 slowMode.extraUsageOffShort");
});

test("every stage renders real words in en, ja and zh-CN, never a raw key", () => {
  const stages = [
    { stage: "low_priority", resetsAtSec: 1_800_000_000, allowanceLeftPercent: 40 },
    { stage: "low_priority", resetsAtSec: 1_800_000_000 },
    { stage: "wrap_up", resetsAtSec: 1_800_000_000, extraUsage: true },
    { stage: "wrap_up", extraUsage: false },
  ];
  for (const [name, messages] of Object.entries(locales)) {
    const t = translatorFor(messages);
    for (const stage of stages) {
      for (const formatTime of [clock, () => null]) {
        const { notice, line } = describeUsageLimit(stage, t, formatTime);
        for (const text of [notice, line]) {
          assert.ok(text.length > 0, `${name}: empty text`);
          assert.ok(!text.includes("slowMode."), `${name}: raw key in "${text}"`);
          assert.ok(!text.includes("undefined") && !/\{\w+\}/.test(text), `${name}: unfilled placeholder in "${text}"`);
        }
      }
    }
    for (const key of ["slowMode.on", "slowMode.off", "slowMode.hintSession", "slowMode.hintGlobal"]) {
      assert.equal(typeof messages[key], "string", `${name} lacks ${key}`);
    }
  }
  assert.match(locales.en["slowMode.hintGlobal"], /every chat/);
});
