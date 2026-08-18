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
