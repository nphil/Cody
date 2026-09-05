"use client";

/**
 * Settings › Extensions: MCP servers, skills and plugins behind one
 * segmented control, each segment gated on its own capability. The landing
 * segment is the first one this engine serves (pi: skills), and a visited
 * segment stays mounted (display:none) so an install stream in Skills
 * survives a look at MCP.
 *
 *   - MCP: the engine's four `mcp.*` keys as bound cards (`MCP_CARDS`, the
 *     same table the Behavior hub's schema list chips as "Also under
 *     Extensions › MCP"): label, description and control come from the
 *     engine's schema row, writes go through the schema index. Below them
 *     `McpConfig`, whose user-level list renders without a workspace.
 *   - Skills / Plugins: `SkillsConfig` / `PluginsConfig` embedded, each with
 *     its store or marketplace in a Drawer. Both are workspace-scoped: with
 *     no workspace the segment says so instead of rendering a dead list.
 *
 * Search: `SEARCH_ENTRIES` are the static lists this hub renders; the MCP
 * cards are schema rows (`schema-<key>`, trailed by `cardOwner`) and
 * `useExtensionsSearchEntries` derives one `mcp-<name>` row per server from
 * the cached inventory.
 */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { extensionsGroupDescription } from "../../SettingsTabs";
import { useSchemaIndex, type SchemaIndex, type SchemaValue } from "@/hooks/useSchemaIndex";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { mcpInventoryOf, mcpRoute, type McpRouteBody } from "../../McpConfig";
import { MCP_CARDS, cardSurfaceAvailable, searchIdForKey, type RecommendedCard } from "../engine/recommended-cards";
import { SchemaControl } from "../engine/SchemaSettingsList";
import { getSection, getVisibleSubViews } from "../registry";
import { NativeSetting, TERMINAL_ONLY_BADGE, chipStyle } from "../primitives";
import { SaveStatusCorner, useSaveStatus } from "../SaveStatus";
import type { SearchEntry } from "../search-index";
import { SegmentedControl } from "../SegmentedControl";
import { useSettingsShell } from "../shell-context";

const PanelLoading = () => <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 20 }}>Loading settings…</div>;
const SkillsConfig = dynamic(() => import("../../SkillsConfig").then((module) => module.SkillsConfig), { loading: PanelLoading });
const PluginsConfig = dynamic(() => import("../../PluginsConfig").then((module) => module.PluginsConfig), { loading: PanelLoading });
const McpConfig = dynamic(() => import("../../McpConfig").then((module) => module.McpConfig), { loading: PanelLoading });

export const EXTENSIONS_PANEL_ID = "extensions";

const ENGINE_TRAIL = ["{engine}", "Extensions"] as const;

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  { id: "configured-mcp-servers", tab: "extensions", sub: "mcp", label: "Configured MCP servers", description: "Every MCP server the engine loads: user level, project level and discovered, with live status when a session is open.", keywords: ["mcp", "server", "user level"], breadcrumb: [...ENGINE_TRAIL, "MCP"], needsCapability: "mcp", action: "jump" },
  { id: "project-mcp-servers", tab: "extensions", sub: "mcp", label: "Project MCP servers", description: "The servers in this workspace's mcp.json: add, check, save or remove.", keywords: ["mcp.json", "add server"], breadcrumb: [...ENGINE_TRAIL, "MCP"], scope: "Workspace", needsCapability: "mcp", action: "jump" },
  { id: "skills", tab: "extensions", sub: "skills", label: "Skills", description: "The workspace's installed skills: enable, disable, check for updates.", keywords: ["skill", "update"], breadcrumb: [...ENGINE_TRAIL, "Skills"], scope: "Workspace", needsCapability: "skills", action: "jump" },
  { id: "skill-store", tab: "extensions", sub: "skills", label: "Skill store", description: "Browse and install skills from skills.sh.", keywords: ["store", "install", "skills.sh"], breadcrumb: [...ENGINE_TRAIL, "Skills"], scope: "Workspace", needsCapability: "skills", action: "jump" },
  { id: "plugins", tab: "extensions", sub: "plugins", label: "Plugins", description: "The engine's plugin packages: install, update, enable, disable, remove.", keywords: ["plugin", "package", "extension"], breadcrumb: [...ENGINE_TRAIL, "Plugins"], scope: "Workspace", needsCapability: "plugins", action: "jump" },
  { id: "plugin-marketplace", tab: "extensions", sub: "plugins", label: "Plugin marketplace", description: "Browse marketplaces and install plugins from them.", keywords: ["marketplace", "browse"], breadcrumb: [...ENGINE_TRAIL, "Plugins"], scope: "Workspace", needsCapability: "plugins", action: "jump" },
];

/** One search row per MCP server in the cached inventory (`mcp-<name>`).
 * Reads the cwd-only route: a `sessionId` would ask the live session, which
 * is not a cached read. */
export function useExtensionsSearchEntries(cwd: string | null, enabled = true): SearchEntry[] {
  const route = useSettingsRoute<McpRouteBody>(mcpRoute(cwd), { enabled });
  return useMemo(() => mcpInventoryOf(route.data).map((server) => ({
    id: `mcp-${server.name}`,
    tab: "extensions" as const,
    sub: "mcp",
    label: server.name,
    description: `${server.source} · ${server.status.replace("_", " ")}${server.type ? ` · ${server.type}` : ""}`,
    keywords: [server.source, ...(server.type ? [server.type] : [])],
    breadcrumb: [...ENGINE_TRAIL, "MCP", server.source],
    needsCapability: "mcp" as const,
    action: "jump" as const,
  })), [route.data]);
}

/** One `mcp.*` card: the schema row's label, description and control, written
 * through the schema index so the Behavior hub's row and this card never
 * disagree. Absent until the schema has loaded, and while the row's own
 * `ui.condition` hides it. */
function McpCard({ card, index }: { card: RecommendedCard; index: SchemaIndex }) {
  const { track } = useSaveStatus(EXTENSIONS_PANEL_ID);
  const row = index.byKey.get(card.key);
  if (!row || !row.visible) return null;
  const write = (value: SchemaValue | null) => { void track(() => index.setValue(row.key, value)); };
  const description = [row.description, index.describeCondition(row.condition)].filter(Boolean).join(" ");
  const inline = row.type === "boolean";
  const control = <SchemaControl setting={row} value={row.value} onChange={write} />;
  const footer = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
        <code style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)", overflowWrap: "anywhere" }}>{row.key}</code>
        {row.modified && <span style={{ ...chipStyle, color: "var(--accent)" }}>Changed</span>}
      </span>
      {row.modified && (
        <button type="button" className="ui-focus-ring" onClick={() => write(null)} title="Reset to the engine's default" style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 10.5, padding: "2px 4px", borderRadius: "var(--radius-control)", flexShrink: 0 }}>
          <RotateCcw size={11} aria-hidden="true" /> Reset
        </button>
      )}
    </div>
  );
  return (
    <NativeSetting
      label={row.label}
      description={description || undefined}
      badge={row.terminalOnly ? TERMINAL_ONLY_BADGE : undefined}
      searchId={searchIdForKey(row.key)}
      control={(
        <>
          {!inline && control}
          {footer}
        </>
      )}
    >
      {inline ? control : undefined}
    </NativeSetting>
  );
}

function WorkspaceNote({ what }: { what: string }) {
  return <p style={{ margin: 0, padding: 20, color: "var(--text-muted)", fontSize: 12 }}>Select a project workspace to manage its {what}.</p>;
}

export function ExtensionsPanel() {
  const { capabilities, cwd, sessionId, sub, callbacks, isMobile } = useSettingsShell();
  const views = getVisibleSubViews(getSection("extensions"), capabilities);
  const active = views.some((view) => view.id === sub) ? sub! : views[0]?.id ?? null;
  const [visited, setVisited] = useState<Set<string>>(() => new Set(active ? [active] : []));
  useEffect(() => {
    if (active) setVisited((current) => (current.has(active) ? current : new Set([...current, active])));
  }, [active]);

  // The bound cards exist where their surface does: an engine with a config
  // editor that also serves MCP. The schema is the same payload the
  // Behavior hub reads, so the cache answers both from one request.
  const mcpCards = cardSurfaceAvailable("mcp", capabilities);
  const index = useSchemaIndex({ enabled: mcpCards });

  const subPanel = (id: string) => ({ role: "tabpanel" as const, id: `settings-subpanel-${id}`, "aria-labelledby": `settings-subtab-${id}` });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "16px 20px 0", display: "flex", flexDirection: "column", gap: 12, flexShrink: 0 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Extensions</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{extensionsGroupDescription(capabilities)}.</p>
        </div>
        {views.length > 1 && active && (
          <SegmentedControl
            label="Extension kinds"
            value={active}
            options={views.map((view) => ({ id: view.id, label: view.label }))}
            onChange={(id) => callbacks.selectSection("extensions", id)}
          />
        )}
      </div>

      {capabilities.mcp && visited.has("mcp") && (
        <div {...subPanel("mcp")} className="settings-scroll-column" style={{ display: active === "mcp" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column", overflowY: "auto", padding: 20, gap: 16 }}>
          <SaveStatusCorner panelId={EXTENSIONS_PANEL_ID} />
          {mcpCards && index.status === "ready" && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {MCP_CARDS.map((card) => <McpCard key={card.key} card={card} index={index} />)}
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
          {cwd ? <SkillsConfig cwd={cwd} /> : <WorkspaceNote what="skills" />}
        </div>
      )}

      {capabilities.plugins && visited.has("plugins") && (
        <div {...subPanel("plugins")} style={{ display: active === "plugins" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }}>
          {cwd ? <PluginsConfig cwd={cwd} sessionId={sessionId} onReloaded={callbacks.onPluginsReloaded} /> : <WorkspaceNote what="plugins" />}
        </div>
      )}
    </div>
  );
}
