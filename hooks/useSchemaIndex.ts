"use client";

/**
 * The engine's settings schema, indexed for the Behavior hub and the
 * dialog-wide search: every row with its effective value, whether its
 * `ui.condition` currently holds, whether it is changed from the engine's
 * default, and (for credential-shaped leaves) whether a value is set at all.
 *
 * This is the ONE component-facing module that reads lib/omp: the condition
 * predicates (`settings-conditions`) are evaluated here, once, so a
 * Recommended card and its schema row can never disagree about visibility —
 * and no component needs the seam allow-list. The types the panels use are
 * re-exported from the engine-neutral harness contract.
 *
 * Reads go through the shared route cache (`useSettingsRoute`), so the rail
 * status line, the search index and both layers of the hub share one body.
 * Writes go through the config writer (`patchSettingsSchema`, coalesced) with
 * an optimistic update of that same cached body, so a toggle never snaps back
 * while the PUT is in flight; the writer's invalidation then re-reads the
 * file, which is the truth.
 */
import { useCallback, useMemo } from "react";
import type { EngineSetting, EngineSettingValue, EngineSettingsSchema } from "@/lib/harness/types";
import { HOST_CONDITIONS, SETTING_CONDITIONS, isConditionSatisfied, type HostFacts } from "@/lib/omp/settings-conditions";
import { SCHEMA_ROUTE, patchSettingsSchema } from "./useConfigWriter";
import { readSettingsRoute, setSettingsRouteData, useSettingsRoute } from "./useSettingsData";

export type { EngineSetting as SchemaSetting, EngineSettingValue as SchemaValue, EngineSettingsSchema as SchemaShape };

/** GET /api/omp-settings/schema, as much of it as the client reads. */
export interface SchemaRouteBody {
  path?: string;
  harness?: { id?: string; shortName?: string } | null;
  host?: { platform?: string } | null;
  schema?: EngineSettingsSchema | null;
  values?: Record<string, EngineSettingValue>;
  /** Secret leaves that hold a value. Their values are never in `values`. */
  secretsSet?: string[];
  reason?: string;
  error?: string;
}

export interface SchemaRow extends EngineSetting {
  /** The `ui.condition` holds (or there is none): the row is shown. */
  visible: boolean;
  /** A value is persisted for this key (an override of the engine default). */
  modified: boolean;
  /** What the engine will use: the persisted value, else the declared default
   * (an empty list for arrays, the first choice for an enum). Undefined for
   * a secret leaf, whose value never reaches the browser. */
  value: EngineSettingValue | undefined;
  /** For secret leaves: a value is set (never what it is). */
  secretSet: boolean;
  /** Search / jump id: `schema-<key>`. */
  searchId: string;
}

export interface SchemaGroup {
  id: string;
  label: string;
  rows: SchemaRow[];
  changed: number;
}

export interface SchemaTab {
  id: string;
  label: string;
  rows: SchemaRow[];
  /** Declared groups in the engine's order (only those with rows). */
  groups: SchemaGroup[];
  /** Rows with no group, bucketed by key prefix, listed after the groups. */
  ungrouped: SchemaGroup[];
  changed: number;
}

export type SchemaStatus = "disabled" | "loading" | "unsupported" | "error" | "unavailable" | "ready";

export interface SchemaIndex {
  status: SchemaStatus;
  /** Why the schema is unavailable, in the engine's words; a fetch error. */
  reason: string | null;
  path: string | null;
  shortName: string | null;
  version: string | null;
  schema: EngineSettingsSchema | null;
  rows: SchemaRow[];
  byKey: ReadonlyMap<string, SchemaRow>;
  tabs: SchemaTab[];
  values: Readonly<Record<string, EngineSettingValue>>;
  defaults: Readonly<Record<string, EngineSettingValue>>;
  secretsSet: ReadonlySet<string>;
  settingsCount: number;
  modifiedCount: number;
  isVisible: (key: string) => boolean;
  /** The same evaluation a row gets, for a card whose key has no schema row
   * but shares its neighbours' predicate (a curated-only key). */
  conditionMet: (condition: string | undefined) => boolean;
  /** A sentence for a predicate Cody cannot evaluate (the row is shown
   * unconditionally), or null when it can and the row simply hides. */
  describeCondition: (condition: string | undefined) => string | null;
  /** Write one key (null resets it to the engine default). Resolves when the
   * coalesced PUT carrying it settles; rejects with the engine's reason. */
  setValue: (key: string, value: EngineSettingValue | null) => Promise<void>;
  reload: () => Promise<unknown>;
}

const EMPTY_VALUES: Record<string, EngineSettingValue> = {};

/** A setting's effective value: the persisted one, else what the engine
 * would use in its absence. */
export function effectiveValue(setting: EngineSetting, values: Readonly<Record<string, EngineSettingValue>>): EngineSettingValue | undefined {
  const stored = values[setting.key];
  if (stored !== undefined) return stored;
  if (setting.default !== undefined) return setting.default;
  if (setting.type === "array") return [];
  if (setting.type === "enum") return setting.options?.[0]?.value ?? setting.values?.[0];
  return undefined;
}

/** Camel-case splits at lowercase→uppercase boundaries only, so an acronym
 * run ("macOS", "hasSIXELSupport") survives instead of shattering. */
function describeUnknownCondition(condition: string, shortName: string): string {
  const words = condition
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()))
    .join(" ");
  return `Only takes effect when ${shortName} reports ${words}.`;
}

/** Rows with no group bucket by their first dotted segment, bare keys under
 * "General" — the only structure an ungrouped key carries. */
function prefixOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? "General" : key.slice(0, dot);
}

function buildTabs(schema: EngineSettingsSchema, rows: SchemaRow[]): SchemaTab[] {
  return schema.tabs.map((tab) => {
    const tabRows = rows.filter((row) => row.tab === tab.id);
    const declared = schema.groups[tab.id] ?? [];
    const seen = new Set<string>();
    const groups: SchemaGroup[] = [];
    for (const group of [...declared, ...tabRows.map((row) => row.group ?? "").filter(Boolean)]) {
      if (seen.has(group)) continue;
      seen.add(group);
      const groupRows = tabRows.filter((row) => row.group === group);
      if (groupRows.length === 0) continue;
      groups.push({ id: group, label: group, rows: groupRows, changed: groupRows.filter((row) => row.modified).length });
    }
    const loose = tabRows.filter((row) => !row.group);
    const ungrouped: SchemaGroup[] = [];
    for (const row of loose) {
      const prefix = prefixOf(row.key);
      let bucket = ungrouped.find((entry) => entry.id === prefix);
      if (!bucket) {
        bucket = { id: prefix, label: prefix, rows: [], changed: 0 };
        ungrouped.push(bucket);
      }
      bucket.rows.push(row);
      if (row.modified) bucket.changed += 1;
    }
    return { id: tab.id, label: tab.label, rows: tabRows, groups, ungrouped, changed: tabRows.filter((row) => row.modified).length };
  });
}

/** Optimistically fold a write into the cached body so the control shows the
 * chosen value at once. Secret values never enter the cache: only the
 * `secretsSet` membership moves. */
function applyOptimistic(key: string, value: EngineSettingValue | null): void {
  const body = readSettingsRoute<SchemaRouteBody>(SCHEMA_ROUTE);
  if (!body?.schema) return;
  const setting = body.schema.settings.find((entry) => entry.key === key);
  const values = { ...(body.values ?? {}) };
  let secretsSet = body.secretsSet ?? [];
  if (setting?.secret) {
    const set = typeof value === "string" && value.length > 0;
    secretsSet = set ? [...new Set([...secretsSet, key])] : secretsSet.filter((entry) => entry !== key);
  } else if (value === null) {
    delete values[key];
  } else {
    values[key] = value;
  }
  setSettingsRouteData<SchemaRouteBody>(SCHEMA_ROUTE, { ...body, values, secretsSet });
}

export function useSchemaIndex(opts?: { enabled?: boolean }): SchemaIndex {
  const enabled = opts?.enabled ?? true;
  const route = useSettingsRoute<SchemaRouteBody>(SCHEMA_ROUTE, { enabled, ttlMs: 60_000 });
  const body = route.data;
  const schema = body?.schema ?? null;
  const values = body?.values ?? EMPTY_VALUES;
  const platform = body?.host?.platform;
  const host = useMemo<HostFacts | undefined>(() => (typeof platform === "string" ? { platform } : undefined), [platform]);
  const shortName = body?.harness?.shortName ?? null;

  const resolver = useCallback((key: string): unknown => {
    const setting = schema?.settings.find((candidate) => candidate.key === key);
    return setting ? effectiveValue(setting, values) : undefined;
  }, [schema, values]);

  const conditionMet = useCallback((condition: string | undefined) => isConditionSatisfied(condition, resolver, host), [resolver, host]);

  const describeCondition = useCallback((condition: string | undefined): string | null => {
    if (!condition || SETTING_CONDITIONS[condition] || HOST_CONDITIONS[condition]) return null;
    return describeUnknownCondition(condition, shortName ?? "the engine");
  }, [shortName]);

  const secretsSet = useMemo(() => new Set(body?.secretsSet ?? []), [body?.secretsSet]);

  const { rows, byKey, tabs, defaults } = useMemo(() => {
    if (!schema) return { rows: [] as SchemaRow[], byKey: new Map<string, SchemaRow>(), tabs: [] as SchemaTab[], defaults: {} as Record<string, EngineSettingValue> };
    const defaultsOut: Record<string, EngineSettingValue> = {};
    const built = schema.settings.map((setting): SchemaRow => {
      if (setting.default !== undefined) defaultsOut[setting.key] = setting.default;
      const secretSet = Boolean(setting.secret) && secretsSet.has(setting.key);
      return {
        ...setting,
        visible: conditionMet(setting.condition),
        modified: setting.secret ? secretSet : values[setting.key] !== undefined,
        value: setting.secret ? undefined : effectiveValue(setting, values),
        secretSet,
        searchId: `schema-${setting.key}`,
      };
    });
    return { rows: built, byKey: new Map(built.map((row) => [row.key, row])), tabs: buildTabs(schema, built), defaults: defaultsOut };
  }, [schema, values, secretsSet, conditionMet]);

  const isVisible = useCallback((key: string) => byKey.get(key)?.visible ?? false, [byKey]);

  const setValue = useCallback((key: string, value: EngineSettingValue | null) => {
    applyOptimistic(key, value);
    return patchSettingsSchema({ [key]: value });
  }, []);

  let status: SchemaStatus = "loading";
  if (!enabled) status = "disabled";
  else if (route.unsupported) status = "unsupported";
  else if (body?.error) status = "error";
  else if (body && !schema) status = "unavailable";
  else if (schema) status = "ready";
  else if (route.error) status = "error";

  const reason = body?.error ?? (body && !schema ? body.reason ?? null : null) ?? route.error ?? null;

  return useMemo<SchemaIndex>(() => ({
    status,
    reason,
    path: body?.path ?? null,
    shortName,
    version: schema?.source.version ?? null,
    schema,
    rows,
    byKey,
    tabs,
    values,
    defaults,
    secretsSet,
    settingsCount: rows.length,
    modifiedCount: rows.filter((row) => row.modified).length,
    isVisible,
    conditionMet,
    describeCondition,
    setValue,
    reload: route.reload,
  }), [status, reason, body?.path, shortName, schema, rows, byKey, tabs, values, defaults, secretsSet, isVisible, conditionMet, describeCondition, setValue, route.reload]);
}
