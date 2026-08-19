import type { RosterModel } from "./roster";

/**
 * Pure planning arithmetic: role assignment -> retry fallback chains.
 *
 * No I/O here on purpose. Everything that decides what lands in the user's
 * config.yml is a plain function over a roster snapshot, so the invariants
 * below are testable without an omp process or a model call.
 */

/** The roles Cody exposes, in the order the Models panel lists them
 * (components/ModelsConfig.tsx NATIVE_MODEL_ROLES). */
export const ROLE_NAMES: readonly string[] = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
];

export interface PlanRationale {
  /** A role name, or a topic like "ladder" — the UI groups on this. */
  subject: string;
  text: string;
}

/** What a planner (LLM or heuristic) decides: assignments plus the order in
 * which quality is allowed to degrade. Chains are derived, never authored. */
export interface PlanDraft {
  roles: Record<string, string>;
  /** Provider ids, best first. */
  ladder: string[];
  rationale: PlanRationale[];
}

export interface ModelPlan {
  roles: Record<string, string>;
  chains: Record<string, string[]>;
  usageAwareFallback: boolean;
  rationale: PlanRationale[];
}

// The provider is the FIRST path segment, not everything before the last "/":
// gateway model ids can themselves contain slashes.
function providerOf(selector: string): string {
  const slash = selector.indexOf("/");
  return slash === -1 ? selector : selector.slice(0, slash);
}

/**
 * Find a plan selector in the roster.
 *
 * Exact match first, because a model id can itself contain a colon
 * (self-hosted tags such as `qwen3:8b`); the optional `:thinking` suffix may
 * only be stripped once the verbatim string has been ruled out as a real model.
 */
export function resolveRosterModel(selector: string, roster: RosterModel[]): RosterModel | null {
  if (!selector || !selector.trim()) return null;
  const exact = roster.find((model) => model.selector === selector);
  if (exact) return exact;
  const colon = selector.lastIndexOf(":");
  if (colon <= selector.lastIndexOf("/")) return null;
  const base = selector.slice(0, colon);
  return roster.find((model) => model.selector === base) ?? null;
}

// Best first. Reasoning support leads because it is the only catalog signal
// that separates a deep-thinking model from a chat model; context window and
// output budget rank the rest, and the selector breaks ties so the same roster
// always yields the same plan.
function compareCapability(a: RosterModel, b: RosterModel): number {
  return Number(b.reasoning) - Number(a.reasoning)
    || (b.contextWindow ?? 0) - (a.contextWindow ?? 0)
    || (b.maxTokens ?? 0) - (a.maxTokens ?? 0)
    || a.selector.localeCompare(b.selector);
}

/**
 * The model to reach for whenever a plan needs "the good one": the strongest
 * model on a provider the user pays for or is signed in to, and a local model
 * only when the roster offers nothing else. Shared by the planner suggestion,
 * the heuristic assignment and the repair path so all three agree.
 */
export function bestAvailableModel(roster: RosterModel[]): RosterModel | null {
  const byCapability = [...roster].sort(compareCapability);
  return byCapability.find((model) => !model.local) ?? byCapability[0] ?? null;
}

/**
 * The closest thing `provider` offers to `reference`. Reasoning support has to
 * match — substituting a chat model for a thinking model changes what the role
 * can do — and among the models that match, the largest context window is the
 * nearest equivalent the catalog can express.
 */
function equivalentOn(provider: string, reference: RosterModel | null, roster: RosterModel[]): RosterModel | null {
  const candidates = roster.filter((model) => model.provider === provider);
  if (candidates.length === 0) return null;
  const sameKind = reference ? candidates.filter((model) => model.reasoning === reference.reasoning) : [];
  return (sameKind.length > 0 ? sameKind : candidates).sort(compareCapability)[0];
}

/**
 * Turn role assignments plus a provider ladder into omp's retry.fallbackChains.
 *
 * The invariant that makes this worth deriving instead of hand-writing: omp
 * resolves a SUBAGENT's chain as `fallbackChains[roleName] ?? fallbackChains.default`.
 * Provider/model wildcard keys are never consulted for that lookup — they only
 * apply to the model active in the main session. A config carrying wildcards
 * alone therefore leaves every subagent with no chain at all, and the first
 * usage limit it meets is fatal: the subagent dies with zero assistant turns.
 * So every assigned role gets its own key, `default` is always attempted as
 * the inheritance safety net, and the wildcard keys are emitted *in addition*.
 */
export function deriveChains(args: { roles: Record<string, string>; ladder: string[]; roster: RosterModel[] }): Record<string, string[]> {
  const { roles, ladder, roster } = args;
  const chains: Record<string, string[]> = {};
  // Stand-in reference for a role whose own model cannot be resolved, and for
  // the synthesized `default` chain below.
  const best = bestAvailableModel(roster);

  const walk = (from: number, reference: RosterModel | null, own: string | null): string[] => {
    const chain: string[] = [];
    for (const provider of ladder.slice(from)) {
      const substitute = equivalentOn(provider, reference, roster);
      // Skip a provider with nothing usable, the role's own model (retrying
      // the model that just failed is the one useless rung), and any selector
      // already on the chain.
      if (!substitute || substitute.selector === own || chain.includes(substitute.selector)) continue;
      chain.push(substitute.selector);
    }
    return chain;
  };

  for (const [role, selector] of Object.entries(roles)) {
    const own = resolveRosterModel(selector, roster);
    // indexOf + 1 lands on 0 for a provider that is not on the ladder, which
    // walks the whole ladder: every rung is a genuine alternative to a model
    // whose own provider was never ranked. Same arithmetic skips exactly one
    // provider when it is ranked.
    const chain = walk(ladder.indexOf(providerOf(selector)) + 1, own ?? best, own?.selector ?? selector);
    // An empty array reads to omp as "a chain exists and it is empty", which
    // is worse than no key: with no key the role inherits `default`.
    if (chain.length > 0) chains[role] = chain;
  }

  if (!roles.default) {
    // No default assignment means the main session runs on whatever model omp
    // resolves, so there is no own provider to skip and no own model to
    // exclude: walk the entire ladder, matched against the best model around.
    const chain = walk(0, best, null);
    if (chain.length > 0) chains.default = chain;
  }

  // Model-oriented keys, the other half of the story: a role-keyed chain only
  // rescues the role whose model failed. When a whole provider's quota is
  // exhausted, every other model of that provider is a dead end unless the
  // provider itself has a chain, and `<provider>/*` is the key omp consults
  // for the model in the main session.
  const references = new Map<string, RosterModel>();
  for (const selector of Object.values(roles)) {
    const model = resolveRosterModel(selector, roster);
    if (!model) continue;
    const current = references.get(model.provider);
    // A provider can own several assignments (a strong model and a cheap one);
    // matching its wildcard chain against the strongest keeps the substitute
    // from being weaker than the work the provider was trusted with.
    if (!current || compareCapability(model, current) < 0) references.set(model.provider, model);
  }
  for (const [provider, reference] of references) {
    const chain = walk(ladder.indexOf(provider) + 1, reference, reference.selector);
    // The last rung of the ladder has nothing below it: no key at all.
    if (chain.length > 0) chains[`${provider}/*`] = chain;
  }

  return chains;
}

/**
 * Reconcile a plan with the roster it will actually be written against, and
 * report every change in words the UI can show.
 *
 * `usageAwareFallback` is recomputed here rather than carried in: it is a
 * function of the final assignment, and a repair or a drop can change how many
 * providers the plan spans.
 */
export function validatePlan(
  plan: { roles: Record<string, string>; chains: Record<string, string[]>; rationale?: PlanRationale[] },
  roster: RosterModel[],
): { plan: ModelPlan; warnings: string[] } {
  const warnings: string[] = [];
  // Repairs land on the best model the user can actually reach.
  const repair = bestAvailableModel(roster);

  const roles: Record<string, string> = {};
  for (const [role, selector] of Object.entries(plan.roles)) {
    if (!ROLE_NAMES.includes(role)) {
      // An invented role name would survive all the way to the save, where the
      // PUT rejects it and the user sees a 400 instead of their plan.
      warnings.push(`Ignored "${role}": not a role Cody assigns.`);
      continue;
    }
    if (resolveRosterModel(selector, roster)) {
      roles[role] = selector;
      continue;
    }
    if (!repair) {
      warnings.push(`Dropped ${role}: "${selector}" is not available and there is no model to replace it with.`);
      continue;
    }
    warnings.push(`"${selector}" is not an available model; ${role} now uses ${repair.selector}.`);
    roles[role] = repair.selector;
  }

  const chains: Record<string, string[]> = {};
  for (const [key, chain] of Object.entries(plan.chains)) {
    // A repaired role can collide with its own chain (the chain was derived
    // against the model that vanished), so the own-model rule is re-applied
    // against the assignment as it stands now.
    const own = roles[key] ? resolveRosterModel(roles[key], roster)?.selector : undefined;
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const selector of chain) {
      const model = resolveRosterModel(selector, roster);
      if (!model) {
        warnings.push(`Dropped "${selector}" from the ${key} fallback chain: not an available model.`);
        continue;
      }
      if (model.selector === own || seen.has(model.selector)) continue;
      seen.add(model.selector);
      kept.push(selector);
    }
    if (kept.length > 0) {
      chains[key] = kept;
      continue;
    }
    if (chain.length > 0) warnings.push(`Removed the ${key} fallback chain: none of its models are available.`);
  }

  const providers = new Set(Object.values(roles).map(providerOf));
  return {
    plan: { roles, chains, usageAwareFallback: providers.size >= 2, rationale: plan.rationale ?? [] },
    warnings,
  };
}

/**
 * The no-model-call path: the plan Cody proposes when the user declines the
 * LLM step, and the fallback whenever the planner call fails. Capability
 * ordering is all it has — the catalog carries no per-role quality signal — so
 * it sorts the roster and places the tiers.
 */
export function heuristicPlan(roster: RosterModel[]): PlanDraft {
  const byCapability = [...roster].sort(compareCapability);
  const roles: Record<string, string> = {};
  const rationale: PlanRationale[] = [];
  const capable = bestAvailableModel(roster);
  if (!capable) return { roles, ladder: [], rationale };

  // Local models are free but share the machine with the session, so the tiers
  // above `tiny` are drawn from models on a provider the user pays for or is
  // signed in to — unless that is all the roster has.
  const local = byCapability.filter((model) => model.local);
  const reachable = byCapability.filter((model) => !model.local);
  const pool = reachable.length > 0 ? reachable : byCapability;
  // "Cheap" without price data: the strongest NON-reasoning model on the same
  // pool. Non-reasoning because a thinking model spends tokens before it
  // answers, which is exactly wrong for mechanical work; strongest of those
  // because the alternative — the weakest model in the roster — is usually a
  // legacy entry nobody wants driving a subagent. With nothing but reasoning
  // models around, the cheapest tier is the weakest of them.
  const fast = pool.filter((model) => !model.reasoning)[0] ?? pool.at(-1) ?? capable;
  const vision = pool.find((model) => model.vision) ?? byCapability.find((model) => model.vision);

  const assign = (role: string, model: RosterModel | undefined, text: string): void => {
    if (!model) return;
    roles[role] = model.selector;
    rationale.push({ subject: role, text });
  };

  assign("default", capable, `${capable.name} is the most capable model you can reach, so it drives main turns.`);
  assign("task", capable, `Subagents do the same work as the main session, so they get ${capable.name} too.`);
  assign("plan", capable, `Planning is where reasoning pays off, so it stays on ${capable.name}.`);
  assign("slow", capable, `The deliberate role keeps ${capable.name} for problems worth the extra thinking.`);
  assign("designer", capable, `Design work reads screenshots and layout code, so it keeps ${capable.name}.`);
  assign("smol", fast, `${fast.name} answers mechanical subagent work without paying for reasoning first.`);
  assign("commit", fast, `Commit messages are short and formulaic — ${fast.name} is enough.`);
  assign("advisor", fast, `The advisor reviews every single turn, so it runs on the cheaper ${fast.name}.`);
  assign(
    "tiny",
    local[0] ?? fast,
    local[0]
      ? `Titles and classifiers run constantly, and ${local[0].name} is served locally, so they cost nothing.`
      : `${fast.name} is the cheapest model available for constant background work like titles.`,
  );
  if (vision) assign("vision", vision, `${vision.name} is the strongest model here that accepts images.`);

  // One rung per provider, its best model standing in for it, with paid or
  // signed-in providers first and local runtimes last so quality degrades in
  // the order the user would choose themselves.
  //
  // Localness is judged per PROVIDER here, not from the rung's own model: a
  // self-hosted runtime serves whatever names its operator loaded, and the
  // catalog does publish real prices for some of those names. Ranking on the
  // best model's own flag let such an entry pull the whole runtime above a paid
  // provider (seen on a live install), which is how a rate-limited session ends
  // up on local hardware while a subscription still has quota.
  const localProviders = new Set(local.map((model) => model.provider));
  const bestPerProvider = new Map<string, RosterModel>();
  for (const model of byCapability) if (!bestPerProvider.has(model.provider)) bestPerProvider.set(model.provider, model);
  const ladder = [...bestPerProvider.values()]
    .sort((a, b) => Number(localProviders.has(a.provider)) - Number(localProviders.has(b.provider)) || compareCapability(a, b))
    .map((model) => model.provider);
  if (ladder.length > 1) {
    rationale.push({
      subject: "ladder",
      text: `When a provider runs out, work moves down ${ladder.join(" → ")} to that provider's nearest equivalent model.`,
    });
  }

  return { roles, ladder, rationale };
}
