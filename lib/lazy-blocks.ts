/**
 * Lazy loading for oversized persisted blocks (pure; shared by the session
 * routes, the detail route and the renderer).
 *
 * A saved tool result, thinking block or tool-call argument can be megabytes.
 * `projectLazyBlocks` keeps such a string out of the history payload (and out
 * of every collapsed card): it leaves a stub that says how long the original
 * is and which entry holds it. The full text is then read on request, one
 * page at a time (a reader moves between pages; none is ever out of reach),
 * from `GET /api/sessions/[id]/detail?entryId=...` (shallow on purpose).
 *
 * Contract (the renderer and the routes depend on every line):
 *  - Only strings longer than LAZY_BLOCK_MIN_CHARS (UTF-16 units) are stubbed.
 *  - Block order and indexes never change: `blockIndex` is the index in
 *    `message.content`, which is what the detail route addresses.
 *  - assistant thinking (not narration): `thinking: ""`, `deferred: true`,
 *    `lazyChars`, `lazyEntry`.
 *  - toolResult text block (only of a generic call paired on the walk, see
 *    projectLazyBlocks): `text` = first LAZY_PREVIEW_CHARS units,
 *    `lazyChars`, `lazyEntry`.
 *  - toolCall: each oversized string inside `input` (depth <= 4, at most
 *    MAX_LAZY_ARGS) is replaced by its preview; `lazyInput` maps the RFC 6901
 *    pointer of every replaced string to its original length; `lazyEntry`.
 *  - A message with nothing oversized is returned as the SAME object; input
 *    is never mutated.
 */
import type { AgentMessage, AssistantContentBlock, ToolCallContent } from "./types";
import { isAskToolCall } from "./ask-walk";
import { homelabberCall } from "./homelabber-approval";
import { MCP_COMMAND, simpleCommandWords, toolCommandRecords } from "./tool-command";
import { isRecord } from "./type-guards";

export const LAZY_BLOCK_MIN_CHARS = 16_384;
export const LAZY_PREVIEW_CHARS = 1_024;
/** Largest page the detail route returns (and the renderer asks for). */
export const LAZY_PAGE_CHARS = 65_536;
const MAX_ARG_DEPTH = 4;
const MAX_LAZY_ARGS = 64;

export type LazyDetailKind = "thinking" | "result" | "arg";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** The first `length` units of `text`, never ending inside a surrogate pair. */
function safePrefix(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

export function isOversizedText(text: unknown): text is string {
  return typeof text === "string" && text.length > LAZY_BLOCK_MIN_CHARS;
}

/** RFC 6901 pointer for a path of object keys / array indexes. */
export function encodePointer(path: readonly (string | number)[]): string {
  return path.map((part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** Inverse of encodePointer; null for anything that is not a well-formed pointer. */
export function decodePointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const parts = pointer.slice(1).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (/~(?![01])/.test(part)) return null;
    out.push(part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return out;
}

/** Walk own enumerable data only (never the prototype chain, never `__proto__`). */
function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length ? value[Number(key)] : undefined;
  if (isRecord(value) && Object.hasOwn(value, key)) return value[key];
  return undefined;
}

interface ArgProjection {
  value: unknown;
  lazy: Record<string, number>;
}

function projectValue(value: unknown, path: (string | number)[], depth: number, lazy: Record<string, number>): unknown {
  if (typeof value === "string") {
    if (!isOversizedText(value) || Object.keys(lazy).length >= MAX_LAZY_ARGS) return value;
    lazy[encodePointer(path)] = value.length;
    return safePrefix(value, LAZY_PREVIEW_CHARS);
  }
  if (depth >= MAX_ARG_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = projectValue(value[index], [...path, index], depth + 1, lazy);
      if (next !== value[index]) {
        out ??= value.slice();
        out[index] = next;
      }
    }
    return out ?? value;
  }
  if (isRecord(value)) {
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(value)) {
      const next = projectValue(value[key], [...path, key], depth + 1, lazy);
      if (next !== value[key]) {
        // Own-property definition: a stored `__proto__` key must stay data.
        out ??= { ...value };
        Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
      }
    }
    return out ?? value;
  }
  return value;
}

function projectArguments(input: Record<string, unknown>): ArgProjection | null {
  const lazy: Record<string, number> = {};
  const value = projectValue(input, [], 0, lazy);
  return Object.keys(lazy).length > 0 ? { value, lazy } : null;
}

/**
 * How a tool call's card reads its data. `specialized`: drawn from the call's own arguments or from its result's
 * whole text (the model's `ask`, a HomeLabber approval, a bash call that runs an MCP tool as a command), so neither
 * the call nor its result is ever stubbed. `command`: a bash call that is one simple command (`cat file`; also the
 * engine's `open_url -j '{…}'`, whose card parses the command): its command line stays whole, because the tool-command
 * card parses it, but its output is stubbed like any other unless the engine attached a tool-command record to it.
 * `generic`: everything else.
 */
function classifyCall(toolName: string, input: unknown): "specialized" | "command" | "generic" {
  if (isAskToolCall(toolName, input) || homelabberCall(toolName, input) !== null) return "specialized";
  if (toolName !== "bash" || !isRecord(input) || typeof input.command !== "string") return "generic";
  const words = simpleCommandWords(input.command);
  if (words === null) return "generic";
  return words[0] !== undefined && MCP_COMMAND.test(words[0]) ? "specialized" : "command";
}

function projectAssistantBlock(block: AssistantContentBlock, entryId: string, genericCalls: Set<string> | undefined): AssistantContentBlock {
  if (block.type === "thinking") {
    if (block.narration || block.deferred || !isOversizedText(block.thinking)) return block;
    // An allowlisted stub, not a spread of the stored block: engine-only fields (thinkingSignature, ...) stay on disk.
    return { type: "thinking", thinking: "", deferred: true, lazyChars: block.thinking.length, lazyEntry: entryId };
  }
  if (block.type === "toolCall") {
    // The latest call with an id owns it (providers can reuse ids): a later specialized call un-pairs it.
    const kind = classifyCall(block.toolName, block.input);
    if (kind === "specialized") {
      genericCalls?.delete(block.toolCallId);
      return block;
    }
    genericCalls?.add(block.toolCallId);
    if (kind === "command") return block;
    if (!isRecord(block.input)) return block;
    const projected = projectArguments(block.input);
    if (!projected) return block;
    return { ...block, input: projected.value as Record<string, unknown>, lazyInput: projected.lazy, lazyEntry: entryId };
  }
  return block;
}

/**
 * See the file header. `message` must already be the UI shape (tool calls normalized).
 * `genericCalls` is the pairing state of one walk over a branch, oldest message first: assistant messages record
 * the ids of their generic tool calls in it and a toolResult is stubbed only when its call is in the set. A result
 * with no call on the walk (unpaired, or the entry read alone) and a result carrying the engine's tool-command
 * record arrive whole.
 */
export function projectLazyBlocks(message: AgentMessage, entryId: string, genericCalls?: Set<string>): AgentMessage {
  if (message.role === "assistant") {
    if (!Array.isArray(message.content)) return message;
    let content: AssistantContentBlock[] | null = null;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      if (!isRecord(block)) continue;
      const next = projectAssistantBlock(block as AssistantContentBlock, entryId, genericCalls);
      if (next === block) continue;
      content ??= message.content.slice();
      content[index] = next;
    }
    return content ? { ...message, content } : message;
  }
  if (message.role === "toolResult") {
    if (!Array.isArray(message.content) || !genericCalls?.has(message.toolCallId) || toolCommandRecords(message.details).length > 0) return message;
    let content: typeof message.content | null = null;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      if (!isRecord(block) || block.type !== "text" || !isOversizedText(block.text)) continue;
      content ??= message.content.slice();
      content[index] = { type: "text", text: safePrefix(block.text, LAZY_PREVIEW_CHARS), lazyChars: block.text.length, lazyEntry: entryId };
    }
    return content ? { ...message, content } : message;
  }
  return message;
}

/** Whether a block still carries a stub (the renderer's one test). */
export function lazyBlockChars(block: unknown): number {
  if (!isRecord(block)) return 0;
  return typeof block.lazyChars === "number" && Number.isSafeInteger(block.lazyChars) && block.lazyChars > 0 ? block.lazyChars : 0;
}

/**
 * The full text a stub stands for, read from the (normalized) message the
 * stub was made from. Only the three displayed fields can be asked for:
 * assistant thinking, toolResult text, a string inside a toolCall's input.
 * Null for anything else.
 */
export function lazyDetailText(
  message: AgentMessage,
  kind: LazyDetailKind,
  blockIndex: number,
  pointer?: string,
): string | null {
  // Not every AgentMessage kind has `content` (bashExecution does not).
  if (!("content" in message) || !Array.isArray(message.content) || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
  const block: unknown = message.content[blockIndex];
  if (!isRecord(block)) return null;
  if (kind === "thinking") {
    return message.role === "assistant" && block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : null;
  }
  if (kind === "result") {
    return message.role === "toolResult" && block.type === "text" && typeof block.text === "string" ? block.text : null;
  }
  if (message.role !== "assistant" || block.type !== "toolCall" || pointer === undefined) return null;
  const path = decodePointer(pointer);
  if (!path || path.length === 0 || path.length > MAX_ARG_DEPTH) return null;
  let value: unknown = (block as unknown as ToolCallContent).input;
  for (const key of path) value = child(value, key);
  return typeof value === "string" ? value : null;
}

/**
 * One page of a text: pages are numbered from 0 and cut every `size` UTF-16 units, except that a cut that would
 * fall between the halves of a surrogate pair moves one unit earlier, so no page starts or ends inside a
 * character and the pages tile the text exactly. A page holds at most `size + 1` units.
 */
export interface LazyPage {
  text: string;
  page: number;
  /** How many pages the text has (at least 1). */
  pages: number;
  /** The text's length in UTF-16 units. */
  total: number;
}

export function clampPageSize(size: number): number {
  return Math.min(Math.max(2, Math.trunc(size)), LAZY_PAGE_CHARS);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function pageBoundary(text: string, index: number, size: number): number {
  const cut = index * size;
  if (cut <= 0) return 0;
  if (cut >= text.length) return text.length;
  return isLowSurrogate(text.charCodeAt(cut)) && isHighSurrogate(text.charCodeAt(cut - 1)) ? cut - 1 : cut;
}

/** Page `page` of `text`, or null when there is no such page. */
export function sliceLazyPage(text: string, page: number, size: number = LAZY_PAGE_CHARS): LazyPage | null {
  const unit = clampPageSize(size);
  const pages = Math.max(1, Math.ceil(text.length / unit));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages) return null;
  return { text: text.slice(pageBoundary(text, page, unit), pageBoundary(text, page + 1, unit)), page, pages, total: text.length };
}

/** Everything the detail route needs to find one block again. */
export interface LazyDetailRef {
  sessionId: string;
  entryId: string;
  kind: LazyDetailKind;
  blockIndex: number;
  pointer?: string;
}

export function lazyDetailUrl(ref: LazyDetailRef, page: number): string {
  const query = new URLSearchParams({ entryId: ref.entryId, kind: ref.kind, blockIndex: String(ref.blockIndex), page: String(page), limit: String(LAZY_PAGE_CHARS) });
  if (ref.pointer !== undefined) query.set("pointer", ref.pointer);
  return `/api/sessions/${encodeURIComponent(ref.sessionId)}/detail?${query}`;
}

/** A detail response, or null when it is not one (the caller reports it as an error). */
export function parseLazyPage(value: unknown): LazyPage | null {
  if (!isRecord(value)) return null;
  const { text, page, pages, total } = value;
  if (typeof text !== "string" || typeof total !== "number") return null;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0) return null;
  if (typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 1 || page >= pages) return null;
  return { text, page, pages, total };
}
