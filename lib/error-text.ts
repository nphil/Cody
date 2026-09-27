/**
 * Turns a raw provider/engine error string into something a person can read
 * in one glance, and tells the caller WHAT KIND of failure it was.
 *
 * omp has no "refusal" stopReason: a model declining on safety grounds comes
 * back exactly like any other failure, an assistant message (or a retry
 * event) carrying `stopReason: "error"` and a plain-text `errorMessage`. The
 * text is the only signal, so this module is the one place that reads it and
 * decides "the model said no" versus "the account is out of quota" versus
 * "the transport broke" versus "the engine build is too old for this model".
 * Getting that distinction right is the whole point: a refusal needs a manual
 * re-pick and no amount of waiting fixes it, while a usage limit resolves
 * itself at the reset, and neither is fixed by staring at a wall of raw JSON,
 * request ids and "learn more" URLs.
 *
 * Pure and framework-free on purpose: no React, no DOM. `hooks/useAgentSession.ts`
 * calls it at every point an engine/provider error string reaches a notice or
 * the retry banner, and `hooks/session-control-scope.ts`'s
 * `classifyFallbackReason` now delegates its refusal/usage split to this.
 */

export type ErrorKind =
  | "refusal"
  | "usage"
  | "credits"
  | "auth"
  | "overloaded"
  | "transport"
  | "outdated"
  | "aborted"
  | "other";

export interface DescribedError {
  kind: ErrorKind;
  provider?: string;
  detail: string;
}

const MAX_DETAIL_LENGTH = 180;

// Checked in this order because one string can carry more than one signal
// (a refusal wrapped in transport context, a 429 body that also names a
// provider). The first match wins, and refusal is checked first: a refusal
// message that also mentions "policy" or a rate limit must never read as a
// mere quota problem, which sends the user to inspect a healthy quota instead
// of accepting the decline.
const ABORTED_PATTERNS = [
  /\binterrupted by user\b/i,
  /\brequest was aborted\b/i,
  /\baborted by (the )?user\b/i,
];

const REFUSAL_PATTERNS = [
  /^refusal\s*\(/i,
  /reasoning_extraction/i,
  /\bblocked\b[^.]*\b(polic|terms of service|safety)/i,
  /terms of service/i,
  /content polic/i,
  /flagged for possible cybersecurity risk/i,
  /trusted access for cyber/i,
  /\bcontent[_ -]?filter\b/i,
  /\bcontent[-_ ]?blocked\b/i,
  /\bsensitive\b/i,
];

const OUTDATED_PATTERNS = [
  /claude_code_version_too_old/i,
  /does not support this model/i,
  /version \S+ or newer is required/i,
];

const CREDITS_PATTERNS = [
  /requires more credits/i,
  /can only afford/i,
  /add more credits to/i,
];

const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bapi[ _-]?key\b/i,
  /\bcredential/i,
  /\bauthenticat/i,
  /invalid[ _-]?(x-)?api/i,
  /no (provider|api) key/i,
];

const OVERLOADED_PATTERNS = [/\boverloaded\b/i];

const USAGE_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /\bquota\b/i,
  /\b429\b/,
  /too many requests/i,
  /out of credits/i,
];

const TRANSPORT_PATTERNS = [
  /econnreset/i,
  /econnrefused/i,
  /\betimedout\b/i,
  /\bsocket\b/i,
  /\bnetwork error\b/i,
  /fetch failed/i,
  /stream (ended|closed|disconnected) unexpectedly/i,
  /stream disconnected/i,
  /connection reset by peer/i,
];

const PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/\bcodex\b/i, "Codex"],
  [/\bclaude code\b/i, "Claude Code"],
  [/\banthropic\b/i, "Anthropic"],
  [/\bopenrouter\b/i, "OpenRouter"],
  [/\bopenai\b/i, "OpenAI"],
  [/\bgemini\b/i, "Gemini"],
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Classify the raw text. Runs on the UNTOUCHED string, so a status code, a
 * JSON `error_code` field or a prefix like "Refusal (...)" still counts even
 * though `cleanDetail` strips all of it from what gets shown. */
function classify(raw: string): ErrorKind {
  if (matchesAny(ABORTED_PATTERNS, raw)) return "aborted";
  if (matchesAny(REFUSAL_PATTERNS, raw)) return "refusal";
  if (matchesAny(OUTDATED_PATTERNS, raw)) return "outdated";
  if (matchesAny(CREDITS_PATTERNS, raw)) return "credits";
  if (matchesAny(AUTH_PATTERNS, raw)) return "auth";
  if (matchesAny(OVERLOADED_PATTERNS, raw)) return "overloaded";
  if (matchesAny(USAGE_PATTERNS, raw)) return "usage";
  if (matchesAny(TRANSPORT_PATTERNS, raw)) return "transport";
  return "other";
}

function inferProvider(raw: string): string | undefined {
  for (const [pattern, name] of PROVIDER_PATTERNS) {
    if (pattern.test(raw)) return name;
  }
  return undefined;
}

/** Find a `{...}` JSON object anywhere in `text` (brace-matched, so it copes
 * with nested objects) and pull the most useful message out of it — the
 * shapes seen in practice are `{message}`, `{error:{message}}` and
 * `{error:{error:{message}}}`. Returns null when there is no JSON, or none of
 * those shapes are present. */
function extractJsonMessage(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const walk = (value: unknown, depthLeft: number): string | null => {
    if (!value || typeof value !== "object" || depthLeft < 0) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (record.error !== undefined) {
      const nested = walk(record.error, depthLeft - 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(parsed, 3);
}

/** Drop a whole sentence if it contains a URL, rather than leaving a dangling
 * "To learn more, visit" with nothing after it. Sentences are split on a
 * trailing `.`/`!`/`?` followed by whitespace; a final sentence with no
 * terminator is still its own segment. */
function dropUrlSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((segment) => !/https?:\/\//i.test(segment))
    .join(" ")
    .trim();
}

function stripLine(text: string, pattern: RegExp): string {
  return text
    .split("\n")
    .filter((line) => !pattern.test(line))
    .join("\n");
}

const PREFIX_PATTERNS = [
  /^\s*\d{3}\s+/, // "400 ", "402 " status-code prefixes
  /^codex error event:\s*/i,
  /^refusal\s*\([^)]*\):\s*/i,
  /^anthropic stream error\s*\([^)]*\):\s*/i,
];

function stripKnownPrefixes(text: string): string {
  let result = text;
  // A status code can be followed by one of the named prefixes (it never is
  // in the examples this was built from, but the loop costs nothing and
  // guards against a provider that combines them).
  for (let i = 0; i < PREFIX_PATTERNS.length; i++) {
    const next = result.replace(PREFIX_PATTERNS[i], "");
    if (next !== result) {
      result = next;
      i = -1; // re-scan from the top; a stripped prefix can expose another
    }
  }
  return result;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s.,;:]+$/, "")}…`;
}

const GENERIC_FALLBACKS: Record<ErrorKind, string> = {
  refusal: "The model declined this request.",
  usage: "A usage limit was reached.",
  credits: "The account ran out of credits.",
  auth: "The request was not authenticated.",
  overloaded: "The provider is overloaded right now.",
  transport: "The connection to the provider failed.",
  outdated: "The engine needs to be updated.",
  aborted: "The request was interrupted.",
  other: "Something went wrong.",
};

/** Clean a raw error string into one readable sentence: no JSON braces, no
 * request ids, no raw-http-request log paths, no stack frames, no trailing
 * "learn more" URLs, capped at roughly {@link MAX_DETAIL_LENGTH} characters
 * on a word boundary. Never returns an empty string. */
function cleanDetail(raw: string, kind: ErrorKind): string {
  let text = raw;
  text = stripLine(text, /^\s*raw-http-request=/i);

  const jsonMessage = extractJsonMessage(text);
  text = jsonMessage ?? text;

  text = stripKnownPrefixes(text.trim());

  // Stack frames ("at Object.<anonymous> (/path:10:5)", "at /path:10:5").
  text = text.replace(/\n?\s*at\s+[^\n]*\(?\S+:\d+:\d+\)?/g, " ");

  text = dropUrlSentences(text);
  text = text.replace(/https?:\/\/\S+/gi, "");

  // Any request/log id that survived (the JSON path above already drops the
  // `request_id` field entirely, since only the inner `message` is kept).
  text = text.replace(/\brequest[_-]?id["']?\s*[:=]\s*["']?[\w-]+["']?/gi, "");
  text = text.replace(/\breq_[\w-]+\b/gi, "");

  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[.,;:\s]+|[.,;:\s]+$/g, (match) => (match.includes(".") ? "." : ""));
  text = text.trim();

  if (!text) return GENERIC_FALLBACKS[kind];
  return truncate(text, MAX_DETAIL_LENGTH);
}

/** Describe a raw engine/provider error string: what kind of failure it is,
 * which provider said so (when the text names one), and a short, clean
 * sentence fit to show a person. Never throws, never returns an empty
 * `detail`. */
export function describeEngineError(raw: string): DescribedError {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const kind = classify(text);
  const provider = inferProvider(text);
  const detail = cleanDetail(text, kind);
  return { kind, provider, detail };
}

/** A stable key for deduplicating notices: same kind, same cleaned detail
 * with digits collapsed (so "attempt 2 of 5" style counters don't defeat the
 * match) and case-insensitive. */
export function errorDedupeKey(raw: string): string {
  const { kind, detail } = describeEngineError(raw);
  const normalized = detail
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^\w#]+/g, " ")
    .trim();
  return `${kind}:${normalized}`;
}

/** Whether two raw error strings should be treated as "the same error" for
 * dedup/storm-control purposes. */
export function sameError(a: string, b: string): boolean {
  return errorDedupeKey(a) === errorDedupeKey(b);
}
