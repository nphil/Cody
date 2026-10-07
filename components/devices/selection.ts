/**
 * Which items of a known list a person has ticked, as pure functions. The files of a backup (Files & backups) and the
 * partitions of a disk (the EDL backup card) are chosen the same way, so both use these. An id that is no longer in the
 * list never counts, and every answer comes back in the list's own order, so a test pins each rule without a browser.
 */

export type Picked = ReadonlySet<string>;

/** The same choice with this id ticked, or unticked when it was ticked. */
export function toggle(picked: Picked, id: string): Picked {
  const next = new Set(picked);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Every id of the list: the whole list, not only the part of it on screen. */
export function selectAll(ids: readonly string[]): Picked {
  return new Set(ids);
}

export function selectNone(): Picked {
  return new Set();
}

/** The ticked ids that are still in the list, in the list's order: what a file that was removed or a set that was combined leaves behind. */
export function chosenIn(ids: readonly string[], picked: Picked): string[] {
  return ids.filter((id) => picked.has(id));
}
