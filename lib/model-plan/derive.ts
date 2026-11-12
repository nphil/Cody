import type { RosterModel } from "./roster";

/**
 * Every role Cody can ever assign. `widget` is new in omp 18.12.3: an engine
 * without it never consults `modelRoles.widget`, so anything that PROPOSES or
 * WRITES a role map must go through planRoleNames() with the engine's live role
 * list rather than use this vocabulary directly (it is also the display set).
 * OMP 18.1 no longer has a designer role.
 */
export const ROLE_NAMES: readonly string[] = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "task",
  "advisor",
  "widget",
];

/** The roles Cody may assign on an engine whose live role list is
 *  `engineRoleIds` (omp's MODEL_ROLE_IDS): ROLE_NAMES minus anything that
 *  engine does not have. Omit the argument only where no engine is involved. */
export function planRoleNames(engineRoleIds?: readonly string[]): readonly string[] {
  if (!engineRoleIds) return ROLE_NAMES;
  return ROLE_NAMES.filter((role) => engineRoleIds.includes(role));
}

export interface PlanRationale {
  subject: string;
  text: string;
}

export interface PlanDraft {
  roles: Record<string, string>;
  ladder: string[];
  rationale: PlanRationale[];
}

export interface ModelPlan {
  roles: Record<string, string>;
  chains: Record<string, string[]>;
  usageAwareFallback: boolean;
  rationale: PlanRationale[];
}

type NativePriorityRole = "smol" | "slow";
type PriceIntent = "lightest" | "strongest" | "balanced";

interface RoleWorkload {
  requireVision: boolean;
  preferReasoning: boolean;
  preferNonReasoning: boolean;
  nativePriority?: NativePriorityRole;
  priceIntent: PriceIntent;
}

const SUBSCRIPTION_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const LIGHTWEIGHT_ROLES = new Set(["smol", "tiny", "commit", "widget"]);
const SLOW_ROLES = new Set(["slow", "plan", "advisor"]);
const THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_FAMILY_RANK: Record<string, number> = {
  fable: 0,
  opus: 1,
  sonnet: 2,
  haiku: 3,
};

/** Mirrors OMP's case-sensitive concrete effort parser and exact auto alias. */
export function isRecognizedThinkingSuffix(suffix: string): boolean {
  if (suffix === "auto" || THINKING_LEVELS.includes(suffix)) return true;
  if (suffix.length < 2) return false;

  return THINKING_LEVELS.filter((level) => level.startsWith(suffix)).length === 1;
}

export function providerOf(selector: string): string {
  const slash = selector.indexOf("/");
  return slash === -1 ? selector : selector.slice(0, slash);
}

/**
 * Resolve only an exact roster selector, plus an OMP-recognized trailing
 * thinking level. A colon in a genuine model id (for example :batch) remains
 * part of that exact id rather than becoming an accidental alias.
 */
export function resolveRosterModel(selector: string, roster: RosterModel[]): RosterModel | null {
  const normalized = selector.trim();
  if (!normalized) return null;

  const exact = roster.find((model) => model.selector === normalized);
  if (exact) return exact;

  const colon = normalized.lastIndexOf(":");
  if (colon <= normalized.lastIndexOf("/")) return null;
  if (!isRecognizedThinkingSuffix(normalized.slice(colon + 1))) return null;

  return roster.find((model) => model.selector === normalized.slice(0, colon)) ?? null;
}

/** OpenRouter remains a gateway even when its currently enabled ids are bare. */
export function gatewayProviders(roster: RosterModel[]): Set<string> {
  const totals = new Map<string, number>();
  const nested = new Map<string, number>();

  for (const model of roster) {
    totals.set(model.provider, (totals.get(model.provider) ?? 0) + 1);
    if (model.id.includes("/")) {
      nested.set(model.provider, (nested.get(model.provider) ?? 0) + 1);
    }
  }

  return new Set(
    [...totals].flatMap(([provider, total]) => {
      const normalized = provider.toLowerCase();
      const isGateway = normalized === "openrouter"
        || normalized.includes("gateway")
        || (nested.get(provider) ?? 0) * 2 > total;
      return isGateway ? [provider] : [];
    }),
  );
}

/** A mixed remote/local provider is not a local-only fallback tier. */
function localProviders(roster: RosterModel[]): Set<string> {
  const byProvider = new Map<string, RosterModel[]>();
  for (const model of roster) {
    const models = byProvider.get(model.provider) ?? [];
    models.push(model);
    byProvider.set(model.provider, models);
  }

  return new Set(
    [...byProvider].flatMap(([provider, models]) => (
      models.length > 0 && models.every((model) => model.local) ? [provider] : []
    )),
  );
}

/** Quota is runtime health, so it deliberately never appears in this ordering. */
function providerTier(provider: string, gateways: Set<string>, locals: Set<string>): number {
  if (SUBSCRIPTION_PROVIDERS.has(provider)) return 0;
  if (locals.has(provider)) return 3;
  return gateways.has(provider) ? 2 : 1;
}

function priceOf(model: RosterModel): number | null {
  return typeof model.relativeCost === "number"
    && Number.isFinite(model.relativeCost)
    && model.relativeCost > 0
    ? model.relativeCost
    : null;
}
function vendorFamilyRank(model: Pick<RosterModel, "id" | "provider">): number | null {
  const id = model.id.toLowerCase();
  if (!id.includes("claude") && model.provider !== "anthropic") return null;
  for (const [family, rank] of Object.entries(ANTHROPIC_FAMILY_RANK)) {
    if (id.includes(family)) return rank;
  }
  return null;
}

function nativeRank(model: RosterModel, role: NativePriorityRole | undefined): number | undefined {
  return role ? model.rolePriority?.[role] : undefined;
}

function providerOrder(
  roster: RosterModel[],
  requested: readonly string[] = [],
  preferred?: string,
): string[] {
  const gateways = gatewayProviders(roster);
  const locals = localProviders(roster);
  const known = [...new Set(roster.map((model) => model.provider))];
  const requestedRank = new Map(requested.map((provider, index) => [provider, index]));

  return known.sort((left, right) => (
    providerTier(left, gateways, locals) - providerTier(right, gateways, locals)
    || Number(right === preferred) - Number(left === preferred)
    || (requestedRank.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (requestedRank.get(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right)
  ));
}

function workloadForRole(role: string, reference?: RosterModel): RoleWorkload {
  const requireVision = role === "vision" || reference?.vision === true;

  if (LIGHTWEIGHT_ROLES.has(role)) {
    return {
      requireVision,
      preferReasoning: false,
      preferNonReasoning: true,
      nativePriority: "smol",
      priceIntent: "lightest",
    };
  }

  if (SLOW_ROLES.has(role)) {
    return {
      requireVision,
      preferReasoning: true,
      preferNonReasoning: false,
      nativePriority: "slow",
      priceIntent: "strongest",
    };
  }

  if (role === "task") {
    return {
      requireVision,
      preferReasoning: true,
      preferNonReasoning: false,
      priceIntent: "balanced",
    };
  }

  return {
    requireVision,
    preferReasoning: true,
    preferNonReasoning: false,
    priceIntent: "strongest",
  };
}

function compareByPrice(left: RosterModel, right: RosterModel, intent: PriceIntent): number {
  if (intent === "strongest") {
    const leftFamily = vendorFamilyRank(left);
    const rightFamily = vendorFamilyRank(right);
    if (leftFamily !== null && rightFamily !== null && leftFamily !== rightFamily) {
      return leftFamily - rightFamily;
    }
  }
  const leftPrice = priceOf(left);
  const rightPrice = priceOf(right);

  if (leftPrice !== null && rightPrice !== null && leftPrice !== rightPrice) {
    return intent === "lightest" ? leftPrice - rightPrice : rightPrice - leftPrice;
  }
  if (leftPrice !== null && rightPrice === null) return -1;
  if (leftPrice === null && rightPrice !== null) return 1;
  return left.selector.localeCompare(right.selector);
}

function sortBalanced(models: RosterModel[]): RosterModel[] {
  const priced = models.filter((model) => priceOf(model) !== null)
    .sort((left, right) => (priceOf(left) ?? 0) - (priceOf(right) ?? 0));
  const unknown = models.filter((model) => priceOf(model) === null)
    .sort((left, right) => left.selector.localeCompare(right.selector));
  if (priced.length === 0) return unknown;

  const middle = (priced.length - 1) / 2;
  return priced
    .map((model, index) => ({ model, distance: Math.abs(index - middle) }))
    .sort((left, right) => left.distance - right.distance || left.model.selector.localeCompare(right.model.selector))
    .map(({ model }) => model)
    .concat(unknown);
}

function isNativeOppositeOnly(model: RosterModel, target: NativePriorityRole): boolean {
  const opposite: NativePriorityRole = target === "smol" ? "slow" : "smol";
  return model.rolePriority?.[opposite] !== undefined
    && model.rolePriority?.[target] === undefined;
}

function sortCandidates(models: RosterModel[], workload: RoleWorkload): RosterModel[] {
  if (workload.priceIntent === "balanced") return sortBalanced(models);

  return [...models].sort((left, right) => {
    if (workload.priceIntent === "strongest") {
      const leftFamily = vendorFamilyRank(left);
      const rightFamily = vendorFamilyRank(right);
      if (leftFamily !== null && rightFamily !== null && leftFamily !== rightFamily) {
        return leftFamily - rightFamily;
      }
    }
    if (workload.nativePriority) {
      const leftNative = nativeRank(left, workload.nativePriority);
      const rightNative = nativeRank(right, workload.nativePriority);
      if (leftNative !== undefined || rightNative !== undefined) {
        if (leftNative === undefined) return 1;
        if (rightNative === undefined) return -1;
        if (leftNative !== rightNative) return leftNative - rightNative;
      }
    }

    return compareByPrice(left, right, workload.priceIntent);
  });
}

function lightCandidates(fullProvider: RosterModel[]): RosterModel[] {
  const candidates = fullProvider.filter((model) => !isNativeOppositeOnly(model, "smol"));
  if (candidates.length === 0) return [];

  const native = candidates.filter((model) => model.rolePriority?.smol !== undefined);
  const nonReasoning = candidates.filter((model) => !model.reasoning);
  const priced = candidates.filter((model) => priceOf(model) !== null);
  const lowest = priced.length > 0
    ? Math.min(...priced.map((model) => priceOf(model) ?? Number.POSITIVE_INFINITY))
    : null;
  const priceLight = lowest === null
    ? []
    : priced.filter((model) => priceOf(model) === lowest);
  const eligible = [...native, ...nonReasoning, ...priceLight];

  // A catalog without a light signal still needs a usable chat fallback.
  return eligible.length > 0 ? [...new Set(eligible)] : candidates;
}

function strongCandidates(fullProvider: RosterModel[]): RosterModel[] {
  const withoutNativeSmol = fullProvider.filter((model) => !isNativeOppositeOnly(model, "slow"));
  const candidates = withoutNativeSmol.length > 0 ? withoutNativeSmol : fullProvider;
  const native = candidates.filter((model) => model.rolePriority?.slow !== undefined);
  const priced = candidates.filter((model) => priceOf(model) !== null);
  const lowest = priced.length > 0
    ? Math.min(...priced.map((model) => priceOf(model) ?? Number.POSITIVE_INFINITY))
    : null;
  // Native-slow models lead. Price then admits the strong and balanced tiers,
  // but never a separately identified cheapest model merely because it reasons.
  const compatible = lowest === null
    ? []
    : priced.filter((model) => (priceOf(model) ?? Number.NEGATIVE_INFINITY) > lowest);
  const eligible = [...native, ...compatible];
  return eligible.length > 0 ? [...new Set(eligible)] : candidates;
}

function nativeOrPriceProfile(
  model: RosterModel,
  roster: RosterModel[],
): "smol" | "slow" | "task" | "default" | null {
  if (model.rolePriority?.smol !== undefined) return "smol";
  if (model.rolePriority?.slow !== undefined) return "slow";
  return sourcePriceRole(model, roster);
}

function balancedCandidates(fullProvider: RosterModel[], roster: RosterModel[]): RosterModel[] {
  const balanced = fullProvider.filter((model) => nativeOrPriceProfile(model, roster) === "task");
  if (balanced.length > 0) return balanced;

  const nonLight = fullProvider.filter((model) => nativeOrPriceProfile(model, roster) !== "smol");
  // A sparse/chat-only provider may have no balanced or nonlight tier at all.
  return nonLight.length > 0 ? nonLight : fullProvider;
}
/**
 * Models suited to one workload on a single provider. Source-tier eligibility
 * is calculated before removing the failing source, so its lone cheap model
 * cannot make a remaining frontier sibling look lightweight.
 */
function rankedModelsOnProvider(
  provider: string,
  roster: RosterModel[],
  workload: RoleWorkload,
  excludedSelector?: string,
): RosterModel[] {
  const fullProvider = roster.filter((model) => (
    model.provider === provider
    && (!workload.requireVision || model.vision)
  ));
  if (fullProvider.length === 0) return [];

  const eligible = workload.preferNonReasoning
    ? lightCandidates(fullProvider)
    : workload.priceIntent === "balanced"
      ? balancedCandidates(fullProvider, roster)
      : strongCandidates(fullProvider);
  return sortCandidates(
    eligible.filter((model) => model.selector !== excludedSelector),
    workload,
  );
}

function firstRankedModelOnProvider(
  provider: string,
  roster: RosterModel[],
  workload: RoleWorkload,
): RosterModel | null {
  return rankedModelsOnProvider(provider, roster, workload)[0] ?? null;
}

function selectAcrossProviders(
  candidates: RosterModel[],
  providers: readonly string[],
  workload: RoleWorkload,
  preferred?: string,
): RosterModel | null {
  if (candidates.length === 0) return null;

  const providerRank = new Map(providers.map((provider, index) => [provider, index]));
  return [...candidates].sort((left, right) => {
    if (workload.nativePriority) {
      const leftNative = nativeRank(left, workload.nativePriority);
      const rightNative = nativeRank(right, workload.nativePriority);
      if (leftNative !== undefined || rightNative !== undefined) {
        if (leftNative === undefined) return 1;
        if (rightNative === undefined) return -1;
        if (leftNative !== rightNative) return leftNative - rightNative;
      }
    }

    return Number(right.provider === preferred) - Number(left.provider === preferred)
      || (providerRank.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
        - (providerRank.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
      || left.selector.localeCompare(right.selector);
  })[0] ?? null;
}

function bestForWorkload(
  workload: RoleWorkload,
  roster: RosterModel[],
  preferredProvider?: string,
  onlyTier?: number,
): RosterModel | null {
  const gateways = gatewayProviders(roster);
  const locals = localProviders(roster);
  const providers = providerOrder(roster, [], preferredProvider);
  const tiers = onlyTier === undefined ? [0, 1, 2, 3] : [onlyTier];

  for (const tier of tiers) {
    const tierProviders = providers.filter((provider) => providerTier(provider, gateways, locals) === tier);
    const candidates = tierProviders.flatMap((provider) => {
      const candidate = firstRankedModelOnProvider(provider, roster, workload);
      return candidate ? [candidate] : [];
    });
    const selected = selectAcrossProviders(candidates, tierProviders, workload, preferredProvider);
    if (selected) return selected;
  }

  return null;
}

function bestFor(role: string, roster: RosterModel[], preferredProvider?: string): RosterModel | null {
  return bestForWorkload(workloadForRole(role), roster, preferredProvider);
}

/** Best eligible main-turn model, without treating context length or a name as a benchmark. */
export function bestAvailableModel(
  roster: RosterModel[],
  options: { preferredProvider?: string } = {},
): RosterModel | null {
  return bestFor("default", roster, options.preferredProvider);
}

function rolesAssignedTo(
  selector: string,
  roles: Record<string, string>,
  roster: RosterModel[],
): string[] {
  return ROLE_NAMES.flatMap((role) => {
    const assigned = roles[role] ? resolveRosterModel(roles[role], roster) : null;
    return assigned?.selector === selector ? [role] : [];
  });
}

const SOURCE_ROLE_PRECEDENCE = [
  "vision",
  "slow",
  "plan",
  "advisor",
  "default",
  "task",
  "smol",
  "tiny",
  "commit",
  "widget",
];

/**
 * One exact selector can serve several roles, but OMP resolves its exact chain
 * before a role key. Produce one deterministic source profile so those role
 * assignments cannot write conflicting fallback behavior.
 */
function sourcePriceRole(
  model: RosterModel,
  roster: RosterModel[],
): "smol" | "default" | "task" | null {
  const modelPrice = priceOf(model);
  if (modelPrice === null) return null;

  const prices = roster
    .filter((candidate) => candidate.provider === model.provider)
    .map((candidate) => priceOf(candidate))
    .filter((price): price is number => price !== null);
  if (prices.length < 2) return null;

  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  if (lowest === highest) return null;
  if (modelPrice === lowest) return "smol";
  if (modelPrice === highest) return "default";
  return "task";
}

function exactFallbackWorkload(role: string, model: RosterModel): RoleWorkload {
  const workload = workloadForRole(role, model);
  if (workload.priceIntent !== "strongest" || workload.nativePriority) return workload;

  // Exact source chains can move between separate model quota buckets. Native
  // slow suitability ranks those strong targets before catalog price, while
  // main-role selection continues to use its independent default workload.
  return { ...workload, nativePriority: "slow" };
}

function workloadForExactSource(
  model: RosterModel,
  assignedRoles: readonly string[],
  roster: RosterModel[],
): RoleWorkload {
  if (model.rolePriority?.smol !== undefined) return exactFallbackWorkload("smol", model);
  if (model.rolePriority?.slow !== undefined) return exactFallbackWorkload("slow", model);

  const priceRole = sourcePriceRole(model, roster);
  if (priceRole) return exactFallbackWorkload(priceRole, model);

  // Only sparse, tied, or unknown price spectra need an assigned-role signal.
  const assigned = SOURCE_ROLE_PRECEDENCE.find((role) => assignedRoles.includes(role));
  if (assigned) return exactFallbackWorkload(assigned, model);

  // No source-tier or assignment evidence remains. Stay conservative without
  // treating reasoning itself as a model-size signal.
  return exactFallbackWorkload("default", model);
}
function fallbackProviderOrder(
  reference: RosterModel,
  roster: RosterModel[],
  requested: readonly string[],
  includeSourceProvider: boolean,
): string[] {
  const ordered = providerOrder(roster, requested);
  if (!includeSourceProvider) return ordered.filter((provider) => provider !== reference.provider);

  const gateways = gatewayProviders(roster);
  const locals = localProviders(roster);
  // A subscription model's model-scoped quota may be separate from its
  // siblings. Keep those siblings first within the subscription tier only;
  // a gateway/local source still gives subscriptions their normal priority.
  if (providerTier(reference.provider, gateways, locals) === 0) {
    return [reference.provider, ...ordered.filter((provider) => provider !== reference.provider)];
  }

  return ordered;
}

function alternatives(
  reference: RosterModel,
  workload: RoleWorkload,
  roster: RosterModel[],
  requestedLadder: readonly string[],
  includeSourceProvider = false,
): string[] {
  const chain: string[] = [];
  for (const provider of fallbackProviderOrder(
    reference,
    roster,
    requestedLadder,
    includeSourceProvider,
  )) {
    for (const replacement of rankedModelsOnProvider(
      provider,
      roster,
      workload,
      includeSourceProvider ? reference.selector : undefined,
    )) {
      if (!chain.includes(replacement.selector)) chain.push(replacement.selector);
    }
  }
  return chain;
}

/** Exact selectors win OMP wildcards and roles: protect every enabled model first. */
export function deriveChains(args: {
  roles: Record<string, string>;
  ladder: string[];
  roster: RosterModel[];
  /** Roles to derive a chain for; defaults to every role Cody knows. */
  roleNames?: readonly string[];
}): Record<string, string[]> {
  const { roles, ladder, roster, roleNames = ROLE_NAMES } = args;
  const chains: Record<string, string[]> = {};
  const enabled = new Set(roster.map((model) => model.selector));

  for (const model of roster) {
    const workload = workloadForExactSource(
      model,
      rolesAssignedTo(model.selector, roles, roster),
      roster,
    );
    const chain = alternatives(model, workload, roster, ladder, true);
    if (chain.length > 0) chains[model.selector] = chain;
  }

  // Wildcards cover a user-pinned selector absent from this snapshot. They are
  // cross-provider escape hatches; exact source chains above retain siblings.
  for (const provider of providerOrder(roster, ladder)) {
    const reference = firstRankedModelOnProvider(provider, roster, workloadForRole("default"));
    if (!reference) continue;

    const chain = alternatives(reference, workloadForRole("default", reference), roster, ladder);
    if (chain.length > 0) chains[`${provider}/*`] = chain;
  }

  for (const role of roleNames) {
    const selected = roles[role] ? resolveRosterModel(roles[role], roster) : null;
    if (selected && chains[selected.selector]) {
      // This mirrors the exact winner when models are shared across roles.
      chains[role] = [...chains[selected.selector]];
      continue;
    }

    const reference = selected ?? bestFor(role, roster);
    if (!reference) continue;

    const chain = alternatives(reference, workloadForRole(role, reference), roster, ladder);
    if (chain.length > 0) chains[role] = chain;
  }

  for (const key of Object.keys(chains)) {
    chains[key] = chains[key].filter((selector) => enabled.has(selector));
  }

  return chains;
}


export function validatePlan(
  plan: {
    roles: Record<string, string>;
    chains: Record<string, string[]>;
    rationale?: PlanRationale[];
  },
  roster: RosterModel[],
  roleNames: readonly string[] = ROLE_NAMES,
): { plan: ModelPlan; warnings: string[] } {
  const warnings: string[] = [];
  const repair = bestAvailableModel(roster);
  const roles: Record<string, string> = {};

  for (const [role, rawSelector] of Object.entries(plan.roles ?? {})) {
    if (!roleNames.includes(role)) {
      warnings.push(`Ignored "${role}": not a role Cody assigns.`);
      continue;
    }
    if (typeof rawSelector !== "string") {
      warnings.push(`Dropped ${role}: its selector is not a string.`);
      continue;
    }

    const selector = rawSelector.trim();
    if (resolveRosterModel(selector, roster)) {
      roles[role] = selector;
    } else if (repair) {
      roles[role] = repair.selector;
      warnings.push(`"${rawSelector}" is not available; ${role} now uses ${repair.selector}.`);
    } else {
      warnings.push(`Dropped ${role}: "${rawSelector}" is not available and there is no replacement.`);
    }
  }

  const chains: Record<string, string[]> = {};
  for (const [rawKey, rawChain] of Object.entries(plan.chains ?? {})) {
    const key = rawKey.trim();
    if (!key) {
      warnings.push("Dropped a fallback chain with an empty key.");
      continue;
    }
    if (!Array.isArray(rawChain)) {
      warnings.push(`Dropped the ${key} fallback chain: it is not an array.`);
      continue;
    }

    const rolePrimary = roles[key] ? resolveRosterModel(roles[key], roster)?.selector : undefined;
    const modelPrimary = key.includes("/") && !key.endsWith("/*")
      ? resolveRosterModel(key, roster)?.selector
      : undefined;
    const ownSelector = rolePrimary ?? modelPrimary;
    const seenModels = new Set<string>();
    const kept: string[] = [];

    for (const rawSelector of rawChain) {
      if (typeof rawSelector !== "string") {
        warnings.push(`Dropped a non-string entry from the ${key} fallback chain.`);
        continue;
      }

      const selector = rawSelector.trim();
      const model = resolveRosterModel(selector, roster);
      if (!model) {
        warnings.push(`Dropped "${rawSelector}" from the ${key} fallback chain: not an available model.`);
        continue;
      }
      if (model.selector === ownSelector || seenModels.has(model.selector)) continue;

      seenModels.add(model.selector);
      // Keep the first selector spelling, including a legitimate thinking level.
      kept.push(selector);
    }

    if (kept.length > 0) chains[key] = kept;
  }

  // Any nonempty validated chain contains a distinct usable target: self
  // entries were removed above. Provider diversity is not required because
  // OMP tracks model-scoped quota buckets as well as provider availability.
  const usageAwareFallback = Object.values(chains).some((chain) => chain.length > 0);

  return {
    plan: {
      roles,
      chains,
      usageAwareFallback,
      rationale: plan.rationale ?? [],
    },
    warnings,
  };
}

function hasLightweightAlternative(
  workload: RoleWorkload,
  roster: RosterModel[],
  permittedTier: number,
  selected: RosterModel,
): boolean {
  const gateways = gatewayProviders(roster);
  const locals = localProviders(roster);
  const providers = new Set(
    roster
      .filter((model) => (
        providerTier(model.provider, gateways, locals) === permittedTier
        && (!workload.requireVision || model.vision)
      ))
      .map((model) => model.provider),
  );

  for (const provider of providers) {
    const candidates = roster.filter((model) => (
      model.provider === provider
      && (!workload.requireVision || model.vision)
      && !isNativeOppositeOnly(model, "smol")
    ));
    const priced = candidates.filter((model) => priceOf(model) !== null);
    const lowest = priced.length > 0
      ? Math.min(...priced.map((model) => priceOf(model) ?? Number.POSITIVE_INFINITY))
      : null;
    const alternative = candidates.some((model) => (
      model.selector !== selected.selector
      && (model.rolePriority?.smol !== undefined
        || !model.reasoning
        || (lowest !== null && priceOf(model) === lowest))
    ));
    if (alternative) return true;
  }

  return false;
}

/** Enforce capability and provider-tier policy without second-guessing valid LLM choices. */
export function constrainPlanDraft(
  draft: PlanDraft,
  roster: RosterModel[],
  roleNames: readonly string[] = ROLE_NAMES,
): { draft: PlanDraft; warnings: string[] } {
  const roles: Record<string, string> = {};
  const warnings: string[] = [];
  const gateways = gatewayProviders(roster);
  const locals = localProviders(roster);

  for (const role of roleNames) {
    const requested = draft.roles[role];
    const model = requested ? resolveRosterModel(requested, roster) : null;
    const replacement = bestFor(role, roster);
    if (!model) {
      if (requested) warnings.push(`Replaced unavailable ${role} model "${requested}".`);
      if (replacement) roles[role] = replacement.selector;
      continue;
    }

    const permittedTier = replacement
      ? providerTier(replacement.provider, gateways, locals)
      : Number.MAX_SAFE_INTEGER;
    if (providerTier(model.provider, gateways, locals) !== permittedTier) {
      if (replacement) {
        roles[role] = replacement.selector;
        warnings.push(`Replaced ${role} model "${requested}" to preserve the enabled provider tier.`);
      }
      continue;
    }

    const workload = workloadForRole(role);
    if (workload.requireVision && !model.vision) {
      const visionReplacement = bestForWorkload(workload, roster, model.provider, permittedTier) ?? replacement;
      if (visionReplacement) {
        roles[role] = visionReplacement.selector;
        warnings.push(`Replaced ${role} model "${requested}" because it cannot accept image input.`);
      }
      continue;
    }

    const clearLightweightViolation = workload.preferNonReasoning
      && model.rolePriority?.smol === undefined
      && model.reasoning
      && hasLightweightAlternative(workload, roster, permittedTier, model);
    if (clearLightweightViolation) {
      const lightweightReplacement = bestForWorkload(workload, roster, model.provider, permittedTier) ?? replacement;
      if (lightweightReplacement) {
        roles[role] = lightweightReplacement.selector;
        warnings.push(`Replaced ${role} model "${requested}" with a suitable lightweight enabled model.`);
      }
      continue;
    }

    // Reasoning and native priorities guide a proposal, but valid choices in
    // the same provider tier are intentionally left to the planner/user.
    roles[role] = requested.trim();
  }

  const requestedProviders = draft.ladder.filter((provider) => (
    roster.some((model) => model.provider === provider)
  ));
  return {
    draft: {
      ...draft,
      roles,
      ladder: providerOrder(roster, requestedProviders),
    },
    warnings,
  };
}

function rationaleFor(role: string, model: RosterModel): string {
  const workload = workloadForRole(role);
  const native = workload.nativePriority ? nativeRank(model, workload.nativePriority) : undefined;
  if (native !== undefined && workload.nativePriority) {
    return `${model.name} matches OMP's native ${workload.nativePriority} priority for this role.`;
  }

  const price = priceOf(model);
  if (price !== null) {
    if (workload.priceIntent === "lightest") {
      return `${model.name} is the lowest published-cost eligible model on its enabled provider tier.`;
    }
    if (workload.priceIntent === "strongest") {
      return `${model.name} has the highest published-cost eligible tier; price is only a within-provider signal.`;
    }
    return `${model.name} is a balanced published-cost option for delegated multi-step work.`;
  }

  return `${model.name} satisfies this role's enabled provider and capability requirements.`;
}

/** Deterministic proposal when the optional planner model is unavailable. */
export function heuristicPlan(
  roster: RosterModel[],
  options: { preferredProvider?: string; roleNames?: readonly string[] } = {},
): PlanDraft {
  const roles: Record<string, string> = {};
  const rationale: PlanRationale[] = [];

  for (const role of options.roleNames ?? ROLE_NAMES) {
    const model = bestFor(role, roster, options.preferredProvider);
    if (!model) continue;

    roles[role] = model.selector;
    rationale.push({ subject: role, text: rationaleFor(role, model) });
  }

  const ladder = providerOrder(roster, [], options.preferredProvider);
  if (ladder.length > 1) {
    rationale.push({
      subject: "ladder",
      text: [
        `OMP runtime health chooses through ${ladder.join(" → ")}; subscriptions lead, then direct APIs, gateways, and local runtimes.`,
        "Catalog prices distinguish only models within one provider, never live quota or measured quality.",
      ].join(" "),
    });
  }

  return { roles, ladder, rationale };
}
