// Pure rules for the composer's inline word completion (omp 18.4 `predict_word`).
// The engine owns the prediction; everything here is the browser's side of the
// contract: when to ask, whether an answer still applies, and what accepting
// one does to the text. Kept free of React so each rule is testable on its own.

/** Pause after the last keystroke before asking the engine. */
export const WORD_COMPLETION_DELAY_MS = 150;

/** What the engine suggested for the word ending at `cursor` in `text`. Text
 * and cursor are the composer state AT REQUEST TIME — the engine's feedback
 * command wants exactly these back, and they are how a late answer is
 * recognized as stale. */
export interface WordSuggestion {
  text: string;
  /** UTF-16 offset, the unit the engine and `selectionStart` share. */
  cursor: number;
  suffix: string;
}

/** The engine only completes a prose word at the end of a line (it answers
 * `null` anywhere else), so asking from mid-line is a wasted round trip. A
 * blank composer and a lone leading `/` or `!` (slash command, bash) are
 * not prose either. */
export function shouldRequestWordSuggestion(text: string, cursor: number): boolean {
  if (!Number.isInteger(cursor) || cursor <= 0 || cursor > text.length) return false;
  if (cursor < text.length && text[cursor] !== "\n") return false;
  const firstChar = text.trimStart()[0];
  if (firstChar === undefined || firstChar === "/" || firstChar === "!") return false;
  // Right after whitespace there is no word to finish.
  return !/\s/.test(text[cursor - 1] ?? " ");
}

/** The engine's `data` for predict_word → a usable suffix, or null. */
export function readSuffix(data: unknown): string | null {
  const suffix = (data as { suffix?: unknown } | null | undefined)?.suffix;
  // A newline in a "word" suffix would break the one-line ghost overlay.
  return typeof suffix === "string" && suffix.length > 0 && !suffix.includes("\n") ? suffix : null;
}

/** An answer applies only while the composer is exactly as it was asked about:
 * same text, caret collapsed at the same offset. Anything else — a keystroke,
 * a click, a selection — means the user moved on. */
export function isSuggestionCurrent(
  suggestion: WordSuggestion,
  text: string,
  selectionStart: number,
  selectionEnd: number,
): boolean {
  return suggestion.text === text && selectionStart === suggestion.cursor && selectionEnd === suggestion.cursor;
}

/** The composer text after accepting: Tab adds a trailing space, Right-arrow
 * does not. The caret lands after whatever was inserted. */
export function acceptSuggestion(suggestion: WordSuggestion, withSpace: boolean): { value: string; cursor: number; inserted: string } {
  const inserted = withSpace ? `${suggestion.suffix} ` : suggestion.suffix;
  const { text, cursor } = suggestion;
  return { value: text.slice(0, cursor) + inserted + text.slice(cursor), cursor: cursor + inserted.length, inserted };
}
