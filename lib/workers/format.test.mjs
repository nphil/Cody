import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatDuration, formatBytes, formatCount, describeReason, lastLines } = await jiti.import("./format.ts");
const { MACHINE_REASONS, WORKER_PROBLEMS } = await jiti.import("../machines/types.ts");

/**
 * The agent reads these words in a tool result, so the numbers must be exact
 * and the units right: durations (`0.4 s`, `1 min 12 s`, `2 h 05 min`), sizes
 * (powers of 1024), counts (singular/plural), the plain-words reason for a
 * worker problem (with the ssh line in parentheses), and `lastLines`, which
 * keeps the newest output lines that fit in a byte budget.
 */

test("a duration under ten seconds shows one decimal", () => {
  assert.equal(formatDuration(0), "0.0 s");
  assert.equal(formatDuration(400), "0.4 s");
  assert.equal(formatDuration(1234), "1.2 s");
  assert.equal(formatDuration(9949), "9.9 s");
});

test("a duration from ten seconds to a minute shows whole seconds", () => {
  assert.equal(formatDuration(10_000), "10 s");
  assert.equal(formatDuration(12_400), "12 s");
  assert.equal(formatDuration(12_500), "13 s");
  assert.equal(formatDuration(59_400), "59 s");
});

test("a duration of a minute or more shows minutes and two-digit seconds", () => {
  assert.equal(formatDuration(60_000), "1 min 00 s");
  assert.equal(formatDuration(72_000), "1 min 12 s");
  assert.equal(formatDuration(3_599_000), "59 min 59 s");
});

test("a duration of an hour or more shows hours and two-digit minutes, dropping seconds", () => {
  assert.equal(formatDuration(3_600_000), "1 h 00 min");
  assert.equal(formatDuration(2 * 3_600_000 + 5 * 60_000 + 59_000), "2 h 05 min");
  assert.equal(formatDuration(25 * 3_600_000), "25 h 00 min");
});

test("a duration is rounded to the nearest second first, so 59.6 s becomes 1 min 00 s", () => {
  assert.equal(formatDuration(59_500), "1 min 00 s");
  assert.equal(formatDuration(59_600), "1 min 00 s");
  assert.equal(formatDuration(3_599_600), "1 h 00 min");
  // below ten seconds the one-decimal form is used, which can show 10.0 s at the very edge
  assert.equal(formatDuration(9_960), "10.0 s");
});

test("a negative duration is shown as zero", () => {
  assert.equal(formatDuration(-5), "0.0 s");
  assert.equal(formatDuration(-1_000_000), "0.0 s");
});

test("sizes use powers of 1024 with the right unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(812), "812 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 ** 2), "1.0 MB");
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
  assert.equal(formatBytes(1024 ** 4), "1.0 TB");
});

test("a size shows one decimal under 10 and whole numbers from 10", () => {
  assert.equal(formatBytes(4200), "4.1 KB");
  assert.equal(formatBytes(10 * 1024), "10 KB");
  assert.equal(formatBytes(45 * 1024 ** 2), "45 MB");
  assert.equal(formatBytes(1.2 * 1024 ** 3), "1.2 GB");
});

test("a size past terabytes stays in terabytes", () => {
  assert.equal(formatBytes(2048 * 1024 ** 4), "2048 TB");
});

test("a negative size is zero bytes and NaN does not crash", () => {
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(-1e12), "0 B");
  assert.doesNotThrow(() => formatBytes(Number.NaN));
  assert.equal(typeof formatBytes(Number.NaN), "string");
});

test("a count says file for one and files for the rest, including zero", () => {
  assert.equal(formatCount(1, "file"), "1 file");
  assert.equal(formatCount(0, "file"), "0 files");
  assert.equal(formatCount(2, "file"), "2 files");
});

test("a count uses the given plural when the plain 's' is wrong", () => {
  assert.equal(formatCount(1, "directory", "directories"), "1 directory");
  assert.equal(formatCount(3, "directory", "directories"), "3 directories");
});

test("a count groups thousands with commas", () => {
  assert.equal(formatCount(1234, "file"), "1,234 files");
  assert.equal(formatCount(1_234_567, "line"), "1,234,567 lines");
  assert.equal(formatCount(999, "line"), "999 lines");
});

test("every machine reason and worker problem has its own plain words", () => {
  const seen = new Set();
  for (const code of [...MACHINE_REASONS, ...WORKER_PROBLEMS]) {
    const words = describeReason(code);
    assert.ok(words.length > 0, code);
    assert.notEqual(words, "something went wrong", `${code} has no words of its own`);
    seen.add(words);
  }
  assert.equal(seen.size, MACHINE_REASONS.length + WORKER_PROBLEMS.length, "no two codes share one sentence");
});

test("known codes read as the plain words they should", () => {
  assert.match(describeReason("auth"), /ssh login was refused/);
  assert.match(describeReason("not_a_worker"), /cody-worker\.json/);
  assert.match(describeReason("no_work_root"), /\/srv\/cody-work/);
});

test("an unknown code falls back to a generic sentence", () => {
  assert.equal(describeReason("brand_new_code"), "something went wrong");
});

test("the detail line is appended in parentheses, trimmed, and a blank detail is ignored", () => {
  assert.equal(describeReason("refused", "  Connection refused  "), `${describeReason("refused")} (Connection refused)`);
  assert.equal(describeReason("refused", ""), describeReason("refused"));
  assert.equal(describeReason("refused", "   \n\t "), describeReason("refused"));
  assert.equal(describeReason("nonsense", "x"), "something went wrong (x)");
});

test("lastLines keeps everything when it all fits", () => {
  assert.deepEqual(lastLines(["a", "b", "c"], 1000), { text: "a\nb\nc", shown: 3 });
});

test("lastLines of nothing is empty text and zero shown", () => {
  assert.deepEqual(lastLines([], 100), { text: "", shown: 0 });
});

test("lastLines keeps the newest lines and drops the oldest when over budget", () => {
  // each line costs its bytes plus one for the newline
  const result = lastLines(["one", "two", "three", "four"], 11);
  assert.deepEqual(result, { text: "three\nfour", shown: 2 });
});

test("lastLines counts an exact fit as fitting, and one byte less as not", () => {
  // "ab" (3) + "cd" (3) = 6 bytes with newlines
  assert.deepEqual(lastLines(["ab", "cd"], 6), { text: "ab\ncd", shown: 2 });
  assert.deepEqual(lastLines(["ab", "cd"], 5), { text: "cd", shown: 1 });
});

test("lastLines stops at the first line that does not fit instead of skipping it", () => {
  const result = lastLines(["tiny", "a-very-long-line-that-does-not-fit", "x"], 12);
  assert.deepEqual(result, { text: "x", shown: 1 });
});

test("lastLines always keeps the newest line, cut from the front, when it alone is too big", () => {
  const result = lastLines(["old", "0123456789abcdef"], 6);
  assert.deepEqual(result, { text: "abcdef", shown: 1 });
});

test("lastLines counts bytes, not characters, for multibyte text", () => {
  // "é" is 2 bytes: "éé" = 4 bytes + newline = 5 per line
  assert.deepEqual(lastLines(["éé", "éé"], 10), { text: "éé\néé", shown: 2 });
  assert.deepEqual(lastLines(["éé", "éé"], 9), { text: "éé", shown: 1 });
});

test("lastLines never cuts a multibyte character in half when it shortens the newest line", () => {
  const result = lastLines(["日本語のテキスト"], 5);
  assert.equal(result.shown, 1);
  assert.ok(!result.text.includes("\uFFFD"), "no replacement character");
  assert.ok(!/[\uD800-\uDFFF]/.test(result.text), "no lone surrogate");
  assert.ok("日本語のテキスト".endsWith(result.text), "what is left is the end of the line");
  assert.ok(result.text.length > 0);
});
