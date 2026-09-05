"use client";

/**
 * Settings › Extensions: MCP servers, skills and plugins behind one
 * segmented control, each segment gated on its own capability. The landing
 * segment is the first one this engine serves (pi: skills), and a visited
 * segment stays mounted (display:none) so an install stream in Skills
 * survives a look at MCP.
 *
 *   - MCP: the four MCP keys of the engine's config as bound cards
 *     (`MCP_SETTING_CARDS`, written through the config writer) above
 *     `McpConfig`, whose user-level list renders without a workspace.
 *   - Skills / Plugins: `SkillsConfig` / `PluginsConfig` embedded, each with
 *     its store or marketplace in a Drawer. Both are workspace-scoped: with
 *     no workspace the segment says so instead of rendering a dead list.
 *
 * Search: `SEARCH_ENTRIES` are the static cards and lists this hub renders
 * (the MCP cards derive from `MCP_SETTING_CARDS`, so a label rendered and a
 * label searchable are one string); `useExtensionsSearchEntries` derives one
 * `mcp-<name>` row per server from the cached inventory.
 */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { extensionsGroupDescription } from "../../SettingsTabs";
import { useNativeSettings, type NativeSettings } from "@/hooks/useConfigWriter";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { mcpInventoryOf, mcpRoute, type McpRouteBody } from "../../McpConfig";
import { getSection, getVisibleSubViews } from "../registry";
import { NativeSetting, ToggleSwitch, nativeInputStyle, slugify } from "../primitives";
import { SaveStatusCorner, useSaveStatus } from "../SaveStatus";
import type { SearchEntry } from "../search-index";
import { SegmentedControl } from "../SegmentedControl";
import { useSettingsShell } from "../shell-context";

const PanelLoading = () => <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 20 }}>Loading settings…</div>;
const SkillsConfig = dynamic(() => import("../../SkillsConfig").then((module) => module.SkillsConfig), { loading: PanelLoading });
const PluginsConfig = dynamic(() => import("../../PluginsConfig").then((module) => module.PluginsConfig), { loading: PanelLoading });
const McpConfig = dynamic(() => import("../../McpConfig").then((module) => module.McpConfig), { loading: PanelLoading });

export const EXTENSIONS_PANEL_ID = "extensions";

type McpSettings = NonNullable<NativeSettings["mcp"]>;

export interface McpSettingCard {
  key: keyof McpSettings;
  label: string;
  description: string;
  control: "toggle" | "number";
  /** The engine's default, shown until the file says otherwise. */
  fallback: boolean | number;
  keywords?: readonly string[];
}

/** The four `mcp.*` keys of the engine's config, as the cards this segment
 * renders and the search index reads. Labels and descriptions mirror the
 * engine's own schema rows for these keys. */
export const MCP_SETTING_CARDS: readonly McpSettingCard[] = [
  { key: "enableProjectConfig", label: "Load Project MCP Servers", description: "Allow project-root MCP configuration to be discovered.", control: "toggle", fallback: true, keywords: ["mcp.json", "project"] },
  { key: "renderMarkdownResults", label: "Render MCP Markdown", description: "Render non-JSON MCP results as Markdown in transcript.", control: "toggle", fallback: true },
  { key: "notifications", label: "MCP Resource Updates", description: "Inject server resource updates into conversation.", control: "toggle", fallback: false, keywords: ["notifications"] },
  { key: "notificationDebounceMs", label: "MCP Notification Debounce", description: "Milliseconds to wait before a burst of resource updates is injected as one notice (0–60,000).", control: "number", fallback: 500, keywords: ["debounce", "ms"] },
];

const ENGINE_TRAIL = ["{engine}", "Extensions"] as const;

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  ...MCP_SETTING_CARDS.map((card): SearchEntry => ({
    id: slugify(card.label),
    tab: "extensions",
    sub: "mcp",
    label: card.label,
    description: card.description,
    keywords: card.keywords,
    breadcrumb: [...ENGINE_TRAIL, "MCP"],
    // The cards write the engine's config file: only the engine with a
    // config editor (which also serves MCP) renders them.
    needsCapability: "configEditor",
    action: "jump",
  })),
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

function DebounceInput({ value, fallback, onCommit }: { value: number | undefined; fallback: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState<string>(value === undefined ? "" : String(value));
  useEffect(() => {
    setDraft(value === undefined ? "" : String(value));
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? fallback : Number(trimmed);
    if (!Number.isInteger(next) || next < 0 || next > 60_000) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    if (next !== (value ?? fallback)) onCommit(next);
  };
  return (
    <input
      type="number"
      min={0}
      max={60000}
      step={50}
      inputMode="numeric"
      value={draft}
      placeholder={String(fallback)}
      aria-label="MCP Notification Debounce"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
      style={{ ...nativeInputStyle, width: 120 }}
    />
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

  const native = useNativeSettings(capabilities.configEditor && capabilities.mcp);
  const { track } = useSaveStatus(EXTENSIONS_PANEL_ID);
  const patchMcp = (patch: Partial<McpSettings>) => { void track(() => native.patchSection("mcp", patch)); };
  const mcpValue = <K extends keyof McpSettings>(key: K): McpSettings[K] | undefined => native.settings?.mcp?.[key];

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
          {capabilities.configEditor && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {MCP_SETTING_CARDS.map((card) => (
                card.control === "toggle" ? (
                  <NativeSetting key={card.key} label={card.label} description={card.description}>
                    <ToggleSwitch checked={(mcpValue(card.key) as boolean | undefined) ?? (card.fallback as boolean)} onChange={(checked) => patchMcp({ [card.key]: checked })} />
                  </NativeSetting>
                ) : (
                  <NativeSetting key={card.key} label={card.label} description={card.description}>
                    <DebounceInput value={mcpValue(card.key) as number | undefined} fallback={card.fallback as number} onCommit={(next) => patchMcp({ [card.key]: next })} />
                  </NativeSetting>
                )
              ))}
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
