import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { bestAvailableModel, deriveChains, heuristicPlan, resolveRosterModel, ROLE_NAMES, validatePlan } from "@/lib/model-plan/derive";
import { planWithModel } from "@/lib/model-plan/planner";
import { loadRoster, type RosterModel } from "@/lib/model-plan/roster";
import { readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";
import { readNativeSettings, writeNativeSettings } from "@/lib/omp/settings-config";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

// A planner has to read a roster of every installed model and answer with a
// JSON object. Nothing else about the model matters — capability filters here
// would quietly hide the model the user actually wants to spend — but a context
// window this small cannot hold the roster, so the call would fail outright.
const MIN_PLANNER_CONTEXT = 8_000;

function plannerCandidates(models: RosterModel[]): RosterModel[] {
  // A null context window means the catalog does not say, not that it is small.
  return models.filter((model) => model.contextWindow === null || model.contextWindow >= MIN_PLANNER_CONTEXT);
}

export async function GET() {
  try {
    const roster = await loadRoster();
    const { roles } = readModelRoles();
    const { settings } = readNativeSettings();
    const candidates = plannerCandidates(roster.models);
    // The model already driving main turns is the one the user has decided to
    // trust, so it plans unless it is a local model — planning is a one-off
    // call where the good model is worth it.
    const current = roles.default ? resolveRosterModel(roles.default, candidates) : null;
    const suggested = current && !current.local ? current : bestAvailableModel(candidates);

    return NextResponse.json({
      plannerCandidates: candidates.map((model) => ({ selector: model.selector, label: model.name, provider: model.provider })),
      suggested: suggested?.selector ?? null,
      roles,
      chains: settings.retry?.fallbackChains ?? {},
      usageAwareFallback: settings.retry?.usageAwareFallback ?? false,
      roleNames: [...ROLE_NAMES],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { plannerModel?: unknown; mode?: unknown };
    const roster = await loadRoster();
    if (roster.models.length === 0) {
      return NextResponse.json({ error: "omp reports no available models. Sign in to a provider first." }, { status: 409 });
    }

    const warnings: string[] = [];
    const heuristic = heuristicPlan(roster.models);
    let draft = heuristic;
    let source: "llm" | "heuristic" = "heuristic";

    if (body.mode !== "heuristic") {
      const requested = typeof body.plannerModel === "string" ? body.plannerModel.trim() : "";
      const planner = requested || bestAvailableModel(plannerCandidates(roster.models))?.selector;
      if (!planner) {
        warnings.push("No model here can run the planner, so this is Cody's own suggestion.");
      } else {
        const outcome = await planWithModel(planner, roster);
        if (outcome.ok) {
          draft = outcome.draft;
          source = "llm";
        } else {
          warnings.push(`${planner} could not plan this (${outcome.reason}), so this is Cody's own suggestion.`);
        }
      }
    }

    // Chains are derived from the ladder, so a plan whose ladder is empty or
    // names providers that do not exist derives no chains at all — which is
    // exactly the failure this feature exists to prevent. Keep the rungs that
    // are real; if none are, degrade to the ladder Cody computed itself.
    const ladder = [...new Set(draft.ladder.filter((id) => roster.providers.some((provider) => provider.id === id)))];
    const chains = deriveChains({
      roles: draft.roles,
      ladder: ladder.length > 0 ? ladder : heuristic.ladder,
      roster: roster.models,
    });
    const validated = validatePlan({ roles: draft.roles, chains, rationale: draft.rationale }, roster.models);

    return NextResponse.json({ plan: validated.plan, source, warnings: [...warnings, ...validated.warnings] });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { roles?: unknown; chains?: unknown; usageAwareFallback?: unknown };
    if (!isRecord(body.roles)) return NextResponse.json({ error: "roles must be an object" }, { status: 400 });
    if (!isRecord(body.chains)) return NextResponse.json({ error: "chains must be an object" }, { status: 400 });
    if (body.usageAwareFallback !== undefined && typeof body.usageAwareFallback !== "boolean") {
      return NextResponse.json({ error: "usageAwareFallback must be a boolean" }, { status: 400 });
    }

    const roles: Record<string, string> = {};
    for (const [role, selector] of Object.entries(body.roles)) {
      if (!ROLE_NAMES.includes(role)) return NextResponse.json({ error: `Unknown role "${role}"` }, { status: 400 });
      if (typeof selector !== "string" || !selector.trim()) {
        return NextResponse.json({ error: `Role "${role}" needs a model selector` }, { status: 400 });
      }
      roles[role] = selector.trim();
    }

    const chains: Record<string, string[]> = {};
    for (const [key, chain] of Object.entries(body.chains)) {
      if (!key.trim()) return NextResponse.json({ error: "A fallback chain needs a role or model key" }, { status: 400 });
      if (!Array.isArray(chain)) return NextResponse.json({ error: `Fallback chain "${key}" must be an array` }, { status: 400 });
      const selectors: string[] = [];
      for (const selector of chain) {
        if (typeof selector !== "string" || !selector.trim()) {
          return NextResponse.json({ error: `Fallback chain "${key}" contains an empty model selector` }, { status: 400 });
        }
        selectors.push(selector.trim());
      }
      // omp reads an empty array as "a chain exists and it is empty", which
      // denies the role the `default` chain it would otherwise inherit.
      if (selectors.length > 0) chains[key] = selectors;
    }

    writeModelRoles(roles);
    // Read-then-merge: the retry block also carries the user's retry count,
    // enable flag and revert policy, and this endpoint owns none of those.
    const { settings } = readNativeSettings();
    writeNativeSettings({
      retry: {
        ...settings.retry,
        fallbackChains: chains,
        ...(typeof body.usageAwareFallback === "boolean" ? { usageAwareFallback: body.usageAwareFallback } : {}),
      },
    });
    invalidateModelsCache();
    return NextResponse.json({ success: true, roles, chains });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
