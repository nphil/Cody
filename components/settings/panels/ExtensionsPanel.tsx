"use client";

/**
 * Settings › Extensions: MCP servers, skills and plugins behind one
 * segmented control, each segment gated on its own capability. STUB: the
 * three sub-surfaces are today's panels (the MCP toggles + `McpConfig`,
 * `SkillsConfig`, `PluginsConfig`) mounted under the new ids; the
 * Extensions slice moves them onto `Directory` and `Drawer`.
 *
 * The landing segment is the first one this engine serves (pi: skills), and
 * a visited segment stays mounted (display:none) so an install stream in
 * Skills survives a look at MCP.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { extensionsGroupDescription } from "../../SettingsTabs";
import { useNativeSettings } from "@/hooks/useConfigWriter";
import { getSection, getVisibleSubViews } from "../registry";
import { NativeSetting, ToggleSwitch } from "../primitives";
import { SaveStatusCorner, useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";

const PanelLoading = () => <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 20 }}>Loading settings…</div>;
const SkillsConfig = dynamic(() => import("../../SkillsConfig").then((module) => module.SkillsConfig), { loading: PanelLoading });
const PluginsConfig = dynamic(() => import("../../PluginsConfig").then((module) => module.PluginsConfig), { loading: PanelLoading });
const McpConfig = dynamic(() => import("../../McpConfig").then((module) => module.McpConfig), { loading: PanelLoading });

export const EXTENSIONS_PANEL_ID = "extensions";

export function ExtensionsPanel() {
  const { capabilities, cwd, sessionId, sub, callbacks, isMobile } = useSettingsShell();
  const views = getVisibleSubViews(getSection("extensions"), capabilities);
  const active = views.some((view) => view.id === sub) ? sub! : views[0]?.id ?? null;
  const [visited, setVisited] = useState<Set<string>>(() => new Set(active ? [active] : []));
  useEffect(() => {
    if (active) setVisited((current) => (current.has(active) ? current : new Set([...current, active])));
  }, [active]);

  const native = useNativeSettings(capabilities.configEditor && capabilities.mcp);
  const { track } = useSaveStatus(EXTENSIONS_PANEL_ID);
  const patchMcp = (patch: NonNullable<Parameters<typeof native.patchSection<"mcp">>[1]>) => { void track(() => native.patchSection("mcp", patch)); };

  const subPanel = (id: string) => ({ role: "tabpanel" as const, id: `settings-subpanel-${id}`, "aria-labelledby": `settings-subtab-${id}` });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "16px 20px 0", display: "flex", flexDirection: "column", gap: 12, flexShrink: 0 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Extensions</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{extensionsGroupDescription(capabilities)}.</p>
        </div>
        {views.length > 1 && (
          <div role="tablist" aria-label="Extension kinds" style={{ display: "flex", gap: 2, padding: 3, background: "var(--bg-subtle)", borderRadius: "var(--radius-control)", width: isMobile ? "100%" : "fit-content" }}>
            {views.map((view) => {
              const selected = view.id === active;
              return (
                <button
                  key={view.id}
                  type="button"
                  role="tab"
                  id={`settings-subtab-${view.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-subpanel-${view.id}`}
                  onClick={() => callbacks.selectSection("extensions", view.id)}
                  className="ui-focus-ring"
                  style={{
                    flex: isMobile ? 1 : undefined,
                    padding: "5px 14px",
                    minHeight: 30,
                    border: "none",
                    borderRadius: "calc(var(--radius-control) - 2px)",
                    background: selected ? "var(--bg-panel)" : "transparent",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    fontWeight: selected ? 600 : 500,
                    fontSize: 12,
                    cursor: "pointer",
                    boxShadow: selected ? "var(--shadow-card)" : "none",
                  }}
                >
                  {view.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {capabilities.mcp && visited.has("mcp") && (
        <div {...subPanel("mcp")} className="settings-scroll-column" style={{ display: active === "mcp" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column", overflowY: "auto", padding: 20, gap: 16 }}>
          <SaveStatusCorner panelId={EXTENSIONS_PANEL_ID} />
          {capabilities.configEditor && cwd && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              <NativeSetting label="Load Project MCP Servers" description="Allow project-root MCP configuration to be discovered.">
                <ToggleSwitch checked={native.settings?.mcp?.enableProjectConfig ?? true} onChange={(checked) => patchMcp({ enableProjectConfig: checked })} />
              </NativeSetting>
              <NativeSetting label="Render MCP Markdown" description="Render non-JSON MCP results as Markdown in transcript.">
                <ToggleSwitch checked={native.settings?.mcp?.renderMarkdownResults ?? true} onChange={(checked) => patchMcp({ renderMarkdownResults: checked })} />
              </NativeSetting>
              <NativeSetting label="MCP Resource Updates" description="Inject server resource updates into conversation.">
                <ToggleSwitch checked={native.settings?.mcp?.notifications ?? false} onChange={(checked) => patchMcp({ notifications: checked })} />
              </NativeSetting>
            </div>
          )}
          <McpConfig cwd={cwd} sessionId={sessionId} />
          {!cwd && (
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>Select a project workspace to view and edit its project MCP configuration.</p>
          )}
        </div>
      )}

      {capabilities.skills && visited.has("skills") && (
        <div {...subPanel("skills")} style={{ display: active === "skills" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }}>
          {cwd ? (
            <SkillsConfig embedded cwd={cwd} onClose={callbacks.onClose} />
          ) : (
            <p style={{ margin: 0, padding: 20, color: "var(--text-muted)", fontSize: 12 }}>Select a project workspace to manage its skills.</p>
          )}
        </div>
      )}

      {capabilities.plugins && visited.has("plugins") && (
        <div {...subPanel("plugins")} style={{ display: active === "plugins" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }}>
          {cwd ? (
            <PluginsConfig embedded cwd={cwd} sessionId={sessionId} onClose={callbacks.onClose} onReloaded={callbacks.onPluginsReloaded} />
          ) : (
            <p style={{ margin: 0, padding: 20, color: "var(--text-muted)", fontSize: 12 }}>Select a project workspace to manage its plugins.</p>
          )}
        </div>
      )}
    </div>
  );
}
