/**
 * Does an assistant reply ask the USER something?
 *
 * omp's todo reminder (`todo-tracker.ts` `isAwaitingUserAnswer`) only looks at
 * the LAST line of the reply before auto-continuing an unfinished todo list. A
 * question followed by a summary line ("Which do you prefer?\n\nSummary: …")
 * is therefore overridden, and the agent carries on as if the user had
 * answered. This helper applies omp's own line rules to EVERY prose line so
 * the rpc wrapper can pause the continuation instead (see rpc-manager's
 * `todo_reminder` case).
 *
 * Pure: no engine types, no I/O.
 */

const MARKDOWN_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_WORD_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_RE = /\b(?:you|your|we|our)\b/i;
const RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise|answer|let\s+me\s+know|tell\s+me)\b/i;
const NON_ASCII_RE = /[^\x00-\x7F]/;
/** Trailing `?` (or fullwidth), tolerating closing emphasis: `**Which one?**`. */
const ENDS_WITH_QUESTION_MARK_RE = /[?？][*_\s]*$/;
const TRAILING_PUNCTUATION_RE = /[.!?。！？]+$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
/** `foo?: string` (optional property / ternary-with-type) and URLs carry a
 * `?` that asks nothing. */
const CODE_LIKE_RE = /\?:|:\/\/|\bwww\./;
const INLINE_CODE_RE = /`[^`]*`/g;

/** Emphasis markers (`**bold**`, `*em*`, `~~strike~~`, `_em_` at word edges)
 * carry no meaning for cue matching; snake_case underscores are kept. */
function stripEmphasis(line: string): string {
  return line.replace(/[*~]+/g, "").replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "");
}
/** Quoted text is somebody else's words (a prompt template, a dialog
 * caption): blank its contents but keep the quote marks, so `say "next"`
 * still reads as an instruction while `says "tell me more"` does not. */
function blankQuotes(line: string): string {
  return line.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '""');
}

/** Where a hand-off cue may start inside a line: line start, after sentence
 * punctuation, a dash, or a conjunction/politeness word ("…, then tell me").
 * Mid-clause matches like "it will tell me" or "to let me know" are therefore
 * not hand-offs. */
const CUE_BOUNDARY =
  String.raw`(?:^|[.!?;:,\u2014\u2013(]\s*|\s[-\u2013\u2014]\s+|\b(?:and|or|then|so|just|please|kindly|now|also|otherwise|ok|okay|if you(?:'d| would)? (?:like|want)(?: me to)?,?|feel free to|you can|you could|you may|go ahead and|when ready,?|once ready,?)\s+)`;
const HANDOFF_CUE_RE = new RegExp(
  CUE_BOUNDARY +
    String.raw`(?:tell me\b|let me know\b|(?:reply|respond|answer)\s+(?:with|to me|yes\b|no\b|["\u201c'\u2018])|say\s+(?:if|whether|so)\b|(?:say|type)\s+["\u201c])`,
  "i",
);
/** Phrases that address the user directly wherever they sit in a sentence. */
const ANYWHERE_CUE_RE = new RegExp(
  String.raw`\b(?:do you want|would you like|which (?:do|would) you (?:prefer|like|want)|up to you)\b|(?:` +
    CUE_BOUNDARY +
    String.raw`|\byou\s+)want me to\b|\b[Ss]hould I\b|\b[Ss]hall I\b|\byour call\b|\b(?:it'?s|that'?s|this is) your (?:choice|decision)\b`,
  "i",
);

/** "What you need to do:", "Your turn", "Action needed" … as a section label,
 * with or without bold/heading markers. Group 1 = text after the label. */
const USER_SECTION_RE =
  /^(?:#{1,6}\s*)?(?:what you(?: still)? need to do|what i need from you|your turn|next steps? for you|actions? (?:needed|required)|your action|your next step)(?: (?:next|now))?\s*(?:[:\uff1a\u2014\u2013-]\s*(.*)|())$/i;
const SECTION_END_RE = /^(?:#{1,6}\s|\*\*[^*]+\*\*:?\s*$)/;
/** Section content that says there is nothing to do. */
const NOTHING_TO_DO_RE = /^(?:nothing|none|n\/a|no (?:action|further|manual|step)|not (?:needed|required)|nope)\b|^[-\u2013\u2014]+\s*$/i;

interface ProseLine {
  /** Line with inline code removed; "" for blank lines. */
  text: string;
  /** Inside a fenced block (kept only so a section followed by a code block
   * counts as having content). */
  fenced: boolean;
}

function proseLines(text: string): ProseLine[] {
  const out: ProseLine[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      out.push({ text: "`code`", fenced: true });
      continue;
    }
    if (fenced) {
      out.push({ text: raw.trim() ? "`code`" : "", fenced: true });
      continue;
    }
    out.push({ text: raw.replace(INLINE_CODE_RE, "").trim(), fenced: false });
  }
  return out;
}

/** A user-action section label followed by real content. */
function userSectionAt(lines: ProseLine[], index: number): boolean {
  const line = lines[index];
  if (line.fenced || !line.text) return false;
  const label = stripEmphasis(line.text.replace(MARKDOWN_PREFIX_RE, "")).trim();
  const match = USER_SECTION_RE.exec(label);
  if (!match) return false;
  const inline = (match[1] ?? "").trim();
  if (inline) return !NOTHING_TO_DO_RE.test(inline);
  for (let i = index + 1; i < lines.length; i++) {
    const next = lines[i];
    if (!next.text) continue;
    if (!next.fenced && SECTION_END_RE.test(next.text)) return false;
    const content = next.fenced ? next.text : stripEmphasis(next.text.replace(MARKDOWN_PREFIX_RE, "")).trim();
    return content !== "" && !NOTHING_TO_DO_RE.test(content);
  }
  return false;
}

/** True when any prose line of `text` is a user-directed question, a response
 * cue ("please confirm…", "…then tell me …"), or a user-action section
 * ("What you need to do:" with something under it). Fenced code and
 * code-looking lines are ignored. */
export function replyAsksUser(text: string): boolean {
  const lines = proseLines(text);
  for (let i = 0; i < lines.length; i++) {
    const { text: line, fenced } = lines[i];
    if (fenced || !line || CODE_LIKE_RE.test(line)) continue;
    if (userSectionAt(lines, i)) return true;
    const raw = line.replace(MARKDOWN_PREFIX_RE, "").trim();
    const unprefixed = stripEmphasis(raw).trim();
    const candidate = unprefixed.replace(PROMPT_LABEL_RE, "").trim();
    const labelled = candidate !== unprefixed;
    if (ENDS_WITH_QUESTION_MARK_RE.test(candidate)) {
      if (labelled || QUESTION_WORD_RE.test(candidate) || USER_DIRECTED_RE.test(candidate) || NON_ASCII_RE.test(candidate)) {
        return true;
      }
    }
    // A bare leading cue ("Answer — …") only counts unemphasised: a bold label
    // like "**Answer** — yes/no" is a heading, not a request.
    if (RESPONSE_CUE_RE.test(raw.replace(PROMPT_LABEL_RE, "").replace(TRAILING_PUNCTUATION_RE, "").trim())) return true;
    const plain = blankQuotes(unprefixed);
    if (HANDOFF_CUE_RE.test(plain) || ANYWHERE_CUE_RE.test(plain)) return true;
  }
  return false;
}

/** Concatenated text of an assistant `message_end` frame's message, or null
 * for any other frame. Blocks join with a newline (as omp's own todo-tracker
 * does) so a `?` ending one block cannot merge into the next block's line. */
export function assistantReplyText(frame: { type: string; [key: string]: unknown }): string | null {
  const message = frame.message;
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return null;
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") continue;
    if ("text" in block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}
