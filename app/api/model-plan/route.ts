import { NextResponse } from "next/server";
import { requireEngine } from "@/lib/engine-guard";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  constrainPlanDraft,
  deriveChains,
  heuristicPlan,
  planRoleNames,
  validatePlan,
} from "@/lib/model-plan/derive";
import { plannerCandidates, savedDefaultProvider, suggestedPlanner } from "@/lib/model-plan/planner-candidates";
import { planWithModel } from "@/lib/model-plan/planner";
import { loadRoster } from "@/lib/model-plan/roster";
import { clearModelRoles, getOmpModelRoleIds, readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";
import {
  deleteNativeSettingsPaths,
  readNativeSettings,
  writeNativeSettings,
} from "@/lib/omp/settings-config";
import { restartIdleRpcSessions } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/**
 * The model-roles planner reads OMP's live registry (a --no-session child) and
 * writes OMP's config.yml. Under another engine it would plan roles nobody
 * consults, using a roster that engine cannot reach.
 */
const SURFACE = "The OMP model-roles planner";

/** The roles this engine has and Cody assigns. `widget` exists only from omp
 * 18.12.3, so on an older engine it is neither offered, proposed nor written
 * (an unknown key is inert there, but would show a role nothing consults). */
function assignableRoles(): readonly string[] {
  return planRoleNames(getOmpModelRoleIds());
}

function savedCustomRoles(roles: Record<string, string>, assignable: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(roles).filter(([role]) => !assignable.includes(role)));
}

export async function GET() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;

    const roster = await loadRoster();
    const { roles } = readModelRoles();
    const { settings } = readNativeSettings();
    const candidates = plannerCandidates(roster.models);
    const preferredProvider = savedDefaultProvider(roles.default, roster.models);
    const suggested = suggestedPlanner(roles.default, candidates, preferredProvider);

    return NextResponse.json({
      plannerCandidates: candidates.map((model) => ({
        selector: model.selector,
        label: model.name,
        provider: model.provider,
      })),
      suggested: suggested?.selector ?? null,
      roles,
      chains: settings.retry?.fallbackChains ?? {},
      usageAwareFallback: settings.retry?.usageAwareFallback ?? false,
      roleNames: [...assignableRoles()],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;

    const body = await request.json().catch(() => ({})) as {
      plannerModel?: unknown;
      mode?: unknown;
    };
    const roster = await loadRoster();
    if (roster.models.length === 0) {
      return NextResponse.json(
        { error: "omp reports no available models. Sign in to a provider first." },
        { status: 409 },
      );
    }

    const warnings: string[] = [];
    const currentDefault = readModelRoles().roles.default;
    const preferredProvider = savedDefaultProvider(currentDefault, roster.models);
    const roleNames = assignableRoles();
    const heuristic = heuristicPlan(roster.models, { preferredProvider, roleNames });
    let draft = heuristic;
    let source: "llm" | "heuristic" = "heuristic";

    if (body.mode !== "heuristic") {
      const requested = typeof body.plannerModel === "string" ? body.plannerModel.trim() : "";
      const planner = requested || suggestedPlanner(
        currentDefault,
        plannerCandidates(roster.models),
        preferredProvider,
      )?.selector;
      if (!planner) {
        warnings.push("No model here can run the planner, so this is Cody's own suggestion.");
      } else {
        const outcome = await planWithModel(planner, roster, roleNames);
        if (outcome.ok) {
          draft = outcome.draft;
          source = "llm";
        } else {
          warnings.push(
            `${planner} could not plan this (${outcome.reason}), so this is Cody's own suggestion.`,
          );
        }
      }
    }

    const constrained = constrainPlanDraft(draft, roster.models, roleNames);
    draft = constrained.draft;
    warnings.push(...constrained.warnings);

    // constrainPlanDraft preserves an LLM's within-tier order while adding
    // every enabled provider, so no model can remove the opposite subscription
    // or a later direct/gateway/local escape from the generated chains.
    const chains = deriveChains({
      roles: draft.roles,
      ladder: draft.ladder,
      roster: roster.models,
      roleNames,
    });
    const validated = validatePlan(
      { roles: draft.roles, chains, rationale: draft.rationale },
      roster.models,
      roleNames,
    );
    const { settings } = readNativeSettings();
    if (validated.plan.usageAwareFallback && settings.retry?.modelFallback === false) {
      warnings.push(
        "Fallback chains are proposed, but OMP's retry.modelFallback setting is disabled, so automatic fallback is not currently active.",
      );
    }

    return NextResponse.json({
      plan: validated.plan,
      source,
      warnings: [...warnings, ...validated.warnings],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;

    const body = await request.json() as {
      roles?: unknown;
      chains?: unknown;
      usageAwareFallback?: unknown;
    };
    if (!isRecord(body.roles)) {
      return NextResponse.json({ error: "roles must be an object" }, { status: 400 });
    }
    if (!isRecord(body.chains)) {
      return NextResponse.json({ error: "chains must be an object" }, { status: 400 });
    }
    if (body.usageAwareFallback !== undefined && typeof body.usageAwareFallback !== "boolean") {
      return NextResponse.json({ error: "usageAwareFallback must be a boolean" }, { status: 400 });
    }

    const assignable = assignableRoles();
    const roles: Record<string, string> = {};
    for (const [role, selector] of Object.entries(body.roles)) {
      if (!assignable.includes(role)) {
        return NextResponse.json({ error: `Unknown role "${role}"` }, { status: 400 });
      }
      if (typeof selector !== "string" || !selector.trim()) {
        return NextResponse.json(
          { error: `Role "${role}" needs a model selector` },
          { status: 400 },
        );
      }
      roles[role] = selector.trim();
    }

    const chains: Record<string, string[]> = {};
    for (const [key, chain] of Object.entries(body.chains)) {
      if (!key.trim()) {
        return NextResponse.json(
          { error: "A fallback chain needs a role or model key" },
          { status: 400 },
        );
      }
      if (!Array.isArray(chain)) {
        return NextResponse.json(
          { error: `Fallback chain "${key}" must be an array` },
          { status: 400 },
        );
      }

      const selectors: string[] = [];
      for (const selector of chain) {
        if (typeof selector !== "string" || !selector.trim()) {
          return NextResponse.json(
            { error: `Fallback chain "${key}" contains an empty model selector` },
            { status: 400 },
          );
        }
        selectors.push(selector.trim());
      }

      // OMP treats an empty array as an explicit empty chain, which prevents a
      // role from inheriting default. Omit it instead.
      if (selectors.length > 0) chains[key.trim()] = selectors;
    }

    writeModelRoles({ ...savedCustomRoles(readModelRoles().roles, assignable), ...roles });
    // Read-then-merge: this endpoint owns fallback chains and the usage-aware
    // switch, never retry.modelFallback, retry count, or revert policy.
    const { settings } = readNativeSettings();
    writeNativeSettings({
      retry: {
        ...settings.retry,
        fallbackChains: chains,
        ...(typeof body.usageAwareFallback === "boolean"
          ? { usageAwareFallback: body.usageAwareFallback }
          : {}),
      },
    });
    invalidateModelsCache();

    // A live OMP child reads config.yml at spawn. Idle children can restart now
    // while running turns safely finish on the prior plan.
    const { restarted, active } = await restartIdleRpcSessions();
    return NextResponse.json({ success: true, roles, chains, restarted, active });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

/** Reset only values the plan writes, preserving unrelated retry tuning. */
export async function DELETE() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;

    const assignable = assignableRoles();
    const persistedRoles = readModelRoles().roles;
    const customRoles = savedCustomRoles(persistedRoles, assignable);
    const clearedRoles = Object.keys(persistedRoles).some((role) => assignable.includes(role))
      ? (Object.keys(customRoles).length > 0 ? (writeModelRoles(customRoles), true) : clearModelRoles())
      : false;
    const clearedPaths = deleteNativeSettingsPaths([
      "retry.fallbackChains",
      "retry.usageAwareFallback",
    ]);
    invalidateModelsCache();
    const { restarted, active } = await restartIdleRpcSessions();
    return NextResponse.json({
      success: true,
      cleared: clearedRoles || clearedPaths.length > 0,
      restarted,
      active,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
