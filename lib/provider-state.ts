/**
 * Everything Cody holds about a provider that must be forgotten the moment its
 * credentials, key or enablement change.
 *
 * Removing an account used to clear the roster and the model list and nothing
 * else, so the account kept coming back: from the usage snapshot (cached for a
 * minute and served stale while it refreshed), from OpenRouter's cached
 * balance, from a remembered "out of credits" blackout that fabricates an
 * account in Usage, from the saved-reset balances, and — worst — from a live
 * engine child that had read the credential or the key's environment variable
 * at spawn and went on using it. One function, so every route that changes a
 * provider forgets the same things.
 */
import { invalidateResetCredits } from "./harness/reset-credits-cache";
import { invalidateModelsCache } from "./models-cache";
import { invalidateOpenRouterAccount } from "./openrouter/account";
import { invalidateProviderLoginsCache } from "./provider-directory-server";
import { restartIdleRpcSessions } from "./rpc-manager";
import { clearBlackout, clearProviderBlackouts } from "./routing/route-memory";
import { peekUsageSnapshot, resetUsageCache } from "./usage/cache";

export interface ProviderChange {
  /** The active engine: its cached sign-in roster is dropped. */
  engineId: string;
  /** Providers GONE from routing — their credentials are removed (signed out,
   * last account removed, last key cleared) or the engine's config switched
   * them off. Their remembered blackouts go too: a provider that nothing
   * routes to cannot be spent, and nothing else would ever lift them. */
  removedProviders?: readonly string[];
  /** Credentials removed while their provider keeps other accounts. A blackout
   * is remembered under the USAGE account's id, which is not the credential's
   * row id, so the cached usage read is asked which account each credential
   * served (before it is dropped below) and that account's blackout goes:
   * otherwise it fabricates a Usage row for an account that no longer exists,
   * until a fresh read happens to see its siblings. */
  removedCredentials?: readonly { provider: string; credentialId: number }[];
  /** Restart idle chat engines so the next turn starts without the old
   * credential or environment. Default true; a plain key SAVE passes false
   * (sessions started afterwards pick it up, as the panel says). */
  restart?: boolean;
}

export interface ProviderChangeResult {
  /** Idle engines restarted. */
  restarted: number;
  /** Engines mid-reply, left alone: they keep the old state until that reply ends. */
  active: number;
}

export interface ProviderChangeDeps {
  restartIdle?: () => Promise<ProviderChangeResult>;
}

export async function settleProviderChange(change: ProviderChange, deps: ProviderChangeDeps = {}): Promise<ProviderChangeResult> {
  invalidateModelsCache();
  invalidateProviderLoginsCache(change.engineId);
  const served = peekUsageSnapshot();
  for (const { provider, credentialId } of change.removedCredentials ?? []) {
    for (const account of served?.accounts ?? []) {
      if (account.provider === provider && account.credentialId === credentialId) clearBlackout(provider, account.id);
    }
  }
  resetUsageCache();
  invalidateOpenRouterAccount();
  invalidateResetCredits();
  for (const provider of change.removedProviders ?? []) clearProviderBlackouts(provider);
  if (change.restart === false) return { restarted: 0, active: 0 };
  // The change itself already stands; failing to restart an engine is not a
  // reason to report it as failed.
  return (deps.restartIdle ?? restartIdleRpcSessions)().catch(() => ({ restarted: 0, active: 0 }));
}
