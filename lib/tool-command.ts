// omp 19.1 runs the tools it keeps off the model's main list (Cody's host tools, an MCP server's tools, the
// toolsets `load_tools` mounts) as COMMANDS inside `bash`: `open_url -j '{"url":"…"}'`. omp 19.0 ran the same
// tools as `write xd://open_url`. A card that read "bash" for those calls would hide which tool the model
// used, and the HomeLabber approval card would never see its own call, so the chat reads a tool command here.
//
// Two signals decide, never a guess from the first word of an arbitrary bash line:
//   - the engine's own record, `details.toolCommands[]`, on the bash result (live frames and the session file);
//   - for an MCP tool, whose command name starts `mcp__` (nothing else is called that), the command itself:
//     all a call has before its result arrives, and all a reloaded history keeps.
// Only a line that is ONE simple command counts, so a pipe or `; echo …` after the tool cannot dress up
// arbitrary shell output as the tool's answer.
import { isRecord } from "./type-guards";

/** What the engine recorded for one tool command a bash call ran (`details.toolCommands[i]`). */
export interface ToolCommandRecord {
  tool: string;
  mode: string | null;
  exitCode: number | null;
  /** The arguments the engine validated and ran with. A reloaded history keeps only the three fields above. */
  args?: Record<string, unknown>;
}

/** A bash call that is one tool command. */
export interface ToolCommandCall {
  tool: string;
  /** The arguments, from the engine's record or from the command's `-j '<json>'`; null when the command carries none. */
  args: Record<string, unknown> | null;
  /** The command after the tool's name: the one-line preview of the call. */
  rest: string;
}

const MAX_RECORDS = 8;
const MAX_TOOL_CHARS = 128;
const MCP_COMMAND = /^mcp__[A-Za-z0-9_]+$/;

/** `details.toolCommands` of a bash result (omp 19.1+), bounded: one record per tool command the shell ran. */
export function toolCommandRecords(details: unknown): ToolCommandRecord[] {
  if (!isRecord(details) || !Array.isArray(details.toolCommands)) return [];
  const records: ToolCommandRecord[] = [];
  for (const raw of details.toolCommands.slice(0, MAX_RECORDS)) {
    if (!isRecord(raw) || typeof raw.tool !== "string" || raw.tool === "" || raw.tool.length > MAX_TOOL_CHARS) continue;
    records.push({
      tool: raw.tool,
      mode: typeof raw.mode === "string" && raw.mode.length <= 16 ? raw.mode : null,
      exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
      ...(isRecord(raw.args) ? { args: raw.args } : {}),
    });
  }
  return records;
}

/**
 * The words of ONE simple shell command, quotes resolved, or null when the line is anything more (a second
 * command, a pipe, a redirect, an expansion, a comment) or cannot be read (an unclosed quote).
 */
function simpleCommandWords(line: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "$" || char === "`") return null;
      else if (char === "\\" && index + 1 < line.length && '"\\$`'.includes(line[index + 1])) current += line[++index];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      if (index + 1 >= line.length || line[index + 1] === "\n") return null;
      current += line[++index];
      inWord = true;
    } else if (char === " " || char === "\t") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else if (";&|<>()$`\n".includes(char) || (char === "#" && !inWord)) {
      return null;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(current);
  return words;
}

/** The JSON object a command's `-j <json>` / `--json <json>` / `--json=<json>` carries (merged when repeated), or null. */
function jsonArgsOf(words: readonly string[]): Record<string, unknown> | null {
  let args: Record<string, unknown> | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    let raw: string | undefined;
    if (word === "-j" || word === "--json") raw = words[++index];
    else if (word.startsWith("--json=")) raw = word.slice("--json=".length);
    if (raw === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) args = { ...(args ?? {}), ...parsed };
    } catch {
      // Not JSON (`@file`, a shell variable the engine expands): the engine's record carries the real arguments.
    }
  }
  return args;
}

/**
 * The tool a bash call runs as a command, or null for any other call. `details` is the result's, when it has one.
 * With a record on the result it must be the only one and name the command's own first word; without one only an
 * MCP tool's own name proves it, which is all a running call and a reloaded history have.
 */
export function toolCommandCall(toolName: string, input: unknown, details?: unknown): ToolCommandCall | null {
  if (toolName !== "bash" || !isRecord(input) || typeof input.command !== "string") return null;
  const words = simpleCommandWords(input.command);
  const tool = words?.[0];
  if (!words || !tool) return null;
  const records = toolCommandRecords(details);
  if (records.length > 0 ? records.length !== 1 || records[0].tool !== tool : !MCP_COMMAND.test(tool)) return null;
  const line = input.command.trim();
  const split = line.search(/\s/);
  return { tool, args: records[0]?.args ?? jsonArgsOf(words.slice(1)), rest: split === -1 ? "" : line.slice(split).trim() };
}
