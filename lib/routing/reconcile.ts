/**
 * The one pass that turns observed quota into routing decisions.
 *
 * Order matters and is the whole design:
 *
 *   observe → remember → filter chains → bind roles → bind agents
 *
 * 1. `deriveBlackouts` reads the live snapshot (and OpenRouter's balance)
 *    for positive evidence of exhaustion.
 * 2. `recordBlackouts` persists it with the provider's own reset time, so
 *    the decision survives a quiet or failed telemetry read — the whole
 *    point of "don't dial that provider again until it is actually back".
 *    A read that could not see a target (a failed read, a provider missing
 *    from the report) leaves its blackout alone; one that sees headroom
 *    lifts it early. A window whose own reset has passed stops counting.
 * 3. `reconcileChainBindings` leaves out of each `retry.fallbackChains`
 *    list the entries whose provider is spent on every account, since
 *    omp's reactive walk dials them without asking about quota, and puts
 *    them back when the provider returns.
 * 4. `reconcileRoleBindings` re-points each omp role at the first entry of
 *    the USER's fallback chain that is not blacked out, remembering their
 *    original assignment to restore.
 * 5. `planAgentRoleOverrides` makes every subagent resolve through a ROLE
 *    rather than a model name, so step 3 reaches subagent routing too.
 *
 * It runs on the server, off the usage read every client already performs,
 * and it writes nothing when nothing moved.
 */

import { getHarness } from "../harness";
import { readAgentModelOverrides, writeAgentModelOverrides } from "../omp/agent-model-overrides";
import { readNativeSettings } from "../omp/settings-config";
import { applyBlackouts, blackoutCoverage, deriveBlackouts, lapseResetWindows, withoutProviders } from "./blackouts";
import { planAgentRoleOverrides, type AgentRoleChange } from "./agent-roles";
import { reconcileChainBindings, type ChainBindingChange } from "./chain-binding";
import type { ClaudeCreditsCover } from "./credits-cover";
import { reconcileRoleBindings, type RoleBindingChange } from "./role-binding";
import { autoBindEnabled, recordBlackouts, type ProviderBlackout } from "./route-memory";
import type { OpenRouterAccountSnapshot } from "../openrouter/account";
import type { UsageSnapshot } from "../usage/types";

export interface RoutingReconciliation {
	blackouts: ProviderBlackout[];
	roleChanges: RoleBindingChange[];
	chainChanges: ChainBindingChange[];
	agentChanges: AgentRoleChange[];
	/** False when Cody is observing only: blackouts are recorded and reported,
	 * but no role, chain or agent override is written. This is the default,
	 * and it is always the answer while another engine than omp is active. */
	autoBind: boolean;
	/** The snapshot with remembered exhaustion folded in — what callers
	 * should hand to availability and to the UI. */
	snapshot: UsageSnapshot;
}

export interface ReconcileDeps {
	agents?: readonly string[];
	catalog?: readonly string[];
	openRouter?: OpenRouterAccountSnapshot | null;
	/** Providers the engine's own config switches off (omp `disabledProviders`).
	 * The engine offers none of their models, so they leave the snapshot every
	 * consumer reads, derive no blackout, and any blackout remembered about them
	 * is forgotten (a live read re-derives the truth when they are enabled again). */
	disabledProviders?: readonly string[];
	/** Saved Claude API credits, when there are any. omp's own fallback chain tries them FIRST (the
	 * per-chat credits overlay), so a spent Claude plan model they carry is not routed around:
	 * no role is re-pointed at another provider and no chain entry is dropped while the credits
	 * can still answer for it. */
	claudeCredits?: ClaudeCreditsCover | null;
}

/**
 * Reconcile routing against one snapshot. Observation runs whatever engine
 * is active, because quota belongs to the accounts and the ring shows it on
 * every engine. BINDING is omp-only: every write targets omp's config.yml,
 * and no other engine has roles or fallback chains to bind. Never throws —
 * a routing optimization must not be able to break a usage read.
 */
export function reconcileRouting(snapshot: UsageSnapshot, deps: ReconcileDeps = {}): RoutingReconciliation {
	const empty: RoutingReconciliation = { blackouts: [], roleChanges: [], chainChanges: [], agentChanges: [], autoBind: false, snapshot };
	try {
		// Observation is unconditional and writes nothing to the engine's
		// config: blackouts are Cody's own state, and folding them into the
		// snapshot only makes the ring and availability honest.
		const disabled = new Set(deps.disabledProviders ?? []);
		const current = withoutProviders(lapseResetWindows(snapshot), disabled);
		const openRouter = disabled.has("openrouter") ? null : deps.openRouter;
		const blackouts = deriveBlackouts(current, openRouter);
		// A disabled provider is routed to by nobody, so what was remembered about
		// it is forgotten rather than kept out of sight: a blackout that outlives
		// its provider is what fabricated an OpenRouter row in Usage for weeks. A
		// live read re-derives whatever is true the moment it is enabled again.
		const covers = blackoutCoverage(current, openRouter);
		const remembered = recordBlackouts(blackouts, Date.now(), (blackout) => disabled.has(blackout.provider) || covers(blackout));
		const effective = applyBlackouts(current, { blackouts: remembered });
		const autoBind = getHarness().id === "omp" && autoBindEnabled();
		if (!autoBind) return { blackouts: remembered, roleChanges: [], chainChanges: [], agentChanges: [], autoBind, snapshot: effective };

		// Chains first, and role binding walks the user's BASELINE chains: the
		// filtered copy on disk is what omp reads, not what the user chose.
		const onDisk = readNativeSettings().settings.retry?.fallbackChains ?? {};
		const { changes: chainChanges, baselines: chains } = reconcileChainBindings({ snapshot: effective, blackouts: remembered, chains: onDisk, claudeCredits: deps.claudeCredits });
		const { changes: roleChanges } = reconcileRoleBindings({ snapshot: effective, chains, claudeCredits: deps.claudeCredits });

		let agentChanges: AgentRoleChange[] = [];
		if (deps.agents && deps.agents.length > 0) {
			const overrides = readAgentModelOverrides();
			const planned = planAgentRoleOverrides({
				overrides,
				agents: deps.agents,
				catalog: deps.catalog ?? [],
				snapshot: effective,
				claudeCredits: deps.claudeCredits,
			});
			if (planned.changes.length > 0) {
				writeAgentModelOverrides(planned.overrides);
				agentChanges = planned.changes;
			}
		}
		return { blackouts: remembered, roleChanges, chainChanges, agentChanges, autoBind, snapshot: effective };
	} catch {
		return empty;
	}
}

