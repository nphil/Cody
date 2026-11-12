"use client";

/**
 * Settings › Models: the catalog (every engine) and, on an engine with a
 * roles surface or Cody's own Distill, the assignments. Two segments under
 * one hub:
 *
 *   - Catalog — `ModelCatalog` over `useModelCatalog`: hide (instance or
 *     personal), pin, curation per provider, what is new since the user
 *     last looked. On an ACP engine the rows are the open session's models
 *     and the hub says so when there is none.
 *   - Assignments — roles, retry & fallback, plan (`capabilities.models`)
 *     and Distill (Cody's own chain, gated on `/api/distill/config`
 *     answering `supported`, so pi gets the segment with Distill alone).
 *
 * `openSettings("models", {sub: "assignments"})` lands on the second
 * segment; the default is the catalog.
 */
import { Cpu } from "lucide-react";
import { useMemo } from "react";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useDistillConfig } from "../models/DistillAssignment";
import { ModelAssignments } from "../models/ModelAssignments";
import { ModelCatalog } from "../models/ModelCatalog";
import { subViewKey, useSettingsNewBadges } from "../new-badges";
import { NewDot } from "../primitives";
import { SaveStatusCorner } from "../SaveStatus";
import { SegmentedControl } from "../SegmentedControl";
import type { SearchEntry } from "../search-index";
import { useSettingsShell } from "../shell-context";

export const MODELS_PANEL_ID = "models";

type Segment = "catalog" | "assignments";

/** What the dialog-wide search can jump to inside this hub. Assignments
 * entries carry the `models` gate so search never offers a role picker to
 * an engine without roles. Distill is NOT here: it is Cody's own feature
 * rather than an engine capability, so whether it exists is a route
 * answer — `useModelsSearchEntries` adds it when the route says yes. */
export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  { id: "model-search", tab: "models", label: "Model catalog", description: "Every model the engine can reach: search, hide, pin, and see what is new.", keywords: ["models", "catalog", "hide", "pin", "visible"], breadcrumb: ["Models", "Catalog"], action: "jump" },
  { id: "new-models", tab: "models", label: "New models", description: "Models added to the catalog since you last looked.", keywords: ["new", "seen", "recent"], breadcrumb: ["Models", "Catalog"], action: "jump" },
  { id: "model-curation", tab: "models", label: "Model curation", description: "Per provider: all current and future models, or an exact list.", keywords: ["enabledModels", "allow-list", "curation", "provider"], breadcrumb: ["Models", "Catalog"], needsCapability: "models", action: "jump" },
  { id: "model-role-default", tab: "models", sub: "assignments", label: "Model roles", description: "Which model plays each role, and its reasoning level.", keywords: ["roles", "default", "smol", "slow", "advisor", "assignments"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
  { id: "retry-transient-errors", tab: "models", sub: "assignments", label: "Retry & fallback", description: "Retries, fallback chains and usage-aware fallback.", keywords: ["retry", "fallback", "chains", "usage"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
  { id: "model-presets-list", tab: "models", sub: "assignments", label: "Model presets", description: "Named role + fallback-chain overlays you switch between from the composer.", keywords: ["preset", "presets", "tier", "max", "high", "medium", "low", "smart"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
  { id: "model-presets-research", tab: "models", sub: "assignments", label: "Research model presets", description: "A strong model researches the web and proposes roles and fallback chains for your presets.", keywords: ["research", "planner", "propose", "benchmark"], breadcrumb: ["Models", "Assignments"], needsCapability: "models", action: "jump" },
];

/** The Distill row, only on an engine that can actually distill. Search
 * must never offer a jump to a view the hub hides. */
export function useModelsSearchEntries(): SearchEntry[] {
  const { available } = useDistillConfig();
  return useMemo<SearchEntry[]>(
    () => (available
      ? [{ id: "distill-chain", tab: "models", sub: "assignments", label: "Distill model", description: "Which model summarizes thinking and condenses replies, and what it falls back to.", keywords: ["distill", "summary", "summarize", "condense", "thinking", "recap"], breadcrumb: ["Models", "Assignments"], action: "jump" }]
      : []),
    [available],
  );
}

export function ModelsPanel() {
  const { capabilities, harnessLabel, sub, sessionModels, callbacks } = useSettingsShell();
  const { subsWithNew } = useSettingsNewBadges();
  const catalog = useModelCatalog();
  const distill = useDistillConfig();
  // The engine's own assignments need `models`; Distill only needs its own
  // route to have answered, so the segment exists whenever EITHER renders.
  const hasAssignments = capabilities.models || distill.available;
  // Derived from `sub`, not local state: a repeated jump to the same
  // section (e.g. search landing on "assignments" twice) must still select
  // it even though the shell's `sub` does not change on the second jump.
  const segment: Segment = sub === "assignments" && hasAssignments ? "assignments" : "catalog";

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
            Every model {harnessLabel} can reach, which ones show in the composer{capabilities.models ? ", and which one plays each role" : ""}.
            {summary ? <span style={{ color: "var(--text-dim)" }}> · {summary}</span> : null}
          </p>
        </div>
        {hasAssignments && (
          <SegmentedControl
            label="Models sections"
            value={segment}
            options={[{ id: "catalog", label: "Catalog" }, { id: "assignments", label: "Assignments", badge: subsWithNew.has(subViewKey("models", "assignments")) ? <NewDot /> : undefined }]}
            onChange={(id) => callbacks.selectSection("models", id)}
          />
        )}
      </div>
      {segment === "assignments" && hasAssignments ? (
        <div role="tabpanel" id="settings-subpanel-assignments" aria-labelledby="settings-subtab-assignments" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <ModelAssignments catalog={catalog} panelId={MODELS_PANEL_ID} engineViews={capabilities.models} distillView={distill.available} />
        </div>
      ) : (
        <div role="tabpanel" id="settings-subpanel-catalog" aria-labelledby={hasAssignments ? "settings-subtab-catalog" : undefined} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <ModelCatalog catalog={catalog} panelId={MODELS_PANEL_ID} />
        </div>
      )}
    </div>
  );
}
