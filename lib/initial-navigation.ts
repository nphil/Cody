import type { SettingsTab } from "@/components/SettingsTabs";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
  };
}

/** Every Settings hub id. Keyed by `SettingsTab` so adding a hub there fails to
 * compile until it is listed here too. */
const SETTINGS_TABS = {
  accounts: true,
  general: true,
  notifications: true,
  forge: true,
  models: true,
  providers: true,
  engine: true,
  extensions: true,
  system: true,
} satisfies Record<SettingsTab, true>;

/**
 * The Settings hub a link asks to open (`/?settings=providers`), or null. A
 * push notification carries one: tapping "Claude was signed out" lands on the
 * page that fixes it. An unknown value opens nothing rather than a guess.
 */
export function getInitialSettingsTab(searchParams: Pick<URLSearchParams, "get">): SettingsTab | null {
  const requested = searchParams.get("settings");
  return requested !== null && Object.hasOwn(SETTINGS_TABS, requested) ? (requested as SettingsTab) : null;
}
