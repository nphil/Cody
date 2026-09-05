"use client";

/**
 * What the dialog-wide search knows about. Two sources, one union:
 *
 *   - STATIC entries: every panel module exports `SEARCH_ENTRIES`, derived
 *     FROM the table it renders (`PREFERENCE_CARDS`, the Behavior
 *     `RECOMMENDED_CARDS`, the Account / System / Extensions lists), so a
 *     label rendered and a label searchable are the same string.
 *     `loadStaticSearchEntries` imports the panel modules lazily and
 *     tolerates one that has no export yet (or fails to load):
 *     `components/settings-search-index.test.mjs` fails when a rendered
 *     `<NativeSetting label>` is missing from the union.
 *   - DYNAMIC entries: rows built from the shared route cache at search time
 *     (`buildSchemaSearchEntries` for the engine's schema; the hubs' own
 *     hooks, gathered by `SearchSources`, for engines and MCP servers;
 *     providers, skills and models follow).
 *
 * Ids follow the jump contract (`data-search-id` + SettingsHighlightContext):
 * `schema-<key>` for schema rows and the curated cards bound to them,
 * `provider-<id>`, `engine-<id>`, `mcp-<name>`, else `slugify(label)`.
 */
import type { EngineCapabilities } from "../SettingsTabs";
import { TERMINAL_ONLY_BADGE, UNAVAILABLE_BADGE } from "./primitives";
import { capabilityAllows, getVisibleSections, groupLabel, normalizeSectionId, type CapabilityGate, type SettingsSectionId } from "./registry";
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

/** The static union: every loaded panel's table plus which hubs those
 * tables cover (a hub whose module has not loaded yet is simply absent). */
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
 * that failed to load) contributes nothing and its hub stays uncovered. */
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
  /** Entries hubs derive from cached routes (`SearchSources`): engines
   * (`engine-<id>`), MCP servers (`mcp-<name>`); providers and models follow. */
  entries?: readonly SearchEntry[] | null;
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
 * The union search runs over: hub rows, the static tables and the dynamic
 * rows. Entries whose hub is not visible or whose own gate fails are
 * dropped, never dimmed; the first entry with an id wins (a curated card
 * over the schema row it binds).
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
  const union = [
    ...hubEntries(capabilities, shortName),
    ...index.entries,
    ...(dynamic?.entries ?? []),
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
