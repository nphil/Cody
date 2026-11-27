import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  LIVE_FRAME_SLOTS,
  LIVE_GLOBAL_RAW_BYTES,
  LIVE_RUN_RAW_BYTES,
  RecentMessageFrames,
  __liveRawBytesForTests,
  estimateFrameBytes,
} = await jiti.import("./live-message-frames.ts");

const keyOf = (ref) => `${ref.role}:${ref.timestamp}:${ref.toolCallId ?? ""}`;
const frame = (timestamp, chars, role = "toolResult") => ({
  type: "message_end",
  message: { role, timestamp, ...(role === "toolResult" ? { toolCallId: `c${timestamp}` } : {}), content: [{ type: "text", text: "x".repeat(chars) }] },
});

/** A session file stand-in: `written` is what the file holds; reads are counted. */
function fakeFile() {
  const written = new Map();
  const file = {
    written,
    reads: 0,
    has: (ref) => written.has(keyOf(ref)),
    read: (ref) => {
      file.reads += 1;
      return written.get(keyOf(ref)) ?? null;
    },
    write: (f) => written.set(keyOf({ role: f.message.role, timestamp: f.message.timestamp, toolCallId: f.message.toolCallId }), structuredClone(f.message)),
  };
  return file;
}

test("small frames are held whole and replayed in order", () => {
  const file = fakeFile();
  const frames = new RecentMessageFrames(file);
  const sent = [frame(1, 10), frame(2, 10), frame(3, 10)];
  for (const f of sent) frames.push(f);
  assert.deepEqual(frames.snapshot(), sent);
  assert.equal(file.reads, 0, "nothing is read back while the frames fit");
  frames.clear();
});

test("only the newest slots are kept, and their bytes leave the account", () => {
  const frames = new RecentMessageFrames(fakeFile());
  const before = __liveRawBytesForTests();
  for (let i = 0; i < LIVE_FRAME_SLOTS + 4; i += 1) frames.push(frame(i, 100));
  const kept = frames.snapshot();
  assert.equal(kept.length, LIVE_FRAME_SLOTS);
  assert.equal(kept[0].message.timestamp, 4);
  assert.equal(__liveRawBytesForTests() - before, frames.rawBytes);
  frames.clear();
  assert.equal(__liveRawBytesForTests(), before);
});

test("a large frame the file holds is reduced, and replayed from the file", () => {
  const file = fakeFile();
  const frames = new RecentMessageFrames(file);
  const small = frame(1, 100);
  const large = frame(2, LIVE_RUN_RAW_BYTES * 4);
  file.write(small);
  file.write(large);
  frames.push(small);
  frames.push(large);
  assert.ok(frames.rawBytes < LIVE_RUN_RAW_BYTES, `kept ${frames.rawBytes}`);
  const replay = frames.snapshot();
  assert.equal(replay.length, 2);
  assert.deepEqual(replay[0], small, "the small one never left memory");
  assert.equal(replay[1].type, "message_end");
  assert.equal(replay[1].message.content[0].text.length, LIVE_RUN_RAW_BYTES * 4);
  assert.equal(file.reads, 1);
  frames.clear();
});

test("a large frame the file does not hold yet is never dropped, and is reduced once it lands", async () => {
  const file = fakeFile();
  const frames = new RecentMessageFrames(file);
  const large = frame(7, LIVE_RUN_RAW_BYTES * 2);
  frames.push(large);
  assert.deepEqual(frames.snapshot(), [large], "the only copy stays whole");
  assert.ok(frames.rawBytes > LIVE_RUN_RAW_BYTES);
  file.write(large);
  // A later frame re-checks the older one.
  frames.push(frame(8, 10));
  assert.ok(frames.rawBytes < LIVE_RUN_RAW_BYTES);
  assert.equal(frames.snapshot()[0].message.content[0].text.length, LIVE_RUN_RAW_BYTES * 2);
  frames.clear();
});

test("a quiet run reduces its large frame on its own once the file has it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const file = fakeFile();
  const frames = new RecentMessageFrames(file);
  const large = frame(9, LIVE_RUN_RAW_BYTES * 2);
  frames.push(large);
  file.write(large);
  t.mock.timers.tick(600);
  assert.ok(frames.rawBytes < LIVE_RUN_RAW_BYTES);
  assert.equal(frames.snapshot().length, 1);
  frames.clear();
});

test("a message the file no longer holds is skipped rather than invented", () => {
  const file = fakeFile();
  const frames = new RecentMessageFrames(file);
  const large = frame(5, LIVE_RUN_RAW_BYTES * 2);
  file.write(large);
  frames.push(large);
  file.written.clear();
  assert.deepEqual(frames.snapshot(), []);
  frames.clear();
});

test("a failing file check keeps the frame whole", () => {
  const frames = new RecentMessageFrames({ has: () => { throw new Error("EIO"); }, read: () => null });
  const large = frame(5, LIVE_RUN_RAW_BYTES * 2);
  frames.push(large);
  assert.deepEqual(frames.snapshot(), [large]);
  frames.clear();
});

test("a frame that cannot be matched in the file stays whole", () => {
  const file = fakeFile();
  const frames = new RecentMessageFrames(file);
  const odd = { type: "message_end", message: { role: "assistant", content: "x".repeat(LIVE_RUN_RAW_BYTES * 2) } };
  frames.push(odd);
  assert.deepEqual(frames.snapshot(), [odd]);
  frames.clear();
});

test("many running chats together stay under the global budget", () => {
  const files = [];
  const runs = [];
  // 40 chats each holding frames that fit their own budget, 8 x 32 KiB.
  for (let chat = 0; chat < 40; chat += 1) {
    const file = fakeFile();
    const frames = new RecentMessageFrames(file);
    for (let i = 0; i < LIVE_FRAME_SLOTS; i += 1) {
      const f = frame(i, 32 * 1024);
      file.write(f);
      frames.push(f);
    }
    files.push(file);
    runs.push(frames);
    assert.ok(__liveRawBytesForTests() <= LIVE_GLOBAL_RAW_BYTES, `after chat ${chat}: ${__liveRawBytesForTests()}`);
  }
  // Every chat still replays all of its messages.
  for (const frames of runs) assert.equal(frames.snapshot().length, LIVE_FRAME_SLOTS);
  for (const frames of runs) frames.clear();
  assert.equal(__liveRawBytesForTests(), 0);
});

test("estimateFrameBytes counts strings and keys, and nests", () => {
  assert.ok(estimateFrameBytes({ a: "x".repeat(1000) }) >= 1000);
  assert.ok(estimateFrameBytes({ a: [{ b: "y".repeat(500) }, { b: "z".repeat(500) }] }) >= 1000);
  assert.ok(estimateFrameBytes({ a: "x".repeat(1000) }) < 1100);
});
