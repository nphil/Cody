"use client";

/**
 * Settings › Account. A thin wrapper: `AccountSettings` renders its own
 * `role="tabpanel"` root (`settings-panel-accounts`), so the registry marks
 * this section `ownsTabpanel` and the shell does not add a second one.
 */
import { AccountSettings } from "../AccountSettings";
import { useSettingsShell } from "../shell-context";

export function AccountPanel() {
  const { isMobile } = useSettingsShell();
  return <AccountSettings isMobile={isMobile} />;
}
