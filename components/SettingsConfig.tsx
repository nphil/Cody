"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSubmitDuringRunBehavior, setSubmitDuringRunBehavior, type SubmitDuringRunBehavior } from "@/lib/composer-prefs";
import dynamic from "next/dynamic";
import { AlertCircle, ArrowDown, ArrowUp, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { SettingsTabs, type SettingsTab, type ActiveEngineInfo, type EngineCapabilities, ALL_CAPABILITIES, DEFAULT_HARNESS_LABEL, SCHEMA_TAB_CAPABILITY, extensionsGroupDescription, getSettingsCategories, getNormalizedActive } from "./SettingsTabs";
import { STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";
import { LOCALES, useI18n, type Locale } from "@/lib/i18n";
import { readTerminalSoftKeyIds, TERMINAL_SOFT_KEYS, writeTerminalSoftKeyIds, type TerminalSoftKeyId } from "@/lib/terminal-preferences";
import { NativeSetting, SettingsHighlightContext, TERMINAL_ONLY_BADGE, ToggleSwitch, chipStyle, nativeOptionStyle, nativeSelectStyle, slugify } from "./settings/primitives";
import { ProviderKeysPanel } from "./settings/ProviderKeysPanel";
import { ProviderSignInPanel } from "./settings/ProviderSignInPanel";

const SettingsTabLoading = () => <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>Loading settings…</div>;
const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), { loading: SettingsTabLoading });
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig), { loading: SettingsTabLoading });
const PluginsConfig = dynamic(() => import("./PluginsConfig").then((module) => module.PluginsConfig), { loading: SettingsTabLoading });
const McpConfig = dynamic(() => import("./McpConfig").then((module) => module.McpConfig), { loading: SettingsTabLoading });
const OmpSchemaSettings = dynamic(() => import("./settings/OmpSchemaSettings").then((module) => module.OmpSchemaSettings), { loading: SettingsTabLoading });
const AccountSettings = dynamic(() => import("./settings/AccountSettings").then((module) => module.AccountSettings), { loading: SettingsTabLoading });
const LocalAiConfig = dynamic(() => import("./settings/LocalAiConfig").then((module) => module.LocalAiConfig), { loading: SettingsTabLoading });
const MemoryPanel = dynamic(() => import("./MemoryPanel").then((module) => module.MemoryPanel), { loading: SettingsTabLoading });
const SystemUpdates = dynamic(() => import("./settings/SystemUpdates").then((module) => module.SystemUpdates), { loading: SettingsTabLoading });

// Mirrors omp 17.4's compaction.methodOrder (session/compaction-methods.ts):
// an ordered preference list replaced the old single `strategy`.
type CompactionMethod = "remote" | "snapcompact" | "handoff" | "shake" | "soft";
const COMPACTION_METHOD_LABELS: Record<CompactionMethod, string> = {
  remote: "Server compaction",
  snapcompact: "Snapcompact",
  handoff: "Handoff",
  shake: "Shake",
  soft: "Soft summary",
};
const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = ["remote", "snapcompact", "handoff", "shake", "soft"];

type NativeSettings = {
  defaultThinkingLevel?: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  hideThinkingBlock?: boolean;
  externalThinking?: boolean;
  textVerbosity?: "low" | "medium" | "high";
  personality?: "default" | "friendly" | "pragmatic" | "none";
  advisor?: { enabled?: boolean; subagents?: boolean; syncBacklog?: "off" | "1" | "3" | "5"; immuneTurns?: number };
  tools?: { approvalMode?: "always-ask" | "write" | "yolo"; approval?: { bash?: "allow" | "prompt" | "deny"; extension?: "allow" | "prompt" } };
  compaction?: { enabled?: boolean; midTurnEnabled?: boolean; methodOrder?: CompactionMethod[]; autoContinue?: boolean; keepRecentTokens?: number };
  memory?: { backend?: "off" | "local" | "mnemopi" | "hindsight" };
  autolearn?: { enabled?: boolean; autoContinue?: boolean; minToolCalls?: number };
  mnemopi?: { scoping?: "global" | "per-project" | "per-project-tagged"; autoRecall?: boolean; autoRetain?: boolean; noEmbeddings?: boolean };
  mcp?: { enableProjectConfig?: boolean; renderMarkdownResults?: boolean; notifications?: boolean; notificationDebounceMs?: number };
  retry?: { enabled?: boolean; maxRetries?: number; modelFallback?: boolean };
};

type SearchResult = {
  id: string;
  kind: "category" | "setting";
  tab: SettingsTab;
  label: string;
  description: string;
  scope?: string;
  section?: string;
};

type SettingIndexEntry = {
  tab: SettingsTab;
  section: string;
  label: string;
  description: string;
  scope?: "Cody only" | "Workspace" | typeof TERMINAL_ONLY_BADGE;
  /** Overrides the label-derived anchor; schema settings key theirs by path so
   * two panels sharing a label do not fight over the highlight. */
  searchId?: string;
  /** Flag the card itself is gated on. Search must not offer a jump to a
   * control the active engine does not render — the tab can be visible while
   * one card inside it is not. */
  needsCapability?: keyof EngineCapabilities;
};

// NOTE: This index mirrors the <NativeSetting label=...> cards rendered in the
// panels below. Search matches against this index and jumps via slugify(label),
// so keep labels/descriptions in sync when editing the settings UI.
const SETTING_INDEX: SettingIndexEntry[] = [
  // User Accounts
  { tab: "accounts", section: "User Accounts", label: "Full name", description: "Shown on your profile and, for administrators, in the account roster.", scope: "Cody only" },
  { tab: "accounts", section: "User Accounts", label: "Profile picture", description: "PNG, JPEG or WebP. Cropped square and downscaled in your browser before upload.", scope: "Cody only" },
  { tab: "accounts", section: "User Accounts", label: "Change password", description: "Signs out your other devices and revokes this account's access tokens." },
  // Interface & Behavior
  { tab: "general", section: "Interface & Behavior", label: "Keep tool calls collapsed", description: "Show only compact headers while tools execute.", scope: "Cody only" },
  { tab: "general", section: "Interface & Behavior", label: "Expand thinking blocks", description: "Show the model's reasoning open by default instead of behind a collapsed header.", scope: "Cody only" },
  { tab: "general", section: "Interface & Behavior", label: "Completion sound", description: "Play a tone when the agent completes a run.", scope: "Cody only" },
  { tab: "general", section: "Interface & Behavior", label: "Message during active run", description: "What composer does on submit while agent runs. Steer interrupts; Queue follow-up delivers after finish.", scope: "Cody only", needsCapability: "chatExtras" },
  { tab: "general", section: "Interface & Behavior", label: "Terminal soft keys", description: "Choose the buttons shown below the terminal on touch devices.", scope: "Cody only" },
  // Tool Safety & Approvals
  { tab: "safety", section: "Tool Safety & Approvals", label: "Approval Mode", description: "Choose when OMP asks before tool calls." },
  { tab: "safety", section: "Tool Safety & Approvals", label: "Bash Override", description: "Override default approval policy specifically for terminal commands." },
  { tab: "safety", section: "Tool Safety & Approvals", label: "Extension Tool Requests", description: "Automatically approve extension tool authorization requests." },
  // AI Model Defaults
  { tab: "models", section: "AI Model Defaults", label: "Reasoning", description: "Default effort level for thinking-capable models." },
  { tab: "models", section: "AI Model Defaults", label: "Verbosity", description: "Response detail level for supporting providers." },
  { tab: "models", section: "AI Model Defaults", label: "Personality", description: "Style included in OMP's system prompt." },
  { tab: "models", section: "AI Model Defaults", label: "Hide thinking blocks", description: "Removes reasoning from the harness's own terminal transcript. Cody draws its own thinking blocks; use Expand thinking blocks under Interface & Behavior.", scope: TERMINAL_ONLY_BADGE, searchId: "hide-thinking-blocks-curated" },
  { tab: "models", section: "AI Model Defaults", label: "External Thinking", description: "Private scratchpad reasoning via think tool." },
  // Agent & Intelligence — Advisor Review
  { tab: "intelligence", section: "Advisor Review", label: "Enable Advisor", description: "Enable Advisor for new sessions with the advisor role." },
  { tab: "intelligence", section: "Advisor Review", label: "Advisor Backlog", description: "Wait briefly when advisor falls behind." },
  { tab: "intelligence", section: "Advisor Review", label: "Review Subagents", description: "Apply Advisor passive review to subagent tasks." },
  // Context Compaction
  { tab: "intelligence", section: "Context Compaction", label: "Automatic Compaction", description: "Compact context before model context limit is hit." },
  { tab: "intelligence", section: "Context Compaction", label: "Continue After Compaction", description: "Resume task execution after compaction completes." },
  { tab: "intelligence", section: "Context Compaction", label: "Method Order", description: "Preferred order of context-maintenance methods; unavailable methods fall through to the next." },
  { tab: "intelligence", section: "Context Compaction", label: "Compact Mid-Turn", description: "Check context limits between tool execution steps." },
  // Memory & Auto-Learn
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Memory Backend", description: "Where durable knowledge is stored across sessions." },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Enable Auto-Learn", description: "Capture reusable lessons after completed runs." },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Private Capture Turn", description: "Run private lesson-capture turn at completion." },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Memory Scope", description: "Scoping for Mnemopi knowledge storage." },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Recall on Session Start", description: "Load relevant memories into first turn." },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Retain Completed Turns", description: "Store completed conversation turns in memory." },
  // Automatic Retry
  { tab: "intelligence", section: "Automatic Retry", label: "Automatic Retry", description: "Retry failed turns automatically." },
  { tab: "intelligence", section: "Automatic Retry", label: "Max Attempts", description: "Retry limit before giving up." },
  { tab: "intelligence", section: "Automatic Retry", label: "Model Fallback", description: "Fall back to alternative model when retries exhaust." },
  // Extensions & Tools
  { tab: "mcp", section: "Extensions & Tools", label: "Load Project MCP Servers", description: "Allow project-root MCP configuration to be discovered.", needsCapability: "mcp" },
  { tab: "mcp", section: "Extensions & Tools", label: "Render MCP Markdown", description: "Render non-JSON MCP results as Markdown in transcript.", needsCapability: "mcp" },
  { tab: "mcp", section: "Extensions & Tools", label: "MCP Resource Updates", description: "Inject server resource updates into conversation.", needsCapability: "mcp" },
];

/** Ordered editor for compaction.methodOrder: enabled methods in preference
 * order with move/remove, remaining methods addable, and a one-click return to
 * omp's default order. An empty list is valid — it turns automatic context
 * maintenance off, which is what the legacy "Off" strategy mapped to. */
function CompactionMethodOrderEditor({ value, onChange }: {
  value: CompactionMethod[] | undefined;
  onChange: (methodOrder: CompactionMethod[]) => void;
}) {
  const order = value ?? DEFAULT_COMPACTION_METHOD_ORDER;
  const remaining = DEFAULT_COMPACTION_METHOD_ORDER.filter((method) => !order.includes(method));
  const isDefault = order.length === DEFAULT_COMPACTION_METHOD_ORDER.length
    && order.every((method, index) => method === DEFAULT_COMPACTION_METHOD_ORDER[index]);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const rowButton: React.CSSProperties = {
    padding: 2, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer",
    display: "inline-flex", alignItems: "center",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {order.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>No methods — automatic context maintenance is off.</div>
      )}
      {order.map((method, index) => (
        <div key={method} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)" }}>
          <span style={{ width: 14, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{index + 1}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{COMPACTION_METHOD_LABELS[method]}</span>
          <button type="button" aria-label={`Move ${COMPACTION_METHOD_LABELS[method]} up`} disabled={index === 0} onClick={() => move(index, -1)} style={{ ...rowButton, opacity: index === 0 ? 0.4 : 1, cursor: index === 0 ? "default" : "pointer" }}><ArrowUp size={13} /></button>
          <button type="button" aria-label={`Move ${COMPACTION_METHOD_LABELS[method]} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)} style={{ ...rowButton, opacity: index === order.length - 1 ? 0.4 : 1, cursor: index === order.length - 1 ? "default" : "pointer" }}><ArrowDown size={13} /></button>
          <button type="button" aria-label={`Remove ${COMPACTION_METHOD_LABELS[method]}`} onClick={() => onChange(order.filter((entry) => entry !== method))} style={rowButton}><X size={13} /></button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {remaining.length > 0 && (
          <select
            style={{ ...nativeSelectStyle, minHeight: 26, fontSize: 11.5 }}
            value=""
            aria-label="Add compaction method"
            onChange={(e) => { if (e.target.value) onChange([...order, e.target.value as CompactionMethod]); }}
          >
            <option value="" style={nativeOptionStyle}>Add method…</option>
            {remaining.map((method) => <option key={method} value={method} style={nativeOptionStyle}>{COMPACTION_METHOD_LABELS[method]}</option>)}
          </select>
        )}
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange([...DEFAULT_COMPACTION_METHOD_ORDER])}
            style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
          >
            Default order
          </button>
        )}
      </div>
    </div>
  );
}

function SearchResultsList({ results, query, onSelect }: { results: SearchResult[]; query: string; onSelect: (result: SearchResult) => void }) {
  return (
    <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
        {results.length === 0 ? `No settings match “${query}”.` : `${results.length} result${results.length === 1 ? "" : "s"} for “${query}”.`}
      </div>
      {results.map((result) => (
        <button
          key={result.id}
          type="button"
          onClick={() => onSelect(result)}
          style={{
            textAlign: "left",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            cursor: "pointer",
            transition: "border-color var(--dur-fast), background var(--dur-fast)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{result.label}</span>
            {result.kind === "category" && (
              <span style={chipStyle}>Section</span>
            )}
            {result.scope && (
              <span style={chipStyle}>{result.scope}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{result.description}</div>
          {result.section && <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{result.section}</div>}
        </button>
      ))}
    </div>
  );
}

export function SettingsConfig({ activeTab, advisorEnabled, onAdvisorChange, toolCallsDefaultCollapsed, onToolCallsDefaultCollapsedChange, thinkingDefaultExpanded, onThinkingDefaultExpandedChange, cwd, sessionId, capabilities = ALL_CAPABILITIES, engine = null, onModelsSaved, onPluginsReloaded, onOmpUpdateAvailabilityChange, onSelectTab, onClose }: {
  activeTab: SettingsTab;
  advisorEnabled: boolean;
  onAdvisorChange: (enabled: boolean) => void;
  toolCallsDefaultCollapsed: boolean;
  onToolCallsDefaultCollapsedChange: (collapsed: boolean) => void;
  thinkingDefaultExpanded: boolean;
  onThinkingDefaultExpandedChange: (expanded: boolean) => void;
  cwd: string | null;
  sessionId: string | null;
  /** Active engine capabilities: surfaces the engine cannot serve are hidden. */
  capabilities?: EngineCapabilities;
  /** Active engine identity, used for the harness-branded labels. */
  engine?: ActiveEngineInfo | null;
  onModelsSaved: () => void;
  onPluginsReloaded: () => void;
  onOmpUpdateAvailabilityChange: (available: boolean) => void;
  onSelectTab: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const workspaceReady = cwd !== null;
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [submitBehavior, setSubmitBehavior] = useState<SubmitDuringRunBehavior>(() => getSubmitDuringRunBehavior());
  const [terminalSoftKeyIds, setTerminalSoftKeyIds] = useState<TerminalSoftKeyId[]>(() => readTerminalSoftKeyIds());
  const { locale, setLocale } = useI18n();
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const value = window.localStorage.getItem(STORAGE_KEYS.soundEnabled);
      return value === null ? true : value === "true";
    } catch {
      return true;
    }
  });
  const [nativeSettings, setNativeSettings] = useState<NativeSettings | null>(null);
  const [nativeSettingsError, setNativeSettingsError] = useState<string | null>(null);
  // The curated panels and the schema-driven OMP panel write the same file.
  // Each bumps the other’s token after a save so neither keeps showing a value
  // the other has already changed.
  const [nativeReloadToken, setNativeReloadToken] = useState(0);
  const [schemaReloadToken, setSchemaReloadToken] = useState(0);
  const [schemaSearchIndex, setSchemaSearchIndex] = useState<SettingIndexEntry[]>([]);
  const [harnessLabel, setHarnessLabel] = useState(engine?.shortName ?? DEFAULT_HARNESS_LABEL);
  const [nativeSavesInFlight, setNativeSavesInFlight] = useState(0);
  const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(() => new Set(["general", activeTab]));

  useEffect(() => {
    setTerminalSoftKeyIds(readTerminalSoftKeyIds());
  }, []);

  useEffect(() => {
    setVisitedTabs((tabs) => (tabs.has(activeTab) ? tabs : new Set([...tabs, activeTab])));
  }, [activeTab]);

  // The engine's own settings file. Engines without native settings have no
  // such file (and no route that can read one), so skip the request entirely
  // rather than paint an error banner over panels that are already hidden.
  useEffect(() => {
    // configEditor, not nativeSettings: /api/omp-settings serves omp's
    // config.yml and refuses for every other engine. Hermes declares
    // nativeSettings for its own SCHEMA panel, so fetching on that flag put a
    // permanent 400 banner over its whole dialog.
    if (!capabilities.configEditor) return;
    fetch("/api/omp-settings")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { settings?: NativeSettings }) => setNativeSettings(data.settings ?? {}))
      .catch((error) => setNativeSettingsError(error instanceof Error ? error.message : String(error)));
  }, [nativeReloadToken, capabilities.configEditor]);

  // The schema behind the "All <engine> Settings" tab also backs the
  // dialog-wide search, so a setting Cody never hand-listed is still findable
  // by name from the search box.
  useEffect(() => {
    // The SAME flag that decides whether the tab exists (SettingsTabs.tsx) —
    // never configEditor, which means "omp, whose editors Cody hand-built".
    if (!capabilities[SCHEMA_TAB_CAPABILITY]) {
      setSchemaSearchIndex([]);
      return;
    }
    const controller = new AbortController();
    fetch("/api/omp-settings/schema", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { harness?: { shortName?: string }; schema?: { tabs?: Array<{ id: string; label: string }>; settings?: Array<{ key: string; tab: string; group?: string; label: string; description?: string; terminalOnly?: boolean }> } | null }) => {
        if (data.harness?.shortName) setHarnessLabel(data.harness.shortName);
        const tabLabels = new Map((data.schema?.tabs ?? []).map((tab) => [tab.id, tab.label]));
        setSchemaSearchIndex((data.schema?.settings ?? []).map((setting) => ({
          tab: "omp" as SettingsTab,
          section: [tabLabels.get(setting.tab) ?? setting.tab, setting.group].filter(Boolean).join(" › "),
          label: setting.label,
          description: setting.description ?? setting.key,
          ...(setting.terminalOnly ? { scope: TERMINAL_ONLY_BADGE } : {}),
          searchId: `omp-${setting.key}`,
        })));
      })
      .catch(() => setSchemaSearchIndex([]));
    return () => controller.abort();
  }, [capabilities]);

  const latestNativeSettingsRef = useRef<NativeSettings | null>(null);
  const nativeSaveDrainingRef = useRef(false);

  const saveNativeSettings = useCallback((next: NativeSettings) => {
    setNativeSettings(next);
    setNativeSettingsError(null);
    latestNativeSettingsRef.current = next;
    if (nativeSaveDrainingRef.current) return;
    nativeSaveDrainingRef.current = true;
    setNativeSavesInFlight((count) => count + 1);

    void (async () => {
      try {
        while (latestNativeSettingsRef.current !== null) {
          const snapshot = latestNativeSettingsRef.current;
          latestNativeSettingsRef.current = null;
          try {
            const response = await fetch("/api/omp-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
            const data = (await response.json()) as { settings?: NativeSettings; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (latestNativeSettingsRef.current === null) setNativeSettings(data.settings ?? snapshot);
          } catch (error) {
            setNativeSettingsError(error instanceof Error ? error.message : String(error));
            break;
          }
        }
      } finally {
        nativeSaveDrainingRef.current = false;
        setNativeSavesInFlight((count) => Math.max(0, count - 1));
        setSchemaReloadToken((token) => token + 1);
      }
    })();
  }, []);

  const currentSettings = (): NativeSettings => latestNativeSettingsRef.current ?? nativeSettings ?? {};

  const patchSettings = (patch: Partial<NativeSettings>) => {
    void saveNativeSettings({ ...currentSettings(), ...patch });
  };

  // `key` is always an object-valued section here (tools/advisor/compaction/...),
  // so the section spread is safe; the cast keeps the generic index type-checkable.
  const patchSection = <K extends keyof NativeSettings>(key: K, patch: Partial<NonNullable<NativeSettings[K]>>) => {
    const base = latestNativeSettingsRef.current;
    // The SECTION under `key`, never the whole settings object: spreading the
    // full object here wrote every top-level key into the section being
    // patched, filling config.yml sections with junk after the first save.
    const section = (base?.[key] ?? nativeSettings?.[key] ?? {}) as object;
    void saveNativeSettings({
      ...currentSettings(),
      [key]: { ...section, ...patch },
    });
  };

  // tools.approval is itself a nested object, so it needs its own base spread.
  const patchApproval = (patch: Partial<NonNullable<NonNullable<NativeSettings["tools"]>["approval"]>>) => {
    const base = latestNativeSettingsRef.current ?? nativeSettings ?? {};
    const tools = base.tools ?? {};
    void saveNativeSettings({ ...base, tools: { ...tools, approval: { ...(tools.approval ?? {}), ...patch } } });
  };

  const currentTab = getNormalizedActive(activeTab);

  // Tabs the active engine can serve. Sub-tabs (skills/plugins/extensions)
  // live under the "mcp" group entry but gate on their OWN capabilities: a
  // skills-only engine (pi) shows the group with just the skills panel.
  const visibleTabs = useMemo(() => {
    const ids = new Set<SettingsTab>(getSettingsCategories(harnessLabel, capabilities).map((tab) => tab.id));
    if (ids.has("mcp")) {
      if (capabilities.skills) ids.add("skills");
      if (capabilities.plugins) ids.add("plugins");
      // "extensions" deep-links to the MCP panel itself.
      if (capabilities.mcp) ids.add("extensions");
    }
    return ids;
  }, [harnessLabel, capabilities]);

  // A tab can go out of reach while it is open — the engine switched, or the
  // capability payload landed after the dialog did. Fall back to a tab that is
  // always available instead of rendering an empty panel.
  useEffect(() => {
    if (!visibleTabs.has(currentTab)) onSelectTab("general");
  }, [visibleTabs, currentTab, onSelectTab]);

  // The Extensions & Tools group can be visible while its MCP panel is not
  // (pi: skills without MCP). Landing on the group then means the first
  // sub-surface this engine actually serves.
  useEffect(() => {
    if ((activeTab === "mcp" || activeTab === "extensions") && !capabilities.mcp) {
      onSelectTab(capabilities.skills ? "skills" : "plugins");
    }
  }, [activeTab, capabilities.mcp, capabilities.skills, onSelectTab]);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchActive = trimmedQuery.length > 0;

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!trimmedQuery) return [];
    const results: SearchResult[] = [];
    for (const category of getSettingsCategories(harnessLabel, capabilities)) {
      const haystack = `${category.label} ${category.description}`.toLowerCase();
      if (haystack.includes(trimmedQuery)) {
        results.push({ id: `tab-${category.id}`, kind: "category", tab: category.id, label: category.label, description: category.description });
      }
    }
    for (const setting of [...SETTING_INDEX, ...schemaSearchIndex]) {
      // Never hand out a jump to a panel — or a card — this engine does not render.
      if (!visibleTabs.has(setting.tab)) continue;
      if (setting.needsCapability && !capabilities[setting.needsCapability]) continue;
      const haystack = `${setting.label} ${setting.description} ${setting.section}`.toLowerCase();
      if (haystack.includes(trimmedQuery)) {
        results.push({ id: setting.searchId ?? slugify(setting.label), kind: "setting", tab: setting.tab, label: setting.label, description: setting.description, scope: setting.scope, section: setting.section });
      }
    }
    return results;
  }, [trimmedQuery, schemaSearchIndex, harnessLabel, capabilities, visibleTabs]);

  const openSearchResult = useCallback((result: SearchResult) => {
    onSelectTab(result.tab);
    setHighlightId(result.kind === "setting" ? result.id : null);
    setSearchQuery("");
  }, [onSelectTab]);
  const toggleTerminalSoftKey = (id: TerminalSoftKeyId) => {
    const selected = new Set(terminalSoftKeyIds);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    const next = TERMINAL_SOFT_KEYS.map((key) => key.id).filter((keyId) => selected.has(keyId));
    setTerminalSoftKeyIds(next);
    try {
      writeTerminalSoftKeyIds(next);
    } catch {
      // The preference remains live for this page even if storage is blocked.
    }
    window.dispatchEvent(new CustomEvent(STORAGE_EVENTS.terminalSoftKeysChange));
  };


  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent ariaLabel="Settings" style={{ width: isMobile ? "calc(100vw - 16px)" : 940, maxWidth: "calc(100vw - 16px)", height: isMobile ? "calc(100dvh - 16px)" : "82vh", maxHeight: "calc(100dvh - 16px)", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "12px 18px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <DialogTitle style={{ fontSize: 16, margin: 0, fontWeight: 600 }}>Settings</DialogTitle>
            {nativeSavesInFlight > 0 ? (
              <span style={{ fontSize: 11, color: "var(--accent)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <RefreshCw size={11} className="spin" aria-hidden="true" /> Saving…
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--text-dim)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)" }}>
                Auto-saved
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, maxWidth: 360, justifyContent: "flex-end" }}>
            <div style={{ position: "relative", width: "100%", maxWidth: 260 }}>
              <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
              <input
                type="text"
                aria-label="Search settings"
                placeholder="Search settings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    setHighlightId(null);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                style={{ width: "100%", height: 28, padding: "0 8px 0 28px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
              />
            </div>
            <button type="button" onClick={onClose} aria-label="Close settings" className="ui-focus-ring" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, width: 32, height: 32, minWidth: 32, minHeight: 32, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>×</button>
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {searchActive ? (
            <SearchResultsList results={searchResults} query={searchQuery.trim()} onSelect={openSearchResult} />
          ) : (
            <SettingsHighlightContext.Provider value={highlightId}>
              {isMobile ? (
                <SettingsTabs active={currentTab} onSelect={onSelectTab} workspaceReady={workspaceReady} layout="horizontal" harnessLabel={harnessLabel} capabilities={capabilities} />
              ) : (
                <SettingsTabs active={currentTab} onSelect={onSelectTab} workspaceReady={workspaceReady} layout="vertical" harnessLabel={harnessLabel} capabilities={capabilities} />
              )}

              <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", background: "var(--bg)" }}>
            {nativeSettingsError && (
              <div role="alert" style={{ margin: 16, padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--status-error)", color: "var(--status-error)", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <AlertCircle size={14} aria-hidden="true" /> {nativeSettingsError}
              </div>
            )}

            {/* USER ACCOUNTS TAB */}
            {currentTab === "accounts" && <AccountSettings isMobile={isMobile} />}

            {/* GENERAL & UI TAB */}
            {currentTab === "general" && (
              <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Interface & Behavior</h3>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Controls interface presentation, notification sounds, and execution submission mode.</p>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <NativeSetting label="Keep tool calls collapsed" description="Show only compact headers while tools execute." scope="Cody only">
                    <ToggleSwitch checked={toolCallsDefaultCollapsed} onChange={onToolCallsDefaultCollapsedChange} />
                  </NativeSetting>
                  <NativeSetting label="Expand thinking blocks" description="Show the model's reasoning open by default instead of behind a collapsed header." scope="Cody only">
                    <ToggleSwitch checked={thinkingDefaultExpanded} onChange={onThinkingDefaultExpandedChange} />
                  </NativeSetting>
                  <NativeSetting label="Completion sound" description="Play a tone when the agent completes a run." scope="Cody only">
                    <ToggleSwitch
                      checked={soundEnabled}
                      onChange={(next) => {
                        setSoundEnabled(next);
                        try { localStorage.setItem(STORAGE_KEYS.soundEnabled, String(next)); } catch { /* storage fallback */ }
                        window.dispatchEvent(new CustomEvent(STORAGE_EVENTS.soundPrefChange, { detail: next }));
                      }}
                    />
                  </NativeSetting>
                </div>
                <NativeSetting label="Language" description="Interface language. Auto-detected from the browser until chosen here." scope="Cody only">
                  <select
                    style={nativeSelectStyle}
                    value={locale}
                    onChange={(event) => setLocale(event.target.value as Locale)}
                  >
                    {LOCALES.map((item) => (
                      <option key={item.value} value={item.value} style={nativeOptionStyle}>{item.label}</option>
                    ))}
                  </select>
                </NativeSetting>
                {/* Steering and the follow-up queue are rpc-dialect commands.
                    On an engine without chatExtras nothing can be submitted
                    mid-turn at all, so this choice governs nothing — it is
                    hidden rather than left as a setting that does nothing. */}
                {capabilities.chatExtras && (
                  <NativeSetting label="Message during active run" description="What composer does on submit while agent runs. Steer interrupts; Queue follow-up delivers after finish." scope="Cody only">
                    <select
                      style={nativeSelectStyle}
                      value={submitBehavior}
                      onChange={(event) => {
                        const next = event.target.value as SubmitDuringRunBehavior;
                        setSubmitDuringRunBehavior(next);
                        setSubmitBehavior(next);
                      }}
                    >
                      <option value="steer" style={nativeOptionStyle}>Steer current run</option>
                      <option value="queue" style={nativeOptionStyle}>Queue follow-up</option>
                    </select>
                  </NativeSetting>
                )}
                <NativeSetting
                  label="Terminal soft keys"
                  description="Choose the buttons shown below the terminal on touch devices. Shift Tab moves backward through terminal UI modes."
                  scope="Cody only"
                  control={(
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(74px, 1fr))", gap: 6 }}>
                      {TERMINAL_SOFT_KEYS.map((key) => {
                        const selected = terminalSoftKeyIds.includes(key.id);
                        return (
                          <button
                            key={key.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => toggleTerminalSoftKey(key.id)}
                            style={{
                              minHeight: 28,
                              padding: "3px 7px",
                              border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                              borderRadius: "var(--radius-control)",
                              background: selected ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg)",
                              color: selected ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                            }}
                          >
                            {key.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                />
              </div>
            )}

            {/* SAFETY & APPROVALS TAB */}
            {currentTab === "safety" && (
              <div role="tabpanel" id="settings-panel-safety" aria-labelledby="settings-tab-safety" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Tool Safety & Approvals</h3>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Tool execution safety rules and permission prompts. Persisted in <code>~/.omp/agent/config.yml</code>.</p>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <NativeSetting label="Approval Mode" description="Choose when OMP asks before tool calls.">
                    <select
                      style={nativeSelectStyle}
                      value={nativeSettings?.tools?.approvalMode ?? "yolo"}
                      onChange={(event) => patchSection("tools", { approvalMode: event.target.value as "always-ask" | "write" | "yolo" })}
                    >
                      <option value="always-ask" style={nativeOptionStyle}>Always ask</option>
                      <option value="write" style={nativeOptionStyle}>Allow writes</option>
                      <option value="yolo" style={nativeOptionStyle}>Auto approve (YOLO)</option>
                    </select>
                  </NativeSetting>
                  <NativeSetting label="Bash Override" description="Override default approval policy specifically for terminal commands.">
                    <select
                      style={nativeSelectStyle}
                      value={nativeSettings?.tools?.approval?.bash ?? "prompt"}
                      onChange={(event) => patchApproval({ bash: event.target.value as "allow" | "prompt" | "deny" })}
                    >
                      <option value="allow" style={nativeOptionStyle}>Allow</option>
                      <option value="prompt" style={nativeOptionStyle}>Always ask</option>
                      <option value="deny" style={nativeOptionStyle}>Deny</option>
                    </select>
                  </NativeSetting>
                  <NativeSetting label="Extension Tool Requests" description="Automatically approve extension tool authorization requests.">
                    <select
                      style={nativeSelectStyle}
                      value={nativeSettings?.tools?.approval?.extension ?? "prompt"}
                      onChange={(event) => patchApproval({ extension: event.target.value as "allow" | "prompt" })}
                    >
                      <option value="prompt" style={nativeOptionStyle}>Ask every time</option>
                      <option value="allow" style={nativeOptionStyle}>Auto approve</option>
                    </select>
                  </NativeSetting>
                </div>
              </div>
            )}

            {/* AI MODEL DEFAULTS TAB */}
            {(activeTab === "models" || currentTab === "models") && (
              <div role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>AI Model Defaults</h3>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Configure default reasoning effort, response verbosity, personality tone, and thinking display.</p>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <NativeSetting label="Reasoning" description="Default effort level for thinking-capable models.">
                    <select
                      style={nativeSelectStyle}
                      value={nativeSettings?.defaultThinkingLevel ?? "high"}
                      onChange={(e) => patchSettings({ defaultThinkingLevel: e.target.value as NativeSettings["defaultThinkingLevel"] })}
                    >
                      {["auto", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
                        <option key={l} value={l} style={nativeOptionStyle}>{l}</option>
                      ))}
                    </select>
                  </NativeSetting>
                  <NativeSetting label="Verbosity" description="Response detail level for supporting providers.">
                    <select
                      style={nativeSelectStyle}
                      value={nativeSettings?.textVerbosity ?? "medium"}
                      onChange={(e) => patchSettings({ textVerbosity: e.target.value as NativeSettings["textVerbosity"] })}
                    >
                      {["low", "medium", "high"].map((l) => (
                        <option key={l} value={l} style={nativeOptionStyle}>{l}</option>
                      ))}
                    </select>
                  </NativeSetting>
                  <NativeSetting label="Personality" description="Style included in OMP's system prompt.">
                    <select
                      style={nativeSelectStyle}
                      value={nativeSettings?.personality ?? "default"}
                      onChange={(e) => patchSettings({ personality: e.target.value as NativeSettings["personality"] })}
                    >
                      {["default", "friendly", "pragmatic", "none"].map((p) => (
                        <option key={p} value={p} style={nativeOptionStyle}>{p}</option>
                      ))}
                    </select>
                  </NativeSetting>
                  <NativeSetting
                    label="Hide thinking blocks"
                    description="Removes reasoning from the harness's own terminal transcript. Cody draws its own thinking blocks; use Expand thinking blocks under Interface & Behavior."
                    badge={TERMINAL_ONLY_BADGE}
                    searchId="hide-thinking-blocks-curated"
                  >
                    <ToggleSwitch
                      checked={nativeSettings?.hideThinkingBlock ?? false}
                      onChange={(checked) => patchSettings({ hideThinkingBlock: checked })}
                    />
                  </NativeSetting>
                  <NativeSetting label="External Thinking" description="Private scratchpad reasoning via think tool.">
                    <ToggleSwitch
                      checked={nativeSettings?.externalThinking ?? false}
                      onChange={(checked) => patchSettings({ externalThinking: checked })}
                    />
                  </NativeSetting>
                </div>
              </div>
            )}

            {/* API KEYS & PROVIDERS TAB. Three parts: the engine's own
                provider SIGN-IN (a subscription or device code, kept in the
                engine's own store — gated on capabilities.providerLogin, so
                it disappears for an engine with no login surface), the
                engine-neutral provider keys (every engine reads its
                credentials from the environment, so this exists for all
                five), and omp's own OAuth/registry editor, which only omp's
                file format serves. */}
            {(visitedTabs.has("providers") || visitedTabs.has("models")) && (
              <div role="tabpanel" id="settings-panel-providers" aria-labelledby="settings-tab-providers" className="settings-scroll-column" style={{ display: (currentTab === "providers" || activeTab === "providers") ? "flex" : "none", height: "100%", minHeight: 0, flexDirection: "column", overflowY: "auto" }}>
                <div style={{ padding: 20, borderBottom: capabilities.models ? "1px solid var(--border)" : undefined, display: "flex", flexDirection: "column", gap: 24 }}>
                  {capabilities.providerLogin && <ProviderSignInPanel />}
                  <ProviderKeysPanel />
                </div>
                {capabilities.models && (
                  // A box of its own: ModelsConfig lays its body out as
                  // `flex: 1` inside a column, and inside this scroll column
                  // that would resolve to ZERO height under ~15 key cards.
                  // A fixed tall box gives it room and scrolls as one unit.
                  <div style={{ flex: "0 0 auto", height: 720, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    <ModelsConfig embedded engineId={engine?.id ?? null} onClose={onClose} onSaved={onModelsSaved} />
                  </div>
                )}
              </div>
            )}

            {/* LOCAL AI TAB */}
            {visitedTabs.has("localai") && (
              <div role="tabpanel" id="settings-panel-localai" aria-labelledby="settings-tab-localai" style={{ display: currentTab === "localai" ? "flex" : "none", flexDirection: "column" }}>
                <LocalAiConfig />
              </div>
            )}

            {/* AGENT INTELLIGENCE TAB */}
            {currentTab === "intelligence" && (
              <div role="tabpanel" id="settings-panel-intelligence" aria-labelledby="settings-tab-intelligence" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
                {/* Advisor Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
                    <Sparkles size={14} aria-hidden="true" style={{ color: "var(--accent)" }} /> Advisor Review
                  </div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>Configured advisor model role passively reviews turns and injects guidance notes.</p>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <NativeSetting label="Enable Advisor" description="Enable Advisor for new sessions with the advisor role.">
                      <ToggleSwitch
                        checked={nativeSettings?.advisor?.enabled ?? advisorEnabled}
                        onChange={(enabled) => {
                          onAdvisorChange(enabled);
                          patchSection("advisor", { enabled });
                        }}
                      />
                    </NativeSetting>
                    {(nativeSettings?.advisor?.enabled ?? advisorEnabled) && (
                      <NativeSetting label="Advisor Backlog" description="Wait briefly when advisor falls behind.">
                        <select
                          style={nativeSelectStyle}
                          value={nativeSettings?.advisor?.syncBacklog ?? "off"}
                          onChange={(e) => patchSection("advisor", { syncBacklog: e.target.value as "off" | "1" | "3" | "5" })}
                        >
                          <option value="off" style={nativeOptionStyle}>Off</option>
                          <option value="1" style={nativeOptionStyle}>1 turn</option>
                          <option value="3" style={nativeOptionStyle}>3 turns</option>
                          <option value="5" style={nativeOptionStyle}>5 turns</option>
                        </select>
                      </NativeSetting>
                    )}
                  </div>
                  {(nativeSettings?.advisor?.enabled ?? advisorEnabled) && (
                    <NativeSetting label="Review Subagents" description="Apply Advisor passive review to subagent tasks.">
                      <ToggleSwitch
                        checked={nativeSettings?.advisor?.subagents ?? false}
                        onChange={(checked) => patchSection("advisor", { subagents: checked })}
                      />
                    </NativeSetting>
                  )}
                </section>

                {/* Context Compaction Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Context Compaction</div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>OMP automatically compacts oversized context to prevent hitting context limits.</p>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <NativeSetting label="Automatic Compaction" description="Compact context before model context limit is hit.">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.enabled ?? true}
                        onChange={(checked) => patchSection("compaction", { enabled: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Continue After Compaction" description="Resume task execution after compaction completes.">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.autoContinue ?? true}
                        onChange={(checked) => patchSection("compaction", { autoContinue: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Method Order" description="Preferred order of context-maintenance methods; unavailable methods fall through to the next.">
                      <CompactionMethodOrderEditor
                        value={nativeSettings?.compaction?.methodOrder}
                        onChange={(methodOrder) => patchSection("compaction", { methodOrder })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Compact Mid-Turn" description="Check context limits between tool execution steps.">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.midTurnEnabled ?? true}
                        onChange={(checked) => patchSection("compaction", { midTurnEnabled: checked })}
                      />
                    </NativeSetting>
                  </div>
                </section>

                {/* Memory & Auto-Learn Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Memory & Auto-Learn</div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>Durable project memory storage and automatic lesson capture.</p>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <NativeSetting label="Memory Backend" description="Where durable knowledge is stored across sessions.">
                      <select
                        style={nativeSelectStyle}
                        value={nativeSettings?.memory?.backend ?? "mnemopi"}
                        onChange={(e) => patchSection("memory", { backend: e.target.value as NonNullable<NativeSettings["memory"]>["backend"] })}
                      >
                        <option value="off" style={nativeOptionStyle}>Off</option>
                        <option value="local" style={nativeOptionStyle}>Local summaries</option>
                        <option value="mnemopi" style={nativeOptionStyle}>Mnemopi SQLite</option>
                        <option value="hindsight" style={nativeOptionStyle}>Hindsight</option>
                      </select>
                    </NativeSetting>
                    <NativeSetting label="Enable Auto-Learn" description="Capture reusable lessons after completed runs.">
                      <ToggleSwitch
                        checked={nativeSettings?.autolearn?.enabled ?? true}
                        onChange={(checked) => patchSection("autolearn", { enabled: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Private Capture Turn" description="Run private lesson-capture turn at completion.">
                      <ToggleSwitch
                        checked={nativeSettings?.autolearn?.autoContinue ?? true}
                        onChange={(checked) => patchSection("autolearn", { autoContinue: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Memory Scope" description="Scoping for Mnemopi knowledge storage.">
                      <select
                        style={nativeSelectStyle}
                        value={nativeSettings?.mnemopi?.scoping ?? "per-project"}
                        onChange={(e) => patchSection("mnemopi", { scoping: e.target.value as NonNullable<NativeSettings["mnemopi"]>["scoping"] })}
                      >
                        <option value="per-project" style={nativeOptionStyle}>Per project</option>
                        <option value="per-project-tagged" style={nativeOptionStyle}>Per project, tagged recall</option>
                        <option value="global" style={nativeOptionStyle}>Global</option>
                      </select>
                    </NativeSetting>
                    <NativeSetting label="Recall on Session Start" description="Load relevant memories into first turn.">
                      <ToggleSwitch
                        checked={nativeSettings?.mnemopi?.autoRecall ?? true}
                        onChange={(checked) => patchSection("mnemopi", { autoRecall: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Retain Completed Turns" description="Store completed conversation turns in memory.">
                      <ToggleSwitch
                        checked={nativeSettings?.mnemopi?.autoRetain ?? true}
                        onChange={(checked) => patchSection("mnemopi", { autoRetain: checked })}
                      />
                    </NativeSetting>
                  </div>
                </section>

                {/* Retry Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Automatic Retry</div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>Rules for automatically retrying failed turns.</p>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <NativeSetting label="Automatic Retry" description="Retry failed turns automatically.">
                      <ToggleSwitch
                        checked={nativeSettings?.retry?.enabled ?? true}
                        onChange={(checked) => patchSection("retry", { enabled: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Max Attempts" description="Retry limit before giving up.">
                      <select
                        style={nativeSelectStyle}
                        value={String(nativeSettings?.retry?.maxRetries ?? 2)}
                        onChange={(e) => patchSection("retry", { maxRetries: Number(e.target.value) })}
                      >
                        {[0, 1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n} style={nativeOptionStyle}>{n}</option>
                        ))}
                      </select>
                    </NativeSetting>
                    <NativeSetting label="Model Fallback" description="Fall back to alternative model when retries exhaust.">
                      <ToggleSwitch
                        checked={nativeSettings?.retry?.modelFallback ?? false}
                        onChange={(checked) => patchSection("retry", { modelFallback: checked })}
                      />
                    </NativeSetting>
                  </div>
                </section>
              </div>
            )}

            {/* EXTENSIONS & TOOLS TAB (MCP, SKILLS, PLUGINS). The group heading
                and workspace-select hint are NOT behind capabilities.mcp: a
                skills-only engine (pi, Hermes) has no MCP panel to fall back
                on, so without a workspace this is the group's only content —
                gating it on capabilities.mcp left the tab highlighted over a
                blank pane. Only the MCP-specific controls stay gated.
                The group pane and a sub-panel are never shown TOGETHER: once
                a workspace lets the skills/plugins panel render, the group
                pane yields to it. Both are 100% tall, so a group pane left
                visible pushed the sub-panel below the fold — under pi and
                Hermes the Extensions tab was a heading over nothing. */}
            {(visitedTabs.has("mcp") || visitedTabs.has("skills") || visitedTabs.has("plugins")) && (
              <div role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp" className="settings-scroll-column" style={{ display: currentTab === "mcp" && (activeTab === "mcp" || !cwd) ? "flex" : "none", height: "100%", minHeight: 0, flexDirection: "column", overflowY: "auto", padding: 20, gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Extensions & Tools</h3>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{extensionsGroupDescription(capabilities)}.</p>
                </div>
                {capabilities.mcp && cwd && (
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <NativeSetting label="Load Project MCP Servers" description="Allow project-root MCP configuration to be discovered.">
                      <ToggleSwitch
                        checked={nativeSettings?.mcp?.enableProjectConfig ?? true}
                        onChange={(checked) => patchSection("mcp", { enableProjectConfig: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="Render MCP Markdown" description="Render non-JSON MCP results as Markdown in transcript.">
                      <ToggleSwitch
                        checked={nativeSettings?.mcp?.renderMarkdownResults ?? true}
                        onChange={(checked) => patchSection("mcp", { renderMarkdownResults: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting label="MCP Resource Updates" description="Inject server resource updates into conversation.">
                      <ToggleSwitch
                        checked={nativeSettings?.mcp?.notifications ?? false}
                        onChange={(checked) => patchSection("mcp", { notifications: checked })}
                      />
                    </NativeSetting>
                  </div>
                )}
                {capabilities.mcp && <McpConfig cwd={cwd} sessionId={sessionId} />}
                {!cwd && (
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
                    {capabilities.mcp
                      ? "Select a project workspace to view and edit its project MCP configuration."
                      : "Select a project workspace to manage its extensions."}
                  </p>
                )}
              </div>
            )}

            {/* SKILLS SUB-PANEL CONTRACT MATCH */}
            {cwd && capabilities.skills && visitedTabs.has("skills") && (
              <div role="tabpanel" id="settings-panel-skills" aria-labelledby="settings-tab-skills" style={{ display: activeTab === "skills" ? "flex" : "none", height: "100%", minHeight: 0, flexDirection: "column" }}>
                <SkillsConfig embedded cwd={cwd} onClose={onClose} />
              </div>
            )}

            {/* PLUGINS SUB-PANEL CONTRACT MATCH */}
            {cwd && capabilities.plugins && visitedTabs.has("plugins") && (
              <div role="tabpanel" id="settings-panel-plugins" aria-labelledby="settings-tab-plugins" style={{ display: activeTab === "plugins" ? "flex" : "none", height: "100%", minHeight: 0, flexDirection: "column" }}>
                <PluginsConfig embedded cwd={cwd} sessionId={sessionId} onClose={onClose} onReloaded={onPluginsReloaded} />
              </div>
            )}

            {/* AGENT MEMORY TAB — read-only, and hidden entirely on an engine
                that cannot hand its memory back (components/MemoryPanel.tsx).
                Same three-site gate as the skills sub-panel: the tab list and
                the visible-tab set both come from `needsCapability: "memory"`
                in SETTINGS_CATEGORIES, and this render gates on the flag too
                so a capability payload arriving late can never paint it. */}
            {capabilities.memory && visitedTabs.has("memory") && (
              <div role="tabpanel" id="settings-panel-memory" aria-labelledby="settings-tab-memory" style={{ display: currentTab === "memory" ? "flex" : "none", flexDirection: "column" }}>
                <MemoryPanel engineName={engine?.shortName ?? null} />
              </div>
            )}

            {/* ALL OMP SETTINGS TAB — rendered from OMP's own schema */}
            {currentTab === "omp" && (
              <OmpSchemaSettings
                isMobile={isMobile}
                harnessLabel={harnessLabel}
                reloadToken={schemaReloadToken}
                onSaved={() => setNativeReloadToken((token) => token + 1)}
              />
            )}

            {/* SYSTEM & UPDATES TAB — the consolidated home for app, engine,
                and skill updates (components/settings/SystemUpdates.tsx). */}
            {currentTab === "system" && (
              <SystemUpdates
                cwd={cwd}
                capabilities={capabilities}
                onOmpUpdateAvailabilityChange={onOmpUpdateAvailabilityChange}
                onOpenSkills={() => onSelectTab("skills")}
              />
            )}
              </div>
            </SettingsHighlightContext.Provider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
