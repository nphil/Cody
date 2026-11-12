import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getHarness } from "../harness";
import { readCatalogRoleDefaults } from "../omp/bundled-catalog";
import { getOmpPackageRoot } from "../omp/settings-schema";
import { type OmpLoginProvider, type OmpModel, runUtilityCommand } from "../omp/rpc-utility";

/** Native OMP role-priority lists: the `smol` and `slow` chains omp ranks its own models by. */
export interface NativeRolePriorityLists {
  smol?: readonly string[];
  slow?: readonly string[];
}

/** Compact live OMP model/provider snapshot used as the planner allow-list. */
export interface RosterModel {
  selector: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  thinkingEfforts: string[];
  vision: boolean;
  /** True only when the model endpoint is a loopback or private-network URL. */
  local: boolean;
  /** Published per-token cost: tier evidence only, never subscription quota. */
  relativeCost: number | null;
  /** Zero-based native OMP suitability ranks, when omp's own smol/slow chains recognise it. */
  rolePriority?: {
    smol?: number;
    slow?: number;
  };
}

export interface RosterProvider {
  id: string;
  name: string;
  authenticated: boolean;
  modelCount: number;
}

export interface Roster {
  models: RosterModel[];
  providers: RosterProvider[];
}

const MODELS_TIMEOUT_MS = 120_000;
const PROVIDERS_TIMEOUT_MS = 30_000;

type EndpointModel = OmpModel & {
  baseUrl?: unknown;
  baseURL?: unknown;
};

function normalizedPriorityList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Ignore an incomplete or malformed asset as a whole. Native hints improve a
 * proposal, but the installed registry remains enough to produce one.
 */
function normalizeNativeRolePriorities(value: unknown): NativeRolePriorityLists | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const smol = raw.smol === undefined ? undefined : normalizedPriorityList(raw.smol);
  const slow = raw.slow === undefined ? undefined : normalizedPriorityList(raw.slow);

  if ((raw.smol !== undefined && !smol) || (raw.slow !== undefined && !slow)) return undefined;
  if (!smol && !slow) return undefined;

  return {
    ...(smol ? { smol } : {}),
    ...(slow ? { slow } : {}),
  };
}

let warnedNativeRoleHints = false;

/**
 * Read OMP's shipped role hints without coupling plan generation to a version.
 * Newer omp keeps them in its catalog package's compiled rules
 * (`behavior.roleDefaults`); older omp shipped `smol` and `slow` as
 * `<root>/src/priority.json`. Either is optional: with neither, planning goes
 * on without native ranks.
 */
export function readNativeRolePriorities(packageRoot: string | null = getOmpPackageRoot()): NativeRolePriorityLists | undefined {
  if (!packageRoot) return undefined;

  const catalog = readCatalogRoleDefaults(packageRoot);
  if (catalog.ok) {
    const lists = normalizeNativeRolePriorities(catalog.defaults);
    if (lists) return lists;
  }

  try {
    const assetPath = join(packageRoot, "src", "priority.json");
    if (existsSync(assetPath)) {
      const lists = normalizeNativeRolePriorities(JSON.parse(readFileSync(assetPath, "utf8")) as unknown);
      if (lists) return lists;
    }
  } catch {
    // An unreadable asset is the same as an absent one.
  }

  if (!warnedNativeRoleHints) {
    warnedNativeRoleHints = true;
    console.warn(`[cody] model plan: omp's own smol/slow ranking could not be read, so plans go by price alone (${catalog.ok ? "its role defaults hold no smol or slow list" : catalog.reason})`);
  }
  return undefined;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;

  const values = octets.map((octet) => Number(octet));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;

  return values[0] === 10
    || values[0] === 127
    || (values[0] === 172 && values[1] >= 16 && values[1] <= 31)
    || (values[0] === 192 && values[1] === 168)
    || (values[0] === 169 && values[1] === 254);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  if (/^f[cd][0-9a-f]*:/.test(normalized)) return true;
  return /^fe[89ab][0-9a-f]*:/.test(normalized);
}

/**
 * Zero prices are common for subscriptions and free remote gateways. Only an
 * endpoint address itself can prove that a model is local to the user's network.
 */
function hasLocalEndpoint(model: OmpModel): boolean {
  const endpoint = model as EndpointModel;
  const baseUrl = typeof endpoint.baseUrl === "string"
    ? endpoint.baseUrl
    : typeof endpoint.baseURL === "string"
      ? endpoint.baseURL
      : undefined;
  if (!baseUrl) return false;

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || isPrivateIpv4(hostname)
    || isPrivateIpv6(hostname);
}

function priorityRank(
  priorities: readonly string[] | undefined,
  selector: string,
  id: string,
): number | undefined {
  if (!priorities) return undefined;

  let rank: number | undefined;
  for (let index = 0; index < priorities.length; index += 1) {
    const candidate = priorities[index];
    // OMP's list includes aliases for its own fuzzy resolver. Cody deliberately
    // uses only an exact full selector or exact bare model id.
    if (candidate === selector || candidate === id) rank = Math.min(rank ?? index, index);
  }
  return rank;
}

function priorityForModel(
  model: OmpModel,
  selector: string,
  priorities: NativeRolePriorityLists | undefined,
): RosterModel["rolePriority"] | undefined {
  const smol = priorityRank(priorities?.smol, selector, model.id);
  const slow = priorityRank(priorities?.slow, selector, model.id);
  if (smol === undefined && slow === undefined) return undefined;

  return {
    ...(smol === undefined ? {} : { smol }),
    ...(slow === undefined ? {} : { slow }),
  };
}

/**
 * Builds a registry snapshot. The optional third argument makes native priority
 * behavior deterministic in tests without requiring an installed OMP package.
 */
export function buildRoster(
  models: OmpModel[],
  loginProviders: OmpLoginProvider[],
  nativeRolePriorities?: NativeRolePriorityLists,
): Roster {
  const priorities = nativeRolePriorities === undefined
    ? undefined
    : normalizeNativeRolePriorities(nativeRolePriorities);
  const authenticated = new Set(
    loginProviders.filter((provider) => provider.authenticated).map((provider) => provider.id),
  );
  const seenSelectors = new Set<string>();
  const rosterModels: RosterModel[] = [];

  for (const model of models) {
    const selector = `${model.provider}/${model.id}`;
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);

    const input = model.cost?.input;
    const output = model.cost?.output;
    const priced = typeof input === "number"
      && Number.isFinite(input)
      && typeof output === "number"
      && Number.isFinite(output)
      && input >= 0
      && output >= 0
      && (input > 0 || output > 0);
    const rolePriority = priorityForModel(model, selector, priorities);

    rosterModels.push({
      selector,
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      reasoning: model.reasoning === true,
      thinkingEfforts: model.thinking?.efforts ?? [],
      vision: (model.input ?? []).includes("image"),
      local: hasLocalEndpoint(model),
      relativeCost: priced ? input + output : null,
      ...(rolePriority ? { rolePriority } : {}),
    });
  }

  const providerNames = new Map(loginProviders.map((provider) => [provider.id, provider.name]));
  const modelCounts = new Map<string, number>();
  for (const model of rosterModels) {
    modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  }

  return {
    models: rosterModels,
    providers: [...modelCounts.entries()].map(([id, modelCount]) => ({
      id,
      name: providerNames.get(id) ?? id,
      authenticated: authenticated.has(id),
      modelCount,
    })),
  };
}

/** Read the installed OMP registry rather than a hand-maintained catalog. */
export async function loadRoster(): Promise<Roster> {
  const active = getHarness();
  if (active.id !== "omp") {
    throw new Error(
      `The model-roles roster reads omp's registry, and ${active.displayName} is the active engine.`,
    );
  }

  const { models } = await runUtilityCommand<{ models: OmpModel[] }>(
    { type: "get_available_models" },
    MODELS_TIMEOUT_MS,
  );
  const { providers } = await runUtilityCommand<{ providers: OmpLoginProvider[] }>(
    { type: "get_login_providers" },
    PROVIDERS_TIMEOUT_MS,
  );

  return buildRoster(models, providers, readNativeRolePriorities());
}
