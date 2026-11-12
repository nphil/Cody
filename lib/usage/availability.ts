/**
 * "Can this model serve right now?" — one answer, derived from one snapshot,
 * for every part of Cody that routes.
 *
 * This is deliberately the ONLY place that turns quota telemetry into a
 * routing verdict. The composer ring, the role binder and the Smart resolver
 * all read it, so a model can never be exhausted in one surface and healthy
 * in another. It is built on lib/usage/select.ts's primitives rather than a
 * second matching dialect: account ranking, tier scoping and window binding
 * already live there.
 *
 * Three rules are load-bearing:
 *
 * 1. **Unknown is usable.** A provider that reports no quota at all (an
 *    ordinary API key, a local endpoint) must never be routed around. Only
 *    positive evidence that a model cannot serve blocks it.
 * 2. **Exhaustion is per serving account.** A provider with two accounts is
 *    exhausted only when the account that would actually serve the request
 *    is; an idle spent sibling says nothing.
 * 3. **A login that ended is evidence, not silence.** When every account a
 *    provider has is signed out or disabled, nothing can serve the model: the
 *    verdict is `unavailable`, never `unknown` (which every caller reads as
 *    "usable") and never `exhausted` (which says "wait for a reset").
 */

import { rankProviderAccounts } from "./select";
import type { UsageSnapshot, UsageWindow } from "./types";

export type AvailabilityState = "ok" | "warning" | "exhausted" | "unavailable" | "unknown";

export interface ModelAvailability {
	provider: string;
	modelId: string;
	state: AvailabilityState;
	/** ISO timestamp of the soonest reset that would restore this model. */
	resetsAt?: string;
	/** The account that would serve this model, when one is known. */
	accountId?: string;
	/** Highest utilization (0-100) among the windows that bind this model. */
	utilization?: number;
	/** Set when every account for the provider is exhausted, not just the
	 * serving one — the case a router must treat as "come back later". */
	allAccountsExhausted?: boolean;
	/** With state "unavailable": why no account can serve — the login ended
	 * ("signed_out", only signing in again fixes it) or omp disabled the
	 * credential ("disabled"). */
	unusable?: "signed_out" | "disabled";
}

/** Whether a verdict means the model cannot take a request right now: out of
 * quota, or no usable login at all. Callers that ask "may I send here?" read
 * this rather than comparing against `exhausted` alone. */
export function cannotServe(availability: Pick<ModelAvailability, "state"> | null | undefined): boolean {
	return availability?.state === "exhausted" || availability?.state === "unavailable";
}

export interface RouteCandidate {
	provider: string;
	modelId: string;
}

export interface RouteChoice {
	chosen: RouteCandidate | null;
	chosenState: AvailabilityState;
	/** Candidates passed over, in the order they were rejected. */
	skipped: ModelAvailability[];
}

function worstWindow(windows: UsageWindow[]): UsageWindow | null {
	let worst: UsageWindow | null = null;
	for (const window of windows) {
		if (!window) continue;
		if (!worst || toUtilization(window.utilization) > toUtilization(worst.utilization)) worst = window;
	}
	return worst;
}

function toUtilization(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function soonestReset(windows: UsageWindow[]): string | undefined {
	let soonest: number | undefined;
	let iso: string | undefined;
	for (const window of windows) {
		if (!window?.resetsAt) continue;
		const at = Date.parse(window.resetsAt);
		if (!Number.isFinite(at)) continue;
		if (soonest === undefined || at < soonest) {
			soonest = at;
			iso = window.resetsAt;
		}
	}
	return iso;
}

/** The verdict for one model, from the snapshot alone. */
export function resolveModelAvailability(
	snapshot: UsageSnapshot | null | undefined,
	provider: string,
	modelId: string,
): ModelAvailability {
	const accounts = snapshot?.available ? (snapshot.accounts ?? []) : [];
	const ranked = rankProviderAccounts(accounts, provider, modelId);
	const top = ranked[0];
	if (!top) return { provider, modelId, state: "unknown" };

	// `rankProviderAccounts` puts every unusable account last, so an unusable
	// FIRST rank means the provider has no account that can serve at all.
	// That is positive evidence about the login, so it is named, not shrugged
	// off as "unknown".
	if (top.state === "signed_out" || top.state === "disabled") {
		return { provider, modelId, state: "unavailable", accountId: top.account.id, unusable: top.state };
	}

	const binding = top.windows ?? [];
	if (binding.length === 0) {
		// The provider reports quota, but none of it constrains this model.
		return { provider, modelId, state: "unknown", accountId: top.account.id };
	}

	const exhausted = binding.filter((window) => window.state === "exhausted");
	const worst = worstWindow(binding);
	const state: AvailabilityState = exhausted.length > 0
		? "exhausted"
		: worst?.state === "warning"
			? "warning"
			: "ok";

	const availability: ModelAvailability = {
		provider,
		modelId,
		state,
		accountId: top.account.id,
		utilization: worst ? toUtilization(worst.utilization) : undefined,
	};
	const resetsAt = soonestReset(exhausted.length > 0 ? exhausted : binding);
	if (resetsAt) availability.resetsAt = resetsAt;
	if (state === "exhausted") {
		// `rankProviderAccounts` already puts the SERVING account first, so an
		// exhausted answer means the best account is spent. Say explicitly
		// whether a sibling could still take it, because that is the
		// difference between "rotate" and "this provider is gone until reset".
		availability.allAccountsExhausted = ranked.every((rank) => rank.state === "limited" || rank.state === "signed_out" || rank.state === "disabled");
	}
	return availability;
}

/**
 * The first candidate that can serve, in the caller's own order.
 *
 * The order is the USER's (their `retry.fallbackChains` entry), never
 * re-sorted by utilization: a fallback chain is a preference, and quietly
 * reordering it would route work somewhere they did not choose. A candidate
 * whose provider has no usable login at all is passed over like a spent one.
 */
export function pickAvailableRoute(
	snapshot: UsageSnapshot | null | undefined,
	candidates: readonly RouteCandidate[],
): RouteChoice {
	const skipped: ModelAvailability[] = [];
	for (const candidate of candidates) {
		if (!candidate?.provider || !candidate?.modelId) continue;
		const availability = resolveModelAvailability(snapshot, candidate.provider, candidate.modelId);
		if (!cannotServe(availability)) {
			return { chosen: { provider: candidate.provider, modelId: candidate.modelId }, chosenState: availability.state, skipped };
		}
		skipped.push(availability);
	}
	const onlyLogins = skipped.length > 0 && skipped.every((availability) => availability.state === "unavailable");
	return { chosen: null, chosenState: onlyLogins ? "unavailable" : "exhausted", skipped };
}
