import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("a process group of nothing but tool calls holds no thinking", async () => {
  const { groupHasThinking } = await loadSubject();
  const messages = [
    { role: "user", content: "go" },
    assistant([{ type: "toolCall", toolCallId: "c1", toolName: "read", input: {} }]),
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
  ];

  assert.equal(groupHasThinking(messages, [1, 2], []), false);
});

test("deferred thinking in a group still counts as thinking", async () => {
  const { groupHasThinking } = await loadSubject();
  const messages = [
    { role: "user", content: "go" },
    assistant([{ type: "thinking", thinking: "", deferred: true }]),
  ];

  // A history load empties the text; the group must still open for it, or the
  // preference would work only on freshly streamed turns.
  assert.equal(groupHasThinking(messages, [1], []), true);
});

test("thinking peeled onto the final assistant message counts as thinking", async () => {
  const { groupHasThinking } = await loadSubject();
  const messages = [
    { role: "user", content: "go" },
    assistant([{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }]),
  ];
  const { processBlocks } = (await loadSubject()).splitFinalAssistantBlocks(messages[1]);

  assert.equal(groupHasThinking(messages, [], processBlocks), true);
});

test("an empty completed thinking block does not open a group", async () => {
  const { groupHasThinking } = await loadSubject();
  const messages = [
    { role: "user", content: "go" },
    assistant([{ type: "thinking", thinking: "   " }, { type: "toolCall", toolCallId: "c1", toolName: "read", input: {} }]),
  ];

  assert.equal(groupHasThinking(messages, [1], []), false);
});
