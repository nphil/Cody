import * as path from "path";
import { getAgentDir } from "../omp/paths";
import { readEnv } from "../env";

/**
 * Cody's account state lives beside its other private state in the agent dir
 * (`cody-checkpoints` set the precedent). That keeps it on the volume a
 * deployment already persists — in the container, `/data/agent` — so accounts
 * survive an image update without a new mount or template change.
 */

export function getAccountsDir(): string {
  const override = readEnv("ACCOUNTS_DIR");
  return override ? path.resolve(override) : path.join(getAgentDir(), "cody-accounts");
}

/** The account records themselves. Written 0600: it holds password hashes. */
export function getAccountsFilePath(): string {
  return path.join(getAccountsDir(), "accounts.json");
}

/** HMAC key backing session cookies. Written 0600; losing it signs everyone out. */
export function getSessionSecretPath(): string {
  return path.join(getAccountsDir(), "session-secret");
}

/** Personal access tokens for native/API clients. Written 0600: it holds
 * credential digests, exactly like the account store. */
export function getAccessTokensPath(): string {
  return path.join(getAccountsDir(), "access-tokens.json");
}

/** Uploaded profile pictures, one file per account id. */
export function getAvatarsDir(): string {
  return path.join(getAccountsDir(), "avatars");
}

/** Maps an omp session id to the account that created it. omp owns the session
 * files themselves, so ownership has to live alongside rather than inside. */
export function getSessionOwnersPath(): string {
  return path.join(getAccountsDir(), "session-owners.json");
}

/** The OPEN-instance time zone: what an instance with no accounts keeps where an
 * account would keep its own (lib/time-zone-prefs.ts). It sits in the accounts
 * directory so a deployment that persists accounts persists it too, and so a
 * test or scratch instance that redirects CODY_ACCOUNTS_DIR redirects it. */
export function getInstanceTimeZonePath(): string {
  return path.join(getAccountsDir(), "time-zone.json");
}

/** Push-notification (ntfy) settings: one record per account plus one for an
 * OPEN instance (lib/notifications/store.ts). Written 0600 — it holds ntfy
 * access tokens. It sits in the accounts directory so a deployment that
 * persists accounts persists it too, and a test that redirects
 * CODY_ACCOUNTS_DIR redirects it. */
export function getNotificationsPath(): string {
  return path.join(getAccountsDir(), "notifications.json");
}

/** HMAC key signing the answer buttons on a notification (lib/notifications/
 * tokens.ts). Written 0600; losing it only makes outstanding buttons stop
 * working. */
export function getNotificationsSecretPath(): string {
  return path.join(getAccountsDir(), "notifications-secret");
}

/** What the quota watcher has already announced, so a window that stays past
 * its threshold is announced once (lib/notifications/quota-watch.ts). */
export function getNotificationsStatePath(): string {
  return path.join(getAccountsDir(), "notifications-state.json");
}
