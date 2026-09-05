"use client";

/**
 * Settings › System: the Cody card (app update) over `EngineRoster` (every
 * engine, every engine action, the Danger zone). `SystemUpdates` owns the
 * `settings-panel-system` tabpanel root, so the registry marks this section
 * `ownsTabpanel`.
 *
 * Search: `SEARCH_ENTRIES` are the static cards this hub renders;
 * `useSystemSearchEntries` derives one `engine-<id>` row per engine from the
 * cached roster for the dialog-wide search's dynamic sources.
 */
import { useMemo } from "react";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { ENGINES_ROUTE, type EnginesPayload } from "../EngineRoster";
import type { SearchEntry } from "../search-index";
import { useSettingsShell } from "../shell-context";
import { SystemUpdates } from "../SystemUpdates";

export const SYSTEM_PANEL_ID = "system";

const TRAIL: readonly string[] = ["Cody", "System"];

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  { id: "cody-application", tab: "system", label: "Cody application", description: "This instance's version and how it updates.", keywords: ["version", "update", "docker", "image", "upgrade"], breadcrumb: TRAIL, action: "jump" },
  { id: "agent-engines", tab: "system", label: "Agent engines", description: "Install, switch, update, revert or reinstall the coding agents this server can run.", keywords: ["install", "switch", "update", "revert", "reinstall", "changelog", "engine", "active"], breadcrumb: TRAIL, action: "jump" },
  { id: "engine-danger-zone", tab: "system", label: "Restart all sessions", description: "Restart every agent session, or uninstall an engine Cody installed.", keywords: ["uninstall", "remove", "restart", "danger"], breadcrumb: [...TRAIL, "Danger zone"], action: "jump" },
];

/** One search row per engine in the cached roster (`engine-<id>`), so
 * "codex" or "hermes" finds its row under System › Agent engines. */
export function useSystemSearchEntries(): SearchEntry[] {
  const roster = useSettingsRoute<EnginesPayload>(ENGINES_ROUTE);
  return useMemo(() => (roster.data?.engines ?? []).map((engine) => ({
    id: `engine-${engine.id}`,
    tab: "system" as const,
    label: engine.name,
    description: `${engine.installed ? (engine.version ? `v${engine.version}` : "Installed") : "Not installed"} · ${engine.tagline}`,
    keywords: [engine.id, engine.shortName, engine.binaryName],
    breadcrumb: [...TRAIL, "Agent engines"],
    action: "jump" as const,
  })), [roster.data]);
}

export function SystemPanel() {
  const { capabilities, callbacks } = useSettingsShell();
  return <SystemUpdates capabilities={capabilities} onOmpUpdateAvailabilityChange={callbacks.onOmpUpdateAvailabilityChange} />;
}
