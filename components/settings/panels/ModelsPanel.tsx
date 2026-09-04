"use client";

/**
 * Settings › Models: the catalog, what is hidden or pinned, and (omp) the
 * role assignments. STUB: a placeholder naming what lands here, plus a
 * pointer to where the registry editor still lives (Providers) so nothing a
 * user had yesterday is out of reach today. The Models slice replaces this
 * with `ModelCatalog` and `ModelAssignments`.
 */
import { Cpu } from "lucide-react";
import { useSettingsShell } from "../shell-context";

export function ModelsPanel() {
  const { capabilities, harnessLabel, sessionModels, callbacks } = useSettingsShell();
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Models</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
          Every model {harnessLabel} can reach, which ones are shown in the composer, and which one plays each role.
        </p>
      </div>
      <div style={{ padding: "14px 16px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Cpu size={18} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0, marginTop: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Model catalog — coming in this release</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            A searchable catalog with hide, pin and &ldquo;new since you last looked&rdquo;, and the role assignments beside it.
            {capabilities.models
              ? " Until it lands, the model registry, curation and roles are under Providers."
              : sessionModels && sessionModels.length > 0
                ? ` The open session offers ${sessionModels.length} model${sessionModels.length === 1 ? "" : "s"}; pick one from the composer.`
                : ` Models come from the session. Start one to see what ${harnessLabel} offers.`}
          </span>
          {capabilities.models && (
            <div>
              <button
                type="button"
                onClick={() => callbacks.selectSection("providers")}
                className="ui-focus-ring"
                style={{ padding: "5px 12px", minHeight: 30, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer" }}
              >
                Open Providers
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
