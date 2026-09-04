"use client";

/**
 * What the dialog-wide search knows about. Two sources:
 *
 *   - STATIC entries: `SEARCH_ENTRIES`, the union of every panel's exported
 *     `SEARCH_ENTRIES` list. The convention every hub follows: the module
 *     that owns a card table (`PREFERENCE_CARDS`, the Behavior
 *     `RECOMMENDED_CARDS`, the Account / System / Extensions lists) exports
 *     `SEARCH_ENTRIES: readonly SearchEntry[]` derived FROM that table, so a
 *     label rendered and a label searchable are the same string, and this
 *     file concatenates them. `components/settings-search-index.test.mjs`
 *     (next slice) fails when a rendered `<NativeSetting label>` is missing
 *     from the union.
 *   - DYNAMIC entries: rows built from the shared route cache at search time
 *     (`buildSchemaSearchEntries` for the engine's schema; providers,
 *     engines, MCP servers, skills and models follow with their hubs).
 *
 * Until every hub exports its table, `LEGACY_SETTING_INDEX` below carries
 * the hand-kept list the old SettingsConfig searched, re-mapped onto the hub
 * ids. It shrinks as hubs adopt the convention and goes when the last does.
 */
import type { EngineCapabilities, SettingsTab } from "../SettingsTabs";
import { TERMINAL_ONLY_BADGE, slugify } from "./primitives";
import { normalizeSectionId, resolveSection, type CapabilityGate, type SettingsSectionId } from "./registry";
import { SEARCH_ENTRIES as PREFERENCE_ENTRIES } from "./panels/PreferencesPanel";

export interface SearchEntry {
  /** `data-search-id` the pane scrolls to: `schema-<key>` for schema rows,
   * `provider-<id>`, `engine-<id>`, `mcp-<name>`, else `slugify(label)`. */
  id: string;
  tab: SettingsSectionId;
  sub?: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  /** Owner trail shown under the result: ["OMP", "Behavior", "Approvals"]. */
  breadcrumb: readonly string[];
  scope?: "Cody only" | "Workspace" | typeof TERMINAL_ONLY_BADGE;
  badge?: string;
  /** The card's own gate: a hub can be visible while one card inside it is
   * not, and search must never offer a jump to a control that is not there. */
  needsCapability?: CapabilityGate;
  modified?: boolean;
  /** `jump` scrolls to the card; `filter` pre-fills a hub's own search box. */
  action: "jump" | "filter";
}

interface LegacyIndexEntry {
  tab: SettingsTab;
  section: string;
  label: string;
  description: string;
  scope?: "Cody only" | "Workspace" | typeof TERMINAL_ONLY_BADGE;
  searchId?: string;
  needsCapability?: keyof EngineCapabilities;
}

// NOTE: This list mirrors the <NativeSetting label=...> cards the stub panels
// render (formerly SettingsConfig's SETTING_INDEX). Search jumps via
// slugify(label), so keep labels in sync when editing a card. Preferences
// already exports its own table (PREFERENCE_ENTRIES) and is not repeated.
const LEGACY_SETTING_INDEX: readonly LegacyIndexEntry[] = [
  // Account
  { tab: "accounts", section: "Account", label: "Full name", description: "Shown on your profile and, for administrators, in the account roster.", scope: "Cody only" },
  { tab: "accounts", section: "Account", label: "Profile picture", description: "PNG, JPEG or WebP. Cropped square and downscaled in your browser before upload.", scope: "Cody only" },
  { tab: "accounts", section: "Account", label: "Change password", description: "Signs out your other devices and revokes this account's access tokens." },
  // Behavior › Safety
  { tab: "safety", section: "Tool Safety & Approvals", label: "Approval Mode", description: "Choose when OMP asks before tool calls.", needsCapability: "configEditor" },
  { tab: "safety", section: "Tool Safety & Approvals", label: "Bash Override", description: "Override default approval policy specifically for terminal commands.", needsCapability: "configEditor" },
  { tab: "safety", section: "Tool Safety & Approvals", label: "Extension Tool Requests", description: "Automatically approve extension tool authorization requests.", needsCapability: "configEditor" },
  // Behavior › Model Defaults
  { tab: "intelligence", section: "AI Model Defaults", label: "Reasoning", description: "Default effort level for thinking-capable models.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "AI Model Defaults", label: "Verbosity", description: "Response detail level for supporting providers.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "AI Model Defaults", label: "Personality", description: "Style included in OMP's system prompt.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "AI Model Defaults", label: "Hide thinking blocks", description: "Removes reasoning from the harness's own terminal transcript. Cody draws its own thinking blocks; use Expand thinking blocks under Preferences.", scope: TERMINAL_ONLY_BADGE, searchId: "hide-thinking-blocks-curated", needsCapability: "configEditor" },
  { tab: "intelligence", section: "AI Model Defaults", label: "External Thinking", description: "Private scratchpad reasoning via think tool.", needsCapability: "configEditor" },
  // Behavior › Advisor
  { tab: "intelligence", section: "Advisor Review", label: "Enable Advisor", description: "Enable Advisor for new sessions with the advisor role.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Advisor Review", label: "Advisor Backlog", description: "Wait briefly when advisor falls behind.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Advisor Review", label: "Review Subagents", description: "Apply Advisor passive review to subagent tasks.", needsCapability: "configEditor" },
  // Behavior › Compaction
  { tab: "intelligence", section: "Context Compaction", label: "Automatic Compaction", description: "Compact context before model context limit is hit.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Context Compaction", label: "Continue After Compaction", description: "Resume task execution after compaction completes.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Context Compaction", label: "Method Order", description: "Preferred order of context-maintenance methods; unavailable methods fall through to the next.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Context Compaction", label: "Compact Mid-Turn", description: "Check context limits between tool execution steps.", needsCapability: "configEditor" },
  // Behavior › Memory & Auto-Learn
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Memory Backend", description: "Where durable knowledge is stored across sessions.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Enable Auto-Learn", description: "Capture reusable lessons after completed runs.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Private Capture Turn", description: "Run private lesson-capture turn at completion.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Memory Scope", description: "Scoping for Mnemopi knowledge storage.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Recall on Session Start", description: "Load relevant memories into first turn.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Memory & Auto-Learn", label: "Retain Completed Turns", description: "Store completed conversation turns in memory.", needsCapability: "configEditor" },
  // Behavior › Retry
  { tab: "intelligence", section: "Automatic Retry", label: "Automatic Retry", description: "Retry failed turns automatically.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Automatic Retry", label: "Max Attempts", description: "Retry limit before giving up.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "Automatic Retry", label: "Model Fallback", description: "Fall back to alternative model when retries exhaust.", needsCapability: "configEditor" },
  // Extensions › MCP
  { tab: "mcp", section: "MCP", label: "Load Project MCP Servers", description: "Allow project-root MCP configuration to be discovered.", needsCapability: "mcp" },
  { tab: "mcp", section: "MCP", label: "Render MCP Markdown", description: "Render non-JSON MCP results as Markdown in transcript.", needsCapability: "mcp" },
  { tab: "mcp", section: "MCP", label: "MCP Resource Updates", description: "Inject server resource updates into conversation.", needsCapability: "mcp" },
];

const HUB_LABELS: Record<SettingsSectionId, string> = {
  accounts: "Account",
  general: "Preferences",
  providers: "Providers",
  models: "Models",
  engine: "Behavior",
  extensions: "Extensions",
  memory: "Memory",
  system: "System",
};

function fromLegacy(entry: LegacyIndexEntry): SearchEntry {
  const { id, sub } = resolveSection(entry.tab);
  const owner = id === "accounts" || id === "general" || id === "system" ? "Cody" : "{engine}";
  return {
    id: entry.searchId ?? slugify(entry.label),
    tab: id,
    ...(sub ? { sub } : {}),
    label: entry.label,
    description: entry.description,
    breadcrumb: [owner, HUB_LABELS[id], entry.section],
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.needsCapability ? { needsCapability: entry.needsCapability } : {}),
    action: "jump",
  };
}

/** Every static entry the shell searches. */
export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  ...PREFERENCE_ENTRIES,
  ...LEGACY_SETTING_INDEX.map(fromLegacy),
];

/** The schema route's body, as much of it as search reads. */
export interface SchemaRouteBody {
  harness?: { shortName?: string; version?: string } | null;
  schema?: { tabs?: Array<{ id: string; label: string }>; settings?: Array<{ key: string; tab: string; group?: string; label: string; description?: string; terminalOnly?: boolean }> } | null;
  values?: Record<string, unknown>;
}

/** Dynamic entries for the engine's own schema: one per declared setting,
 * findable by label, description AND key, with the schema tab › group as the
 * trail. Ids are `omp-<key>` to match the jump the schema panel answers to. */
export function buildSchemaSearchEntries(body: SchemaRouteBody | null, harnessLabel: string): SearchEntry[] {
  if (!body?.schema?.settings) return [];
  const tabLabels = new Map((body.schema.tabs ?? []).map((tab) => [tab.id, tab.label]));
  const values = body.values ?? {};
  return body.schema.settings.map((setting) => ({
    id: `omp-${setting.key}`,
    tab: "engine" as const,
    label: setting.label,
    description: setting.description ?? setting.key,
    keywords: [setting.key],
    breadcrumb: [harnessLabel, HUB_LABELS.engine, tabLabels.get(setting.tab) ?? setting.tab, ...(setting.group ? [setting.group] : [])],
    ...(setting.terminalOnly ? { scope: TERMINAL_ONLY_BADGE as SearchEntry["scope"] } : {}),
    modified: setting.key in values,
    action: "jump" as const,
  }));
}

export interface SearchResult extends SearchEntry {
  /** Lower ranks first: label prefix, label contains, keyword/key, description. */
  rank: number;
}

/** Filter + rank entries for a query. Entries whose hub is not visible or
 * whose own gate fails are dropped, never dimmed. */
export function searchSettings(query: string, entries: readonly SearchEntry[], visibleSections: ReadonlySet<SettingsSectionId>, capabilities: EngineCapabilities, harnessLabel: string): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (!visibleSections.has(entry.tab)) continue;
    if (entry.needsCapability) {
      const needs = typeof entry.needsCapability === "string" ? [entry.needsCapability] : entry.needsCapability;
      if (!needs.some((key) => capabilities[key])) continue;
    }
    const label = entry.label.toLowerCase();
    let rank: number | null = null;
    if (label.startsWith(needle)) rank = 0;
    else if (label.includes(needle)) rank = 1;
    else if ((entry.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle))) rank = 2;
    else if ((entry.description ?? "").toLowerCase().includes(needle)) rank = 3;
    else if (entry.breadcrumb.join(" ").replace("{engine}", harnessLabel).toLowerCase().includes(needle)) rank = 4;
    if (rank === null) continue;
    results.push({ ...entry, breadcrumb: entry.breadcrumb.map((crumb) => (crumb === "{engine}" ? harnessLabel : crumb)), rank });
  }
  return results.sort((a, b) => a.rank - b.rank);
}

/** The hub a result opens, as the shell's `selectSection` wants it. */
export function resultTarget(result: SearchEntry): { id: SettingsSectionId; sub?: string } {
  return { id: normalizeSectionId(result.tab), ...(result.sub ? { sub: result.sub } : {}) };
}
