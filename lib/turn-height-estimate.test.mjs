import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./turn-height-estimate.ts");
}

test("empty content clamps to the minimum height", async () => {
  const { estimateTurnHeight, MIN_TURN_HEIGHT_PX } = await loadSubject();
  assert.equal(estimateTurnHeight({}), MIN_TURN_HEIGHT_PX);
  assert.equal(estimateTurnHeight({ text: "" }), MIN_TURN_HEIGHT_PX);
});

test("height grows monotonically with text length", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const lengths = [0, 10, 100, 500, 2000, 20000];
  let previous = -Infinity;
  for (const length of lengths) {
    const height = estimateTurnHeight({ text: "a".repeat(length) });
    assert.ok(height >= previous, `height for ${length} chars (${height}) should be >= previous (${previous})`);
    previous = height;
  }
  // And strictly so once past the shared floor, not just non-decreasing.
  assert.ok(estimateTurnHeight({ text: "a".repeat(2000) }) > estimateTurnHeight({ text: "a".repeat(10) }));
});

test("height grows monotonically with tool-call count", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const zero = estimateTurnHeight({ toolCallCount: 0 });
  const one = estimateTurnHeight({ toolCallCount: 1 });
  const five = estimateTurnHeight({ toolCallCount: 5 });
  assert.ok(one > zero, `1 tool call (${one}) should exceed 0 (${zero})`);
  assert.ok(five > one, `5 tool calls (${five}) should exceed 1 (${one})`);
});

test("height grows monotonically with image count", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const zero = estimateTurnHeight({ imageCount: 0 });
  const one = estimateTurnHeight({ imageCount: 1 });
  const three = estimateTurnHeight({ imageCount: 3 });
  assert.ok(one > zero);
  assert.ok(three > one);
});

test("negative counts are treated as zero rather than reducing the estimate", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const zero = estimateTurnHeight({ toolCallCount: 0, imageCount: 0 });
  const negative = estimateTurnHeight({ toolCallCount: -5, imageCount: -5 });
  assert.equal(negative, zero);
});

test("a one-liner and a huge diff no longer look identical", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const oneLiner = estimateTurnHeight({ text: "Done." });
  const hugeDiff = estimateTurnHeight({
    text: Array.from({ length: 3000 }, (_, i) => `+  line ${i}`).join("\n"),
  });
  assert.ok(
    hugeDiff > oneLiner * 10,
    `a 3000-line diff (${hugeDiff}px) should dwarf a one-liner (${oneLiner}px) instead of sharing one flat placeholder`,
  );
});

test("many short lines (diffs/code) count as more lines than raw char-wrap would predict", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const manyShortLines = Array.from({ length: 100 }, (_, i) => `x${i % 10}`).join("\n");
  const oneLongLineSameLength = "x".repeat(manyShortLines.length);
  assert.ok(estimateTurnHeight({ text: manyShortLines }) > estimateTurnHeight({ text: oneLongLineSameLength }));
});

test("fenced code blocks add height beyond the equivalent bare text", async () => {
  const { estimateTurnHeight } = await loadSubject();
  const body = "line one\nline two\nline three";
  const fencedHeight = estimateTurnHeight({ text: "```js\n" + body + "\n```" });
  const unfencedHeight = estimateTurnHeight({ text: body });
  assert.ok(fencedHeight > unfencedHeight, `fenced (${fencedHeight}) should exceed unfenced (${unfencedHeight})`);
});

test("clamps to the maximum height for extreme content", async () => {
  const { estimateTurnHeight, MAX_TURN_HEIGHT_PX } = await loadSubject();
  const height = estimateTurnHeight({ text: "a".repeat(1_000_000), toolCallCount: 500, imageCount: 500 });
  assert.equal(height, MAX_TURN_HEIGHT_PX);
});

test("never returns a value outside [MIN_TURN_HEIGHT_PX, MAX_TURN_HEIGHT_PX]", async () => {
  const { estimateTurnHeight, MIN_TURN_HEIGHT_PX, MAX_TURN_HEIGHT_PX } = await loadSubject();
  const samples = [
    {},
    { text: "short" },
    { text: "x".repeat(50000) },
    { toolCallCount: 20 },
    { imageCount: 20 },
    { text: "```\n".repeat(50) },
    { text: "line\n".repeat(10000), toolCallCount: 40, imageCount: 12 },
  ];
  for (const signal of samples) {
    const height = estimateTurnHeight(signal);
    assert.ok(
      height >= MIN_TURN_HEIGHT_PX && height <= MAX_TURN_HEIGHT_PX,
      `estimateTurnHeight(${JSON.stringify(signal)}) = ${height} is outside the clamped range`,
    );
  }
});
