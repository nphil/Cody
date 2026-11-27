/**
 * A least-recently-used cache bounded by what its entries WEIGH, not just how
 * many there are, with an optional entry cap per group of entries.
 *
 * The server keeps parsed session files in memory so a chat switch or a poll
 * does not re-read tens of megabytes. One parsed transcript can weigh
 * hundreds of megabytes, so "8 or 32 entries" says nothing about memory: a
 * handful of long chats could pin gigabytes. Here one budget is shared by every
 * chat and every group, and the least recently used entry goes first.
 *
 * An entry heavier than the whole budget is never kept (and does not evict
 * anyone else): the caller parses it again next time, which is the price of a
 * transcript that big.
 */
interface Slot<V> {
  value: V;
  weight: number;
  group: string;
}

export class WeightedLru<V> {
  private readonly slots = new Map<string, Slot<V>>();
  private readonly groupCounts = new Map<string, number>();
  private total = 0;

  readonly budget: number;
  private readonly groupCaps: Readonly<Record<string, number>>;

  constructor(budget: number, groupCaps: Readonly<Record<string, number>> = {}) {
    this.budget = budget;
    this.groupCaps = groupCaps;
  }

  /** Total weight of everything kept. */
  get weight(): number {
    return this.total;
  }

  get size(): number {
    return this.slots.size;
  }

  /** The entry for `key`, marked most recently used. */
  get(key: string): V | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  delete(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    this.total -= slot.weight;
    this.groupCounts.set(slot.group, (this.groupCounts.get(slot.group) ?? 1) - 1);
  }

  /** Keep `value` as the most recently used entry; false when it is heavier than the whole budget and so was not kept. Any older entry under `key` is dropped either way. */
  set(key: string, group: string, value: V, weight: number): boolean {
    this.delete(key);
    if (!(weight <= this.budget)) return false;
    this.slots.set(key, { value, weight, group });
    this.total += weight;
    this.groupCounts.set(group, (this.groupCounts.get(group) ?? 0) + 1);
    const cap = this.groupCaps[group] ?? Infinity;
    while ((this.groupCounts.get(group) ?? 0) > cap && this.evictOldest(key, group));
    while (this.total > this.budget && this.evictOldest(key));
    return true;
  }

  /** Drop the least recently used entry (of `group`, when given) other than `keep`. */
  private evictOldest(keep: string, group?: string): boolean {
    for (const [key, slot] of this.slots) {
      if (key === keep || (group !== undefined && slot.group !== group)) continue;
      this.delete(key);
      return true;
    }
    return false;
  }

  clear(): void {
    this.slots.clear();
    this.groupCounts.clear();
    this.total = 0;
  }
}
