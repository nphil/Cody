"use client";

/**
 * Settings › Memory: what the engine wrote down, read-only. The section is
 * gated on `capabilities.memory` in the registry; this wrapper only hands
 * the engine's name to the panel so its copy can say who remembers.
 */
import { MemoryPanel as MemoryPanelBody } from "../../MemoryPanel";
import { useSettingsShell } from "../shell-context";

export function MemoryPanel() {
  const { engine } = useSettingsShell();
  return <MemoryPanelBody engineName={engine?.shortName ?? null} />;
}
