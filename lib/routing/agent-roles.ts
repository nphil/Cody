/**
 * Making subagents resolve through omp's ROLES instead of hardcoded model
 * names.
 *
 * The failure this prevents, traced through omp 18.1
 * (`config/model-resolver.ts` `resolveEffectiveAgentModelSelection` and
 * `task/structured-subagent.ts`):
 *
 * - An agent definition may pin a concrete model
 *   (`~/.omp/agent/agents/luna.md` → `model: openai-codex/gpt-5.6-luna`).
 * - `resolveAgentModelSelection` returns `role: undefined` for any source
 *   that is not a role alias. The role is what keys the child's inherited
 *   retry-fallback chain — so a concrete pin means the subagent gets **no
 *   fallback chain at all**, however carefully `retry.fallbackChains.task`
 *   was written.
 * - If the pinned pattern matches nothing in the live catalog, the
 *   resolution falls through to `activeModelPattern` — the PARENT's model.
 *   Ask an Opus session for a cheap subagent and you get Opus, silently, on
 *   every spawn.
 * - An agent with no `model:` at all (scout, security-reviewer) takes that
 *   same parent-model path by definition. The bundled reviewer declares
 *   `model: "@slow"` (omp 18.2), and an override must keep that role rather
 *   than trade it for a cheaper one.
 *
 * `task.agentModelOverrides` outranks agent frontmatter, and a role alias
 * (`@task`, `@smol`, …) restores both properties at once: the role's
 * fallback chain is inherited, and the concrete model is resolved from
 * `modelRoles` — which the role binder keeps pointed at a provider that can
 * actually answer. So the override is written as an ALIAS, never as a model.
 *
 * Cody only ever fills a gap or repairs a pin it can prove is broken. An
 * override the user wrote themselves is left exactly as found.
 */

import { resolveModelAvailability } from "../usage/availability";
import type { UsageSnapshot } from "../usage/types";
import { coveredByClaudeCredits, type ClaudeCreditsCover } from "./credits-cover";
import { parseRoleSelector } from "./role-binding";

/** Role alias each known agent should resolve through. The mapping follows
 * the agent's stated job, which is also how omp's own bundled definitions
 * are written (`task` → `@task`, `sonic` → `@smol`, `reviewer` → `@slow`).
 * A security review is the same careful reading, so it takes `@slow` too. */
export const DEFAULT_AGENT_ROLES: Record<string, string> = {
	task: "@task",
	sonic: "@smol",
	luna: "@smol",
	scout: "@smol",
	reviewer: "@slow",
	"security-reviewer": "@slow",
};

export interface AgentRoleChange {
	agent: string;
	from: string | null;
	to: string;
	reason: "unset" | "concrete_model" | "unresolvable" | "exhausted";
}

export interface AgentRoleInput {
	/** `task.agentModelOverrides` exactly as configured. */
	overrides: Record<string, string>;
	/** Agent names discovered for this installation, bundled ones included. */
	agents: readonly string[];
	/** Every `provider/id` the live catalog serves, for the resolvable check. */
	catalog: readonly string[];
	snapshot: UsageSnapshot | null;
	/** Saved Claude API credits: a Claude pin they carry is not "blacked out". */
	claudeCredits?: ClaudeCreditsCover | null;
}

export interface AgentRoleResult {
	changes: AgentRoleChange[];
	overrides: Record<string, string>;
}

/**
 * Decide the override each agent should carry. Pure: the caller writes.
 */
export function planAgentRoleOverrides(input: AgentRoleInput): AgentRoleResult {
	const overrides = { ...input.overrides };
	const changes: AgentRoleChange[] = [];
	const catalog = new Set(input.catalog);

	for (const agent of input.agents) {
		const role = DEFAULT_AGENT_ROLES[agent];
		if (!role) continue;
		const current = overrides[agent]?.trim() ?? "";

		// A role alias is already the right shape, whoever wrote it.
		if (current.startsWith("@")) continue;
		// "on"/"off"-style values belong to other per-agent settings; never
		// reinterpret one as a model.
		if (current && !current.includes("/")) continue;
		// No catalog cached: "does this pin resolve?" is unanswerable, and
		// guessing "no" would rewrite a model that works. Fill gaps only.
		if (current && catalog.size === 0) continue;

		let reason: AgentRoleChange["reason"];
		if (!current) {
			reason = "unset";
		} else {
			const parsed = parseRoleSelector(current);
			const key = parsed ? `${parsed.provider}/${parsed.modelId}` : current;
			if (!parsed || !catalog.has(key)) reason = "unresolvable";
			else if (resolveModelAvailability(input.snapshot, parsed.provider, parsed.modelId).state === "exhausted" && !coveredByClaudeCredits(input.snapshot, parsed.provider, parsed.modelId, input.claudeCredits)) reason = "exhausted";
			else reason = "concrete_model";
		}

		// A concrete pin that resolves AND has quota is the user's working
		// choice — the only thing it costs is the role's fallback chain, and
		// silently rewriting a model that works would be the more surprising
		// behaviour. Only repair pins that are actually broken, plus gaps.
		if (reason === "concrete_model") continue;

		overrides[agent] = role;
		changes.push({ agent, from: current || null, to: role, reason });
	}

	return { changes, overrides };
}
