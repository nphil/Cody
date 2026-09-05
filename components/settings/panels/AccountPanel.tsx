"use client";

/**
 * Settings › Account. A thin wrapper: `AccountSettings` renders its own
 * `role="tabpanel"` root (`settings-panel-accounts`), so the registry marks
 * this section `ownsTabpanel` and the shell does not add a second one.
 *
 * Search: `SEARCH_ENTRIES` are the cards and sections `AccountSettings`
 * renders (its `<NativeSetting label>`s, the token section's, the roster and
 * the Danger zone), so a label rendered and a label searchable are one
 * string.
 */
import { AccountSettings } from "../AccountSettings";
import type { SearchEntry } from "../search-index";
import { useSettingsShell } from "../shell-context";

const TRAIL: readonly string[] = ["Cody", "Account"];

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  { id: "full-name", tab: "accounts", label: "Full name", description: "Shown on your profile and, for administrators, in the account roster.", keywords: ["profile", "display name"], breadcrumb: TRAIL, scope: "Cody only", action: "jump" },
  { id: "profile-picture", tab: "accounts", label: "Profile picture", description: "PNG, JPEG or WebP. Cropped square and downscaled in your browser before upload.", keywords: ["avatar", "photo"], breadcrumb: TRAIL, scope: "Cody only", action: "jump" },
  { id: "change-password", tab: "accounts", label: "Change password", description: "Signs out your other devices and revokes this account's access tokens.", keywords: ["security", "sign in"], breadcrumb: TRAIL, action: "jump" },
  { id: "access-tokens", tab: "accounts", label: "Access tokens", description: "Bearer tokens for scripts and native clients signing in as you.", keywords: ["token", "bearer", "api", "revoke"], breadcrumb: TRAIL, action: "jump" },
  { id: "accounts-on-this-server", tab: "accounts", label: "Accounts on this server", description: "Who can sign in, their roles, password resets and new accounts (administrators).", keywords: ["users", "roster", "admin", "member", "signup", "reset password", "add account"], breadcrumb: TRAIL, action: "jump" },
  { id: "account-danger-zone", tab: "accounts", label: "Delete an account", description: "Remove another account from this server; its sessions stay on disk without an owner.", keywords: ["delete", "remove", "danger"], breadcrumb: [...TRAIL, "Danger zone"], action: "jump" },
];

export function AccountPanel() {
  const { isMobile, callbacks } = useSettingsShell();
  return <AccountSettings isMobile={isMobile} onOpenSystem={() => callbacks.selectSection("system")} />;
}
