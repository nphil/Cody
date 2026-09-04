"use client";

/**
 * Settings › Models: the catalog (every engine) and, on an engine with a
 * roles surface, the assignments. Two segments under one hub:
 *
 *   - Catalog — `ModelCatalog` over `useModelCatalog`: hide (instance or
 *     personal), pin, curation per provider, what is new since the user
 *     last looked. On an ACP engine the rows are the open session's models
 *     and the hub says so when there is none.
 *   - Assignments (`capabilities.models`) — roles, retry & fallback, plan.
 *
 * `openSettings("models", {sub: "assignments"})` lands on the second
 * segment; the default is the catalog.
 */
import { Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { ModelAssignments } from "../models/ModelAssignments";
import { ModelCatalog } from "../models/ModelCatalog";
import { SaveStatusCorner } from "../SaveStatus";
import type { SearchEntry } from "../search-index";
import { useSettingsShell } from "../shell-context";

export const MODELS_PANEL_ID = "models";

type Segment = "catalog" | "assignments";

/** What the dialog-wide search can jump to inside this hub. Assignments
 * entries carry the `models` gate so search never offers a role picker to
 * an engine without roles. */
export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  { id: "model-search", tab: "models", label: "Model catalog", description: "Every model the engine can reach: search, hide, pin, and see what is new.", keywords: ["models", "catalog", "hide", "pin", "visible"], breadcrumb: ["Models", "Catalog"], action: "jump" },
  { id: "new-models", tab: "models", label: "New models", description: "Models added to the catalog since you last looked.", keywords: ["new", "seen", "recent"], breadcrumb: ["Models", "Catalog"], action: "jump" },
  { id: "model-curation", tab: "models", label: "Model curation", description: "Per provider: all current and future models, or an exact list.", keywords: ["enabledModels", "allow-list", "curation", "provider"], breadcrumb: ["Models", "Catalog"], needsCapability: "models", action: "jump" },
  { id: "model-role-default", tab: "models", sub: "assignments", label: "Model roles", description: "Which model plays each role, and its reasoning level.", keywords: ["roles", "default", "smol", "slow", "advisor", "assignments"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
  { id: "retry-transient-errors", tab: "models", sub: "assignments", label: "Retry & fallback", description: "Retries, fallback chains and usage-aware fallback.", keywords: ["retry", "fallback", "chains", "usage"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
  { id: "model-plan-usage-aware-fallback", tab: "models", sub: "assignments", label: "Plan roles & fallbacks", description: "Propose a model for every role and the fallback chains that go with them.", keywords: ["plan", "planner", "propose"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
];

export function ModelsPanel() {
  const { capabilities, harnessLabel, sub, sessionModels } = useSettingsShell();
  const catalog = useModelCatalog();
  const hasAssignments = capabilities.models;
  const [segment, setSegment] = useState<Segment>(() => (sub === "assignments" && hasAssignments ? "assignments" : "catalog"));

  useEffect(() => {
    if (sub === "assignments" && hasAssignments) setSegment("assignments");
    else if (sub === "catalog") setSegment("catalog");
  }, [sub, hasAssignments]);

  const sessionCount = catalog.catalogSource === "session" ? (sessionModels?.length ?? 0) : null;
  const visibleCount = catalog.rows.filter((row) => row.source !== "placeholder" && row.state !== "instanceHidden" && row.state !== "myHidden").length;
  const hiddenCount = catalog.rows.filter((row) => row.state === "instanceHidden" || row.state === "myHidden").length;
  const summary = sessionCount !== null
    ? sessionCount === 0 ? "From the session" : `${sessionCount} from the session`
    : catalog.rows.length === 0
      ? null
      : [`${visibleCount} visible`, hiddenCount > 0 ? `${hiddenCount} hidden` : null, catalog.newCount > 0 ? `${catalog.newCount} new` : null].filter(Boolean).join(" · ");

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <SaveStatusCorner panelId={MODELS_PANEL_ID} />
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 7 }}>
            <Cpu size={15} aria-hidden="true" style={{ color: "var(--accent)" }} /> Models
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Every model {harnessLabel} can reach, which ones show in the composer{hasAssignments ? ", and which one plays each role" : ""}.
            {summary ? <span style={{ color: "var(--text-dim)" }}> · {summary}</span> : null}
          </p>
        </div>
        {hasAssignments && (
          <div role="tablist" aria-label="Models sections" style={{ display: "inline-flex", gap: 2, padding: 3, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", flexShrink: 0 }}>
            {([["catalog", "Catalog"], ["assignments", "Assignments"]] as const).map(([id, label]) => {
              const active = segment === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`settings-subtab-${id}`}
                  aria-selected={active}
                  onClick={() => setSegment(id)}
                  className="ui-focus-ring"
                  style={{ padding: "5px 12px", minHeight: 30, border: "none", borderRadius: "calc(var(--radius-control) - 2px)", background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", fontSize: 12, fontWeight: active ? 600 : 500, cursor: "pointer" }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {segment === "assignments" && hasAssignments
        ? <ModelAssignments catalog={catalog} panelId={MODELS_PANEL_ID} />
        : <ModelCatalog catalog={catalog} panelId={MODELS_PANEL_ID} />}
    </div>
  );
}
