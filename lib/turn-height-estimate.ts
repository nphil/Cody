/**
 * Cheap, content-aware height estimate for a `.chat-turn` wrapper
 * (components/ChatWindow.tsx), used as that turn's inline
 * `contain-intrinsic-size` so a turn that has never painted
 * (`content-visibility: auto` skips it until scrolled near — see
 * app/globals.css `.chat-turn`) reports a placeholder close to its real
 * height instead of the stylesheet's flat 320px/96px default.
 *
 * Without this, the scroll minimap (components/ChatMinimap.tsx) measures
 * unvisited turns via `getBoundingClientRect()` and gets the same flat
 * placeholder back for a one-line reply and a multi-thousand-line diff — the
 * minimap draws unvisited history as uniform blocks, and the turn visibly
 * reflows (dragging the minimap and native scroll anchoring along with it)
 * the moment it first scrolls into view and paints for real.
 *
 * Deliberately rough: this only has to land the placeholder in the right
 * neighborhood before first paint, not match the eventual layout exactly.
 */

export interface TurnContentSignal {
  /** All human-legible text in the turn, concatenated in reading order
   *  (markdown source, pre-render) — used for both the line-count estimate
   *  and to count fenced code blocks. */
  text?: string;
  /** Tool-call blocks in the turn; each renders its own collapsed header row
   *  by default (components/MessageView.tsx ToolCallBlock). */
  toolCallCount?: number;
  /** Image blocks in the turn; each renders a thumbnail. */
  imageCount?: number;
}

const BASE_HEIGHT_PX = 48; // padding / avatar / timestamp chrome every turn pays
const CHARS_PER_LINE = 80; // rough prose wrap width at the chat column's measure
const LINE_HEIGHT_PX = 24; // ~14px body text at 1.7 line-height (globals.css .markdown-body)
const CODE_FENCE_CHROME_PX = 32; // header/border/padding a fenced block adds beyond its own lines
const TOOL_CALL_ROW_PX = 34; // collapsed tool-call header row (padding 6px 10px + border)
const IMAGE_ROW_PX = 160; // thumbnail row

/** Placeholder floor/ceiling: a turn is never assumed shorter than a single
 *  compact line, nor worth reserving more than a very long screenful for. */
export const MIN_TURN_HEIGHT_PX = 64;
export const MAX_TURN_HEIGHT_PX = 4000;

function countCodeFences(text: string): number {
  const markers = text.match(/^```/gm);
  // Fences come in open/close pairs; an unterminated trailing fence (still
  // streaming) still costs a header and border, so round up rather than down.
  return markers ? Math.ceil(markers.length / 2) : 0;
}

/**
 * Estimates a turn's rendered height in pixels from a cheap content signal.
 * Monotonically non-decreasing in every field, and clamped to
 * [MIN_TURN_HEIGHT_PX, MAX_TURN_HEIGHT_PX].
 */
export function estimateTurnHeight(signal: TurnContentSignal): number {
  const text = signal.text ?? "";
  const toolCallCount = Math.max(0, signal.toolCallCount ?? 0);
  const imageCount = Math.max(0, signal.imageCount ?? 0);

  // Long lines wrap (prose); many short lines don't (diffs, code, terminal
  // output) — take whichever predicts more rendered lines, so a 3000-line
  // diff of short lines isn't undercounted just because its char/80 quotient
  // is small.
  const wrappedLines = Math.ceil(text.length / CHARS_PER_LINE);
  const explicitLines = text.length > 0 ? text.split("\n").length : 0;
  const lines = Math.max(wrappedLines, explicitLines);

  const raw =
    BASE_HEIGHT_PX +
    lines * LINE_HEIGHT_PX +
    countCodeFences(text) * CODE_FENCE_CHROME_PX +
    toolCallCount * TOOL_CALL_ROW_PX +
    imageCount * IMAGE_ROW_PX;

  return Math.min(MAX_TURN_HEIGHT_PX, Math.max(MIN_TURN_HEIGHT_PX, Math.round(raw)));
}
