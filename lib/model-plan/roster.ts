import { getHarness } from "../harness";
import { type OmpLoginProvider, type OmpModel, runUtilityCommand } from "../omp/rpc-utility";

/**
 * The compact model/provider snapshot the role planner reasons about.
 *
 * omp's own catalog entry carries far more than a planner needs (api ids,
 * per-token prices, effort maps). Everything here is either something the
 * planner weighs (capability, reasoning support, cost tier) or something it
 * must echo back verbatim (the `provider/id` selector), so the roster doubles
 * as the allow-list that keeps invented selectors out of config.yml.
 */

export interface RosterModel {
  /** `provider/id` — the exact string omp accepts in modelRoles and chains. */
  selector: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  thinkingEfforts: string[];
  /** Accepts image input (omp catalog `input` includes "image"); the only
   * evidence available for assigning the vision role. */
  vision: boolean;
  /** Costs nothing to call and needs no account — see `buildRoster`. */
  local: boolean;
}

export interface RosterProvider {
  id: string;
  name: string;
  /** Signed in through omp's own login flow (OAuth subscription or stored key). */
  authenticated: boolean;
  modelCount: number;
}

export interface Roster {
  models: RosterModel[];
  providers: RosterProvider[];
}

const MODELS_TIMEOUT_MS = 120_000;
const PROVIDERS_TIMEOUT_MS = 30_000;

export function buildRoster(models: OmpModel[], loginProviders: OmpLoginProvider[]): Roster {
  const authenticated = new Set(loginProviders.filter((provider) => provider.authenticated).map((provider) => provider.id));

  const rosterModels = models.map((model): RosterModel => ({
    selector: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    reasoning: model.reasoning === true,
    thinkingEfforts: model.thinking?.efforts ?? [],
    vision: (model.input ?? []).includes("image"),
    // Local/free from evidence, not a brand list — a hardcoded list of local
    // runtimes goes stale the moment someone points omp at one we never heard
    // of. Two signals, both required: zero (or absent) per-token cost is what
    // every self-hosted runtime looks like in the catalog, but it is also how
    // a subscription provider looks once its plan covers usage, so a provider
    // the user is signed in to is never called local. What survives both tests
    // costs nothing and needs no account: something served on this machine.
    //
    // The signal is per model and the catalog is not perfectly consistent:
    // observed on a live install, three of four models on a self-hosted
    // runtime classified free while the fourth — a widely published open model
    // whose catalog entry carries real prices — did not. Judging the runtime
    // by one such entry would be worse: on a provider that mixes a free tier
    // with paid models it would mark genuinely priced models free. Provider
    // scope belongs to the fallback ladder, which ranks a provider local when
    // any model it serves is (see heuristicPlan).
    //
    // The distinction is load-bearing: a local model is the right home for
    // constant cheap background work and the right last rung of a fallback
    // ladder, and the wrong choice for the main session.
    local: [model.cost?.input, model.cost?.output, model.cost?.cacheRead, model.cost?.cacheWrite].every((rate) => !rate)
      && !authenticated.has(model.provider),
  }));

  const providerNames = new Map(loginProviders.map((provider) => [provider.id, provider.name]));
  const modelCounts = new Map<string, number>();
  for (const model of rosterModels) modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);

  return {
    models: rosterModels,
    providers: [...modelCounts.entries()].map(([id, modelCount]): RosterProvider => ({
      id,
      name: providerNames.get(id) ?? id,
      authenticated: authenticated.has(id),
      modelCount,
    })),
  };
}

/**
 * Snapshot the installed omp's live registry: every model it can currently
 * reach, plus which providers the user is signed in to.
 *
 * Refuses under any other engine rather than spawning omp behind it. Its one
 * caller (/api/model-plan) is already gated, so this is the module refusing
 * on its own account: `runUtilityCommand` with no launch means "the installed
 * omp", and a helper that quietly does that while another engine is active is
 * the shape of the bug this whole change exists to remove. It also disposes a
 * live pi utility child as a side effect, since that child is keyed by engine.
 */
export async function loadRoster(): Promise<Roster> {
  const active = getHarness();
  if (active.id !== "omp") {
    throw new Error(`The model-roles roster reads omp's registry, and ${active.displayName} is the active engine.`);
  }
  const { models } = await runUtilityCommand<{ models: OmpModel[] }>({ type: "get_available_models" }, MODELS_TIMEOUT_MS);
  const { providers } = await runUtilityCommand<{ providers: OmpLoginProvider[] }>({ type: "get_login_providers" }, PROVIDERS_TIMEOUT_MS);
  return buildRoster(models, providers);
}
