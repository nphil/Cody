"use client";

import { Brain, Cable, Cpu, KeyRound, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, UserRound } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import { normalizeSectionId } from "./settings/registry";

/**
 * Every id Settings can be opened with. The eight HUB ids (accounts, general,
 * providers, models, engine, extensions, memory, system) are the sections
 * `components/settings/registry.ts` renders; the rest are LEGACY ids that
 * deep links, toasts and older callers still pass, kept for one release and
 * normalised by `normalizeSectionId` (safety/intelligence/omp → engine,
 * localai → providers, mcp/skills/plugins → extensions with a sub-view).
 * `models` keeps its id but now means the Models hub, not "AI Model Defaults"
 * (those moved into Behavior).
 */
export type SettingsTab =
  | "accounts"
  | "general"
  | "safety"
  | "models"
  | "providers"
  | "intelligence"
  | "memory"
  | "engine"
  | "extensions"
  | "mcp"
  | "omp"
  | "skills"
  | "plugins"
  | "localai"
  | "system";

/**
 * The active engine's capability flags, mirroring HarnessCapabilities in
 * lib/harness/types.ts. GET /api/info reports them for the engine currently
 * driving the instance; the client keeps its own structural copy so no client
 * component has to import server code.
 */
export interface EngineCapabilities {
  liveSessions: boolean;
  models: boolean;
  skills: boolean;
  plugins: boolean;
  mcp: boolean;
  nativeSettings: boolean;
  configEditor: boolean;
  updates: boolean;
  chatExtras: boolean;
  fastMode: boolean;
  advisor: boolean;
  subagents: boolean;
  memory: boolean;
  providerLogin: boolean;
}

/** The active engine's identity, also from GET /api/info. */
export interface ActiveEngineInfo {
  id: string;
  displayName: string;
  shortName: string;
  experimental: boolean;
}

/** What an older server (no `capabilities` in /api/info) and omp both mean.
 * Everything omp serves is on, so gating only ever bites on an explicit
 * `false` — with one exception, below.
 *
 * `memory` defaults OFF because it is the one flag omp itself reports false:
 * omp keeps memory but exposes no read-back, so defaulting it on would show a
 * Memory tab whose route answers 400. A capability flag hides a surface, it
 * never renders a broken one. */
export const ALL_CAPABILITIES: EngineCapabilities = {
  liveSessions: true,
  models: true,
  skills: true,
  plugins: true,
  mcp: true,
  nativeSettings: true,
  configEditor: true,
  updates: true,
  chatExtras: true,
  fastMode: true,
  advisor: true,
  subagents: true,
  memory: false,
  providerLogin: true,
};

/** Coerce whatever /api/info returned into a full flag set, defaulting every
 * missing or non-boolean flag to ALL_CAPABILITIES' value so today's omp
 * behavior is unchanged. */
export function normalizeCapabilities(value: unknown): EngineCapabilities {
  if (!value || typeof value !== "object") return ALL_CAPABILITIES;
  const source = value as Record<string, unknown>;
  const result = { ...ALL_CAPABILITIES };
  for (const key of Object.keys(ALL_CAPABILITIES) as Array<keyof EngineCapabilities>) {
    if (typeof source[key] === "boolean") result[key] = source[key] as boolean;
  }
  return result;
}

/**
 * What shell/deployment is hosting Cody, mirroring `InfoResponse["platformInfo"]`
 * in app/api/info/route.ts. Orthogonal to EngineCapabilities above: that's
 * what the active *engine* can serve, this is what the *shell* is — a plain
 * web/Docker deployment never sets CODY_DESKTOP, so `desktop` stays false.
 */
export interface PlatformInfo {
  desktop: boolean;
}

/** Unlike ALL_CAPABILITIES, the safe default here is "no" — an older server
 * with no `platformInfo` field is never the desktop shell. */
export const DEFAULT_PLATFORM: PlatformInfo = { desktop: false };

export function normalizePlatform(value: unknown): PlatformInfo {
  if (!value || typeof value !== "object") return DEFAULT_PLATFORM;
  const source = value as Record<string, unknown>;
  return { desktop: source.desktop === true };
}

export interface TabItem {
  id: SettingsTab;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false"; style?: CSSProperties }>;
  needsWorkspace?: boolean;
  /** Hidden entirely when the active engine lacks this capability — an engine
   * that cannot serve the surface should not advertise it as disabled. An
   * array means ANY of the listed capabilities keeps the tab (a group tab
   * whose sub-surfaces gate individually, like Extensions & Tools). */
  needsCapability?: keyof EngineCapabilities | readonly (keyof EngineCapabilities)[];
  /** Sits apart at the foot of the sidebar. The full harness settings dump is
   * a reference surface, not part of the curated walk through the tabs above. */
  pinBottom?: boolean;
}

/** Fallback brand for the harness-settings tab. The real one comes from the
 * active harness (CODY_HARNESS) and arrives with the schema fetch, so this is
 * only what renders before that lands. */
export const DEFAULT_HARNESS_LABEL = "OMP";

/** The founding engine's id, as `/api/info` reports it.
 *
 * Capability flags cover almost everything the UI gates on, but a few routes
 * are ONE engine's own files rather than a capability anything else could
 * grow — session import writes omp's .jsonl layout, archive moves it with
 * omp's gc layout — and the server refuses them under any other engine
 * (lib/engine-guard `requireEngine("omp", …)`). The client half of that rule
 * needs the same id, so it is named once here instead of being spelled out
 * as a bare string wherever a control mirrors such a route. */
export const OMP_ENGINE_ID = "omp";

/** The Extensions & Tools group description, composed from what the active
 * engine actually serves so a skills-only engine (pi) is not promised MCP. */
/** What this group actually offers on the ACTIVE engine. Shared by the tab
 * entry and the panel heading: the panel is no longer hidden on an engine
 * without MCP, so a hardcoded "MCP servers, skills and OMP plugins" there
 * would name three things a pi or Hermes user does not have. */
export function extensionsGroupDescription(capabilities: EngineCapabilities): string {
  const parts = [
    ...(capabilities.mcp ? ["MCP servers"] : []),
    ...(capabilities.skills ? ["skills"] : []),
    ...(capabilities.plugins ? ["plugins"] : []),
  ];
  return parts.length > 0
    ? `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())} for the active engine`
    : "Extensions for the active engine";
}

export function getSettingsCategories(
  harnessLabel: string = DEFAULT_HARNESS_LABEL,
  capabilities: EngineCapabilities = ALL_CAPABILITIES,
): TabItem[] {
  return SETTINGS_CATEGORIES
    .filter((tab) => {
      if (!tab.needsCapability) return true;
      const needs = typeof tab.needsCapability === "string" ? [tab.needsCapability] : tab.needsCapability;
      return needs.some((key) => capabilities[key]);
    })
    .map((tab) => {
      if (tab.id === "omp") {
        return { ...tab, label: `All ${harnessLabel} Settings`, description: `Every setting ${harnessLabel} declares, read from its own schema` };
      }
      if (tab.id === "mcp") {
        return { ...tab, description: extensionsGroupDescription(capabilities) };
      }
      return tab;
    });
}

/**
 * The flag that decides whether the schema-driven "All <engine> Settings" tab
 * exists — and therefore whether its schema is worth fetching at all.
 *
 * Named once and shared because the tab and the fetch behind it drifted apart
 * twice: the route is engine-GENERIC (it serves omp's TypeScript schema and
 * Hermes\' DEFAULT_CONFIG-derived one through the same panel), so guarding the
 * fetch on `configEditor` — which means "Cody has hand-built editors for this
 * engine", omp alone — left Hermes with a settings tab whose contents the
 * dialog search could not find. One constant, one answer.
 */
export const SCHEMA_TAB_CAPABILITY = "nativeSettings" satisfies keyof EngineCapabilities;

export const SETTINGS_CATEGORIES: TabItem[] = [
  { id: "accounts", label: "User Accounts", description: "Your profile, password, and who can sign in", Icon: UserRound },
  { id: "general", label: "Interface & Behavior", description: "UI preferences, completion sound, submission mode", Icon: Settings2 },
  { id: "safety", label: "Safety & Approvals", description: "Tool safety rules, YOLO mode, terminal permissions", Icon: ShieldCheck, needsCapability: "configEditor" },
  { id: "models", label: "AI Model Defaults", description: "Reasoning budget, verbosity, personality, scratchpad", Icon: Cpu, needsCapability: "configEditor" },
  // No needsCapability: every engine reads provider keys from its environment
  // (lib/harness/provider-keys.ts), so the tab exists for all of them. omp's
  // OAuth and registry editor inside it stays gated on `models`.
  { id: "providers", label: "API Keys & Providers", description: "Provider API keys for the active engine, plus omp's OAuth accounts and model registry", Icon: KeyRound },
  // No needsCapability: this scans the network Cody itself runs on, not
  // anything the active engine serves, so it stays visible on every engine —
  // and is just as useful on a headless Docker install as on desktop.
  { id: "localai", label: "Local AI", description: "Detect Ollama, LM Studio, and llama.cpp running near this instance", Icon: Server },
  { id: "intelligence", label: "Agent & Intelligence", description: "Advisor, memory, autolearn, compaction and retry", Icon: Sparkles, needsCapability: "configEditor" },
  // Sits next to Agent & Intelligence — that tab CONFIGURES memory, this one
  // shows what the engine actually wrote. Hidden unless the engine can hand
  // its memory back (Hermes today; omp keeps memory but cannot read it out).
  { id: "memory", label: "Agent Memory", description: "What the agent has written down and remembers between sessions", Icon: Brain, needsCapability: "memory" },
  { id: "mcp", label: "Extensions & Tools", description: "MCP servers, managed skills, and plugins", Icon: Cable, needsCapability: ["mcp", "skills", "plugins"] },
  { id: "system", label: "System & Updates", description: "Updates for the app, agent engines, and skills, plus session restart", Icon: RefreshCw },
  { id: "omp", label: `All ${DEFAULT_HARNESS_LABEL} Settings`, description: `Every setting ${DEFAULT_HARNESS_LABEL} declares, read from its own schema`, Icon: SlidersHorizontal, pinBottom: true, needsCapability: SCHEMA_TAB_CAPABILITY },
];

/** Legacy id → the hub that now renders it. Delegates to the registry so the
 * alias table is spelled once. */
export const getNormalizedActive = (tab: SettingsTab): SettingsTab => normalizeSectionId(tab);

/**
 * @deprecated The settings dialog renders `components/settings/SettingsSidebar`
 * (desktop rail) and `MobileStack` (phone) from the registry. This renderer
 * survives only for the non-embedded branches of SkillsConfig, PluginsConfig
 * and ModelsConfig, which nothing mounts any more; it goes when those
 * branches do. Do not add callers.
 */
export function SettingsTabs({
  active,
  onSelect,
  workspaceReady = true,
  layout = "vertical",
  harnessLabel = DEFAULT_HARNESS_LABEL,
  capabilities = ALL_CAPABILITIES,
}: {
  active: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  workspaceReady?: boolean;
  layout?: "horizontal" | "vertical";
  /** Brand of the active harness, used for the "All <harness> Settings" tab. */
  harnessLabel?: string;
  /** Active engine capabilities; tabs the engine cannot serve are hidden. */
  capabilities?: EngineCapabilities;
}) {
  const currentActive = getNormalizedActive(active);
  const categories = getSettingsCategories(harnessLabel, capabilities);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const enabled = categories.filter((tab) => !(tab.needsWorkspace && !workspaceReady));
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = enabled.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const next = enabled[nextIndex] ?? enabled[index];
      if (next) onSelect(next.id);
    }
  };

  if (layout === "vertical") {
    return (
      <nav
        aria-label="Settings sections"
        role="tablist"
        aria-orientation="vertical"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "12px 8px",
          width: 230,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-panel)",
          overflowY: "auto",
        }}
      >
        {categories.map(({ id, label, description, Icon, needsWorkspace, pinBottom }, index) => {
          const selected = id === currentActive;
          const disabled = Boolean(needsWorkspace && !workspaceReady);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={selected}
              aria-controls={`settings-panel-${id}`}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onSelect(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "9px 10px",
                border: "none",
                borderRadius: "var(--radius-control)",
                // Pinned entries fall to the foot of the nav, set off by a rule.
                ...(pinBottom ? { marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 13, borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {}),
                background: selected ? "var(--bg-selected)" : "transparent",
                color: selected ? "var(--text)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                textAlign: "left",
                transition: "background var(--dur-fast), color var(--dur-fast)",
                width: "100%",
              }}
            >
              <Icon size={16} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0, color: selected ? "var(--accent)" : "currentColor" }} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 12.5, fontWeight: selected ? 600 : 500, lineHeight: 1.3, color: selected ? "var(--text)" : "inherit" }}>
                  {label}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {description}
                </div>
              </div>
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Settings sections" role="tablist" style={{ display: "flex", gap: 3, padding: "7px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0, overflowX: "auto" }}>
      {categories.map(({ id, label, Icon, needsWorkspace }, index) => {
        const selected = id === currentActive;
        const disabled = Boolean(needsWorkspace && !workspaceReady);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={selected}
            aria-controls={`settings-panel-${id}`}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 9px", border: "none", borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, fontSize: 12, whiteSpace: "nowrap" }}
          >
            <Icon size={13} aria-hidden="true" /> {label}
          </button>
        );
      })}
    </nav>
  );
}
