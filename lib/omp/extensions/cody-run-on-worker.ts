// Loaded by omp itself (Bun), not by Cody's bundler. Its Cody import is the
// pure `lib/workers/definition` (no imports), so it works unchanged in omp's
// runtime and in Cody's tests.
//
// Offers `run_on_worker` to every agent in a chat: the main one AND its helper
// agents (subagents). omp passes Cody's host tools to the main chat only, so
// a helper never had the tool and ran every heavy build on the busy server
// itself (measured: 89% of heavy commands came from helpers). An extension
// reaches every helper, so the tool lives here and calls Cody's own
// /api/internal/workers route; lib/workers/access.ts hands the engine the
// endpoint, the chat's identity and a token through CODY_WORKERS_*.
//
// Helpers without a shell (read-only scouts and reviewers) are refused: the
// tool runs commands, so it must not be a way around their missing `bash`.
//
// This file registers NO `tool_call` / `tool_result` handler: omp turns off
// `task.speculativeLaunch` while any extension has one (see the disk-budget
// note in AGENTS.md).
import { RUN_ON_WORKER_TOOL } from "../../workers/definition";

// -- what the extension needs from omp (a structural subset, so tests can fake it) --

type Content = { type: "text"; text: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}
type Update = (partial: ToolResult) => void;
interface Context {
  cwd?: string;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: object;
  loadMode: "essential" | "discoverable";
  approval: "read" | "write" | "exec";
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: Update | undefined, ctx: Context): Promise<ToolResult>;
}
export interface OmpApi {
  registerTool(tool: ToolDefinition): void;
  getActiveTools(): string[];
}

export interface Deps {
  /** CODY_WORKERS_ENDPOINT, CODY_WORKERS_SESSION, CODY_WORKERS_TOKEN: all three, or no tool. */
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

function result(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The server answers application/x-ndjson, one JSON object a line:
 * {"type":"progress","text"} (shown as the running status), {"type":"heartbeat"}
 * (ignored) and a last {"type":"result","text","isError"}. Anything refused
 * before the job starts is a plain JSON {error}.
 */
async function call(deps: Deps, params: unknown, signal: AbortSignal | undefined, onUpdate: Update | undefined, cwd: string | undefined): Promise<ToolResult> {
  const { CODY_WORKERS_ENDPOINT: endpoint, CODY_WORKERS_SESSION: session, CODY_WORKERS_TOKEN: token } = deps.env;
  if (!endpoint || !session || !token) return result("Cody's worker capability is unavailable in this session.", true);
  // A helper agent that works in its own directory runs the command from there unless it says otherwise.
  const given = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const args = given.cwd === undefined && cwd ? { ...given, cwd } : given;
  const response = await deps.fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
    body: JSON.stringify({ sessionId: session, tool: RUN_ON_WORKER_TOOL.name, arguments: args }),
    signal,
  });
  if (!(response.headers.get("content-type") ?? "").includes("application/x-ndjson") || !response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; text?: unknown };
    if (!response.ok) return result(typeof body.error === "string" ? body.error : `HTTP ${response.status}`, true);
    if (typeof body.error === "string") return result(body.error, true);
    return result(typeof body.text === "string" ? body.text : "");
  }
  let outcome: ToolResult | null = null;
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    let event: { type?: unknown; text?: unknown; isError?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "progress" && typeof event.text === "string") onUpdate?.(result(event.text));
    else if (event.type === "result") outcome = result(typeof event.text === "string" ? event.text : "", event.isError === true);
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  handleLine(buffered + decoder.decode());
  return outcome ?? result("The worker request ended without a result.", true);
}

export function createRunOnWorker(deps: Deps): (pi: OmpApi) => void {
  return (pi) => {
    // Outside a Cody chat there is nothing to call: offer no tool rather than one that always fails.
    if (!deps.env.CODY_WORKERS_ENDPOINT || !deps.env.CODY_WORKERS_SESSION || !deps.env.CODY_WORKERS_TOKEN) return;
    pi.registerTool({
      name: RUN_ON_WORKER_TOOL.name,
      label: "Run on worker",
      description: RUN_ON_WORKER_TOOL.description,
      parameters: RUN_ON_WORKER_TOOL.parameters,
      loadMode: "essential",
      approval: "exec",
      async execute(_id, params, signal, onUpdate, ctx) {
        const active = pi.getActiveTools();
        if (!active.includes("bash") && !active.includes("eval")) {
          return result("run_on_worker runs shell commands, and this agent has no shell tool, so it cannot use it.", true);
        }
        try {
          return await call(deps, params, signal, onUpdate, ctx.cwd);
        } catch (error) {
          return result(signal?.aborted ? "run_on_worker was cancelled." : `Worker request failed: ${errorText(error)}`, true);
        }
      },
    });
  };
}

export default createRunOnWorker({ env: process.env, fetch });
