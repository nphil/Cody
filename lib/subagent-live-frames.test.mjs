import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSubagentFrames } from "./subagent-live-frames.ts";

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
