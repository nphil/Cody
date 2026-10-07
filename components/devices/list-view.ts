/**
 * How a long list of items (fifty-eight partitions, fifty-eight files) is cut down to what a person can take in. Pure,
 * so a test can pin it: the panel never renders a wall of rows unasked, and never hides one that matches what was typed.
 */

/** Past this many items the list has a filter box. */
export const FILTER_FROM = 10;

/** Rows written out before "Show all". Enough to see the shape of a list without scrolling past it. */
export const ROW_CAP = 12;

export interface Narrowed<T> {
  /** What to draw, in the order given. */
  readonly rows: readonly T[];
  /** How many items are not drawn: nothing matched them, or the cap held them back. */
  readonly hidden: number;
  /** Whether the cap, rather than the filter, is what hides them. */
  readonly capped: boolean;
}

/**
 * `items` filtered by what was typed (a case-insensitive part of the name) and, when nothing was typed and the person has
 * not asked for all of them, held to ROW_CAP. A typed filter shows every match: asking for something is asking for it.
 */
export function narrow<T>(items: readonly T[], options: { query: string; showAll: boolean; nameOf: (item: T) => string; cap?: number }): Narrowed<T> {
  const query = options.query.trim().toLowerCase();
  const cap = options.cap ?? ROW_CAP;
  if (query) {
    const rows = items.filter((item) => options.nameOf(item).toLowerCase().includes(query));
    return { rows, hidden: items.length - rows.length, capped: false };
  }
  if (options.showAll || items.length <= cap) return { rows: items, hidden: 0, capped: false };
  return { rows: items.slice(0, cap), hidden: items.length - cap, capped: true };
}
