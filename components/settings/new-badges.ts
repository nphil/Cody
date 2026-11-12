"use client";

/**
 * What every Settings surface knows about the "New" badges (the chip on a
 * row or card, the dots on hubs and sub-views, the counts in the All-settings
 * list, the chip in search results), without prop threading.
 *
 * SettingsShell provides one value per open (hooks/useSettingsNewKeys.ts is
 * the state, `computeNewHomes` adds where the badged keys live). The default
 * is "nothing is new", so a panel rendered without the shell (a test, another
 * mount) shows no badge and cannot crash.
 *
 * The rules a row must pass to carry a badge are in `isBadgedRow`: terminal
 * -only settings do nothing in a browser, so they never badge and never feed
 * a dot or a count, even though the ledger still records their keys.
 */
import { createContext, useContext } from "react";
import { NO_NEW_KEYS, type SettingsNewKeysState } from "@/hooks/useSettingsNewKeys";

export interface SettingsNewBadges extends SettingsNewKeysState {
  /** Ids of the hubs that own at least one badged setting. */
  hubsWithNew: ReadonlySet<string>;
  /** `hub/sub` (see `subViewKey`) of the sub-views that do. */
  subsWithNew: ReadonlySet<string>;
}

const NO_IDS: ReadonlySet<string> = new Set();

export const NO_NEW_BADGES: SettingsNewBadges = { ...NO_NEW_KEYS, hubsWithNew: NO_IDS, subsWithNew: NO_IDS };

export const SettingsNewBadgesContext = createContext<SettingsNewBadges>(NO_NEW_BADGES);

export function useSettingsNewBadges(): SettingsNewBadges {
  return useContext(SettingsNewBadgesContext);
}

/** The accessible name of a hub or sub-view dot. */
export const NEW_SETTINGS_LABEL = "New settings";

/** The key a sub-view goes by in `subsWithNew`. */
export function subViewKey(hub: string, sub: string): string {
  return `${hub}/${sub}`;
}

/** The slice of a schema row the badge rules read (`SchemaRow` has all of it). */
export interface BadgeRow {
  key: string;
  /** False when the row's `ui.condition` does not hold: it has no control on screen. Missing means shown. */
  visible?: boolean;
  terminalOnly?: boolean;
}

/** A row carries the "New" chip, and feeds dots and counts, when its key is
 * new, it has a control on screen and the engine can use it in a browser. */
export function isBadgedRow(row: BadgeRow, isNew: (key: string) => boolean): boolean {
  return row.visible !== false && !row.terminalOnly && isNew(row.key);
}

/** How many of `rows` are badged. */
export function countBadged(rows: readonly BadgeRow[], isNew: (key: string) => boolean): number {
  let count = 0;
  for (const row of rows) if (isBadgedRow(row, isNew)) count += 1;
  return count;
}

/** The compact count shown in tab buttons, group headers and directory rows. */
export function newCountLabel(count: number): string {
  return `${count} new`;
}

/** Where a setting's row or card lives: a hub and, for the hubs that have
 * them, a sub-view. `settingHome` in search-index.ts resolves it. */
export interface SettingHome {
  tab: string;
  sub?: string;
}

export interface NewHomes {
  hubs: ReadonlySet<string>;
  subs: ReadonlySet<string>;
}

/** The hubs and sub-views that own at least one badged setting, for the dots. */
export function computeNewHomes(rows: readonly BadgeRow[], newKeys: ReadonlySet<string>, homeOf: (key: string) => SettingHome): NewHomes {
  const hubs = new Set<string>();
  const subs = new Set<string>();
  if (newKeys.size === 0) return { hubs, subs };
  const isNew = (key: string) => newKeys.has(key);
  for (const row of rows) {
    if (!isBadgedRow(row, isNew)) continue;
    const home = homeOf(row.key);
    hubs.add(home.tab);
    if (home.sub) subs.add(subViewKey(home.tab, home.sub));
  }
  return { hubs, subs };
}
