import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LIVE_SUBAGENT_FRAME_BYTES, LIVE_SUBAGENT_TOTAL_BYTES, LiveSubagentFrames } = await jiti.import("./subagent-live-frames.ts");

const lifecycle = (id, status, extra = {}) => ({ type: "subagent_lifecycle", payload: { id, status, agent: "task", ...extra } });
const progress = (id, step) => ({ type: "subagent_progress", payload: { index: 0, progress: { id, step } } });

test("a page attaching mid-run gets every running helper, lifecycle first, then its latest progress", () => {
  const frames = new LiveSubagentFrames();
  frames.note(lifecycle("Alpha", "started"));
  frames.note(progress("Alpha", 1));
  frames.note(lifecycle("Beta", "started"));
  frames.note(progress("Alpha", 2));
  frames.note({ type: "message_update", payload: { id: "Alpha" } });
  assert.deepEqual(frames.snapshot(), [
    lifecycle("Alpha", "started"),
    lifecycle("Beta", "started"),
    progress("Alpha", 2),
  ]);
});

test("a terminal lifecycle frame drops the helper and its progress", () => {
  for (const status of ["completed", "failed", "aborted"]) {
    const frames = new LiveSubagentFrames();
    frames.note(lifecycle("Alpha", "started"));
    frames.note(progress("Alpha", 1));
    frames.note(lifecycle("Alpha", status));
    // A late progress frame cannot resurrect a finished helper.
    frames.note(progress("Alpha", 2));
    assert.deepEqual(frames.snapshot(), [], status);
  }
});

test("progress for a helper never seen starting is left to get_subagents", () => {
  const frames = new LiveSubagentFrames();
  frames.note(progress("Ghost", 1));
  frames.note({ type: "subagent_progress", payload: {} });
  frames.note({ type: "subagent_lifecycle", payload: { status: "started" } });
  assert.deepEqual(frames.snapshot(), []);
});

test("clear() forgets everything and the roster stays bounded", () => {
  const frames = new LiveSubagentFrames();
  for (let i = 0; i < 70; i += 1) frames.note(lifecycle(`Helper${i}`, "started"));
  const ids = frames.snapshot().map((frame) => frame.payload.id);
  assert.equal(ids.length, 64);
  assert.equal(ids[0], "Helper6");
  assert.equal(ids.at(-1), "Helper69");
  frames.clear();
  assert.deepEqual(frames.snapshot(), []);
});

test("a frame over the per-frame budget is left to get_subagents, and takes the stale one with it", () => {
  const frames = new LiveSubagentFrames();
  frames.note(lifecycle("Alpha", "started"));
  frames.note(progress("Alpha", 1));
  frames.note({ type: "subagent_progress", payload: { index: 0, progress: { id: "Alpha", step: 2, output: "x".repeat(LIVE_SUBAGENT_FRAME_BYTES) } } });
  assert.deepEqual(frames.snapshot(), [lifecycle("Alpha", "started")]);
  frames.note(lifecycle("Alpha", "running", { note: "y".repeat(LIVE_SUBAGENT_FRAME_BYTES) }));
  assert.deepEqual(frames.snapshot(), []);
});

test("the roster stays under its byte budget, dropping the longest-running helper first", () => {
  const frames = new LiveSubagentFrames();
  const chunk = "x".repeat(LIVE_SUBAGENT_FRAME_BYTES / 2);
  for (let i = 0; i < 60; i += 1) frames.note(lifecycle(`H${i}`, "started", { note: chunk }));
  const ids = frames.snapshot().map((frame) => frame.payload.id);
  assert.ok(ids.length < 60, "the byte budget bit before the count cap");
  assert.ok(ids.length * (LIVE_SUBAGENT_FRAME_BYTES / 2) <= LIVE_SUBAGENT_TOTAL_BYTES + ids.length * 200);
  assert.equal(ids.at(-1), "H59");
  assert.ok(!ids.includes("H0"));
  frames.clear();
  assert.deepEqual(frames.snapshot(), []);
});
