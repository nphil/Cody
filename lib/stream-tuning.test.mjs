import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname },
});
const {
  DEFAULT_STREAM_TUNING,
  STREAM_TUNING_RANGES,
  normalizeStreamTuning,
  streamTuningCssVars,
  isDefaultStreamTuning,
} = await jiti.import("./stream-tuning.ts");

test("defaults round-trip through normalization untouched", () => {
  assert.deepEqual(normalizeStreamTuning(DEFAULT_STREAM_TUNING), DEFAULT_STREAM_TUNING);
  assert.equal(isDefaultStreamTuning(DEFAULT_STREAM_TUNING), true);
});

test("garbage and out-of-range values clamp to safe tuning", () => {
  const t = normalizeStreamTuning({
    catchUpMs: -50,
    minRevealChars: 9999,
    maxBacklogChars: "not a number",
    wordFadeMs: Infinity,
    paceToolInput: "yes",
    easing: "javascript:alert(1)",
  });
  assert.equal(t.catchUpMs, STREAM_TUNING_RANGES.catchUpMs.min);
  assert.equal(t.minRevealChars, STREAM_TUNING_RANGES.minRevealChars.max);
  assert.equal(t.maxBacklogChars, DEFAULT_STREAM_TUNING.maxBacklogChars);
  assert.equal(t.wordFadeMs, DEFAULT_STREAM_TUNING.wordFadeMs);
  assert.equal(t.paceToolInput, DEFAULT_STREAM_TUNING.paceToolInput);
  assert.equal(t.easing, DEFAULT_STREAM_TUNING.easing, "easing is an allowlist, not free text");
});

test("non-object input yields the defaults", () => {
  assert.deepEqual(normalizeStreamTuning(null), DEFAULT_STREAM_TUNING);
  assert.deepEqual(normalizeStreamTuning("junk"), DEFAULT_STREAM_TUNING);
});

test("css vars are emitted only for values that differ from defaults", () => {
  assert.deepEqual(streamTuningCssVars(DEFAULT_STREAM_TUNING), {},
    "a default tuning must leave the stylesheet's own var() fallbacks in charge");
  const vars = streamTuningCssVars({ ...DEFAULT_STREAM_TUNING, wordFadeMs: 400, wordBlurPx: 2, easing: "linear" });
  assert.deepEqual(vars, {
    "--stream-word-dur": "400ms",
    "--stream-word-blur": "2px",
    "--stream-anim-ease": "linear",
  });
});

test("every numeric range key exists on the tuning shape", () => {
  for (const key of Object.keys(STREAM_TUNING_RANGES)) {
    assert.ok(key in DEFAULT_STREAM_TUNING, `range ${key} names a real tuning field`);
  }
});
