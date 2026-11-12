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

test("treats a trailing narration thinking block as final answer text", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "thinking", thinking: "Here is what I found.", narration: true },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["thinking"]);
  assert.equal(result.answerBlocks[0].narration, true);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
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

test("narration blocks are answer prose, so they do not open a thinking group", async () => {
  const { groupHasThinking } = await loadSubject();
  const messages = [
    { role: "user", content: "go" },
    assistant([{ type: "thinking", thinking: "Checking the logs now.", narration: true }, { type: "toolCall", toolCallId: "c1", toolName: "read", input: {} }]),
  ];

  assert.equal(groupHasThinking(messages, [1], []), false);
});

test("background classification uses exact metadata without changing content", async () => {
  const { backgroundActivityKind, isVisibleTranscriptMessage, isInternalBackgroundMessage } = await loadSubject();
  for (const customType of ["async-result", "async_result"]) {
    const message = { role: "custom", customType, display: false, content: "literal async-result: failed?", details: { jobs: [{ schema: { status: "valid" } }] } };
    const before = structuredClone(message);
    assert.equal(backgroundActivityKind(message), "completion");
    assert.deepEqual(message, before);
    const user = { ...message, attribution: "user" };
    assert.equal(backgroundActivityKind(user), null);
    assert.equal(isVisibleTranscriptMessage(user, "hidden"), true);
    assert.equal(isInternalBackgroundMessage(user), true);
  }
  for (const customType of ["irc:incoming", "irc:autoreply", "irc:relay", "irc:workpool"]) {
    for (const attribution of [undefined, "agent"]) {
      assert.equal(backgroundActivityKind({ role: "custom", customType, attribution, content: "Can you check?", display: true }), "coordination");
    }
    const user = { role: "custom", customType, attribution: "user", content: "Question?", display: true };
    assert.equal(backgroundActivityKind(user), null);
    assert.equal(isVisibleTranscriptMessage(user, "hidden"), true);
  }
  for (const message of [
    { role: "user", attribution: "agent", content: "async-result" },
    { role: "custom", customType: "ordinary", attribution: "agent", content: "async-result", display: false },
    assistant([{ type: "text", text: "async-result" }]),
    assistant([{ type: "toolCall", toolCallId: "1", toolName: "approval", input: {} }]),
  ]) assert.equal(backgroundActivityKind(message), null);
});

test("explicit failure and action metadata remains visible in hidden mode", async () => {
  const { backgroundActivityKind, isVisibleTranscriptMessage, isActionableCustomDetails, isInternalBackgroundMessage } = await loadSubject();
  const cases = [
    { notifyType: "error" }, { notifyType: "warning" }, { isError: true }, { requiresAction: true },
    ...["failed", "error", "cancelled"].map(status => ({ status })),
    ...["invalid", "unavailable", "error"].map(status => ({ jobs: [{ schema: { status } }] })),
    { jobs: [{ status: "failed", schema: { status: "valid" } }] },
    ...[{ isError: true }, { requiresAction: true }, { notifyType: "warning" }, { notifyType: "error" }].map(job => ({ jobs: [job] })),
  ];
  for (const details of cases) {
    const message = { role: "custom", customType: "async-result", content: "notice", display: false, details };
    assert.equal(backgroundActivityKind(message), null);
    assert.equal(isActionableCustomDetails(details), true);
    assert.equal(isInternalBackgroundMessage(message), true);
    assert.equal(isVisibleTranscriptMessage(message, "hidden"), true);
  }
});

test("IRC incoming duplicates replace the latest matching ID in either arrival order", async () => {
  const { appendBackgroundMessage } = await loadSubject();
  const first = { role: "custom", customType: "irc:incoming", details: { id: "42" }, content: "first", display: true };
  const second = { ...first, content: "second" };
  const unrelated = { ...first, details: { id: "other" } };
  for (const [old, incoming] of [[first, second], [second, first]]) {
    const source = [old, unrelated, old];
    const result = appendBackgroundMessage(source, incoming);
    assert.deepEqual(result, [old, unrelated, incoming]);
    assert.deepEqual(source, [old, unrelated, old]);
    assert.notEqual(result, source);
  }
  const noId = { ...first, details: {} };
  assert.deepEqual(appendBackgroundMessage([noId], noId), [noId, noId]);
  const relay = { ...first, customType: "irc:relay" };
  assert.deepEqual(appendBackgroundMessage([relay], first), [relay, first]);
  assert.deepEqual(appendBackgroundMessage([first], relay), [first, relay]);
});

test("unknown async outcomes require review but completed status is authoritative", async () => {
  const { backgroundActivityNeedsReview } = await loadSubject();
  const message = { role: "custom", customType: "async-result", display: true, content: "result" };
  assert.equal(backgroundActivityNeedsReview(message), true);
  assert.equal(backgroundActivityNeedsReview({ ...message, details: { jobs: [] } }), true);
  assert.equal(backgroundActivityNeedsReview({ ...message, details: { jobs: [{ schema: { status: "valid" } }] } }), true);
  assert.equal(backgroundActivityNeedsReview({ ...message, details: { jobs: [{ status: "completed" }, {}] } }), true);
  assert.equal(backgroundActivityNeedsReview({ ...message, details: { jobs: [{ status: "completed" }] } }), false);
  assert.equal(backgroundActivityNeedsReview({ ...message, attribution: "user" }), false);
  assert.equal(backgroundActivityNeedsReview({ ...message, customType: "irc:incoming" }), false);
});

test("async identity matches live and history without conflating reused job IDs", async () => {
  const { appendBackgroundMessage, backgroundMessageIdentity } = await loadSubject();
  const live = { role: "custom", customType: "async-result", content: "unchanged", timestamp: 1793480414394, details: { jobs: [{ jobId: "bg_8" }] }, display: true };
  const history = { ...live, timestamp: Date.parse("2026-10-31T21:00:14.394Z") };
  const later = { ...live, timestamp: live.timestamp + 1 };
  assert.equal(backgroundMessageIdentity(live), backgroundMessageIdentity(history));
  for (const [first, second] of [[live, history], [history, live]]) {
    const original = [first];
    assert.deepEqual(appendBackgroundMessage(original, second), [second]);
    assert.deepEqual(original, [first]);
  }
  assert.notEqual(backgroundMessageIdentity(live), backgroundMessageIdentity(later));
  assert.deepEqual(appendBackgroundMessage([live], later), [live, later]);
  assert.equal(backgroundMessageIdentity({ ...live, timestamp: undefined }), null);
  assert.equal(backgroundMessageIdentity({ ...live, details: { jobs: [{}] } }), null);
});
