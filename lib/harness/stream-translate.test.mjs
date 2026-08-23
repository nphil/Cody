import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const claude = await jiti.import("./claude-stream.ts");

/** Timestamps are wall-clock; the sequence and payload shapes are what matter. */
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "timestamp") continue;
      out[key] = strip(entry);
    }
    return out;
  }
  return value;
}

function replay(translate, state, lines) {
  const events = [];
  for (const line of lines) events.push(...translate(line, state));
  return strip(events);
}

const CLAUDE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

// A complete `claude -p --output-format stream-json --include-partial-messages`
// turn: init, partial text deltas, the authoritative assistant message with a
// tool_use block, the tool_result echo, and the terminal result frame.
const CLAUDE_TURN = [
  {
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: CLAUDE_SESSION_ID,
    model: "claude-sonnet-4-5-20250929",
    tools: ["Bash", "Read"],
    permissionMode: "acceptEdits",
  },
  { type: "stream_event", event: { type: "message_start", message: { id: "msg_1", role: "assistant" } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Listing " } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "files." } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  {
    type: "assistant",
    session_id: CLAUDE_SESSION_ID,
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [
        { type: "text", text: "Listing files." },
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 34 },
    },
  },
  {
    type: "user",
    session_id: CLAUDE_SESSION_ID,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "README.md" }], is_error: false }],
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 900,
    num_turns: 2,
    result: "Listing files.",
    session_id: CLAUDE_SESSION_ID,
    total_cost_usd: 0.012,
    usage: { input_tokens: 12, output_tokens: 34 },
  },
];

test("claude: a full turn translates to the pi event sequence", () => {
  const state = claude.createClaudeTurnState();
  const events = replay(claude.translateClaudeLine, state, CLAUDE_TURN);

  const assistant = { model: "claude-sonnet-4-5-20250929", provider: "anthropic", role: "assistant" };
  const toolResultContent = [{ type: "text", text: "README.md" }];

  assert.deepEqual(events, [
    { type: "message_start", message: { ...assistant, content: [{ type: "text", text: "Listing " }] } },
    { type: "message_update", message: { ...assistant, content: [{ type: "text", text: "Listing files." }] } },
    {
      type: "message_end",
      message: {
        ...assistant,
        content: [
          { type: "text", text: "Listing files." },
          { type: "toolCall", id: "toolu_01", name: "Bash", arguments: { command: "ls" } },
        ],
      },
    },
    { type: "usage_event", usage: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0 } },
    { type: "tool_execution_start", toolCallId: "toolu_01", toolName: "Bash", args: { command: "ls" } },
    {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "toolu_01", toolName: "Bash", content: toolResultContent, isError: false },
    },
    {
      type: "tool_execution_end",
      toolCallId: "toolu_01",
      toolName: "Bash",
      result: { content: toolResultContent, isError: false },
    },
    // The result frame restates the same 12/34 tokens the assistant frame
    // already reported, so only its first-party cost is forwarded. Adding the
    // restatement would report 24 input tokens for 12 spent.
    { type: "usage_event", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.012 } },
  ]);

  // Identity and model reach the session through the state, not the events.
  assert.equal(state.engineSessionId, CLAUDE_SESSION_ID);
  assert.equal(state.model, "claude-sonnet-4-5-20250929");
  assert.equal(state.errorMessage, null);
  assert.deepEqual(state.usage, { input: 12, output: 34, cacheRead: 0, cacheWrite: 0 });
  assert.equal(state.streaming, false);
});

test("claude: usage frames sum the turn exactly once across several API calls", () => {
  const state = claude.createClaudeTurnState();
  const events = replay(claude.translateClaudeLine, state, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "one" }],
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "two" }],
        usage: { input_tokens: 5, output_tokens: 6 },
      },
    },
    // Anthropic's terminal frame restates the whole turn: 15 input, 10 output.
    { type: "result", subtype: "success", usage: { input_tokens: 15, output_tokens: 10 }, total_cost_usd: 0.5 },
  ]);

  const usage = events.filter((event) => event.type === "usage_event").map((event) => event.usage);
  assert.deepEqual(usage, [
    { input: 10, output: 4, cacheRead: 100, cacheWrite: 7 },
    { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
  ]);
  // Additive frames: the turn's tokens land once, and the cost lands once.
  const summed = usage.reduce(
    (total, part) => ({
      input: total.input + part.input,
      output: total.output + part.output,
      cacheRead: total.cacheRead + part.cacheRead,
      cacheWrite: total.cacheWrite + part.cacheWrite,
      cost: total.cost + (part.cost ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
  assert.deepEqual(summed, { input: 15, output: 10, cacheRead: 100, cacheWrite: 7, cost: 0.5 });
});

test("claude: a turn that only reports usage on the result frame still counts it", () => {
  const state = claude.createClaudeTurnState();
  const events = replay(claude.translateClaudeLine, state, [
    // No per-message usage anywhere — the older CLI shape.
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", usage: { input_tokens: 9, output_tokens: 3 }, total_cost_usd: 0.25 },
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "usage_event"),
    [{ type: "usage_event", usage: { input: 9, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }],
  );
});

test("claude: thinking deltas stream as a thinking block, failures set errorMessage", () => {
  const state = claude.createClaudeTurnState();
  const events = replay(claude.translateClaudeLine, state, [
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } },
    { type: "result", subtype: "error_max_turns", is_error: true },
  ]);
  assert.deepEqual(events, [
    {
      type: "message_start",
      message: { role: "assistant", provider: "anthropic", model: "claude-code", content: [{ type: "thinking", thinking: "hmm" }] },
    },
  ]);
  assert.equal(state.errorMessage, "error_max_turns");
});

test("claude: string tool_result content and unknown tool ids stay renderable", () => {
  const state = claude.createClaudeTurnState();
  const events = replay(claude.translateClaudeLine, state, [
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "raw text", is_error: true }] } },
  ]);
  assert.deepEqual(events, [
    {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "toolu_x", toolName: "tool", content: [{ type: "text", text: "raw text" }], isError: true },
    },
    {
      type: "tool_execution_end",
      toolCallId: "toolu_x",
      toolName: "tool",
      result: { content: [{ type: "text", text: "raw text" }], isError: true },
    },
  ]);
});

test("claude: malformed and unknown lines never throw", () => {
  const state = claude.createClaudeTurnState();
  const junk = [
    null,
    undefined,
    42,
    "a string",
    [],
    {},
    { type: "system" },
    { type: "system", subtype: "compact_boundary" },
    { type: "stream_event" },
    { type: "stream_event", event: null },
    { type: "stream_event", event: { type: "content_block_delta" } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } },
    { type: "assistant" },
    { type: "assistant", message: { content: "not an array" } },
    { type: "user", message: { content: [{ type: "text", text: "plain" }] } },
    { type: "who_knows", payload: { nested: true } },
  ];
  for (const line of junk) {
    assert.deepEqual(claude.translateClaudeLine(line, state), [], `line: ${JSON.stringify(line)}`);
  }
});

test("claude: argv pre-assigns the id on turn one and resumes after", () => {
  const fresh = claude.buildClaudeTurnArgv({
    prompt: "hello",
    cwd: "/workspace",
    sessionId: CLAUDE_SESSION_ID,
    engineSessionId: CLAUDE_SESSION_ID,
    resume: false,
  });
  assert.deepEqual(fresh, [
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
    "--session-id",
    CLAUDE_SESSION_ID,
  ]);

  const resumed = claude.buildClaudeTurnArgv({
    prompt: "again",
    cwd: "/workspace",
    sessionId: CLAUDE_SESSION_ID,
    engineSessionId: CLAUDE_SESSION_ID,
    resume: true,
  });
  assert.deepEqual(resumed.slice(-2), ["--resume", CLAUDE_SESSION_ID]);
  assert.equal(resumed.includes("--session-id"), false);
});
