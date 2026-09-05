"use client";

/**
 * What the dialog-wide search knows about. Three sources, one union:
 *
 *   - STATIC entries: every panel module exports `SEARCH_ENTRIES`, derived
 *     FROM the table it renders (`PREFERENCE_CARDS`, the Behavior
 *     `RECOMMENDED_CARDS`, the Account / System / Extensions lists), so a
 *     label rendered and a label searchable are the same string.
 *     `loadStaticSearchEntries` imports the panel modules lazily and
 *     tolerates one that has no export yet (or fails to load):
 *     `components/settings-search-index.test.mjs` fails when a rendered
 *     `<NativeSetting label>` is missing from the union.
 *   - FALLBACK entries: TEMPORARY. Hubs whose module does not export
 *     `SEARCH_ENTRIES` yet are searched through `FALLBACK_ENTRIES` below,
 *     the hand-kept list the old SettingsConfig carried, re-mapped onto hub
 *     ids. Entries for a hub drop out automatically the moment its module
 *     exports the real table; delete the whole list when the last hub does.
 *   - DYNAMIC entries: rows built from the shared route cache at search time
 *     (`buildSchemaSearchEntries` for the engine's schema; providers,
 *     engines, MCP servers, skills and models follow with their hubs).
 *
 * Ids follow the jump contract (`data-search-id` + SettingsHighlightContext):
 * `schema-<key>` for schema rows and the curated cards bound to them,
 * `provider-<id>`, `engine-<id>`, `mcp-<name>`, else `slugify(label)`.
 */
import type { EngineCapabilities, SettingsTab } from "../SettingsTabs";
import { TERMINAL_ONLY_BADGE, UNAVAILABLE_BADGE, slugify } from "./primitives";
import { capabilityAllows, getVisibleSections, groupLabel, normalizeSectionId, resolveSection, type CapabilityGate, type SettingsSectionId } from "./registry";
import { cardOwner, cardSurfaceAvailable } from "./engine/recommended-cards";
import { SEARCH_ENTRIES as PREFERENCE_ENTRIES } from "./panels/PreferencesPanel";

export interface SearchEntry {
  /** `data-search-id` the pane scrolls to. */
  id: string;
  tab: SettingsSectionId;
  sub?: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  /** Owner trail shown under the result: ["OMP", "Behavior", "Approvals"].
   * `{engine}` is replaced by the active engine's short name. */
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

export type SearchFilter = "changed" | "cody" | "terminal" | "unavailable";

/** The chips above the results, in display order. */
export const SEARCH_FILTERS: readonly { id: SearchFilter; label: string }[] = [
  { id: "changed", label: "Changed" },
  { id: "cody", label: "Cody only" },
  { id: "terminal", label: TERMINAL_ONLY_BADGE },
  { id: "unavailable", label: UNAVAILABLE_BADGE },
];

export function matchesSearchFilter(entry: SearchEntry, filter: SearchFilter | null | undefined): boolean {
  switch (filter) {
    case "changed": return entry.modified === true;
    case "cody": return entry.scope === "Cody only";
    case "terminal": return entry.scope === TERMINAL_ONLY_BADGE;
    case "unavailable": return entry.badge === UNAVAILABLE_BADGE;
    default: return true;
  }
}

export const HUB_LABELS: Record<SettingsSectionId, string> = {
  accounts: "Account",
  general: "Preferences",
  providers: "Providers",
  models: "Models",
  engine: "Behavior",
  extensions: "Extensions",
  memory: "Memory",
  system: "System",
};

interface FallbackEntry {
  tab: SettingsTab;
  section: string;
  label: string;
  description: string;
  scope?: SearchEntry["scope"];
  searchId?: string;
  needsCapability?: keyof EngineCapabilities;
}

// TEMPORARY (see the module note): mirrors the <NativeSetting label=...>
// cards the stub Account, Behavior and Extensions panels still render.
// Search jumps via slugify(label), so a label edited in a stub panel must
// be edited here too until that panel exports its own SEARCH_ENTRIES.
const FALLBACK_INDEX: readonly FallbackEntry[] = [
  // Account
  { tab: "accounts", section: "Account", label: "Full name", description: "Shown on your profile and, for administrators, in the account roster.", scope: "Cody only" },
  { tab: "accounts", section: "Account", label: "Profile picture", description: "PNG, JPEG or WebP. Cropped square and downscaled in your browser before upload.", scope: "Cody only" },
  { tab: "accounts", section: "Account", label: "Change password", description: "Signs out your other devices and revokes this account's access tokens." },
  // Behavior › Safety
  { tab: "safety", section: "Tool Safety & Approvals", label: "Approval Mode", description: "Choose when the engine asks before tool calls.", needsCapability: "configEditor" },
  { tab: "safety", section: "Tool Safety & Approvals", label: "Bash Override", description: "Override default approval policy specifically for terminal commands.", needsCapability: "configEditor" },
  { tab: "safety", section: "Tool Safety & Approvals", label: "Extension Tool Requests", description: "Automatically approve extension tool authorization requests.", needsCapability: "configEditor" },
  // Behavior › Model Defaults
  { tab: "intelligence", section: "AI Model Defaults", label: "Reasoning", description: "Default effort level for thinking-capable models.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "AI Model Defaults", label: "Verbosity", description: "Response detail level for supporting providers.", needsCapability: "configEditor" },
  { tab: "intelligence", section: "AI Model Defaults", label: "Personality", description: "Style included in the engine's system prompt.", needsCapability: "configEditor" },
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

function fromFallback(entry: FallbackEntry): SearchEntry {
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

/** The temporary list, as search entries; exported for the drift test only. */
export const FALLBACK_ENTRIES: readonly SearchEntry[] = FALLBACK_INDEX.map(fromFallback);

/** The static union: every loaded panel's table plus which hubs those
 * tables cover (a covered hub needs no fallback). */
export interface StaticSearchIndex {
  entries: readonly SearchEntry[];
  coveredTabs: ReadonlySet<SettingsSectionId>;
}

/** What is known before any panel module has loaded: Preferences is
 * imported statically (it is small and every engine has it). */
export const PRELOADED_STATIC_INDEX: StaticSearchIndex = {
  entries: PREFERENCE_ENTRIES,
  coveredTabs: new Set<SettingsSectionId>(["general"]),
};

/** Kept for callers that only need the synchronous part of the union. */
export const SEARCH_ENTRIES: readonly SearchEntry[] = PRELOADED_STATIC_INDEX.entries;

/** Reads a module's `SEARCH_ENTRIES` export; null when it has none. */
export function readSearchEntriesExport(module: unknown): readonly SearchEntry[] | null {
  if (!module || typeof module !== "object") return null;
  const candidate = (module as { SEARCH_ENTRIES?: unknown }).SEARCH_ENTRIES;
  return Array.isArray(candidate) ? (candidate as readonly SearchEntry[]) : null;
}

/** Every hub module, loaded lazily: the same chunks `registry.ts` mounts,
 * so nothing is downloaded twice. Order is the rail's. */
const STATIC_SOURCES: ReadonlyArray<{ tab: SettingsSectionId; load: () => Promise<unknown> }> = [
  { tab: "accounts", load: () => import("./panels/AccountPanel") },
  { tab: "general", load: () => import("./panels/PreferencesPanel") },
  { tab: "providers", load: () => import("./panels/ProvidersPanel") },
  { tab: "models", load: () => import("./panels/ModelsPanel") },
  { tab: "engine", load: () => import("./panels/EnginePanel") },
  { tab: "extensions", load: () => import("./panels/ExtensionsPanel") },
  { tab: "memory", load: () => import("./panels/MemoryPanel") },
  { tab: "system", load: () => import("./panels/SystemPanel") },
];

let staticIndexPromise: Promise<StaticSearchIndex> | null = null;
let staticIndexCache: StaticSearchIndex | null = null;

/** Build the union from module results; a module with no export (or one
 * that failed to load) leaves its hub to the fallback list. */
export function buildStaticSearchIndex(sources: ReadonlyArray<{ tab: SettingsSectionId; entries: readonly SearchEntry[] | null }>): StaticSearchIndex {
  const entries: SearchEntry[] = [];
  const coveredTabs = new Set<SettingsSectionId>();
  for (const source of sources) {
    if (!source.entries) continue;
    coveredTabs.add(source.tab);
    for (const entry of source.entries) {
      coveredTabs.add(entry.tab);
      entries.push(entry);
    }
  }
  return { entries, coveredTabs };
}

/** Load every panel module once and remember the union. Never rejects. */
export function loadStaticSearchEntries(): Promise<StaticSearchIndex> {
  if (!staticIndexPromise) {
    staticIndexPromise = Promise.all(STATIC_SOURCES.map(async ({ tab, load }) => {
      try {
        return { tab, entries: readSearchEntriesExport(await load()) };
      } catch {
        // A hub another slice is mid-writing, or a chunk that failed to
        // download: search keeps working without it.
        return { tab, entries: null };
      }
    })).then((sources) => {
      staticIndexCache = buildStaticSearchIndex(sources);
      return staticIndexCache;
    });
  }
  return staticIndexPromise;
}

/** The static union as currently known: the full one once loaded, the
 * preloaded Preferences table before that. */
export function currentStaticSearchIndex(): StaticSearchIndex {
  return staticIndexCache ?? PRELOADED_STATIC_INDEX;
}

/** The schema route's body, as much of it as search reads without the
 * index hook (tests, and anything that only has the raw body). */
export interface SchemaRouteBody {
  harness?: { shortName?: string; version?: string } | null;
  schema?: {
    tabs?: Array<{ id: string; label: string }>;
    settings?: Array<{ key: string; tab: string; group?: string; label: string; description?: string; terminalOnly?: boolean; condition?: unknown }>;
  } | null;
  values?: Record<string, unknown>;
  /** Secret leaves that hold a value; never in `values`. */
  secretsSet?: string[];
}

/** One schema setting as search wants it: `useSchemaIndex().rows` resolve
 * `visible` (the `ui.condition` holds) and `modified` per row; a raw body
 * (`schemaRowsFromBody`) treats every row as visible. */
export interface SchemaSearchRow {
  key: string;
  label: string;
  description?: string;
  tab: string;
  /** The tab's display label; the id is shown when unknown. */
  tabLabel?: string;
  group?: string;
  terminalOnly?: boolean;
  visible: boolean;
  modified: boolean;
}

/** Rows from a raw schema body, every one visible: what search had before
 * conditions were evaluated per row, kept for callers without the hook. */
export function schemaRowsFromBody(body: SchemaRouteBody | null | undefined): SchemaSearchRow[] {
  if (!body?.schema?.settings) return [];
  const tabLabels = new Map((body.schema.tabs ?? []).map((tab) => [tab.id, tab.label]));
  const values = body.values ?? {};
  const secrets = new Set(body.secretsSet ?? []);
  return body.schema.settings.map((setting) => ({
    key: setting.key,
    label: setting.label,
    description: setting.description,
    tab: setting.tab,
    tabLabel: tabLabels.get(setting.tab),
    group: setting.group,
    terminalOnly: setting.terminalOnly,
    visible: true,
    modified: setting.key in values || secrets.has(setting.key),
  }));
}

/** Where a schema key's CARD renders when a curated surface owns it and
 * that surface exists on this engine: the jump then lands on the card (it
 * holds the `schema-<key>` id), so the result must open that hub and trail
 * it. Null when the schema row is the key's only home. */
function cardHome(key: string, capabilities: EngineCapabilities | undefined): { tab: SettingsSectionId; sub?: string; trail: string[] } | null {
  const owner = cardOwner(key);
  if (!owner || !capabilities || !cardSurfaceAvailable(owner.surface, capabilities)) return null;
  if (owner.surface === "mcp") return { tab: "extensions", sub: "mcp", trail: [HUB_LABELS.extensions, "MCP"] };
  if (owner.surface === "retry") return { tab: "models", sub: "assignments", trail: [HUB_LABELS.models, "Assignments"] };
  return { tab: "engine", trail: [HUB_LABELS.engine, "Recommended", ...(owner.group ? [owner.group.label] : [])] };
}

/** Dynamic entries for the engine's own schema: one per VISIBLE setting
 * (a row whose `ui.condition` does not hold has no control to jump to),
 * findable by label, description AND key, with the schema tab › group as
 * the trail — or the curated card's home (Recommended › group, Extensions ›
 * MCP, Models › Assignments) when a card owns the key, since that card
 * holds the `schema-<key>` id the jump lands on. A static entry with the
 * same id (a curated-only card) wins the dedupe in `collectSearchEntries`. */
export function buildSchemaSearchEntries(rows: readonly SchemaSearchRow[] | null | undefined, shortName: string, capabilities?: EngineCapabilities): SearchEntry[] {
  if (!rows) return [];
  const entries: SearchEntry[] = [];
  for (const row of rows) {
    if (!row.visible) continue;
    const home = cardHome(row.key, capabilities);
    entries.push({
      id: `schema-${row.key}`,
      tab: home?.tab ?? "engine",
      ...(home?.sub ? { sub: home.sub } : {}),
      label: row.label,
      description: row.description ?? row.key,
      keywords: [row.key],
      breadcrumb: home
        ? [shortName, ...home.trail]
        : [shortName, HUB_LABELS.engine, row.tabLabel ?? row.tab, ...(row.group ? [row.group] : [])],
      ...(row.terminalOnly ? { scope: TERMINAL_ONLY_BADGE as SearchEntry["scope"] } : {}),
      modified: row.modified,
      action: "jump",
    });
  }
  return entries;
}

/** Everything the shell has cached that search can read. Providers, engines,
 * MCP servers, skills and models join here with their hubs. */
export interface DynamicSearchSources {
  /** `useSchemaIndex().rows` mapped through the shell, or `schemaRowsFromBody`. */
  schemaRows?: readonly SchemaSearchRow[] | null;
}

/** One hub row per visible section, so "Providers" finds the hub itself. */
function hubEntries(capabilities: EngineCapabilities, shortName: string): SearchEntry[] {
  return getVisibleSections(capabilities).map((section) => ({
    id: `tab-${section.id}`,
    tab: section.id,
    label: section.label,
    description: `${groupLabel(section.group, shortName)} › ${section.label}`,
    breadcrumb: [groupLabel(section.group, shortName)],
    action: "jump" as const,
  }));
}

/**
 * The union search runs over: hub rows, the static tables, the temporary
 * fallback for hubs without a table, and the dynamic rows. Entries whose hub
 * is not visible or whose own gate fails are dropped, never dimmed; the
 * first entry with an id wins (a curated card over the schema row it binds).
 */
export function collectSearchEntries({ capabilities, shortName, dynamic, statics }: {
  capabilities: EngineCapabilities;
  shortName: string;
  dynamic?: DynamicSearchSources;
  /** Overrides the loaded static index (tests). */
  statics?: StaticSearchIndex;
}): SearchEntry[] {
  const index = statics ?? currentStaticSearchIndex();
  const visible = new Set<SettingsSectionId>(getVisibleSections(capabilities).map((section) => section.id));
  const fallback = FALLBACK_ENTRIES.filter((entry) => !index.coveredTabs.has(entry.tab));
  const union = [
    ...hubEntries(capabilities, shortName),
    ...index.entries,
    ...fallback,
    ...buildSchemaSearchEntries(dynamic?.schemaRows, shortName, capabilities),
  ];
  const seen = new Set<string>();
  const result: SearchEntry[] = [];
  for (const entry of union) {
    if (!visible.has(entry.tab)) continue;
    if (!capabilityAllows(entry.needsCapability, capabilities)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push({ ...entry, breadcrumb: entry.breadcrumb.map((crumb) => (crumb === "{engine}" ? shortName : crumb)) });
  }
  return result;
}

export interface SearchResult extends SearchEntry {
  /** Lower ranks first: label prefix, label contains, keyword/key, description, trail. */
  rank: number;
}

/**
 * Filter + rank the union for a query and an optional chip. A chip with no
 * query lists everything it matches (every changed setting, say), in table
 * order. Nothing is returned for an empty query without a chip.
 */
export function searchSettings(query: string, entries: readonly SearchEntry[], opts?: { filter?: SearchFilter | null }): SearchResult[] {
  const needle = query.trim().toLowerCase();
  const filter = opts?.filter ?? null;
  if (!needle && !filter) return [];
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (!matchesSearchFilter(entry, filter)) continue;
    let rank: number | null = null;
    if (!needle) rank = 5;
    else {
      const label = entry.label.toLowerCase();
      if (label.startsWith(needle)) rank = 0;
      else if (label.includes(needle)) rank = 1;
      else if ((entry.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle))) rank = 2;
      else if ((entry.description ?? "").toLowerCase().includes(needle)) rank = 3;
      else if (entry.breadcrumb.join(" ").toLowerCase().includes(needle)) rank = 4;
    }
    if (rank === null) continue;
    results.push({ ...entry, rank });
  }
  // A stable sort: entries of equal rank keep table order.
  return results.sort((a, b) => a.rank - b.rank);
}

/** The hub a result opens, as the shell's `selectSection` wants it. */
export function resultTarget(result: SearchEntry): { id: SettingsSectionId; sub?: string } {
  return { id: normalizeSectionId(result.tab), ...(result.sub ? { sub: result.sub } : {}) };
}

/** The highlight a result asks the pane for: hub rows highlight nothing. */
export function resultHighlight(result: SearchEntry): string | null {
  return result.id.startsWith("tab-") ? null : result.id;
}
