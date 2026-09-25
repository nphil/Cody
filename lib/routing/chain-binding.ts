/**
 * Keeping omp's `retry.fallbackChains` free of providers that cannot answer.
 *
 * omp walks a chain after a request fails, and the walk only asks whether a
 * candidate has an API key, never whether it has quota. So a chain entry on
 * a provider that is spent on every account (a prepaid gateway out of money,
 * a plan blocked for a week) is dialled every time the chain is walked, and
 * the failure it produces is what triggers the next hop. `usageAwareFallback`
 * does not cover it either: it only knows providers that report a usage
 * ranking, which a prepaid gateway does not.
 *
 * So Cody writes each chain with those entries left out, and puts them back
 * the moment their provider is usable again. The policy:
 *
 * - An entry is dropped only when EVERY account that could serve its model
 *   is exhausted (`allAccountsExhausted`), which includes a provider-wide
 *   blackout. One spent account beside a healthy sibling drops nothing: omp
 *   rotates accounts itself, and that is the preferred recovery.
 * - The user's order is kept. Entries are removed, never reordered or added.
 * - If every entry would be dropped, the user's full chain is written
 *   instead. An empty chain means "no fallback at all", which turns a slow
 *   recovery into a certain failure; dialling a spent provider at least
 *   gets the provider's own error, and its reset, in front of the user.
 * - The baseline is kept in route memory and restored verbatim, and a chain
 *   that no longer matches what Cody wrote is the user's word: it becomes
 *   the new baseline, exactly as role-binding.ts treats `modelRoles`.
 *
 * An entry Cody cannot parse (a role alias, a bare wildcard) is kept.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isMap, parseDocument } from "yaml";
import { getSettingsPath } from "../omp/paths";
import { resolveModelAvailability } from "../usage/availability";
import type { UsageSnapshot } from "../usage/types";
import { parseRoleSelector } from "./role-binding";
import {
	clearChainBinding,
	readRouteMemory,
	writeChainBinding,
	type ChainBinding,
	type DroppedChainEntry,
	type ProviderBlackout,
} from "./route-memory";

export interface ChainBindingChange {
	/** The `retry.fallbackChains` key: a role name or a model selector. */
	chain: string;
	from: string[];
	to: string[];
	/** "filtered" = spent providers left out; "restored" = the baseline came back. */
	kind: "filtered" | "restored";
	reason: string;
}

export interface ChainBindingInput {
	snapshot: UsageSnapshot | null;
	/** The active blackouts behind `snapshot`, so a dropped entry can say
	 * "out of credits" rather than only "exhausted". */
	blackouts?: readonly ProviderBlackout[];
	/** `retry.fallbackChains` exactly as it is on disk now. */
	chains: Record<string, string[]>;
}

export interface ChainBindingResult {
	changes: ChainBindingChange[];
	/** The chains that should be on disk after reconciliation. */
	chains: Record<string, string[]>;
	/** The user's own chains, unfiltered: what role binding should walk. */
	baselines: Record<string, string[]>;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Why an entry cannot be served by any account, or null when it can (or
 * the entry is not Cody's to judge). */
function droppedEntry(input: ChainBindingInput, entry: string): DroppedChainEntry | null {
	const parsed = parseRoleSelector(entry);
	if (!parsed) return null;
	const { provider } = parsed;
	const availability = resolveModelAvailability(input.snapshot, provider, parsed.modelId);
	if (availability.state !== "exhausted" || availability.allAccountsExhausted !== true) return null;
	const providerAccounts = (input.snapshot?.accounts ?? []).filter((account) => account.provider.toLowerCase() === provider.toLowerCase());
	if (providerAccounts.length > 0 && providerAccounts.every((account) => Boolean(account.disabled))) {
		return { entry, provider, reason: "all accounts disabled", until: null, source: "disabled" };
	}

	const credits = input.blackouts?.find((blackout) => blackout.provider === provider && blackout.kind === "credits");
	if (credits) return { entry, provider, reason: credits.reason || "out of credits", until: null, source: "credits" };

	const until = availability.resetsAt ?? null;
	const exhausted = (input.snapshot?.accounts ?? [])
		.filter((account) => account?.provider === provider)
		.flatMap((account) => (account.windows ?? []).filter((window) => window?.state === "exhausted" && !window.tier));
	const blocked = exhausted.length > 0 && exhausted.every((window) => window.source === "block");
	const reason = blocked ? "blocked after a rejected request" : "all accounts exhausted";
	return { entry, provider, reason: until ? `${reason} until ${until}` : reason, until, source: blocked ? "block" : "quota" };
}

function sameDropped(a: readonly DroppedChainEntry[], b: readonly DroppedChainEntry[]): boolean {
	return a.length === b.length && a.every((entry, index) => entry.entry === b[index].entry
		&& entry.reason === b[index].reason && entry.until === b[index].until && entry.source === b[index].source);
}

/**
 * Decide every chain against the snapshot and the remembered bindings.
 * Pure: `reconcileChainBindings` persists the result.
 */
export function planChainBindings(input: ChainBindingInput, memory: Record<string, ChainBinding>): ChainBindingResult & {
	record: ChainBinding[];
	forget: string[];
} {
	const chains: Record<string, string[]> = {};
	const baselines: Record<string, string[]> = {};
	const changes: ChainBindingChange[] = [];
	const record: ChainBinding[] = [];
	const forget: string[] = [];

	for (const [key, current] of Object.entries(input.chains)) {
		const binding = memory[key];
		// A chain Cody did not write is the user's word.
		const baseline = binding && sameList(binding.active, current) ? binding.baseline : current;
		baselines[key] = baseline;

		const dropped: DroppedChainEntry[] = [];
		const kept = baseline.filter((entry) => {
			const reason = droppedEntry(input, entry);
			if (reason) dropped.push(reason);
			return !reason;
		});
		// Every entry spent, or none: either way the user's chain is the answer.
		const desired = kept.length === 0 || kept.length === baseline.length ? baseline : kept;
		chains[key] = desired;

		if (desired === baseline) {
			if (binding) forget.push(key);
			if (!sameList(current, baseline)) changes.push({ chain: key, from: current, to: baseline, kind: "restored", reason: "quota restored" });
			continue;
		}
		const reason = [...new Set(dropped.map((entry) => `${entry.provider}: ${entry.reason}`))].join("; ");
		// Already written: only the reasons (a moved reset, say) may need saving.
		if (sameList(current, desired) && binding && sameDropped(binding.dropped, dropped)) continue;
		record.push({ key, baseline, active: desired, dropped, reason, boundAt: binding && sameList(binding.baseline, baseline) ? binding.boundAt : new Date().toISOString() });
		if (!sameList(current, desired)) changes.push({ chain: key, from: current, to: desired, kind: "filtered", reason });
	}
	// A binding for a chain the user deleted has nothing left to restore.
	for (const key of Object.keys(memory)) if (!(key in input.chains)) forget.push(key);

	return { changes, chains, baselines, record, forget };
}

/** Write only the changed chain keys, leaving the rest of config.yml (and
 * every other chain) as the user wrote it. */
function writeFallbackChains(changed: Record<string, string[]>): void {
	const path = getSettingsPath();
	const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
	if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
	if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
	for (const [key, chain] of Object.entries(changed)) doc.setIn(["retry", "fallbackChains", key], doc.createNode(chain));
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, doc.toString(), "utf8");
	renameSync(temp, path);
}

/**
 * Reconcile every fallback chain, writing config.yml only when a chain
 * actually moved and route memory only when a binding did.
 */
export function reconcileChainBindings(input: ChainBindingInput): ChainBindingResult {
	const plan = planChainBindings(input, readRouteMemory().chains);
	// Baselines are remembered BEFORE the chain is rewritten: a filtered chain
	// on disk with no baseline behind it would read as the user's own edit
	// next time, and the dropped entries would never come back.
	for (const binding of plan.record) writeChainBinding(binding);
	if (plan.changes.length > 0) {
		writeFallbackChains(Object.fromEntries(plan.changes.map((change) => [change.chain, change.to])));
	}
	for (const key of plan.forget) clearChainBinding(key);
	return { changes: plan.changes, chains: plan.chains, baselines: plan.baselines };
}
