import type { PlanKeeperClaim, PlanKeeperDigestEntry, PlanKeeperOpenTask } from "./prompts";

/**
 * The server-side guard between what the cheap model reports and what the
 * plan keeper applies. Pure functions over the activity log, so each rule can
 * be tested without a model or an engine:
 *
 *  - which open task a reported check-off means (its id, or its text even
 *    when the model paraphrased it);
 *  - whether the words the model quoted as proof really are in the log;
 *  - for a task that names its own acceptance bar (verify, test, gate,
 *    publish, release, deploy), whether that log entry shows the check
 *    passing or the push happening.
 *
 * The safe failure mode throughout is under-completing: a check-off that
 * cannot be proven is dropped and caught again on a later pass.
 */

const STOP_WORDS: Record<string, true> = {
  a: true, an: true, and: true, as: true, at: true, by: true, for: true, from: true, in: true, into: true,
  is: true, it: true, of: true, on: true, or: true, that: true, the: true, this: true, to: true, with: true,
};

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Word set for comparing two phrasings of the same thing: no filler words,
 * and a plural counts as its singular. */
function keyWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of words(text)) {
    if (STOP_WORDS[word]) continue;
    out.add(word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
  }
  return out;
}

/** The same word in another form: "write"/"writing", "verify"/"verified",
 * "handler"/"handlers". Equal, or alike for at least four letters and up to
 * the last letter of the shorter one — a model rewording a task changes the
 * endings of its words far more often than the words. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  let alike = 0;
  while (alike < shorter && a[alike] === b[alike]) alike += 1;
  return alike >= 4 && alike >= shorter - 1;
}

/** Dice similarity of two phrasings, 0 to 1. */
function similarity(left: string, right: string): number {
  const a = keyWords(left);
  const b = [...keyWords(right)];
  if (a.size === 0 || b.length === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.some((other) => sameWord(word, other))) shared += 1;
  return (2 * shared) / (a.size + b.length);
}

/** A paraphrase has to be this close to a task, and this much closer to it
 * than to any other open task, before it counts as naming that task. */
const PARAPHRASE_MIN = 0.6;
const PARAPHRASE_MARGIN = 0.15;

/**
 * The open task a reported check-off means. Its id when the model used one;
 * otherwise its text — exactly, or as the single clearly closest open task
 * when the model reworded it. A reference that fits two tasks about equally
 * well names neither.
 */
export function resolveClaimedTask(ref: string, open: readonly PlanKeeperOpenTask[]): PlanKeeperOpenTask | null {
  // "T3", "T3: …" or a bare "3" — never a task text that merely starts with a number.
  const id = ref.trim().match(/^#?t(\d+)\b/i) ?? ref.trim().match(/^#?(\d+)$/);
  if (id) return open.find((item) => item.id.toLowerCase() === `t${id[1]}`) ?? null;

  const flat = words(ref).join(" ");
  const exact = open.filter((item) => words(item.task.content).join(" ") === flat);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null;

  let best: PlanKeeperOpenTask | null = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const item of open) {
    const score = similarity(ref, item.task.content);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = item;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  return best && bestScore >= PARAPHRASE_MIN && bestScore - runnerUp >= PARAPHRASE_MARGIN ? best : null;
}

/** A quote looked for across the log has to be at least this many words, and
 * this share of them has to be in the entry when it is not there word for
 * word. */
const QUOTE_MIN_WORDS = 2;
const QUOTE_MIN_SHARE = 0.8;

/**
 * The log entry that really contains the words the model quoted as proof, or
 * null when no entry does. The entry the model cited is tried first; a quote
 * found only in another entry still counts, against that entry (a cheap model
 * miscounts more often than it invents). No quote, no check-off.
 *
 * A single word is a quote only as a whole word of the very entry the model
 * cited: some proof is one word long (`wc -l` prints "3"), and there the
 * entry's number and its words agree. It is never looked for anywhere else —
 * almost every entry holds an "ok".
 */
export function findEvidence(claim: PlanKeeperClaim, digest: readonly PlanKeeperDigestEntry[]): PlanKeeperDigestEntry | null {
  const quoted = words(claim.quote);
  if (quoted.length === 0) return null;
  const flatQuote = quoted.join(" ");
  const cited = digest.find((entry) => entry.seq === claim.entry);
  if (cited && ` ${words(cited.text).join(" ")} `.includes(` ${flatQuote} `)) return cited;
  if (quoted.length < QUOTE_MIN_WORDS) return null;
  const contains = (entry: PlanKeeperDigestEntry): boolean => {
    const entryWords = words(entry.text);
    if (entryWords.join(" ").includes(flatQuote)) return true;
    const have = new Set(entryWords);
    return quoted.filter((word) => have.has(word)).length / quoted.length >= QUOTE_MIN_SHARE;
  };
  if (cited && contains(cited)) return cited;
  for (let index = digest.length - 1; index >= 0; index -= 1) {
    if (digest[index] !== cited && contains(digest[index])) return digest[index];
  }
  return null;
}

/** Whole words only: "investigate", "latest", "gateway" and "delegated" are
 * not acceptance bars, though each contains one. */
const GATED_RE = /\b(?:verif(?:y|ies|ied|ying|ication)|(?:re-?)?test(?:s|ed|ing)?|gat(?:e|es|ed|ing)|publish(?:es|ed|ing)?|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment|ments)?)\b/i;

/** A task naming its own acceptance bar needs an entry that shows the bar
 * being met — see passesGate. */
export function isGatedTask(content: string): boolean {
  return GATED_RE.test(content);
}

/** Stripped out before the failure check runs: "0 failed", "0 errors", "no
 * failures" are PASSING phrasing that happens to contain the word "failed"
 * or "error" — the single most common false positive a naive scan hits. Uses
 * `.replace()` only (never `.test()`/`.exec()` on this object), so the
 * global flag's lastIndex statefulness never leaks between calls. */
const ZERO_COUNT_RE = /\b(?:0|no|zero)\s+(?:failed|failing|failures?|errors?)\b/gi;
const FAIL_RE = /\b(?:fail(?:s|ed|ing|ure|ures)?|errors?|broken|exception|traceback|timed out|not ok)\b/i;
const PASS_RE = /\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|success(?:ful|fully)?|green|verified|confirmed|works)\b|\b(?:0|no|zero)\s+(?:failed|failing|failures?|errors?)\b|[✓✔]/i;
/** A push or release actually happening: the words an agent reports it with,
 * and what `git push` itself prints (it never says "pushed"). */
const PUSH_RE = /\b(?:pushed|published|released|deployed|shipped|tagged|merged|uploaded|installed)\b|\[new (?:tag|branch)\]|\b[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s+\S+\s+->\s+\S+|\beverything up-to-date\b/i;

/** Judged on what a tool RETURNED, never on what it was asked to do ("run the
 * failing tests" is not a failure); a message is judged on its own words. */
function showsFailure(entry: PlanKeeperDigestEntry): boolean {
  return entry.failed === true || FAIL_RE.test((entry.result ?? entry.text).replace(ZERO_COUNT_RE, ""));
}

/** Two tool calls are the same check when the same tool was asked about this
 * much the same thing. */
const SAME_CHECK_MIN = 0.5;

/**
 * Whether `evidence` proves a gated task: the entry itself has to show a pass
 * (verify/test/gate) or a push (publish/release/deploy) and no failure, and
 * the same check must not have failed again afterwards — a suite that passed,
 * then failed on a later run, is not passing. A failure elsewhere in the log
 * (another command, an old run) says nothing about this entry and is ignored.
 */
export function passesGate(evidence: PlanKeeperDigestEntry, digest: readonly PlanKeeperDigestEntry[]): boolean {
  if (showsFailure(evidence)) return false;
  const result = evidence.result ?? evidence.text;
  if (!PASS_RE.test(result) && !PUSH_RE.test(result)) return false;
  if (evidence.kind !== "tool") return true;
  return !digest.some((later) =>
    later.seq > evidence.seq
    && later.kind === "tool"
    && later.tool === evidence.tool
    && showsFailure(later)
    && similarity(later.request ?? "", evidence.request ?? "") >= SAME_CHECK_MIN);
}
