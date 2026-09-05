"use client";

/**
 * Settings › Models › Assignments (omp, `capabilities.models`): which model
 * plays each role, what happens when one fails, and the planner that
 * proposes both. Three views behind one segmented control so a long
 * fallback-chain editor never pushes the roles off screen.
 *
 * The role and chain pickers offer the models that reach sessions AND are
 * visible to this user; a role already on a hidden model is flagged in
 * `ModelRoles` rather than silently re-pointed.
 */
import { useEffect, useState } from "react";
import { useSettingsShell } from "../shell-context";
import type { ModelCatalogHandle } from "@/hooks/useModelCatalog";
import { ModelPlanPanel } from "../ModelPlanPanel";
import { RetryFallbackPanel, type RuntimeModelEntry } from "../RetryFallbackPanel";
import { ModelRoles, type RoleModelOption } from "./ModelRoles";

type View = "roles" | "retry" | "plan";

const VIEWS: { id: View; label: string }[] = [
  { id: "roles", label: "Roles" },
  { id: "retry", label: "Retry & fallback" },
  { id: "plan", label: "Plan" },
];

/** Search ids that live on the retry view: the retry keys' schema ids (the
 * Behavior hub trails them here) and the panel's own toggle. */
function retryViewOwns(highlight: string | null): boolean {
  return highlight !== null && (highlight.startsWith("schema-retry.") || highlight === "retry-transient-errors");
}

export function ModelAssignments({ catalog, panelId, initialView = "roles" }: { catalog: ModelCatalogHandle; panelId: string; initialView?: View }) {
  const { highlight } = useSettingsShell();
  const [view, setView] = useState<View>(retryViewOwns(highlight) ? "retry" : initialView);
  // A jump to a retry setting (search result, "Also under" chip) must land
  // on the view that renders it, whichever view was open before.
  useEffect(() => {
    if (retryViewOwns(highlight)) setView("retry");
  }, [highlight]);

  const roleOptions: RoleModelOption[] = catalog.rows
    .filter((row) => row.source === "catalog")
    .map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      ...(row.thinkingLevels ? { thinkingLevels: row.thinkingLevels } : {}),
      ...(row.state === "instanceHidden" || row.state === "myHidden" ? { hidden: true } : {}),
    }));
  const visibleModels: RuntimeModelEntry[] = roleOptions.filter((model) => !model.hidden);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div role="tablist" aria-label="Assignments" style={{ display: "inline-flex", gap: 2, padding: 3, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", alignSelf: "flex-start", maxWidth: "100%", overflowX: "auto" }}>
        {VIEWS.map((entry) => {
          const active = entry.id === view;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`settings-assignments-${entry.id}`}
              aria-selected={active}
              onClick={() => setView(entry.id)}
              className="ui-focus-ring"
              style={{ padding: "5px 12px", minHeight: 30, border: "none", borderRadius: "calc(var(--radius-control) - 2px)", background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", fontSize: 12, fontWeight: active ? 600 : 500, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      {view === "roles" && <ModelRoles models={roleOptions} panelId={panelId} />}
      {view === "retry" && <RetryFallbackPanel models={visibleModels} panelId={panelId} onOpenModelPlan={() => setView("plan")} />}
      {view === "plan" && <ModelPlanPanel />}
    </div>
  );
}
