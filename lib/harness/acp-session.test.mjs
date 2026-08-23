import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { translateSessionUpdate } = await jiti.import("./acp-session.ts");

/** Fresh streaming state, as one session holds across a turn. */
const fresh = () => ({ open: false, text: "" });

test("a run of message chunks opens once and accumulates", () => {
  const state = fresh();
  // ACP sends assistant text as chunks with no explicit start or end, so the
  // FIRST chunk has to synthesize message_start.
  const first = translateSessionUpdate(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    state,
  );
  assert.deepEqual(first.map((e) => e.type), ["message_start", "message_update"]);
  assert.equal(first[1].delta, "Hel");
  assert.deepEqual(first[1].content, [{ type: "text", text: "Hel" }]);

  const second = translateSessionUpdate(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
    state,
  );
  assert.deepEqual(second.map((e) => e.type), ["message_update"], "no second message_start");
  assert.equal(second[0].delta, "lo");
  assert.deepEqual(second[0].content, [{ type: "text", text: "Hello" }], "content is cumulative");
  assert.deepEqual(state, { open: true, text: "Hello" });
});

test("thinking chunks are distinct from message chunks", () => {
  const state = fresh();
  const events = translateSessionUpdate(
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    state,
  );
  assert.deepEqual(events, [{ type: "thinking", delta: "hmm" }]);
  // Reasoning must not open an assistant message, or the transcript would
  // show the model's private thinking as its answer.
  assert.deepEqual(state, { open: false, text: "" });
});

test("tool calls map to start and only terminal updates end them", () => {
  const state = fresh();
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file" }, state),
    [{ type: "tool_execution_start", toolCallId: "t1", toolName: "Read file" }],
  );
  // No title: fall back to the kind rather than rendering "undefined".
  assert.equal(
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", kind: "edit" }, state)[0].toolName,
    "edit",
  );
  // In-progress updates are not endings.
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }, state),
    [],
  );
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }, state),
    [{ type: "tool_execution_end", toolCallId: "t1", isError: false }],
  );
  assert.deepEqual(
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" }, state),
    [{ type: "tool_execution_end", toolCallId: "t2", isError: true }],
  );
});

test("unknown and malformed updates are ignored, never thrown on", () => {
  const state = fresh();
  // ACP keeps gaining sessionUpdate variants; meeting a new one must not break
  // a live chat, and must not disturb an open message.
  state.open = true;
  state.text = "partial";
  for (const input of [
    { sessionUpdate: "plan", entries: [] },
    { sessionUpdate: "some_future_variant", whatever: true },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "..." } },
    { sessionUpdate: "agent_message_chunk" },
    {},
    null,
    undefined,
    "not an object",
    42,
  ]) {
    assert.deepEqual(translateSessionUpdate(input, state), [], `ignored: ${JSON.stringify(input)}`);
  }
  assert.deepEqual(state, { open: true, text: "partial" }, "open message left intact");
});
