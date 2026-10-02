/**
 * omp injects its own nudges into the session as `role:"developer"` messages
 * wrapped in `<system-reminder>…</system-reminder>`: the todo reminder ("You
 * stopped with N incomplete todo item(s)…"), tool-use reminders, and so on.
 * They are for the model, not the person reading the chat, so the transcript
 * folds them into a slim collapsed row instead of a full "developer" bubble.
 *
 * Pure: no engine types, no I/O. Shared by the session-file reader and the
 * live streaming path so both fold identically.
 */

import type { CustomMessage, ImageContent, TextContent } from "./types";

export const TODO_REMINDER_CUSTOM_TYPE = "todo-reminder";
export const ENGINE_NOTE_CUSTOM_TYPE = "engine-note";

export interface TodoReminderItem {
  text: string;
  /** Nesting level: 0 for a phase/top-level task, 1+ for its sub-tasks. */
  depth: number;
}

export interface TodoReminderDetails {
  /** Open task count as omp reported it ("N incomplete todo item(s)"). */
  count: number;
  /** Which nudge this is (1-based), when omp said. */
  attempt?: number;
  max?: number;
  items: TodoReminderItem[];
}

const WRAPPER_RE = /^\s*<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;
const TODO_HEADER_RE = /^You stopped with (\d+) incomplete todo item\(s\):[ \t]*\r?\n/;
const ATTEMPT_RE = /\(Reminder (\d+)\s*\/\s*(\d+)\)\s*$/;
const NUDGE_LINE_RE = /^Please continue working on these tasks\b.*$/m;

function textOf(content: string | (TextContent | ImageContent)[] | unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** The text inside `<system-reminder>` when the whole message is one, else null. */
export function systemReminderBody(content: unknown): string | null {
  const text = textOf(content);
  if (text === null) return null;
  const match = WRAPPER_RE.exec(text);
  return match ? match[1] : null;
}

/** Parse omp's todo reminder body; null when it is not that shape. */
export function parseTodoReminder(body: string): TodoReminderDetails | null {
  const header = TODO_HEADER_RE.exec(body);
  if (!header) return null;
  const count = Number(header[1]);
  let rest = body.slice(header[0].length);
  const attemptMatch = ATTEMPT_RE.exec(rest);
  if (attemptMatch) rest = rest.slice(0, attemptMatch.index);
  const nudge = NUDGE_LINE_RE.exec(rest);
  if (nudge) rest = rest.slice(0, nudge.index);
  const items: TodoReminderItem[] = [];
  for (const line of rest.split(/\r?\n/)) {
    const match = /^(\s*)(?:[-*+]\s+)?(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, "  ").length;
    items.push({ text: match[2], depth: Math.min(Math.floor(indent / 2), 4) });
  }
  const details: TodoReminderDetails = { count, items };
  if (attemptMatch) {
    details.attempt = Number(attemptMatch[1]);
    details.max = Number(attemptMatch[2]);
  }
  return details;
}

export function isTodoReminderDetails(value: unknown): value is TodoReminderDetails {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.count === "number" && Array.isArray(v.items);
}

/**
 * Fold an omp `developer` message into a slim custom row when it is one of the
 * engine's `<system-reminder>` nudges. Anything else (a plain developer
 * instruction) returns null so the caller keeps its own handling.
 */
export function foldSystemReminder(raw: { content?: unknown; timestamp?: number }): CustomMessage | null {
  const body = systemReminderBody(raw.content);
  if (body === null) return null;
  const todo = parseTodoReminder(body);
  if (todo) {
    return {
      role: "custom",
      customType: TODO_REMINDER_CUSTOM_TYPE,
      content: body,
      display: true,
      details: todo,
      timestamp: raw.timestamp,
    };
  }
  return {
    role: "custom",
    customType: ENGINE_NOTE_CUSTOM_TYPE,
    content: body,
    display: true,
    timestamp: raw.timestamp,
  };
}

/** True for the slim collapsed rows this module produces. */
export function isReminderCustomType(customType: string): boolean {
  return customType === TODO_REMINDER_CUSTOM_TYPE || customType === ENGINE_NOTE_CUSTOM_TYPE;
}
