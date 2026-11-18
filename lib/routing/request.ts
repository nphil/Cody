/**
 * Server-side glue: gather what `reconcileRouting` needs from whatever is
 * already cheap to read, and never pay to find it.
 *
 * The reconciler runs off the usage poll (every 90 s per open tab), so it
 * must not spawn an engine child, hit the network, or walk a large tree.
 * Anything it cannot get for free is simply not supplied, and the
 * reconciler degrades honestly: no catalog means it only fills gaps and
 * never judges an existing pin unresolvable.
 */

import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getHarness } from "../harness";
import { peekCatalogCache } from "../models-cache";
import { readClaudeCreditsRouting } from "../omp/claude-credits";
import { getOmpVersion, versionBelow } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";
import { readNativeSettings } from "../omp/settings-config";
import { getOpenRouterAccount } from "../openrouter/account";
import { restartIdleRpcSessions } from "../rpc-manager";
import type { UsageSnapshot } from "../usage/types";
import { DEFAULT_AGENT_ROLES } from "./agent-roles";
import type { ClaudeCreditsCover } from "./credits-cover";
import { reconcileRouting, type RoutingReconciliation } from "./reconcile";

/** Agents every omp Cody supports embeds in the binary. */
const BUNDLED_AGENTS = ["task", "sonic", "scout", "reviewer", "security-reviewer"] as const;

/**
 * Agents only an older omp embeds, each with the first release that no longer
 * does. `seance` (omp 18.12+, reads a saved chat read-only, no `model:` of its
 * own) went in 18.20.3, together with the task tool's `sourceSession`. It is
 * listed, to get a role like `scout`, only for an engine KNOWN to be older: an
 * override for an agent an engine lacks is never read, and an unreadable
 * version counts as current so a new engine is never given a stale pin.
 */
const RETIRED_BUNDLED_AGENTS: Readonly<Record<string, readonly [number, number, number]>> = {
	seance: [18, 20, 3],
};

function agentNamesIn(directory: string): string[] {
	try {
		return readdirSync(directory)
			.filter((entry) => entry.endsWith(".md"))
			.map((entry) => entry.slice(0, -3));
	} catch {
		return [];
	}
}

/**
 * Agent names this installation can spawn on the engine at `engineVersion`
 * (bare semver, or null when unreadable). Both roots are read: omp 18.18.8
 * and newer resolve user-level agents from `$PI_CODING_AGENT_DIR/agents`,
 * while older engines (18.8.3) read `~/.omp/agent/agents` even when the
 * instance data dir is elsewhere, so a `luna.md` may live in either.
 */
export function discoverAgentNames(engineVersion: string | null = null): string[] {
	const names = new Set<string>(BUNDLED_AGENTS);
	for (const [name, removedIn] of Object.entries(RETIRED_BUNDLED_AGENTS)) {
		if (versionBelow(engineVersion, removedIn)) names.add(name);
	}
	for (const root of [path.join(getAgentDir(), "agents"), path.join(homedir(), ".omp", "agent", "agents")]) {
		for (const name of agentNamesIn(root)) names.add(name);
	}
	// Only agents with a known role mapping are actionable; the rest are
	// listed for nothing.
	return [...names].filter((name) => name in DEFAULT_AGENT_ROLES);
}

interface CachedCatalog {
	modelList?: { provider: string; id: string }[];
}

/** `provider/id` for every model in the catalog cache, or [] when nothing is
 * cached — deliberately never a fetch. */
function cachedCatalogKeys(): string[] {
	const cached = peekCatalogCache<CachedCatalog>("models");
	const list = cached?.modelList;
	return Array.isArray(list) ? list.map((model) => `${model.provider}/${model.id}`) : [];
}

/** The providers omp's config switches off. Only omp has the setting, and a
 * config that cannot be read means "none": routing must not depend on it. */
function disabledProviders(): string[] {
	if (getHarness().id !== "omp") return [];
	try {
		return readNativeSettings().settings.disabledProviders ?? [];
	} catch {
		return [];
	}
}

/** The saved Claude API credits, as far as routing needs them; null when there are none. Two small
 * file reads (omp only), never a child process. */
function claudeCreditsCover(): ClaudeCreditsCover | null {
	if (getHarness().id !== "omp") return null;
	try {
		const routing = readClaudeCreditsRouting();
		return routing.active ? { modelIds: routing.modelIds, keyCount: routing.keyCount } : null;
	} catch {
		return null;
	}
}

export async function reconcileRoutingForRequest(snapshot: UsageSnapshot): Promise<RoutingReconciliation> {
	// A prepaid balance decides an OpenRouter blackout, but only from cache:
	// `refresh` is the top-up flow's business, not a background poll's.
	const openRouter = await getOpenRouterAccount().catch(() => null);
	const engineVersion = getHarness().id === "omp" ? await getOmpVersion().catch(() => null) : null;
	const routing = reconcileRouting(snapshot, {
		agents: discoverAgentNames(engineVersion),
		catalog: cachedCatalogKeys(),
		openRouter,
		disabledProviders: disabledProviders(),
		claudeCredits: claudeCreditsCover(),
	});
	// A running omp child read `modelRoles` and `retry.fallbackChains` once,
	// at start; only subagent spawns re-read them. So a live session would
	// keep walking the chain it booted with, spent providers included. Idle
	// children are restarted to pick the new config up, exactly as a save in
	// Settings does; a child mid-turn is left alone. Writes happen only on a
	// transition, so this is once per exhaustion or reset, not per poll.
	if (routing.chainChanges.length > 0 || routing.roleChanges.length > 0) {
		await restartIdleRpcSessions().catch(() => undefined);
	}
	return routing;
}
