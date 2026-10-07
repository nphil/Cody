import assert from "node:assert/strict";
import test from "node:test";
import { createActiveGoal, parseActiveGoal } from "./web-mode-state.ts";

test("goal state trims its objective and keeps its start time", () => {
  assert.deepEqual(createActiveGoal("  Ship the sidebar  ", 123), {
    objective: "Ship the sidebar",
    startedAt: 123,
  });
});

test("goal state parser accepts only valid persisted goal records", () => {
  assert.deepEqual(parseActiveGoal('{"objective":"Ship it","startedAt":123}'), {
    objective: "Ship it",
    startedAt: 123,
  });
  assert.equal(parseActiveGoal('{"objective":"","startedAt":123}'), null);
  assert.equal(parseActiveGoal('{"objective":"Ship it","startedAt":"123"}'), null);
  assert.equal(parseActiveGoal("not JSON"), null);
});
