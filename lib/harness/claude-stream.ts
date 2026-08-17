import { asString, isRecord } from "../type-guards";
import type { TurnArgvInput, TurnStreamState } from "./turn-session";
import type { EngineEvent } from "./types";

/**
 * Claude Code stream-json → pi event vocabulary.
 *
 * `claude -p … --output-format stream-json --include-partial-messages` prints
 * one NDJSON frame per line and exits when the turn ends. The frames Cody
 * cares about:
 *
 *   {type:"system", subtype:"init", session_id, model, tools}
 *   {type:"stream_event", event:{type:"content_block_delta", delta:{…}}}
 *   {type:"assistant", message:{content:[text|thinking|tool_use …]}}
 *   {type:"user", message:{content:[{type:"tool_result", …}]}}
 *   {type:"result", subtype:"success"|…, usage, total_cost_usd}
 *
 * Partial frames drive the live bubble (message_start/message_update); the
 * `assistant` frame is authoritative and closes it with message_end. Tool calls
 * ride inside that message as on-disk-shaped {type:"toolCall", id, name,
 * arguments} blocks — lib/normalize.ts's normalizeToolCalls accepts exactly
 * that shape and rewrites it for the UI.
 *
 * Lifecycle events (agent_start / agent_end) are NOT emitted here: the session
 * owns them so that a stream which dies mid-turn still ends exactly once (see
 * lib/harness/turn-session.ts).
 *
 * Every function is pure apart from the `state` it is handed, so a recorded
 * NDJSON transcript replays deterministically in tests.
 */

export function createClaudeTurnState(
  seed: { engineSessionId: string | null; model: string | null } = { engineSessionId: null, model: null },
): TurnStreamState {
  return {
    engineSessionId: seed.engineSessionId,
    model: seed.model,
    provider: "anthropic",
    modelFallback: "claude-code",
    text: "",
    thinking: "",
    streaming: false,
    toolNames: new Map(),
    startedTools: new Set(),
    usage: null,
    errorMessage: null,
  };
}

/**
 * argv for one turn. The first turn of a session pre-assigns the id with
 * --session-id so Cody's session id and Claude's are the same value from the
 * start; later turns resume it. Edits are auto-accepted inside the workspace:
 * `-p` mode has no interactive permission channel, so the alternative is an
 * agent that silently stalls on its first write.
 */
export function buildClaudeTurnArgv(input: TurnArgvInput): string[] {
  const argv = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
  ];
  if (input.displayMcpConfig) argv.push("--mcp-config", input.displayMcpConfig);
  const id = input.engineSessionId;
  if (id) argv.push(...(input.resume ? ["--resume", id] : ["--session-id", id]));
  return argv;
}

function assistantMessage(state: TurnStreamState, content: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    model: state.model ?? state.modelFallback,
    provider: state.provider,
    timestamp: Date.now(),
  };
}

/** Content of the bubble currently streaming (reasoning first, like omp). */
function streamingContent(state: TurnStreamState): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (state.thinking) content.push({ type: "thinking", thinking: state.thinking });
  if (state.text) content.push({ type: "text", text: state.text });
  return content;
}

function streamEvent(state: TurnStreamState): EngineEvent[] {
  const content = streamingContent(state);
  if (content.length === 0) return [];
  const message = assistantMessage(state, content);
  if (state.streaming) return [{ type: "message_update", message }];
  state.streaming = true;
  return [{ type: "message_start", message }];
}

function resetStream(state: TurnStreamState): void {
  state.streaming = false;
  state.text = "";
  state.thinking = "";
}

/** tool_result content is a string, a block array, or something structured. */
function flattenResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        if (isRecord(block) && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function handleSystem(frame: Record<string, unknown>, state: TurnStreamState): EngineEvent[] {
  if (frame.subtype !== "init") return [];
  const sessionId = asString(frame.session_id);
  if (sessionId) state.engineSessionId = sessionId;
  const model = asString(frame.model);
  if (model) state.model = model;
  return [];
}

function handleStreamEvent(frame: Record<string, unknown>, state: TurnStreamState): EngineEvent[] {
  const event = isRecord(frame.event) ? frame.event : null;
  if (!event) return [];
  // A new API message starts a new bubble; anything buffered belonged to the
  // previous one (which its `assistant` frame already closed).
  if (event.type === "message_start") {
    resetStream(state);
    return [];
  }
  if (event.type !== "content_block_delta") return [];
  const delta = isRecord(event.delta) ? event.delta : null;
  if (!delta) return [];
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    state.text += delta.text;
    return streamEvent(state);
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    state.thinking += delta.thinking;
    return streamEvent(state);
  }
  // input_json_delta (streaming tool arguments) and signature deltas carry
  // nothing the transcript shows before the authoritative assistant frame.
  return [];
}

function handleAssistant(frame: Record<string, unknown>, state: TurnStreamState): EngineEvent[] {
  const message = isRecord(frame.message) ? frame.message : null;
  if (!message) return [];
  const model = asString(message.model);
  if (model) state.model = model;
  if (isRecord(message.usage)) state.usage = message.usage;

  const content: Array<Record<string, unknown>> = [];
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      content.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use") {
      const id = asString(block.id) ?? "";
      const name = asString(block.name) ?? "tool";
      const args = isRecord(block.input) ? block.input : {};
      content.push({ type: "toolCall", id, name, arguments: args });
      calls.push({ id, name, args });
      if (id) state.toolNames.set(id, name);
    }
  }

  // An assistant frame with nothing renderable still has to close whatever the
  // partial stream put on screen.
  const blocks = content.length > 0 ? content : streamingContent(state);
  if (blocks.length === 0) return [];

  const events: EngineEvent[] = [{ type: "message_end", message: assistantMessage(state, blocks) }];
  resetStream(state);
  for (const call of calls) {
    if (call.id && state.startedTools.has(call.id)) continue;
    if (call.id) state.startedTools.add(call.id);
    events.push({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
  }
  return events;
}

function handleUser(frame: Record<string, unknown>, state: TurnStreamState): EngineEvent[] {
  const message = isRecord(frame.message) ? frame.message : null;
  if (!message) return [];
  const events: EngineEvent[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const toolCallId = asString(block.tool_use_id) ?? "";
    const toolName = state.toolNames.get(toolCallId) ?? "tool";
    const text = flattenResultContent(block.content);
    const isError = block.is_error === true;
    const content = [{ type: "text", text }];
    events.push({
      type: "message_end",
      message: { role: "toolResult", toolCallId, toolName, content, isError, timestamp: Date.now() },
    });
    events.push({ type: "tool_execution_end", toolCallId, toolName, result: { content, isError } });
  }
  return events;
}

function handleResult(frame: Record<string, unknown>, state: TurnStreamState): EngineEvent[] {
  if (isRecord(frame.usage)) state.usage = frame.usage;
  const failed = frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== "success");
  if (failed) {
    state.errorMessage =
      asString(frame.error) ??
      (typeof frame.result === "string" && frame.result ? frame.result : undefined) ??
      asString(frame.subtype) ??
      "the turn ended with an error";
  }
  return [];
}

/**
 * Translate one parsed NDJSON frame. Unknown frame types, malformed payloads
 * and non-objects all return no events rather than throwing — an experimental
 * engine changing its output must never take a turn (or the server) down.
 */
export function translateClaudeLine(line: unknown, state: TurnStreamState): EngineEvent[] {
  if (!isRecord(line)) return [];
  switch (line.type) {
    case "system":
      return handleSystem(line, state);
    case "stream_event":
      return handleStreamEvent(line, state);
    case "assistant":
      return handleAssistant(line, state);
    case "user":
      return handleUser(line, state);
    case "result":
      return handleResult(line, state);
    default:
      return [];
  }
}
