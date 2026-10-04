import { createHash } from "node:crypto";
import * as path from "path";
import { readPermissionOptions, describeToolCall } from "../permission-request";
import { replyAsksUser } from "../reply-question";
import { asString, isRecord } from "../type-guards";
import type { NotificationEventId } from "./catalog";

/**
 * Everything about HOW a notification reads and what its buttons can answer —
 * pure functions over the frames a session emits, so the rules are pinned by
 * tests rather than by what a phone happened to show.
 *
 * The server has no locale (the browser's language never reaches it), so all
 * copy here is English, exactly like the Settings page.
 */

/** The start of every title: what kind of notification this is. */
export const EVENT_TITLES: Record<NotificationEventId, string> = {
  approval: "Approval needed",
  question: "Question",
  waiting: "Waiting for your reply",
  finished: "Reply finished",
  subagent: "Subagent finished",
  error: "Error",
  fallback: "Model fallback",
  quotaLow: "Quota running low",
  quotaOut: "Quota used up",
};

/** ntfy turns a tag that is an emoji short code into that emoji in front of the title. */
export const EVENT_TAGS: Record<NotificationEventId, string> = {
  approval: "lock",
  question: "question",
  waiting: "speech_balloon",
  finished: "white_check_mark",
  subagent: "robot",
  error: "x",
  fallback: "twisted_rightwards_arrows",
  quotaLow: "warning",
  quotaOut: "no_entry",
};

export const TITLE_MAX_CHARS = 120;
export const BODY_MAX_CHARS = 1500;
/** ntfy treats a message past 4096 bytes as an attachment, so the body stays well inside it however wide its characters are. */
export const BODY_MAX_BYTES = 3500;
export const EXCERPT_MAX_CHARS = 300;
export const BUTTON_LABEL_MAX_CHARS = 24;
/** ntfy shows at most three action buttons. */
export const MAX_ANSWER_BUTTONS = 3;
const TAG_MAX_CHARS = 32;

/** One line, single spaces. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` characters (not UTF-16 units), ending in an ellipsis when cut. */
export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** At most `max` UTF-8 bytes, never splitting a character. */
export function clipBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = max;
  // A continuation byte (10xxxxxx) belongs to a character that starts earlier.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.toString("utf8", 0, end);
}

/** The notification title: `<kind> · <chat title>`. */
export function buildTitle(event: NotificationEventId, subject: string): string {
  return clipChars(singleLine(`${EVENT_TITLES[event]} · ${subject}`), TITLE_MAX_CHARS);
}

/** A notification body: trimmed, newlines kept, inside both caps. */
export function buildBody(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clipBytes(clipChars(normalized, BODY_MAX_CHARS), BODY_MAX_BYTES);
}

/** The first few hundred characters of a reply, on one line of text per paragraph. */
export function replyExcerpt(text: string): string {
  return clipChars(text.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim(), EXCERPT_MAX_CHARS);
}

/**
 * What a "waiting for your reply" notification quotes. The question is usually
 * the END of a long reply, so the last line that asks something is shown
 * (marked with an ellipsis when it is not the start of the reply); a reply
 * whose question cannot be pinned to a line is quoted from its start.
 */
export function questionExcerpt(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (replyAsksUser(lines[index]!)) {
      const asked = clipChars(lines[index]!, EXCERPT_MAX_CHARS);
      return index === 0 ? asked : `… ${asked}`;
    }
  }
  return replyExcerpt(text);
}

/** The project name tag: the working directory's own name, made safe for a tag. */
export function projectTag(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const name = singleLine(path.basename(cwd)).replace(/[^\w .-]/g, "-").slice(0, TAG_MAX_CHARS).trim();
  return name === "" ? null : name;
}

/** ntfy's sequence id for a pending request: charset-safe and short, and stable across the notification's life. */
export function sequenceIdFor(sessionId: string, requestKey: string): string {
  return `cody-${createHash("sha256").update(`${sessionId}\0${requestKey}`).digest("hex").slice(0, 24)}`;
}

/** A short digest of a value's JSON, used to bind a button to the exact request it was made for. */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
}

/** What one button answers with: `answer` is merged into the command the browser would have sent. */
export interface AnswerChoice {
  label: string;
  answer: Record<string, unknown>;
}

/** The buttons offered for one pending request. */
export interface AnswerOffer {
  /** `ui` answers an omp dialog (`extension_ui_response`); `permission` an ACP approval (`respond_permission`). */
  kind: "ui" | "permission";
  requestId: string;
  /** Binds the buttons to this request's content (see uiRequestDigest / permissionDigest). */
  digest: string;
  /** The request's own deadline, when it has one; a button never outlives it. */
  expiresAt?: number;
  choices: AnswerChoice[];
}

/** omp's tool approval: a confirm titled "Allow tool: <name>". */
export function isToolApprovalTitle(title: unknown): title is string {
  return typeof title === "string" && /^allow tool\s*:/i.test(title);
}

/** The string entries of an array field; anything else reads as no options. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** One question of an omp `ask` dialog, as far as an answer needs it. */
export interface AskQuestionView {
  id: string;
  question: string;
  header: string | null;
  multi: boolean;
  options: string[];
}

export function askQuestions(event: Record<string, unknown>): AskQuestionView[] {
  if (!Array.isArray(event.questions)) return [];
  return event.questions.flatMap((entry): AskQuestionView[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.question !== "string") return [];
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => (isRecord(option) && typeof option.label === "string" ? [option.label] : []))
      : [];
    return [{ id: entry.id, question: entry.question, header: asString(entry.header) ?? null, multi: entry.multi === true, options }];
  });
}

/**
 * A digest of what an omp dialog says and offers. Both ends compute it — the
 * observer from the frame it saw, the answer route from the request still
 * pending — so a button made for one dialog cannot answer a different one that
 * happens to reuse its id.
 */
export function uiRequestDigest(event: Record<string, unknown>): string {
  return digestOf({
    method: asString(event.method) ?? null,
    title: asString(event.title) ?? null,
    message: asString(event.message) ?? null,
    options: strings(event.options),
    questions: askQuestions(event).map((q) => ({ id: q.id, question: q.question, multi: q.multi, options: q.options })),
  });
}

/** The same, for an ACP approval: the tool call and which options exist. */
export function permissionDigest(toolCall: unknown, options: unknown): string {
  return digestOf({ toolCall: toolCall ?? null, options: readPermissionOptions(options).map((o) => [o.optionId, o.kind]) });
}

function buttonLabel(text: string): string {
  return clipChars(singleLine(text), BUTTON_LABEL_MAX_CHARS);
}

/** One button per option, or none when any option could not be labelled. */
function choicesFromLabels(labels: string[], answer: (label: string) => Record<string, unknown>): AnswerChoice[] {
  if (labels.length === 0 || labels.length > MAX_ANSWER_BUTTONS) return [];
  const shown = labels.map(buttonLabel);
  if (shown.some((label) => label === "")) return [];
  return labels.map((label, index) => ({ label: shown[index]!, answer: answer(label) }));
}

/**
 * The buttons an omp dialog can honestly be answered with:
 *  - confirm: two. "Allow"/"Deny" for a tool approval, otherwise "Yes"/"No".
 *  - select: one per option, when there are at most three.
 *  - ask: one per option, when it is a single question that takes one answer
 *    and has at most three options.
 * Anything else (typed input, an editor, a link, a form, a long list) needs the
 * chat itself, and gets none.
 */
export function answerOfferForUiRequest(event: Record<string, unknown>): AnswerOffer | null {
  const requestId = asString(event.id);
  if (!requestId) return null;
  const expiresAt = typeof event.expiresAt === "number" ? event.expiresAt : undefined;
  let choices: AnswerChoice[] = [];
  if (event.method === "confirm") {
    const [yes, no] = isToolApprovalTitle(event.title) ? (["Allow", "Deny"] as const) : (["Yes", "No"] as const);
    choices = [
      { label: yes, answer: { confirmed: true } },
      { label: no, answer: { confirmed: false } },
    ];
  } else if (event.method === "select") {
    const options = strings(event.options);
    // A list with an entry that is not text is one this code does not understand: no buttons, not a subset.
    if (Array.isArray(event.options) && options.length === event.options.length) {
      choices = choicesFromLabels(options, (value) => ({ value }));
    }
  } else if (event.method === "ask") {
    const questions = askQuestions(event);
    const raw = Array.isArray(event.questions) && event.questions.length === 1 ? event.questions[0] : null;
    const only = questions.length === 1 ? questions[0]! : null;
    // Every option must be readable, or the buttons would be a subset of what was asked.
    const readable = only !== null && isRecord(raw) && Array.isArray(raw.options) && raw.options.length === only.options.length;
    if (only && readable && !only.multi) {
      choices = choicesFromLabels(only.options, (label) => ({ answers: [{ id: only.id, selectedOptions: [label] }] }));
    }
  }
  if (choices.length === 0) return null;
  return { kind: "ui", requestId, digest: uiRequestDigest(event), ...(expiresAt === undefined ? {} : { expiresAt }), choices };
}

/**
 * The buttons an ACP approval gets: the agent's FIRST "allow once" and FIRST
 * "reject once", under the agent's own names. Never a button for an
 * "always" option — a lasting grant (or a lasting refusal) must not be one tap
 * on a lock screen.
 */
export function answerOfferForPermission(event: Record<string, unknown>): AnswerOffer | null {
  const requestId = asString(event.requestId);
  if (!requestId) return null;
  const options = readPermissionOptions(event.options);
  const picked = [options.find((o) => o.kind === "allow_once"), options.find((o) => o.kind === "reject_once")];
  const choices = picked.flatMap((option): AnswerChoice[] => {
    if (!option) return [];
    const label = buttonLabel(option.name);
    return label === "" ? [] : [{ label, answer: { optionId: option.optionId } }];
  });
  if (choices.length === 0) return null;
  return { kind: "permission", requestId, digest: permissionDigest(event.toolCall, event.options), choices };
}

/** What a notification for an omp dialog says: which kind it is, and its text. */
export interface UiRequestSummary {
  event: "approval" | "question";
  body: string;
}

function optionList(options: string[]): string {
  return options.map((option, index) => `${index + 1}. ${singleLine(option)}`).join("\n");
}

/** The kind and text of a notification for one omp dialog; null for a method that is not a question. */
export function summarizeUiRequest(event: Record<string, unknown>): UiRequestSummary | null {
  const title = asString(event.title)?.trim() ?? "";
  const message = asString(event.message)?.trim() ?? "";
  switch (event.method) {
    case "confirm": {
      if (isToolApprovalTitle(title)) {
        const tool = title.replace(/^allow tool\s*:\s*/i, "").trim();
        return { event: "approval", body: [tool ? `Tool: ${tool}` : "A tool wants to run.", message].filter(Boolean).join("\n") };
      }
      return { event: "question", body: [title, message].filter(Boolean).join("\n") || "The agent asked you to confirm something." };
    }
    case "select": {
      const options = strings(event.options);
      return { event: "question", body: [title || "The agent asked you to choose.", optionList(options)].filter(Boolean).join("\n") };
    }
    case "input":
    case "editor":
      return { event: "question", body: title || "The agent is waiting for you to type something." };
    case "open_url":
      // The link itself stays in Cody: it can carry a one-time sign-in code.
      return { event: "question", body: [title || "The agent wants you to open a link.", "Open the chat to continue."].join("\n") };
    case "ask": {
      const questions = askQuestions(event);
      const lines = questions.flatMap((q, index) => {
        const heading = questions.length > 1 ? `${index + 1}. ` : "";
        return [`${heading}${q.header ? `${q.header}: ` : ""}${q.question}`, ...q.options.map((option) => `   - ${singleLine(option)}`)];
      });
      return { event: "question", body: lines.join("\n") || "The agent asked you some questions." };
    }
    default:
      return null;
  }
}

/** The text of an ACP approval: what the agent says it wants to do. */
export function summarizePermission(event: Record<string, unknown>): string {
  const call = describeToolCall(event.toolCall);
  return call.title ?? "The agent wants permission to use a tool.";
}
