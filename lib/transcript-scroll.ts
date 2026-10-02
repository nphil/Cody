// Scroll rules for a transcript that is read, followed and grown at both ends:
// a pure decision (does this scroll event pin or unpin the reader?) and the
// DOM helpers that hold the reader's place by ROW IDENTITY across a prepend, a
// trim or a row expanding above the viewport.
//
// Why identity and not a distance from the end: an earlier page is prepended
// above the reader, so the only thing that stays true is "this row sits this
// far below the top edge". The anchor names the row by its stable key
// (`data-row-key`), never by DOM node or index, so React keeping, moving or
// remounting rows changes nothing.

/** Within this many px of the bottom a reader counts as "at the bottom" and
 *  follows new rows again. */
export const REPIN_DISTANCE_PX = 40;

/** Within this many px of an edge the next page loads on its own, so it is
 *  there before the reader arrives. */
export const EDGE_LOAD_DISTANCE_PX = 240;

/** A wheel tick, key press or touch counts as the reader's own scrolling for
 *  this long: scroll events inside the window were theirs, whatever the
 *  distance says. */
export const USER_INTENT_WINDOW_MS = 250;

export interface ScrollGeometry {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function distanceFromBottom(el: ScrollGeometry): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * Whether the viewport stays pinned to the bottom after a scroll event.
 *
 * - Our own write (`top` equals the position we just set) decides nothing —
 *   told apart by VALUE, so there is no time window during which the reader's
 *   scrolling is ignored.
 * - A move UP unpins at once when the reader drove it (wheel/touch/key/
 *   scrollbar), however small; an undriven move up (the browser clamping the
 *   scroll position because content below shrank) only unpins when it ended
 *   far from the bottom, so a collapsing tool card cannot drop a follower.
 * - A move down (or none) pins again once the reader is back near the bottom.
 */
export function pinnedAfterScroll(input: {
  pinned: boolean;
  top: number;
  prevTop: number;
  expectedTop: number | null;
  distance: number;
  driven: boolean;
}): boolean {
  const { pinned, top, prevTop, expectedTop, distance, driven } = input;
  if (expectedTop !== null && Math.abs(top - expectedTop) < 1) return pinned;
  const movedUp = top < prevTop - 0.5;
  if (movedUp) return driven || distance > REPIN_DISTANCE_PX ? false : pinned;
  return distance <= REPIN_DISTANCE_PX ? true : pinned;
}

export interface RowAnchor {
  key: string;
  /** Top of the row relative to the scroller's top edge; negative when the edge is inside it. */
  offset: number;
}

/** The row at the scroller's top edge: the first whose bottom is below it.
 *  Rows are in document order, so a binary search reads O(log n) rects. */
export function captureRowAnchor(scroller: HTMLElement, rowsEl: HTMLElement): RowAnchor | null {
  const rows = rowsEl.children;
  if (rows.length === 0) return null;
  const edge = scroller.getBoundingClientRect().top;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].getBoundingClientRect().bottom <= edge) low = mid + 1;
    else high = mid;
  }
  const row = rows[low] as HTMLElement;
  const key = row.dataset.rowKey;
  return key === undefined ? null : { key, offset: row.getBoundingClientRect().top - edge };
}

/** Put the anchored row back at its offset. Returns the scroll applied (0 when
 *  nothing needed to move or the row is gone). */
export function restoreRowAnchor(scroller: HTMLElement, rowsEl: HTMLElement, anchor: RowAnchor): number {
  let row: HTMLElement | null = null;
  for (const child of rowsEl.children) {
    if ((child as HTMLElement).dataset.rowKey === anchor.key) {
      row = child as HTMLElement;
      break;
    }
  }
  if (row === null) return 0;
  const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) <= 0.5) return 0;
  const before = scroller.scrollTop;
  scroller.scrollTop = before + delta;
  return scroller.scrollTop - before;
}
