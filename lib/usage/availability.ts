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
 * Two rules are load-bearing:
 *
 * 1. **Unknown is usable.** A provider that reports no quota at all (an
 *    ordinary API key, a local endpoint) must never be routed around. Only
 *    positive evidence of exhaustion blocks a model.
 * 2. **Exhaustion is per serving account.** A provider with two accounts is
 *    exhausted only when the account that would actually serve the request
 *    is; an idle spent sibling says nothing.
 */

import { rankProviderAccounts, selectWindowsForModel } from "./select";
import type { UsageSnapshot, UsageWindow } from "./types";

export type AvailabilityState = "ok" | "warning" | "exhausted" | "unknown";

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
	const match = selectWindowsForModel(accounts, { provider, modelId });
	if (!match) return { provider, modelId, state: "unknown" };
	// OMP deliberately omits live quota windows for disabled credentials. If
	// every saved account is disabled, that is positive evidence this provider
	// cannot serve the model, not the ordinary "no quota telemetry" case.
	if (match.account.disabled) {
		return { provider, modelId, state: "exhausted", accountId: match.account.id, allAccountsExhausted: true };
	}

	const binding = match.windows ?? [];
	if (binding.length === 0) {
		// The provider reports quota, but none of it constrains this model.
		return { provider, modelId, state: "unknown", accountId: match.account.id };
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
		accountId: match.account.id,
		utilization: worst ? toUtilization(worst.utilization) : undefined,
	};
	const resetsAt = soonestReset(exhausted.length > 0 ? exhausted : binding);
	if (resetsAt) availability.resetsAt = resetsAt;
	if (state === "exhausted") {
		// `selectWindowsForModel` already reports the SERVING account, so an
		// exhausted answer means the best account is spent. Say explicitly
		// whether a sibling could still take it, because that is the
		// difference between "rotate" and "this provider is gone until reset".
		const ranked = rankProviderAccounts(accounts, provider, modelId);
		availability.allAccountsExhausted = ranked.length > 0
			&& ranked.every((rank) => rank.state === "limited" || rank.state === "disabled");
	}
	return availability;
}

/**
 * The first candidate that is not exhausted, in the caller's own order.
 *
 * The order is the USER's (their `retry.fallbackChains` entry), never
 * re-sorted by utilization: a fallback chain is a preference, and quietly
 * reordering it would route work somewhere they did not choose.
 */
export function pickAvailableRoute(
	snapshot: UsageSnapshot | null | undefined,
	candidates: readonly RouteCandidate[],
): RouteChoice {
	const skipped: ModelAvailability[] = [];
	for (const candidate of candidates) {
		if (!candidate?.provider || !candidate?.modelId) continue;
		const availability = resolveModelAvailability(snapshot, candidate.provider, candidate.modelId);
		if (availability.state !== "exhausted") {
			return { chosen: { provider: candidate.provider, modelId: candidate.modelId }, chosenState: availability.state, skipped };
		}
		skipped.push(availability);
	}
	return { chosen: null, chosenState: "exhausted", skipped };
}
