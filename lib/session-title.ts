/**
 * Session title sanitation and the last-resort fallback title.
 *
 * The auto-name endpoint prefers the engine's own title (omp auto-generates
 * one, persisted in the fixed-width title slot) and then a short model-written
 * name from `lib/session-namer`; this truncation of the first user message is
 * what it settles for when both are unavailable.
 */

const MAX_DERIVED_TITLE_LENGTH = 60;

/** First-line, control-character-free, whitespace-collapsed view of a title. */
export function sanitizeSessionTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  const stripped = firstLine.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Derive a fallback title from a session's first user message: first line,
 * truncated to ~60 characters by code points. Returns null when the message
 * has no usable text (e.g. "(no messages)").
 */
export function deriveSessionTitleFromFirstMessage(firstMessage: string | undefined): string | null {
  if (!firstMessage || firstMessage === "(no messages)") return null;
  const sanitized = sanitizeSessionTitle(firstMessage);
  if (!sanitized || !/[\p{L}\p{N}]/u.test(sanitized)) return null;

  const characters = Array.from(sanitized);
  if (characters.length <= MAX_DERIVED_TITLE_LENGTH) return sanitized;
  return `${characters.slice(0, MAX_DERIVED_TITLE_LENGTH).join("").trimEnd()}…`;
}
