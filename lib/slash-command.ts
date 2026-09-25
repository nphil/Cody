/**
 * Detect a slash command token immediately before the textarea caret.
 * A command may start the prompt or follow whitespace; punctuation inside a
 * URL or path must not open the command palette.
 */
export interface SlashQueryMatch {
  /** Index of the "/" character in the complete prompt. */
  start: number;
  /** Caret position used to delimit the in-progress token. */
  end: number;
  /** Lower-cased text typed after the slash. */
  query: string;
}

export function extractSlashQuery(text: string, cursor = text.length): SlashQueryMatch | null {
  const position = Number.isFinite(cursor)
    ? Math.max(0, Math.min(text.length, cursor))
    : text.length;
  const textBeforeCursor = text.slice(0, position);
  const match = /(?:^|\s)\/([^\s]*)$/u.exec(textBeforeCursor);
  if (!match) return null;

  return {
    start: position - match[1].length - 1,
    end: position,
    query: match[1].toLowerCase(),
  };
}
