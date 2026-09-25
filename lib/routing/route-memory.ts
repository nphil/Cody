/**
 * Cody's durable memory of which providers are spent, and of which model
 * actually served a role while one was.
 *
 * Why this file exists: a live quota snapshot is not enough to route well.
 * It is a 60-second cache that can go quiet (a failed read, an engine
 * restart, a provider that stops answering), and "no telemetry" reads as
 * "usable" — which is exactly how a session ends up dialling an account that
 * has been exhausted for days, every single turn. Remembering the
 * exhaustion, with the provider's OWN stated reset time as its expiry, is
 * what turns one observation into a routing decision that holds.
 *
 * Two kinds of memory live here:
 *
 * - **Blackouts.** A provider (optionally one account of it) is off the
 *   routing table until `until`. A quota blackout carries the reset the
 *   provider stated. A `credits` blackout (prepaid balances — OpenRouter)
 *   has NO expiry: money does not come back on a timer, so it clears only
 *   when a later read sees a positive balance.
 * - **Role bindings.** When a role's configured model is blacked out, Cody
 *   re-points that role at the first healthy entry of the user's own
 *   fallback chain, and keeps the user's original assignment as `baseline`
 *   so it can be restored exactly. Without the baseline the rebinding would
 *   be a one-way edit of the user's config.
 * - **Chain bindings.** While every account of a provider is spent, Cody
 *   drops that provider's entries from each `retry.fallbackChains` list,
 *   keeping the user's full list as `baseline` so the entries come back the
 *   moment the provider does. Same shape and same rules as role bindings.
 *
 * Cody-owned state: it lives in the instance data dir, never in omp's
 * config.yml, so an engine update or switch cannot lose or rewrite it.
 * Unknown top-level keys round-trip so a newer Cody's data survives an
 * older Cody's write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

export const ROUTE_MEMORY_FILE = "cody-route-memory.json";
// Still 1: `chains` is an additive key. A file without it parses as "no
// chain filtered", which is exactly what an older Cody left behind.
const FILE_VERSION = 1;

export type BlackoutKind = "quota" | "credits";

export interface ProviderBlackout {
	provider: string;
	/** One account of the provider, or null for the provider as a whole. */
	accountId: string | null;
	kind: BlackoutKind;
	/** When Cody first observed the exhaustion. */
	since: string;
	/** Provider-stated reset. Null for a prepaid balance, which never
	 * refills on its own and is cleared by observation instead. */
	until: string | null;
	/** Human-facing reason, shown verbatim in the routing notice. */
	reason: string;
	/** `"block"` when the only evidence is omp refusing the credential after
	 * one rejected request, not a measured quota. Absent = measured. */
	source?: "block";
}

export interface RoleBinding {
	role: string;
	/** The user's own assignment, restored verbatim when it is usable again. */
	baseline: string;
	/** What Cody wrote into `modelRoles[role]` instead. */
	active: string;
	reason: string;
	boundAt: string;
}

/** One chain entry Cody left out, and why, in words the UI can show. */
export interface DroppedChainEntry {
	entry: string;
	provider: string;
	/** "out of credits ($0.40 left)", "all accounts exhausted until …",
	 * "blocked after a rejected request until …". */
	reason: string;
	/** When the provider is expected back; null for a prepaid balance, which
	 * comes back only when money does. */
	until: string | null;
	/** `credits` = prepaid balance; `quota` = measured windows on every
	 * account; `block` = omp refused every credential after a rejected
	 * request; `disabled` = every saved credential is disabled. */
	source: "credits" | "quota" | "block" | "disabled";
}

export interface ChainBinding {
	/** The `retry.fallbackChains` key: a role name or a model selector. */
	key: string;
	/** The user's own chain, in their order, restored verbatim. */
	baseline: string[];
	/** What Cody wrote under the key instead. */
	active: string[];
	/** The entries of `baseline` missing from `active`, with their reasons. */
	dropped: DroppedChainEntry[];
	reason: string;
	boundAt: string;
}

export interface RouteMemory {
	blackouts: ProviderBlackout[];
	bindings: Record<string, RoleBinding>;
	chains: Record<string, ChainBinding>;
}

interface RouteMemoryFile extends RouteMemory {
	version: number;
	[extra: string]: unknown;
}

const EMPTY: RouteMemory = { blackouts: [], bindings: {}, chains: {} };


/**
 * Whether Cody may WRITE routing decisions into omp's config.yml
 * (`modelRoles`, `task.agentModelOverrides`).
 *
 * Default OFF, deliberately. Observing quota, remembering blackouts and
 * reporting them costs nothing and cannot surprise anyone; re-pointing a
 * role is a change to the user's own configuration, and it must never
 * happen merely because they installed a new version. An instance that
 * updates and finds its roles rewritten on the first usage poll is exactly
 * the failure this guard exists to prevent.
 *
 * `CODY_ROUTE_AUTOBIND=1` enables it for a deployment; the persisted flag
 * is what a future settings toggle writes.
 */
export function autoBindEnabled(): boolean {
  if (process.env.CODY_ROUTE_AUTOBIND === "1") return true;
  const file = readFile();
  return file.autoBind === true;
}

export function setAutoBind(enabled: boolean): void {
  const file = readFile();
  writeFile({ ...file, autoBind: enabled });
}
export function getRouteMemoryPath(): string {
	return path.join(getAgentDir(), ROUTE_MEMORY_FILE);
}

function normalizeBlackout(value: unknown): ProviderBlackout | null {
	if (!isRecord(value)) return null;
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	if (!provider) return null;
	const kind: BlackoutKind = value.kind === "credits" ? "credits" : "quota";
	return {
		provider,
		accountId: typeof value.accountId === "string" && value.accountId ? value.accountId : null,
		kind,
		since: typeof value.since === "string" ? value.since : new Date().toISOString(),
		until: typeof value.until === "string" ? value.until : null,
		reason: typeof value.reason === "string" ? value.reason : "",
		// Files written before `source` existed carry a block only as its label.
		...(value.source === "block" || (value.source === undefined && value.reason === "rate-limit block") ? { source: "block" as const } : {}),
	};
}

function normalizeBinding(role: string, value: unknown): RoleBinding | null {
	if (!isRecord(value)) return null;
	const baseline = typeof value.baseline === "string" ? value.baseline : "";
	const active = typeof value.active === "string" ? value.active : "";
	if (!baseline || !active) return null;
	return {
		role,
		baseline,
		active,
		reason: typeof value.reason === "string" ? value.reason : "",
		boundAt: typeof value.boundAt === "string" ? value.boundAt : new Date().toISOString(),
	};
}

function selectorList(value: unknown): string[] | null {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
	return value;
}

function normalizeChainBinding(key: string, value: unknown): ChainBinding | null {
	if (!isRecord(value)) return null;
	const baseline = selectorList(value.baseline);
	const active = selectorList(value.active);
	if (!baseline || !active || baseline.length === 0) return null;
	const dropped = Array.isArray(value.dropped)
		? value.dropped.flatMap((item): DroppedChainEntry[] => {
			if (!isRecord(item) || typeof item.entry !== "string" || typeof item.provider !== "string") return [];
			const source = item.source === "credits" || item.source === "block" || item.source === "disabled" ? item.source : "quota";
			return [{
				entry: item.entry,
				provider: item.provider,
				reason: typeof item.reason === "string" ? item.reason : "",
				until: typeof item.until === "string" ? item.until : null,
				source,
			}];
		})
		: [];
	return {
		key,
		baseline,
		active,
		dropped,
		reason: typeof value.reason === "string" ? value.reason : "",
		boundAt: typeof value.boundAt === "string" ? value.boundAt : new Date().toISOString(),
	};
}

function readFile(): RouteMemoryFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(getRouteMemoryPath(), "utf8"));
	} catch {
		// Missing, unreadable and corrupt all mean the same thing: nothing is
		// remembered yet, which is the safe state — every model is usable.
		return { version: FILE_VERSION, ...EMPTY };
	}
	if (!isRecord(parsed)) return { version: FILE_VERSION, ...EMPTY };
	const blackouts = Array.isArray(parsed.blackouts)
		? parsed.blackouts.flatMap((entry) => { const normalized = normalizeBlackout(entry); return normalized ? [normalized] : []; })
		: [];
	const bindings: Record<string, RoleBinding> = {};
	if (isRecord(parsed.bindings)) {
		for (const [role, entry] of Object.entries(parsed.bindings)) {
			const normalized = normalizeBinding(role, entry);
			if (normalized) bindings[role] = normalized;
		}
	}
	const chains: Record<string, ChainBinding> = {};
	if (isRecord(parsed.chains)) {
		for (const [key, entry] of Object.entries(parsed.chains)) {
			const normalized = normalizeChainBinding(key, entry);
			if (normalized) chains[key] = normalized;
		}
	}
	const file = { ...parsed } as RouteMemoryFile;
	file.version = FILE_VERSION;
	file.blackouts = blackouts;
	file.bindings = bindings;
	file.chains = chains;
	return file;
}

function writeFile(file: RouteMemoryFile): void {
	const target = getRouteMemoryPath();
	mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, target);
}

/** Whether a remembered blackout still applies at `now`. A `credits`
 * blackout has no expiry by design — it is cleared by a positive balance,
 * never by the clock. */
export function blackoutActive(blackout: ProviderBlackout, now = Date.now()): boolean {
	if (blackout.kind === "credits") return true;
	if (!blackout.until) return true;
	const until = Date.parse(blackout.until);
	return Number.isFinite(until) ? until > now : true;
}

/** Everything remembered, with expired quota blackouts already dropped. */
export function readRouteMemory(now = Date.now()): RouteMemory {
	const file = readFile();
	return {
		blackouts: file.blackouts.filter((blackout) => blackoutActive(blackout, now)),
		bindings: { ...file.bindings },
		chains: { ...file.chains },
	};
}

function sameTarget(a: ProviderBlackout, b: { provider: string; accountId: string | null }): boolean {
	return a.provider === b.provider && (a.accountId ?? null) === (b.accountId ?? null);
}

/**
 * Replace the remembered blackout set with what `observed` and the read's
 * coverage justify, keeping the original `since` of anything still blacked
 * out.
 *
 * A remembered blackout the read COVERED (it could see that account or
 * balance) and did not re-observe is cleared: the provider showed headroom,
 * and that is the early-restore path. One the read did not cover (a failed
 * read, a provider that dropped out of the report) is kept until its own
 * `until`: silence is not headroom. `covered` defaults to "the read saw
 * everything", the wholesale replacement a complete read deserves.
 */
export function recordBlackouts(
	observed: readonly ProviderBlackout[],
	now = Date.now(),
	covered: (blackout: ProviderBlackout) => boolean = () => true,
): ProviderBlackout[] {
	const file = readFile();
	const previous = file.blackouts.filter((blackout) => blackoutActive(blackout, now));
	const next = observed.map((blackout) => {
		const existing = previous.find((entry) => sameTarget(entry, blackout));
		return existing ? { ...blackout, since: existing.since } : blackout;
	});
	for (const blackout of previous) {
		if (next.some((entry) => sameTarget(entry, blackout))) continue;
		if (!covered(blackout)) next.push(blackout);
	}
	const changed = next.length !== previous.length
		|| next.some((blackout) => {
			const existing = previous.find((entry) => sameTarget(entry, blackout));
			return !existing || existing.until !== blackout.until || existing.kind !== blackout.kind;
		});
	if (changed) writeFile({ ...file, blackouts: next });
	return next;
}

export function writeRoleBinding(binding: RoleBinding): void {
	const file = readFile();
	writeFile({ ...file, bindings: { ...file.bindings, [binding.role]: binding } });
}

export function clearRoleBinding(role: string): void {
	const file = readFile();
	if (!(role in file.bindings)) return;
	const bindings = { ...file.bindings };
	delete bindings[role];
	writeFile({ ...file, bindings });
}

export function writeChainBinding(binding: ChainBinding): void {
	const file = readFile();
	writeFile({ ...file, chains: { ...file.chains, [binding.key]: binding } });
}

export function clearChainBinding(key: string): void {
	const file = readFile();
	if (!(key in file.chains)) return;
	const chains = { ...file.chains };
	delete chains[key];
	writeFile({ ...file, chains });
}

/** Forget one remembered blackout, after its cause was removed by hand (a
 * block lifted from Settings). A read that no longer sees the account would
 * otherwise keep it until its own deadline. Returns whether one was removed. */
export function clearBlackout(provider: string, accountId: string | null): boolean {
	const file = readFile();
	const blackouts = file.blackouts.filter((blackout) => !sameTarget(blackout, { provider, accountId }));
	if (blackouts.length === file.blackouts.length) return false;
	writeFile({ ...file, blackouts });
	return true;
}
