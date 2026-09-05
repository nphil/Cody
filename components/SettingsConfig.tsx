"use client";

/**
 * The Settings dialog's entry point. AppShell mounts this while Settings is
 * open and hands it one `request` (which hub to show, bumped per
 * `openSettings` call) plus the workspace, session, engine and the few
 * callbacks a panel needs back into the app. Everything else — the rail,
 * the phone stack, the hubs, search, saves — lives under
 * `components/settings/` and renders through `SettingsShell`.
 *
 * The hub table is `components/settings/registry.ts`; the per-panel
 * contracts every hub codes against are `components/settings/shell-context`
 * (`useSettingsShell`), `hooks/useSettingsData` (`useSettingsRoute`) and
 * `hooks/useConfigWriter` (`useConfigWriter`, `useNativeSettings`).
 */
import { SettingsShell, type SettingsRequest, type SettingsShellProps } from "./settings/SettingsShell";

export type { SettingsRequest };
export type SettingsConfigProps = SettingsShellProps;

export function SettingsConfig(props: SettingsConfigProps) {
  return <SettingsShell {...props} />;
}
