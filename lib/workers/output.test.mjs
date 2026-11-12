// OutputSink keeps what a job printed readable: colour and cursor codes gone,
// a progress bar that rewrites its line shown as its last state, the last
// lines in memory and the whole output (bounded) in a private file. What
// matters here: escapes split across writes, `\r` handling, memory staying
// bounded for a line that never ends, the file contents and mode, and the
// file cap. Nothing touches the network; files live in a self-cleaning dir.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { OutputSink, TAIL_LINES, LOG_CAP_BYTES } = await jiti.import("./output.ts");

const root = mkdtempSync(join(tmpdir(), "cody-workers-output-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const logIn = () => join(root, `log-${counter++}`, "out.log");

test("plain lines come back in order and tail(n) keeps the last n", () => {
  const sink = new OutputSink();
  sink.write("one\ntwo\nthree\n");
  assert.deepEqual(sink.tail(), ["one", "two", "three"]);
  assert.deepEqual(sink.tail(2), ["two", "three"]);
  assert.equal(sink.lineCount, 3);
});

test("empty lines are kept and an empty write changes nothing", () => {
  const sink = new OutputSink();
  sink.write("a\n\nb\n");
  sink.write("");
  assert.deepEqual(sink.tail(), ["a", "", "b"]);
});

test("a half-written line counts and shows as the last tail line", () => {
  const sink = new OutputSink();
  sink.write("done\nhalf");
  assert.equal(sink.lineCount, 2);
  assert.deepEqual(sink.tail(), ["done", "half"]);
  sink.write("way\n");
  assert.equal(sink.lineCount, 2);
  assert.deepEqual(sink.tail(), ["done", "halfway"]);
});

test("colour, cursor and title sequences are removed", () => {
  const sink = new OutputSink();
  sink.write("\u001b[1;31mred\u001b[0m \u001b[2K\u001b[1Aup \u001b]0;window title\u0007text\n");
  sink.write("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\\n");
  assert.deepEqual(sink.tail(), ["red up text", "link"]);
});

test("an escape sequence split across two writes is still removed", () => {
  const sink = new OutputSink();
  sink.write("a\u001b[3");
  sink.write("1mred\u001b[0");
  sink.write("m b\n");
  sink.write("x\u001b]0;ti");
  sink.write("tle\u0007y\n");
  sink.write("z\u001b");
  sink.write("[0Kw\n");
  assert.deepEqual(sink.tail(), ["ared b", "xy", "zw"]);
});

test("control characters are removed but tabs stay", () => {
  const sink = new OutputSink();
  sink.write("a\u0000b\u0007c\u0008d\te\u007ff\u001ag\n");
  assert.deepEqual(sink.tail(), ["abcd\tefg"]);
});

test("a progress bar that rewrites its line shows only its last state", () => {
  const sink = new OutputSink();
  sink.write("10%\r20%\r30%\n");
  assert.deepEqual(sink.tail(), ["30%"]);
  assert.equal(sink.lineCount, 1);
});

test("a rewrite is shown as it happens, also across chunks", () => {
  const sink = new OutputSink();
  sink.write("10%\r");
  sink.write("20%\r");
  assert.deepEqual(sink.tail(), ["20%"]);
  sink.write("30%\nnext\n");
  assert.deepEqual(sink.tail(), ["30%", "next"]);
});

test("a rewrite that is shorter than before drops the old text", () => {
  const sink = new OutputSink();
  sink.write("loading...\rok\n");
  assert.deepEqual(sink.tail(), ["ok"]);
});

test("Windows line endings stay clean", () => {
  const sink = new OutputSink();
  sink.write("a\r\nb\r\nc");
  sink.write("\r\n");
  assert.deepEqual(sink.tail(), ["a", "b", "c"]);
  assert.equal(sink.lineCount, 3);
});

test("a return at the end of one chunk and the newline at the start of the next is one line ending", () => {
  const sink = new OutputSink();
  sink.write("a\r");
  sink.write("\nb\r");
  sink.write("\n");
  assert.deepEqual(sink.tail(), ["a", "b"]);
});

test("a return at the end of one chunk followed by text rewrites the line", () => {
  const sink = new OutputSink();
  sink.write("old\r");
  sink.write("new\n");
  assert.deepEqual(sink.tail(), ["new"]);
});

test("a very long line is shortened in the tail but the file keeps all of it", () => {
  const logPath = logIn();
  const sink = new OutputSink({ logPath });
  const long = "x".repeat(10_000);
  sink.write(`${long}\nshort\n`);
  const [first, second] = sink.tail();
  assert.equal(first, `${"x".repeat(4000)} … [+6000 characters]`);
  assert.equal(second, "short");
  sink.end();
  assert.equal(readFileSync(logPath, "utf8"), `${long}\nshort\n`);
});

test("a half-written very long line is shortened in the tail too", () => {
  const sink = new OutputSink();
  sink.write("y".repeat(5000));
  assert.deepEqual(sink.tail(), [`${"y".repeat(4000)} …`]);
});

test("a line that never ends is spilled in pieces and memory stays bounded", () => {
  const logPath = logIn();
  const sink = new OutputSink({ logPath, tailLines: 5 });
  const piece = "a".repeat(100_000);
  for (let i = 0; i < 20; i += 1) sink.write(piece);
  // 2,000,000 characters with no newline: cut at 262,144 each time
  assert.equal(sink.lineCount, 8, "7 spilled pieces plus the remainder");
  const tail = sink.tail();
  assert.ok(tail.length <= 5);
  for (const line of tail) assert.ok(line.length <= 4100, "no stored line is longer than the tail limit");
  sink.end();
  assert.equal(sink.lineCount, 8);
  const file = readFileSync(logPath, "utf8");
  assert.equal(file.length, 2_000_000 + 8);
  assert.equal(file.replaceAll("\n", "").length, 2_000_000);
});

test("a single huge write without a newline is spilled the same way", () => {
  const sink = new OutputSink();
  sink.write("b".repeat(600_000));
  assert.equal(sink.lineCount, 3);
  assert.equal(sink.tail().length, 3);
});

test("tailLines drops the oldest lines", () => {
  const sink = new OutputSink({ tailLines: 3 });
  for (let i = 0; i < 10; i += 1) sink.write(`l${i}\n`);
  assert.deepEqual(sink.tail(), ["l7", "l8", "l9"]);
  assert.deepEqual(sink.tail(10), ["l7", "l8", "l9"]);
  assert.equal(sink.lineCount, 10);
});

test("by default the tail keeps TAIL_LINES lines", () => {
  const sink = new OutputSink();
  for (let i = 0; i < TAIL_LINES + 50; i += 1) sink.write(`n${i}\n`);
  const tail = sink.tail();
  assert.equal(tail.length, TAIL_LINES);
  assert.equal(tail[0], "n50");
  assert.equal(tail.at(-1), `n${TAIL_LINES + 49}`);
});

test("the log file receives every line, even those the tail dropped", () => {
  const logPath = logIn();
  const sink = new OutputSink({ logPath, tailLines: 2 });
  assert.equal(sink.hasLog, true);
  assert.equal(sink.logPath, logPath);
  sink.write("\u001b[31mone\u001b[0m\ntwo\nthree\n10%\r20%\nfour");
  sink.end();
  assert.equal(readFileSync(logPath, "utf8"), "one\ntwo\nthree\n20%\nfour\n");
  assert.deepEqual(sink.tail(), ["20%", "four"]);
});

test("the log file is private and its directory is created on demand", () => {
  const logPath = join(root, "made", "on", "demand", "out.log");
  assert.equal(existsSync(join(root, "made")), false);
  const sink = new OutputSink({ logPath });
  assert.equal(sink.hasLog, true);
  sink.write("hi\n");
  sink.end();
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(logPath, "utf8"), "hi\n");
});

test("without a log path there is no file", () => {
  const sink = new OutputSink();
  assert.equal(sink.hasLog, false);
  assert.equal(sink.logPath, null);
  sink.write("x\n");
  sink.end();
  assert.deepEqual(sink.tail(), ["x"]);
});

test("an unwritable log path means no file and everything else still works", () => {
  const blocker = join(root, "regular-file");
  writeFileSync(blocker, "not a directory");
  const sink = new OutputSink({ logPath: join(blocker, "sub", "out.log") });
  assert.equal(sink.hasLog, false);
  sink.write("a\nb\n");
  sink.end();
  assert.deepEqual(sink.tail(), ["a", "b"]);
  assert.equal(sink.lineCount, 2);
  assert.equal(readFileSync(blocker, "utf8"), "not a directory");
});

test("end() moves the last half line into the tail and the file", () => {
  const logPath = logIn();
  const sink = new OutputSink({ logPath });
  sink.write("first\nlast without newline");
  sink.end();
  assert.deepEqual(sink.tail(), ["first", "last without newline"]);
  assert.equal(sink.lineCount, 2);
  assert.equal(readFileSync(logPath, "utf8"), "first\nlast without newline\n");
});

test("an unfinished escape at the end is dropped by end()", () => {
  const sink = new OutputSink();
  sink.write("ok\n\u001b[3");
  sink.end();
  assert.deepEqual(sink.tail(), ["ok"]);
});

test("writing after end() does not throw and the file stays as it was", () => {
  const logPath = logIn();
  const sink = new OutputSink({ logPath });
  sink.write("before\n");
  sink.end();
  assert.doesNotThrow(() => sink.write("after\nmore\n"));
  assert.doesNotThrow(() => sink.end());
  assert.equal(readFileSync(logPath, "utf8"), "before\n");
});

test("the file stops at LOG_CAP_BYTES with a note, while the tail keeps following the output", () => {
  const logPath = logIn();
  const sink = new OutputSink({ logPath, tailLines: 3 });
  const line = `${"z".repeat(1023)}\n`;
  const chunk = line.repeat(1024); // 1 MiB
  const megabytes = LOG_CAP_BYTES / (1024 * 1024) + 1; // 33 MiB: past the cap
  for (let i = 0; i < megabytes; i += 1) {
    assert.equal(sink.logTruncated, false, "not cut off before the cap is reached");
    sink.write(chunk);
  }
  assert.equal(sink.logTruncated, true);
  sink.write("the very end\n");
  sink.end();
  assert.equal(sink.tail().at(-1), "the very end");
  assert.equal(sink.lineCount, megabytes * 1024 + 1);
  const size = statSync(logPath).size;
  assert.ok(size <= LOG_CAP_BYTES + 200, `file is ${size} bytes`);
  assert.ok(size > LOG_CAP_BYTES - 2048, "the file filled up to the cap");
  const file = readFileSync(logPath, "utf8");
  assert.match(file, /\n\[Output file cut off at 32 MB; the end of the output is in the tool result\]\n$/);
  assert.ok(!file.includes("the very end"));
});
