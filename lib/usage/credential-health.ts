/**
 * Whether a stored credential's login has ENDED, read off the cause omp gave
 * when it disabled the row.
 *
 * omp disables a credential for a handful of reasons, and only some of them
 * mean "the provider no longer honours this login":
 *  - a token refresh the provider refused for good (`oauth refresh failed:
 *    …invalid_grant…Refresh token expired`) — Anthropic ends an OAuth grant
 *    about 30 days after the interactive sign-in whatever the refreshing does;
 *  - an upstream reply saying the bearer was invalidated;
 *  - a deliberate removal (`deleted by user`, `replaced by …`, `logged out by
 *    user`), which is the owner's own doing and is not an expired login.
 *
 * A signed-out account is not out of quota and not broken: it needs one thing
 * from the owner, signing in again. Telling it apart from the others is what
 * lets every surface say that instead of a bare "Disabled".
 *
 * The vocabulary is omp's own: `isOAuthExpiry` in pi-ai (`invalid_grant`,
 * `invalid_token`, `unauthorized_client`, `revoked`, `refresh token … expired`)
 * plus the invalidated-token message. omp writes `oauth refresh failed:` only
 * after that classifier called the failure definitive, so the prefix alone is
 * enough. Pure and dependency-free: the browser, the server and the
 * notification watcher all read it.
 */
const LOGIN_ENDED = /^oauth refresh failed\b|invalid_grant|invalid_token|unauthorized_client|\brevoked\b|\binvalidated oauth token\b|\bexpired\b/i;

export function isSignedOutCause(cause: string | null | undefined): boolean {
  return typeof cause === "string" && LOGIN_ENDED.test(cause);
}
