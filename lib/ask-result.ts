import { isRecord } from "./type-guards";
import { isAskToolCall } from "./ask-walk";

/**
 * The `ask` tool's call and result, normalised for the transcript card.
 *
 * omp 18.19 asks with one HTML `<form>` (`args.html`) and answers with
 * `details = { answers: [{ name, question, answer }], notes?, timedOut? }`.
 * omp 18.8 asks with `args.questions[]` and answers with either one question's
 * details (`{ question, selectedOptions, customInput?, note?, timedOut? }`) or
 * `{ results: [...] }` for several. Both shapes end up as the same rows here.
 *
 * omp 18.19 and 18.20 mount `ask` under `xd://`, so the model calls it as `write xd://ask`: the call's `content` is
 * the ask's arguments as JSON text, and the result's details nest the ask's own details as
 * `{ xdev: { tool: "ask", mode, args, tier, inner } }`. `askCallInput` and the `xdev.inner` unwrap below turn that
 * back into the shapes above, so one card serves every way the model reached the tool.
 */

export interface AskRow {
  question: string;
  answer: string;
  /** The form control's `name` (18.19 only). */
  name?: string;
}

export interface AskNote {
  question: string;
  /** The option the note is attached to; empty for a 18.8 question-level note. */
  option: string;
  text: string;
  name?: string;
}

export interface AskAnswers {
  rows: AskRow[];
  notes: AskNote[];
  timedOut: boolean;
}

export const ASK_NO_ANSWER = "(no answer)";

/** One 18.8 question's answer in a line: `Auth, Billing + "typed text"`. */
function legacyAnswer(entry: Record<string, unknown>): string {
  const selected = Array.isArray(entry.selectedOptions)
    ? entry.selectedOptions.filter((option): option is string => typeof option === "string")
    : [];
  const custom = typeof entry.customInput === "string" ? entry.customInput : undefined;
  const parts: string[] = [];
  if (selected.length > 0) parts.push(selected.join(", "));
  if (custom !== undefined) parts.push(selected.length > 0 ? `+ "${custom}"` : `"${custom}"`);
  return parts.length > 0 ? parts.join(" ") : ASK_NO_ANSWER;
}

function legacyRow(entry: unknown, rows: AskRow[], notes: AskNote[]): boolean {
  if (!isRecord(entry) || typeof entry.question !== "string") return false;
  rows.push({ question: entry.question, answer: legacyAnswer(entry) });
  if (typeof entry.note === "string" && entry.note.trim()) {
    notes.push({ question: entry.question, option: "", text: entry.note });
  }
  return entry.timedOut === true;
}

/**
 * The ask's own arguments out of a tool call, however the model reached it; null when the call is not an ask. A plain
 * `ask` call is its arguments. For `write xd://ask` they are the JSON text in `content`, and the harness's own `i`
 * (the call's intent, beside `path`) stands in when the content carries none. A `content` that is not valid JSON yet
 * (the call is still streaming in) gives no arguments.
 */
export function askCallInput(toolName: unknown, input: unknown): Record<string, unknown> | null {
  if (!isAskToolCall(toolName, input)) return null;
  if (!isRecord(input)) return {};
  if (toolName === "ask") return input;
  const args = jsonRecord(input.content);
  return typeof input.i === "string" && input.i.trim() && !("i" in args) ? { ...args, i: input.i } : args;
}

function jsonRecord(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The ask's own details out of a `write xd://ask` result's details; null for any other shape. */
function xdevAskInner(details: unknown): Record<string, unknown> | null {
  if (!isRecord(details) || !isRecord(details.xdev)) return null;
  const { tool, inner } = details.xdev;
  return tool === "ask" && isRecord(inner) ? inner : null;
}

/** Whether a result's details are those of a `write xd://ask` call that ran (not a help read or a failed dispatch). */
export function isAskXdevDetails(details: unknown): boolean {
  return xdevAskInner(details) !== null;
}

/** Rows, notes and the timed-out flag out of a settled `ask` result's details (the ask's own, or those of a
 * `write xd://ask` result with the ask's nested under `xdev.inner`); malformed entries are skipped, never thrown on. */
export function askAnswersFromDetails(settled: unknown): AskAnswers {
  const out: AskAnswers = { rows: [], notes: [], timedOut: false };
  const details = xdevAskInner(settled) ?? settled;
  if (!isRecord(details)) return out;

  if (Array.isArray(details.answers)) {
    for (const entry of details.answers) {
      if (!isRecord(entry)) continue;
      if (typeof entry.question !== "string" || typeof entry.answer !== "string") continue;
      out.rows.push({
        question: entry.question,
        answer: entry.answer,
        ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}),
      });
    }
    if (Array.isArray(details.notes)) {
      for (const entry of details.notes) {
        if (!isRecord(entry)) continue;
        if (typeof entry.question !== "string" || typeof entry.option !== "string" || typeof entry.text !== "string") continue;
        out.notes.push({
          question: entry.question,
          option: entry.option,
          text: entry.text,
          ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}),
        });
      }
    }
    out.timedOut = details.timedOut === true;
    return out;
  }

  let timedOut = false;
  if (Array.isArray(details.results)) {
    for (const entry of details.results) timedOut = legacyRow(entry, out.rows, out.notes) || timedOut;
  } else {
    timedOut = legacyRow(details, out.rows, out.notes);
  }
  out.timedOut = timedOut || details.timedOut === true;
  return out;
}

/** Tags of every `<input ...>` in the form, tolerant of quoting and of `>` inside quoted values. */
const INPUT_TAG = /<input(?=[\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>?/gi;
const TYPE_PASSWORD = /(?<![\w-])type\s*=\s*(?:"\s*password\s*"|'\s*password\s*'|password(?=[\s/>]|$))/i;
const NAME_ATTR = /(?<![\w-])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;

/** Names of the form's password fields; their answers never show in the transcript. */
export function passwordFieldNames(html: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof html !== "string") return names;
  for (const tag of html.match(INPUT_TAG) ?? []) {
    if (!TYPE_PASSWORD.test(tag)) continue;
    const match = NAME_ATTR.exec(tag);
    const name = match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
    if (name) names.add(name);
  }
  return names;
}

/** An answer as shown: bullets (at most 12) for a password field, else the text. */
export function askAnswerShown(row: AskRow, passwords: ReadonlySet<string>): string {
  if (row.name && passwords.has(row.name)) return "•".repeat(Math.min(row.answer.length, 12));
  return row.answer;
}

const PREVIEW_MAX = 100;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/&(#39|#x27|amp|lt|gt|quot|apos|nbsp);/gi, (_, key: string) => ENTITIES[key.toLowerCase()] ?? "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

/**
 * The header line of an `ask` call. 18.8: the first question (the caller
 * words the "+N more"); else the `i` intent; else the start of the 18.19 form
 * with its tags stripped. Never `[object Object]`.
 */
export function askCallPreview(input: unknown, labels: { more: (count: number) => string }): string {
  if (!isRecord(input)) return "";
  if (Array.isArray(input.questions)) {
    const questions = input.questions
      .map((entry) => (isRecord(entry) && typeof entry.question === "string" ? entry.question : ""))
      .filter(Boolean);
    if (questions.length > 0) {
      const head = clip(questions[0]);
      return questions.length > 1 ? `${head} ${labels.more(questions.length - 1)}` : head;
    }
  }
  if (typeof input.i === "string" && input.i.trim()) return clip(input.i);
  if (typeof input.html === "string") return clip(htmlText(input.html));
  return "";
}

// ---------------------------------------------------------------------------
// History projection (lib/session-reader.ts stripToolResultDetails)
// ---------------------------------------------------------------------------

const ASK_DETAIL_MAX_ROWS = 50;
const ASK_DETAIL_MAX_TEXT = 4000;

function boundText(value: string): string {
  if (value.length <= ASK_DETAIL_MAX_TEXT) return value;
  // By code point so a boundary never splits a surrogate pair; the slice first
  // keeps a hostile megabyte string from being spread into an array.
  return `${[...value.slice(0, ASK_DETAIL_MAX_TEXT * 2)].slice(0, ASK_DETAIL_MAX_TEXT).join("")}…`;
}

function pickStrings(raw: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string") out[key] = boundText(value);
  }
  return out;
}

function boundList(
  raw: unknown,
  pick: (entry: Record<string, unknown>) => Record<string, unknown> | null,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const entry of raw) {
    if (out.length >= ASK_DETAIL_MAX_ROWS) break;
    if (!isRecord(entry)) continue;
    const picked = pick(entry);
    if (picked) out.push(picked);
  }
  return out;
}

function legacyEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof entry.question !== "string") return null;
  const out: Record<string, unknown> = pickStrings(entry, ["id", "question", "customInput", "note"]);
  const selected = Array.isArray(entry.selectedOptions)
    ? entry.selectedOptions.filter((option): option is string => typeof option === "string").slice(0, ASK_DETAIL_MAX_ROWS).map(boundText)
    : [];
  out.selectedOptions = selected;
  if (entry.timedOut === true) out.timedOut = true;
  return out;
}

/**
 * The bounded, whitelisted subset of an `ask` result's details that the
 * transcript card reads (answers, notes, timedOut; 18.8 question/results).
 * A `write xd://ask` result keeps that subset under `xdev.inner` and nothing
 * else of its `xdev` envelope (its `args` repeat the whole form).
 * Nothing else rides the history payload. Null when nothing is left.
 */
export function keepAskToolResultDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const inner = xdevAskInner(details);
  if (!inner) return keepAskDetails(details);
  const kept = keepAskDetails(inner);
  return kept ? { xdev: { tool: "ask", inner: kept } } : null;
}

function keepAskDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {};

  const answers = boundList(details.answers, (entry) => {
    if (typeof entry.question !== "string" || typeof entry.answer !== "string") return null;
    return pickStrings(entry, ["name", "question", "answer"]);
  });
  if (answers && answers.length > 0) kept.answers = answers;

  const notes = boundList(details.notes, (entry) => {
    if (typeof entry.question !== "string" || typeof entry.option !== "string" || typeof entry.text !== "string") return null;
    return pickStrings(entry, ["name", "question", "option", "value", "text"]);
  });
  if (notes && notes.length > 0) kept.notes = notes;

  if (details.timedOut === true) kept.timedOut = true;

  // omp 18.8: one question's answer at the top level, or `results[]`.
  const single = legacyEntry(details);
  if (single) {
    const { id: _id, ...fields } = single;
    Object.assign(kept, fields);
  }
  const results = boundList(details.results, legacyEntry);
  if (results && results.length > 0) kept.results = results;

  return Object.keys(kept).length > 0 ? kept : null;
}
