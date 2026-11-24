/**
 * "New in this update" first: the ordering rules of the All-settings list,
 * kept pure so they are tested without a browser.
 *
 * There is no second ledger. The list asks the same question the "New" chip
 * asks (`isBadgedRow` in ../new-badges.ts) ONCE per open and keeps the answer
 * (`newFirstSnapshot`). A setting then leaves the group by the chip's own
 * rule, at the next open: seen in three opens, or changed. A change made
 * inside this open hides the chip at once but does not move the row, so a
 * setting never jumps from under the cursor while it is being edited.
 *
 * The snapshot rows are MOVED out of their sections (`liftNewFirst`), never
 * shown twice: a setting keeps one set of ids (search highlight, label links).
 */
import type { BadgeRow } from "../new-badges";

/** The slice of a schema row the grouping reads (`SchemaRow` has all of it). */
export interface NewFirstRow extends BadgeRow {
  modified: boolean;
}

export interface NewFirstGroup<R extends NewFirstRow = NewFirstRow> {
  id: string;
  label: string;
  rows: R[];
  changed: number;
}

export interface NewFirstTab<R extends NewFirstRow = NewFirstRow> {
  id: string;
  label: string;
  rows: R[];
  groups: NewFirstGroup<R>[];
  ungrouped: NewFirstGroup<R>[];
  changed: number;
}

/** A snapshot row and the section it belongs to (`Tab › Group`, or just the group of a single-tab engine). */
export interface NewFirstEntry<R extends NewFirstRow = NewFirstRow> {
  row: R;
  section: string;
}

/** The keys that are badged right now, in the order of `rows` (the engine's own). */
export function newFirstSnapshot(rows: readonly BadgeRow[], isBadged: (row: BadgeRow) => boolean): string[] {
  const keys: string[] = [];
  for (const row of rows) if (isBadged(row)) keys.push(row.key);
  return keys;
}

/** Where a row lives: `Tab › Group`; the tab is left out when the engine has one tab. */
function sectionLabel(tab: { label: string }, group: { label: string }, singleTab: boolean): string {
  return singleTab ? group.label : `${tab.label} › ${group.label}`;
}

/**
 * The group's rows in `snapshot` order, each with its section. A key the
 * schema no longer has, or whose row has no control on screen right now
 * (`visible` false), is left out.
 */
export function newFirstEntries<R extends NewFirstRow>(tabs: readonly NewFirstTab<R>[], snapshot: readonly string[]): NewFirstEntry<R>[] {
  if (snapshot.length === 0) return [];
  const where = new Map<string, NewFirstEntry<R>>();
  const singleTab = tabs.length === 1;
  for (const tab of tabs) {
    for (const group of [...tab.groups, ...tab.ungrouped]) {
      for (const row of group.rows) {
        if (!where.has(row.key)) where.set(row.key, { row, section: sectionLabel(tab, group, singleTab) });
      }
    }
  }
  const entries: NewFirstEntry<R>[] = [];
  for (const key of snapshot) {
    const entry = where.get(key);
    if (entry && entry.row.visible !== false) entries.push(entry);
  }
  return entries;
}

function liftGroup<R extends NewFirstRow>(group: NewFirstGroup<R>, lifted: ReadonlySet<string>): NewFirstGroup<R> | null {
  if (!group.rows.some((row) => lifted.has(row.key))) return group;
  const rows = group.rows.filter((row) => !lifted.has(row.key));
  if (rows.length === 0) return null;
  return { ...group, rows, changed: rows.filter((row) => row.modified).length };
}

/**
 * The tabs without the snapshot rows, for the list below the group. Tabs,
 * groups and rows keep their order; a group left empty goes; counts follow.
 * With nothing to lift the same tabs come back.
 */
export function liftNewFirst<R extends NewFirstRow>(tabs: readonly NewFirstTab<R>[], snapshot: readonly string[]): NewFirstTab<R>[] {
  if (snapshot.length === 0) return [...tabs];
  const lifted = new Set(snapshot);
  return tabs.map((tab) => {
    if (!tab.rows.some((row) => lifted.has(row.key))) return tab;
    const groups = tab.groups.map((group) => liftGroup(group, lifted)).filter((group): group is NewFirstGroup<R> => group !== null);
    const ungrouped = tab.ungrouped.map((group) => liftGroup(group, lifted)).filter((group): group is NewFirstGroup<R> => group !== null);
    const rows = tab.rows.filter((row) => !lifted.has(row.key));
    return { ...tab, rows, groups, ungrouped, changed: rows.filter((row) => row.modified).length };
  });
}

/**
 * The snapshot of one open. Not ready (the schema or the server's answer is
 * still on its way, or the engine changed): none yet. Ready: taken once, then
 * kept as it is however the badges move, until the list is not ready again.
 */
export function nextNewFirstSnapshot(current: readonly string[] | null, ready: boolean, take: () => string[]): readonly string[] | null {
  if (!ready) return null;
  return current ?? take();
}
