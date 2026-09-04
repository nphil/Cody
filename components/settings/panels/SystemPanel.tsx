"use client";

/**
 * Settings › System: the app, engine and skill update surfaces plus session
 * restart. STUB: renders today's `SystemUpdates` unchanged (it owns the
 * `settings-panel-system` tabpanel root); the System slice replaces its body
 * with the Cody card, `EngineRoster` and the Danger zone.
 */
import { SystemUpdates } from "../SystemUpdates";
import { useSettingsShell } from "../shell-context";

export function SystemPanel() {
  const { cwd, capabilities, callbacks } = useSettingsShell();
  return (
    <SystemUpdates
      cwd={cwd}
      capabilities={capabilities}
      onOmpUpdateAvailabilityChange={callbacks.onOmpUpdateAvailabilityChange}
      onOpenSkills={() => callbacks.selectSection("extensions", "skills")}
    />
  );
}
