"use client";

/**
 * The dialog-wide search's DYNAMIC static-shaped sources: entries a hub
 * derives from a cached route rather than from a table — one `engine-<id>`
 * per roster engine (System) and one `mcp-<name>` per inventory server
 * (Extensions). Each hub exports its hook; this component is the one place
 * that calls them, renders nothing, and hands the union up to the shell.
 *
 * Loaded through `next/dynamic` by the shell so the hub modules these hooks
 * live in stay out of the shell's own chunk (the shell already loads every
 * hub module lazily for its `SEARCH_ENTRIES` tables).
 */
import { useEffect, useMemo } from "react";
import { useExtensionsSearchEntries } from "./panels/ExtensionsPanel";
import { useSystemSearchEntries } from "./panels/SystemPanel";
import type { SearchEntry } from "./search-index";
import { useSettingsShell } from "./shell-context";

export function SearchSources({ onChange }: { onChange: (entries: readonly SearchEntry[]) => void }) {
  const { cwd, capabilities } = useSettingsShell();
  const system = useSystemSearchEntries();
  const extensions = useExtensionsSearchEntries(cwd, capabilities.mcp);
  const entries = useMemo(() => [...system, ...extensions], [system, extensions]);
  useEffect(() => onChange(entries), [entries, onChange]);
  return null;
}

export default SearchSources;
