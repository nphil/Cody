import { test } from "node:test";
import assert from "node:assert/strict";
import { holdsMessage, messageReplayKey, withDeliveredTail } from "./attach-replay.ts";

const reply = (timestamp, text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const result = (timestamp, toolCallId) => ({ role: "toolResult", toolCallId, toolName: "bash", content: [], timestamp });
const keys = (...messages) => new Set(messages.map(messageReplayKey));

test("a tool result is told apart from a sibling finished in the same millisecond", () => {
  assert.equal(messageReplayKey(reply(5, "a")), "5");
  assert.equal(messageReplayKey(result(5, "call_1")), "5:call_1");
  assert.equal(messageReplayKey({ role: "assistant", content: [] }), null);
  assert.equal(holdsMessage([result(5, "call_1")], result(5, "call_2")), false);
  assert.equal(holdsMessage([reply(4, "x"), result(5, "call_1")], result(5, "call_1")), true);
});

test("a replayed frame is held only when the list already shows it; untimed messages never match", () => {
  const list = [reply(1, "one"), result(2, "c1"), reply(3, "three")];
  assert.equal(holdsMessage(list, reply(3, "three")), true);
  assert.equal(holdsMessage(list, reply(6, "six")), false);
  assert.equal(holdsMessage([{ role: "assistant", content: [] }], { role: "assistant", content: [] }), false);
});

test("the transcript landing keeps what the stream delivered after its read, in order, and nothing it already holds", () => {
  const transcript = [reply(1, "one"), result(2, "c1"), reply(3, "three")];
  // Cached older paint, then the stream: 3 (already in the transcript), 4 and 5 (written after its read).
  const current = [reply(1, "one"), reply(3, "three"), result(4, "c3"), reply(5, "five")];
  const merged = withDeliveredTail(transcript, current, keys(reply(3, "three"), result(4, "c3"), reply(5, "five")));
  assert.deepEqual(merged.map(messageReplayKey), ["1", "2:c1", "3", "4:c3", "5"]);
});

test("without stream deliveries the transcript replaces the list exactly as before", () => {
  const transcript = [reply(1, "one")];
  assert.equal(withDeliveredTail(transcript, [reply(9, "stale paint")], new Set()), transcript);
  // A newer message the stream did NOT deliver (an optimistic or cached row) is not carried over.
  assert.equal(withDeliveredTail(transcript, [reply(9, "stale paint")], keys(reply(8, "x"))), transcript);
});
