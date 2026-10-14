/**
 * Turning quota telemetry into durable "do not route here" facts, and
 * folding those facts back into the snapshot every surface reads.
 *
 * `deriveBlackouts` is the observation step: an account is blacked out when
 * it reports an exhausted window that binds EVERY model it serves (an
 * untiered window). A tier-scoped exhaustion is not a blackout — the other
 * tiers still work, and live availability already scopes it correctly.
 *
 * `applyBlackouts` is the memory step: it re-asserts remembered exhaustion
 * on top of a fresh snapshot. That is what makes the rule hold when
 * telemetry goes quiet — a failed `omp usage` read reports nothing, and
 * "nothing" would otherwise read as "healthy" and send the next turn
 * straight back into a provider that is out for another six days.
 */

import type { OpenRouterAccountSnapshot } from "../openrouter/account";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "../usage/types";
import { blackoutActive, type ProviderBlackout, type RouteMemory } from "./route-memory";

/** Provider id of the gateway whose balance is money, not a quota window. */
const OPENROUTER_PROVIDER = "openrouter";
/**
 * Below this many dollars a gateway balance is treated as spent. One Opus
 * turn with a 64k output budget reserves roughly $1.60 at list price, so a
 * balance under a dollar cannot start the requests this app actually makes.
 * Deliberately a floor, not a prediction: the point is to stop routing to
 * an account that will 402, not to price every request.
 */
export const OPENROUTER_CREDITS_FLOOR_USD = 1;

function untieredExhausted(account: UsageAccount): UsageWindow[] {
	return (account.windows ?? []).filter((window) => Boolean(window) && !window.tier && window.state === "exhausted");
}

function soonestReset(windows: readonly UsageWindow[]): string | null {
	let best: number | undefined;
	let iso: string | null = null;
	for (const window of windows) {
		if (!window.resetsAt) continue;
		const at = Date.parse(window.resetsAt);
		if (!Number.isFinite(at)) continue;
		if (best === undefined || at < best) {
			best = at;
			iso = window.resetsAt;
		}
	}
	return iso;
}

/**
 * Every blackout the current reads justify.
 *
 * Only positive evidence counts. A provider that reports no quota at all
 * produces no blackout, because an ordinary API key or a local endpoint has
 * nothing to exhaust and must never be routed around.
 */
export function deriveBlackouts(
	snapshot: UsageSnapshot | null | undefined,
	openRouter?: OpenRouterAccountSnapshot | null,
): ProviderBlackout[] {
	const now = new Date().toISOString();
	const blackouts: ProviderBlackout[] = [];
	for (const account of snapshot?.available ? (snapshot.accounts ?? []) : []) {
		if (!account?.provider) continue;
		if (account.disabled) {
			blackouts.push({
				provider: account.provider,
				accountId: account.id,
				kind: "quota",
				since: now,
				until: null,
				reason: account.disabled.cause ?? "credential disabled",
			});
			continue;
		}
		const exhausted = untieredExhausted(account);
		if (exhausted.length === 0) continue;
		blackouts.push({
			provider: account.provider,
			accountId: account.id,
			kind: "quota",
			since: now,
			until: soonestReset(exhausted),
			reason: exhausted[0].label,
			...(exhausted.every((window) => window.source === "block") ? { source: "block" as const } : {}),
		});
	}

	// A prepaid balance is not a window: it does not refill on a schedule, so
	// the blackout carries no expiry and is lifted only by seeing money.
	// A FAILED balance read is not a zero balance and must not black out the
	// gateway — `available` is what separates the two.
	//
	// "Out of credits" means "cannot afford a request", NOT "exactly zero".
	// Measured: a balance of a few cents answered every request with
	// `402 … can only afford 17889 tokens`, and because it was positive the
	// gateway counted as usable and won a chain walk. A capped key is the
	// same story on its own limit.
	if (openRouter?.available) {
		const balance = openRouter.credits?.remaining;
		const keyRoom = openRouter.key?.limitRemaining;
		const broke = (typeof balance === "number" && balance < OPENROUTER_CREDITS_FLOOR_USD)
			|| (typeof keyRoom === "number" && keyRoom < OPENROUTER_CREDITS_FLOOR_USD);
		if (broke) {
			blackouts.push({
				provider: OPENROUTER_PROVIDER,
				accountId: null,
				kind: "credits",
				since: now,
				until: null,
				reason: typeof balance === "number" && balance < OPENROUTER_CREDITS_FLOOR_USD
					? `out of credits ($${balance.toFixed(2)} left)`
					: "key spend limit reached",
			});
		}
	}
	return blackouts;
}

/**
 * Which remembered blackouts this read had standing to lift.
 *
 * Clearing a blackout needs positive evidence too: the read must actually
 * have looked at the target and found headroom. A prepaid balance is covered
 * by a successful balance read — or by a read that found NO key anywhere
 * (`no_key`): a key that was removed has nothing left to spend, and a
 * balance read can never succeed for it, so without this the blackout would
 * hold forever and keep fabricating an OpenRouter account in Usage. A failed
 * read (unreachable, rate-limited, a rejected key) covers nothing. A quota
 * blackout is covered only by a
 * fresh, successful usage read that reports that exact account; a stale
 * cached read is last hour's news, and a missing account is silence. The
 * one exception is an account the provider no longer reports while its
 * siblings still do, on a blackout with no reset: nothing else could ever
 * lift it, and the read says the account is gone.
 */
export function blackoutCoverage(
	snapshot: UsageSnapshot | null | undefined,
	openRouter?: OpenRouterAccountSnapshot | null,
): (blackout: ProviderBlackout) => boolean {
	const fresh = Boolean(snapshot?.available) && !snapshot?.stale;
	const accounts = fresh ? (snapshot?.accounts ?? []) : [];
	return (blackout) => {
		if (blackout.kind === "credits") return openRouter?.available === true || openRouter?.error?.code === "no_key";
		const siblings = accounts.filter((account) => account?.provider === blackout.provider);
		if (siblings.length === 0) return false;
		if (blackout.accountId === null) return true;
		if (siblings.some((account) => account.id === blackout.accountId)) return true;
		return blackout.until === null;
	};
}

/**
 * A usage read is a photograph. Served from cache past a window's own reset,
 * it still says "exhausted" about quota that has already refilled, and
 * routing would refuse a model whose quota is back. A window whose stated
 * reset has passed is read as reset: not exhausted, utilization unknown.
 */
export function lapseResetWindows(snapshot: UsageSnapshot, now = Date.now()): UsageSnapshot {
	if (!snapshot.available) return snapshot;
	const lapsed = (window: UsageWindow | null | undefined): boolean => {
		if (!window || window.state !== "exhausted" || !window.resetsAt) return false;
		const at = Date.parse(window.resetsAt);
		return Number.isFinite(at) && at <= now;
	};
	let changed = false;
	const accounts = (snapshot.accounts ?? []).map((account) => {
		if (!(account.windows ?? []).some(lapsed)) return account;
		changed = true;
		const windows = account.windows.map((window) => (lapsed(window) ? { ...window, state: "ok" as const, utilization: 0 } : window));
		return { ...account, windows };
	});
	return changed ? { ...snapshot, accounts } : snapshot;
}

/**
 * The snapshot minus every account of `providers` — the providers the engine's
 * own config switches off (omp `disabledProviders`). A disabled provider is
 * hidden from models by the engine itself, so it must not stay in the one
 * snapshot routing and Usage read: its accounts would keep drawing quota rows,
 * and its remembered exhaustion would keep fabricating an account.
 */
export function withoutProviders(snapshot: UsageSnapshot, providers: ReadonlySet<string>): UsageSnapshot {
	if (providers.size === 0 || !(snapshot.accounts ?? []).some((account) => providers.has(account.provider))) return snapshot;
	return { ...snapshot, accounts: snapshot.accounts.filter((account) => !providers.has(account.provider)) };
}

function blackoutWindow(blackout: ProviderBlackout): UsageWindow {
	return {
		id: `${blackout.provider}:blackout`,
		label: blackout.reason || (blackout.kind === "credits" ? "out of credits" : "usage limit"),
		utilization: 100,
		resetsAt: blackout.until,
		state: "exhausted",
		windowMs: null,
		tier: null,
		shared: true,
		...(blackout.source ? { source: blackout.source } : {}),
	};
}

/**
 * The snapshot every consumer should actually read: live telemetry with
 * remembered exhaustion re-asserted on top.
 *
 * An account that is already reporting its own exhaustion is left untouched
 * — the live numbers are better copy than a synthetic window. Memory only
 * fills gaps: an account that has gone quiet, or a provider that vanished
 * from the report entirely.
 */
export function applyBlackouts(
	snapshot: UsageSnapshot,
	memory: Pick<RouteMemory, "blackouts">,
	now = Date.now(),
): UsageSnapshot {
	const active = memory.blackouts.filter((blackout) => blackoutActive(blackout, now));
	if (active.length === 0) return snapshot;

	const accounts = (snapshot.accounts ?? []).map((account) => {
		const blackout = active.find((entry) => entry.provider === account.provider
			&& (entry.accountId === null || entry.accountId === account.id));
		if (!blackout) return account;
		if (untieredExhausted(account).length > 0) return account;
		return { ...account, windows: [...(account.windows ?? []), blackoutWindow(blackout)] };
	});

	for (const blackout of active) {
		if (accounts.some((account) => account.provider === blackout.provider)) continue;
		// No live account at all: the provider dropped out of the report while
		// still spent. Synthesize exactly enough for routing to see it, and
		// label it so the quota popup does not pass it off as a live read.
		accounts.push({
			provider: blackout.provider,
			id: blackout.accountId ?? `${blackout.provider}#remembered`,
			identity: null,
			credentialId: null,
			label: blackout.provider,
			planType: null,
			unlimited: false,
			windows: [blackoutWindow(blackout)],
		});
	}

	return { ...snapshot, accounts };
}
