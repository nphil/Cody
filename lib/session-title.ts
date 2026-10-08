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

/** omp 18.8's card form, `<icon> <CODE>: <title>` (omp `utils/title-card.ts`). */
const CARD_TITLE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;

/** omp reads a card icon as 1-8 characters, none of them ASCII. */
function isCardIcon(icon: string): boolean {
  const characters = Array.from(icon);
  return characters.length > 0 && characters.length <= 8 && characters.every((char) => char.charCodeAt(0) >= 0x80);
}

/**
 * The title a person should see. omp 18.8+ writes generated titles as a card,
 * `<icon> <CODE>: <title>`, and by default the icon is a Nerd Font glyph — a
 * private-use character a browser draws as an empty box. The card is terminal
 * chrome, so Cody shows only the title part; a plain title passes through.
 */
export function displaySessionTitle(value: string | undefined): string | undefined {
  const sanitized = sanitizeSessionTitle(value);
  if (!sanitized) return undefined;
  const card = CARD_TITLE.exec(sanitized);
  if (!card || !isCardIcon(card[1]!)) return sanitized;
  return card[3]!.trim() || sanitized;
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
