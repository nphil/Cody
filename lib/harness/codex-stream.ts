import { asNumber, asString, isRecord } from "../type-guards";
import type { TurnArgvInput, TurnStreamState } from "./turn-session";
import type { EngineEvent } from "./types";

/**
 * Codex `exec --json` → pi event vocabulary.
 *
 * One turn per process, NDJSON on stdout:
 *
 *   {type:"thread.started", thread_id}          ← the resume handle
 *   {type:"turn.started"}
 *   {type:"item.started"|"item.updated"|"item.completed", item:{…}}
 *   {type:"turn.completed", usage}
 *   {type:"error", message} / {type:"turn.failed", error:{message}}
 *
 * Item kinds Cody renders: agent_message (assistant text), reasoning (thinking),
 * command_execution / file_change / mcp_tool_call / web_search (tool calls).
 * The item's kind field has been spelled both `item_type` and `type` across
 * codex releases, so both are read; anything unrecognized is skipped rather
 * than guessed at, because this stream is the least stable of the two engines.
 *
 * Tool calls are surfaced the same way the omp path does: an assistant message
 * carrying an on-disk-shaped {type:"toolCall", id, name, arguments} block (see
 * lib/normalize.ts) plus tool_execution_start, then a toolResult message plus
 * tool_execution_end when the item completes.
 *
 * agent_start / agent_end belong to the session (lib/harness/turn-session.ts),
 * not to this translator.
 */

export function createCodexTurnState(
  seed: { engineSessionId: string | null; model: string | null } = { engineSessionId: null, model: null },
): TurnStreamState {
  return {
    engineSessionId: seed.engineSessionId,
    model: seed.model,
    provider: "openai",
    modelFallback: "codex",
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
 * argv for one turn. A brand-new session is `exec <prompt>`; once the thread id
 * has been captured from thread.started, later turns are `exec resume <id>
 * <prompt>`. Sandbox is workspace-write (edits inside the session cwd are
 * auto-accepted — `exec` is non-interactive, so there is no approval channel),
 * and the git-repo check is skipped because Cody's workspaces are arbitrary
 * directories.
 */
export function buildCodexTurnArgv(input: TurnArgvInput): string[] {
  const prefix = input.displayMcpArgs ?? [];
  const tail = [
    "--json",
    "--color",
    "never",
    "-C",
    input.cwd,
    "-s",
    "workspace-write",
    "--skip-git-repo-check",
  ];
  if (input.resume && input.engineSessionId) {
    return [...prefix, "exec", "resume", input.engineSessionId, input.prompt, ...tail];
  }
  return [...prefix, "exec", input.prompt, ...tail];
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

/** message_start the first time a bubble streams, message_update after. */
function streamEvent(state: TurnStreamState, content: Array<Record<string, unknown>>): EngineEvent[] {
  if (content.length === 0) return [];
  const message = assistantMessage(state, content);
  if (state.streaming) return [{ type: "message_update", message }];
  state.streaming = true;
  return [{ type: "message_start", message }];
}

/** Close an open streaming bubble before something else takes the stage. */
function flushStream(state: TurnStreamState): EngineEvent[] {
  if (!state.streaming) return [];
  const content: Array<Record<string, unknown>> = [];
  if (state.thinking) content.push({ type: "thinking", thinking: state.thinking });
  if (state.text) content.push({ type: "text", text: state.text });
  state.streaming = false;
  state.text = "";
  state.thinking = "";
  if (content.length === 0) return [];
  return [{ type: "message_end", message: assistantMessage(state, content) }];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ToolShape {
  name: string;
  args: Record<string, unknown>;
  output: string;
  isError: boolean;
}

/** Map a codex tool item onto the toolCall/toolResult pair the UI renders.
 * Unknown item kinds return null and are dropped. */
function describeTool(itemType: string, item: Record<string, unknown>): ToolShape | null {
  const status = asString(item.status) ?? "";
  const failed = status === "failed" || status === "error";
  switch (itemType) {
    case "command_execution": {
      const command = asString(item.command) ?? "";
      const exitCode = asNumber(item.exit_code);
      return {
        name: "bash",
        args: { command },
        output: stringify(item.aggregated_output ?? item.output ?? ""),
        isError: failed || (exitCode !== undefined && exitCode !== 0),
      };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        name: "edit",
        args: { changes },
        output: stringify(item.aggregated_output ?? changes),
        isError: failed,
      };
    }
    case "mcp_tool_call": {
      const server = asString(item.server) ?? "";
      const tool = asString(item.tool) ?? asString(item.name) ?? "mcp";
      return {
        name: server ? `${server}.${tool}` : tool,
        args: isRecord(item.arguments) ? item.arguments : {},
        output: stringify(item.result ?? item.output ?? ""),
        isError: failed || item.error !== undefined,
      };
    }
    case "web_search": {
      const query = asString(item.query) ?? "";
      return {
        name: "web_search",
        args: { query },
        output: stringify(item.results ?? item.output ?? ""),
        isError: failed,
      };
    }
    default:
      return null;
  }
}

function toolStartEvents(
  state: TurnStreamState,
  id: string,
  tool: ToolShape,
): EngineEvent[] {
  if (state.startedTools.has(id)) return [];
  state.startedTools.add(id);
  state.toolNames.set(id, tool.name);
  const events = flushStream(state);
  events.push({
    type: "message_end",
    message: assistantMessage(state, [{ type: "toolCall", id, name: tool.name, arguments: tool.args }]),
  });
  events.push({ type: "tool_execution_start", toolCallId: id, toolName: tool.name, args: tool.args });
  return events;
}

function handleItem(frame: Record<string, unknown>, state: TurnStreamState, phase: string): EngineEvent[] {
  const item = isRecord(frame.item) ? frame.item : null;
  if (!item) return [];
  const itemType = asString(item.item_type) ?? asString(item.type) ?? "";
  const id = asString(item.id) ?? "";
  const completed = phase === "completed";

  if (itemType === "agent_message") {
    const text = asString(item.text) ?? asString(item.message) ?? "";
    if (!completed) {
      if (text) state.text = text;
      return streamEvent(state, state.text ? [{ type: "text", text: state.text }] : []);
    }
    const finalText = text || state.text;
    state.streaming = false;
    state.text = "";
    if (!finalText) return [];
    return [{ type: "message_end", message: assistantMessage(state, [{ type: "text", text: finalText }]) }];
  }

  if (itemType === "reasoning") {
    const text = asString(item.text) ?? asString(item.summary) ?? "";
    if (!completed) {
      if (text) state.thinking = text;
      return streamEvent(state, state.thinking ? [{ type: "thinking", thinking: state.thinking }] : []);
    }
    const finalText = text || state.thinking;
    state.streaming = false;
    state.thinking = "";
    if (!finalText) return [];
    return [{ type: "message_end", message: assistantMessage(state, [{ type: "thinking", thinking: finalText }]) }];
  }

  const tool = describeTool(itemType, item);
  if (!tool || !id) return [];
  // A tool item that only ever reports as completed still needs its start pair,
  // otherwise the transcript shows a result with nothing that produced it.
  const events = toolStartEvents(state, id, tool);
  if (!completed) return events;
  const content = [{ type: "text", text: tool.output }];
  events.push({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: tool.name,
      content,
      isError: tool.isError,
      timestamp: Date.now(),
    },
  });
  events.push({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: tool.name,
    result: { content, isError: tool.isError },
  });
  return events;
}

function errorText(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (isRecord(value)) {
    const message = asString(value.message);
    if (message) return message;
  }
  return "the turn ended with an error";
}

/**
 * Translate one parsed NDJSON frame. Unknown frame/item types, malformed
 * payloads and non-objects yield no events instead of throwing: this stream
 * changes shape between codex releases and a surprise must cost at most a
 * missing bubble.
 */
export function translateCodexLine(line: unknown, state: TurnStreamState): EngineEvent[] {
  if (!isRecord(line)) return [];
  switch (line.type) {
    case "thread.started": {
      const threadId = asString(line.thread_id) ?? asString(line.id);
      if (threadId) state.engineSessionId = threadId;
      return [];
    }
    case "turn.completed":
      if (isRecord(line.usage)) state.usage = line.usage;
      return flushStream(state);
    case "turn.failed":
      state.errorMessage = errorText(line.error);
      return flushStream(state);
    case "error":
      state.errorMessage = errorText(line.message ?? line.error);
      return [];
    case "item.started":
      return handleItem(line, state, "started");
    case "item.updated":
      return handleItem(line, state, "updated");
    case "item.completed":
      return handleItem(line, state, "completed");
    default:
      return [];
  }
}
