import { providerBrand } from "../provider-brand";
import { buildSessionContext, getSessionEntries, resolveSessionPath } from "../session-reader";
import { isRecord } from "../type-guards";
import { getUsageSnapshot } from "../usage/cache";
import { resolveModelAvailability } from "../usage/availability";
import { unavailableUsageSnapshot, usageReaderInstalled } from "../usage/omp-usage";
import { usageProviderFor } from "../usage/provider-map";
import { readSessionAccounts } from "../usage/session-accounts";
import { evidenceFromSessionAccount, rankProviderAccounts } from "../usage/select";
import type { UsageSnapshot } from "../usage/types";
import type { EngineSession } from "../harness/types";
import type { ScheduledModelRef } from "./types";

/**
 * "When quota resets": which model, which window, and whether it is usable yet.
 *
 * The answer must be the one the composer's quota ring gives, because that is
 * what the person read before choosing "when quota resets". So it is built from
 * the same primitives (lib/usage/select's account ranking, with the same
 * evidence of which account the chat is actually on), not from a second
 * dialect. Whether a model can serve again is lib/usage/availability's single
 * verdict, exactly as for every other router in Cody.
 */

/** A model as an engine states it. */
export type ChatModel = ScheduledModelRef;

/** What a quota-mode message waits for. */
export interface QuotaTarget {
  /** The usage provider id that meters the model. */
  provider: string;
  modelId: string;
  /** Epoch ms of the binding window's reset. */
  resetsAt: number;
  /** "Claude · Secondary": the provider's name plus the account's position when it has several. */
  label: string;
}

export type QuotaPlan = { ok: true; target: QuotaTarget } | { ok: false; code: "no_quota_reset" };

function titleCase(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/** "Primary", "Secondary", "Account 3": a position, never the account's own identity (which can be an email). */
function positionName(position: number): string {
  if (position === 0) return "Primary";
  if (position === 1) return "Secondary";
  return `Account ${position + 1}`;
}

/**
 * The account the chat is on and the window that will stop it next, from `snapshot`.
 * `sessionAccounts` is what `readSessionAccounts` found in the chat's own file.
 */
export function planQuotaTarget(
  snapshot: UsageSnapshot,
  usageProvider: string | null,
  modelId: string,
  sessionAccounts: Record<string, { accountId: string | null; since: string | null }>,
  now: number,
): QuotaPlan {
  if (!usageProvider || !snapshot.available) return { ok: false, code: "no_quota_reset" };
  const ranks = rankProviderAccounts(snapshot.accounts, usageProvider, modelId, evidenceFromSessionAccount(sessionAccounts[usageProvider]));
  const top = ranks[0];
  const binding = top?.windows[0];
  if (!top || !binding?.resetsAt) return { ok: false, code: "no_quota_reset" };
  const resetsAt = Date.parse(binding.resetsAt);
  // A reading that predates its own reset is no longer true: nothing to wait for.
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return { ok: false, code: "no_quota_reset" };
  const siblings = snapshot.accounts.filter((account) => account.provider === usageProvider);
  const brand = providerBrand(usageProvider)?.name ?? (titleCase(usageProvider) || usageProvider);
  const label = siblings.length > 1 ? `${brand} · ${positionName(siblings.indexOf(top.account))}` : brand;
  return { ok: true, target: { provider: usageProvider, modelId, resetsAt, label } };
}

export type QuotaJudgement =
  | { state: "usable" }
  | { state: "exhausted"; resetsAt: number | null }
  | { state: "unreadable" };

/**
 * Can this model serve a request right now? "Unknown is usable" (a provider
 * that reports nothing must never be waited on forever), but a read that did
 * not happen proves nothing: that is `unreadable`, and the caller tries again.
 */
export function judgeQuota(snapshot: UsageSnapshot | null | undefined, provider: string, modelId: string): QuotaJudgement {
  if (!snapshot?.available) return { state: "unreadable" };
  const availability = resolveModelAvailability(snapshot, provider, modelId);
  if (availability.state !== "exhausted") return { state: "usable" };
  const resetsAt = availability.resetsAt ? Date.parse(availability.resetsAt) : Number.NaN;
  return { state: "exhausted", resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

/** The shared usage read, waited for. An engine without the usage reader answers "unavailable", which waits rather than guesses. */
export async function readUsageNow(): Promise<UsageSnapshot> {
  if (!usageReaderInstalled()) return unavailableUsageSnapshot("omp is not installed, so account quota cannot be read.");
  return getUsageSnapshot({ awaitFresh: true });
}

// ---------------------------------------------------------------------------
// The chat's own model
// ---------------------------------------------------------------------------

declare global {
  /** The live-session registry lib/rpc-manager.ts keeps; read here without importing it (rpc-manager imports the scheduling tools). */
  var __ompSessions: Map<string, EngineSession> | undefined;
}

const LIVE_STATE_TIMEOUT_MS = 5_000;

/** `{provider, id}` (what an engine's state reports) or `{provider, modelId}` (what the composer sends), normalised. */
export function readModelRef(value: unknown): ChatModel | null {
  if (!isRecord(value)) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.modelId === "string" ? value.modelId : typeof value.id === "string" ? value.id : "";
  return provider && id.trim() ? { provider, modelId: id.trim() } : null;
}

function modelOfState(state: unknown): ChatModel | null {
  if (!isRecord(state)) return null;
  return readModelRef(state.model) ?? (isRecord(state.data) ? readModelRef(state.data.model) : null);
}

/**
 * The model a chat is on right now. A live session knows (its last state, or one
 * bounded read of it); a dormant omp session's transcript records every model
 * change. Null when neither can say — the caller refuses rather than guesses.
 */
export async function resolveChatModel(sessionId: string): Promise<ChatModel | null> {
  const live = globalThis.__ompSessions?.get(sessionId);
  if (live?.isAlive()) {
    const remembered = modelOfState(live.lastKnownState?.());
    if (remembered) return remembered;
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LIVE_STATE_TIMEOUT_MS);
        timer.unref?.();
      });
      const state = await Promise.race([live.send({ type: "get_state" }), timeout]).finally(() => clearTimeout(timer));
      const fromState = modelOfState(state);
      if (fromState) return fromState;
    } catch {
      // A wedged child is not a reason to refuse: the transcript may still know.
    }
  }
  try {
    const file = await resolveSessionPath(sessionId);
    if (!file) return null;
    const recorded = buildSessionContext(getSessionEntries(file)).model;
    return readModelRef(recorded);
  } catch {
    return null;
  }
}

/**
 * Everything a quota-mode message needs, read now: the model (the composer's
 * own when it sent one, else the chat's), the account the chat is on, and the
 * window that binds it.
 */
export async function planQuotaForChat(
  sessionId: string,
  engineId: string,
  suppliedModel: ChatModel | null,
  now: number,
): Promise<QuotaPlan | { ok: false; code: "no_model" }> {
  const model = suppliedModel ?? await resolveChatModel(sessionId);
  if (!model) return { ok: false, code: "no_model" };
  const usageProvider = usageProviderFor(engineId, model.provider);
  const snapshot = await readUsageNow();
  let sessionAccounts: Record<string, { accountId: string | null; since: string | null }> = {};
  try {
    const file = await resolveSessionPath(sessionId);
    if (file && snapshot.available) sessionAccounts = await readSessionAccounts(file, snapshot);
  } catch {
    // No evidence of which account the chat is on just means "the one omp would pick".
  }
  return planQuotaTarget(snapshot, usageProvider, model.modelId, sessionAccounts, now);
}
