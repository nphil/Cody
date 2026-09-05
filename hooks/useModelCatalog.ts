"use client";

/**
 * The data behind Settings › Models: every model the ACTIVE engine can
 * reach, in one row shape whatever the engine, with who hid or pinned it
 * and what is new since the user last looked.
 *
 * Three engines, three sources, one row:
 *   - omp: the UNRESTRICTED catalog (`/api/models?catalog=full`, an hour's
 *     cache) diffed against the effective list (`/api/models`) — a model in
 *     the first and not the second is hidden by omp's own `enabledModels`,
 *     the instance-wide hide on omp. Hiding writes that allow-list through
 *     the config writer (lib/model-allow-list.ts is the dialect).
 *   - pi: the effective list is the catalog; the instance hide is Cody's
 *     visibility file (`/api/models/visibility` `instanceHidden`).
 *   - ACP engines: the open session's `availableModels`, lifted into the
 *     shell as `sessionModels`; pins and hides key on the session's ids.
 *
 * Personal hides and pins (any user) always go to `/api/models/visibility`
 * and are mirrored into the browser (lib/composer-model-visibility.ts) so
 * the composer repaints without a round trip. On an open instance (no
 * accounts, the route answers 409) the mirror IS the store.
 *
 * Every read goes through the settings route cache, so the rail's status
 * line, this hub and the composer share one body per route.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettingsShell } from "@/components/settings/shell-context";
import { useConfigWriter, useNativeSettings } from "@/hooks/useConfigWriter";
import { fetchSettingsRoute, invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { mirrorServerVisibility, readComposerVisibility, writeComposerVisibility } from "@/lib/composer-model-visibility";
import { allowListActive, applyInstanceHide, curationModeFor, keepAllowListActive, modelKey, NOTHING_ENABLED_ENTRY, providerOfEntry, seedAllowList, summarizeProviderCuration, writeProviderSelection, type ProviderCuration } from "@/lib/model-allow-list";
import type { ModelsData } from "@/lib/models-cache";

export type CatalogRowState = "visible" | "instanceHidden" | "myHidden" | "needsKey" | "new";

export interface CatalogRow {
  /** `provider/id` — omp's dialect and the visibility file's key. */
  key: string;
  id: string;
  provider: string;
  name: string;
  /** Where the row comes from: the engine's registry, the open session, or
   * a provider-level placeholder for a provider that has no credentials. */
  source: "catalog" | "session" | "placeholder";
  contextWindow?: number;
  reasoning: boolean;
  supportsFastMode: boolean;
  thinkingLevels?: string[];
  state: CatalogRowState;
  pinned: boolean;
  /** New since the seen ledger was last written; independent of `state` so
   * a hidden new model still counts for the New chip. */
  isNew: boolean;
  /** The provider has credentials (its models reach the engine). */
  connected: boolean;
  local: boolean;
}

export interface VisibilityBody {
  engine: { id: string };
  instanceHidden: string[];
  hidden: string[];
  pinned: string[];
  instanceSource: "enabledModels" | "cody" | "readonly";
}

interface NewModelsBody {
  newModels: { provider: string; id: string; name: string }[];
  total: number;
  seenAt: string | null;
  firstRun: boolean;
  catalogSource: "global" | "session";
  modelError?: string;
  pending?: true;
}

interface FullCatalogBody {
  modelList: { id: string; name: string; provider: string }[];
}

interface ProviderKeysBody {
  providers: { id: string; name: string; configured: boolean }[];
}

interface ModelRolesBody {
  roles?: Record<string, string>;
  roleNames?: string[];
}

interface AccountBody {
  user?: { id: string; role?: string };
}

const MODELS_ROUTE = "/api/models";
const FULL_CATALOG_ROUTE = "/api/models?catalog=full";
const VISIBILITY_ROUTE = "/api/models/visibility";
const NEW_MODELS_ROUTE = "/api/models/new";
const PROVIDER_KEYS_ROUTE = "/api/provider-keys";
const MODEL_ROLES_ROUTE = "/api/model-roles";
const ACCOUNT_ROUTE = "/api/accounts/me";

/** The exact message `lib/auth/http.ts`'s `requireCredential` answers for the
 * `no_accounts` case — the settings-route cache keeps only `unsupported` as
 * a structured code (`hooks/useSettingsData.ts`), so this is the one signal
 * left to tell "no accounts exist" apart from every other account-route
 * failure (signed out, a network blip, a 5xx). */
const NO_ACCOUNTS_ERROR_MESSAGE = "No accounts exist yet";

/** Providers whose models run on the user's own hardware, for the Local
 * chip. A best-effort list: a custom models.yml endpoint on a loopback URL
 * is also local, but the catalog does not carry base URLs. */
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "lm-studio", "llamacpp", "llama-cpp", "llama-swap", "vllm", "local", "localai", "mlx", "koboldcpp", "textgen"]);

export function isLocalProvider(provider: string): boolean {
  const id = provider.toLowerCase();
  return LOCAL_PROVIDER_IDS.has(id) || id.startsWith("local-") || id.endsWith("-local");
}

/** Strip a `:effort` suffix off a role selector so it compares as a key. */
function roleModelKey(selector: string): string {
  return selector.replace(/:([^,:/]+)$/, "");
}

const modelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** New → Pinned → name, then provider and id so duplicates order stably. */
export function compareCatalogRows(a: CatalogRow, b: CatalogRow): number {
  if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return modelCollator.compare(a.name || a.id, b.name || b.id)
    || modelCollator.compare(a.provider, b.provider)
    || modelCollator.compare(a.id, b.id);
}

export interface ModelCatalogHandle {
  rows: CatalogRow[];
  /** Every provider with a row, sorted; `modelProviderOrder` first on omp. */
  providers: string[];
  catalogSource: "global" | "session";
  loading: boolean;
  /** The first error worth a banner, or null. */
  error: string | null;
  isAdmin: boolean;
  /** "account" once the visibility route has answered, "browser" on an
   * open instance (no accounts) or while signed out. */
  savedIn: "account" | "browser";
  instanceSource: VisibilityBody["instanceSource"] | null;
  /** omp whose config.yml holds path-scoped registry entries: curation is
   * shown but cannot be written. */
  readOnly: boolean;
  /** omp: per-provider curation summary for the strip. Empty elsewhere. */
  curation: ProviderCuration[];
  enabledModels: string[];
  /** The keys of every catalog row (placeholders excluded): what "seen" records. */
  catalogKeys: string[];
  newCount: number;
  seenAt: string | null;
  /** The role assignments and default model, so seeding an allow-list never
   * takes away a model in use. omp only. */
  inUseKeys: string[];
  roleNames: string[];
  roles: Record<string, string>;
  myHidden: Set<string>;
  pinned: Set<string>;
  instanceHidden: Set<string>;
  /** Re-read everything, bypassing the hour-long full-catalog cache. */
  refresh: () => Promise<void>;
  refreshing: boolean;
  setPinned: (keys: readonly string[], pinned: boolean) => Promise<void>;
  setMyHidden: (keys: readonly string[], hidden: boolean) => Promise<void>;
  /** Admin: hide or show for the whole instance. On omp this edits
   * `enabledModels`; elsewhere the visibility file. */
  setInstanceHidden: (keys: readonly string[], hidden: boolean) => Promise<void>;
  /** Admin, omp: replace one provider's selection (the curation dialog).
   * `nothingEnabled` is true when the save left NO model reachable anywhere
   * (this was the only curated, or only connected, provider) — the caller
   * should tell the user, since the list is kept non-empty under the hood
   * (see `keepAllowListActive`) rather than read back as "unrestricted". */
  writeProviderCuration: (provider: string, selected: readonly string[], options: { includeFuture: boolean }) => Promise<{ nothingEnabled: boolean }>;
  /** Admin: record that `keys` (default: the whole catalog) were shown.
   * `merge: true` unions `keys` into the ledger's current list instead of
   * replacing it — for a curation dialog that displayed only one provider's
   * models, so every other provider's seen state survives the save. */
  markSeen: (keys?: readonly string[], options?: { merge?: boolean }) => Promise<void>;
  /** Whether hiding `keys` for the instance would pin a whole-provider glob
   * (or an unrestricted provider) down to an exact list; the providers. */
  providersPinnedByHiding: (keys: readonly string[]) => string[];
}

async function putVisibility(patch: Partial<Pick<VisibilityBody, "instanceHidden" | "hidden" | "pinned">>): Promise<VisibilityBody | "browser"> {
  const response = await fetch(VISIBILITY_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  if (response.status === 401 || response.status === 409) return "browser";
  const body = (await response.json().catch(() => ({}))) as VisibilityBody & { error?: string };
  if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function useModelCatalog(): ModelCatalogHandle {
  const { capabilities, engine, sessionModels, callbacks } = useSettingsShell();
  const engineId = engine?.id ?? null;
  const writer = useConfigWriter();

  const effective = useSettingsRoute<ModelsData>(MODELS_ROUTE);
  const catalogSource: "global" | "session" = effective.data?.catalogSource === "session" ? "session" : "global";
  const isSession = catalogSource === "session";
  // The unrestricted read is omp's own overlay mechanism; the route refuses
  // `unsupported` elsewhere and the entry is then cached as such.
  const full = useSettingsRoute<FullCatalogBody>(FULL_CATALOG_ROUTE, { enabled: capabilities.models, ttlMs: 60 * 60 * 1000 });
  const visibility = useSettingsRoute<VisibilityBody>(VISIBILITY_ROUTE);
  const fresh = useSettingsRoute<NewModelsBody>(NEW_MODELS_ROUTE, { enabled: !isSession, ttlMs: 60_000 });
  const providerKeys = useSettingsRoute<ProviderKeysBody>(PROVIDER_KEYS_ROUTE, { ttlMs: 60_000 });
  const roles = useSettingsRoute<ModelRolesBody>(MODEL_ROLES_ROUTE, { enabled: capabilities.models });
  const account = useSettingsRoute<AccountBody>(ACCOUNT_ROUTE);
  const native = useNativeSettings(capabilities.configEditor);
  const [refreshing, setRefreshing] = useState(false);
  // The browser mirror, re-read whenever the server answers or a write lands.
  const [mirrorVersion, setMirrorVersion] = useState(0);

  // An open instance answers 409 "No accounts exist yet" to the account
  // route (lib/auth/http.ts's requireCredential, `no_accounts`): everyone is
  // the administrator there, and the visibility store is the browser. Any
  // OTHER failure — signed-out (401), a network blip, a 5xx — is NOT that
  // case and must not grant admin: on omp a member wrongly treated as admin
  // can write `enabledModels` for real, since that PUT has no server-side
  // role gate of its own.
  const openInstance = account.error === NO_ACCOUNTS_ERROR_MESSAGE && !account.unsupported;
  const isAdmin = openInstance || account.data?.user?.role === "admin";
  const savedIn: "account" | "browser" = visibility.data ? "account" : "browser";

  useEffect(() => {
    if (!visibility.data || !engineId) return;
    mirrorServerVisibility(engineId, visibility.data);
    setMirrorVersion((version) => version + 1);
  }, [visibility.data, engineId]);

  const mirror = useMemo(() => readComposerVisibility(engineId), [engineId, mirrorVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const lists = useMemo(() => {
    const body = visibility.data;
    const instanceFromFile = new Set(body?.instanceHidden ?? mirror.instanceHidden);
    return {
      hidden: new Set(body?.hidden ?? mirror.hidden),
      pinned: new Set(body?.pinned ?? mirror.pinned),
      instanceFromFile,
    };
  }, [visibility.data, mirror]);

  const enabledModels = useMemo(() => native.settings?.enabledModels ?? [], [native.settings]);
  const readOnly = visibility.data?.instanceSource === "readonly" || native.settings?.registryHasScopedEntries === true;

  const effectiveList = useMemo(() => effective.data?.modelList ?? [], [effective.data]);
  const fullList = useMemo(() => full.data?.modelList ?? null, [full.data]);
  const newKeys = useMemo(() => new Set((fresh.data?.newModels ?? []).map(modelKey)), [fresh.data]);

  const { rows, catalogKeys, instanceHidden, curation } = useMemo(() => {
    const effectiveByKey = new Map(effectiveList.map((model) => [modelKey(model), model]));
    const base: { id: string; name: string; provider: string; source: CatalogRow["source"] }[] = isSession
      ? (sessionModels ?? []).map((model) => ({ ...model, source: "session" as const }))
      : (fullList ?? effectiveList).map((model) => ({ id: model.id, name: model.name, provider: model.provider, source: "catalog" as const }));
    // omp's instance hide is what the unrestricted catalog has and the
    // effective list lacks; every other engine's is the visibility file.
    const instanceHiddenKeys = new Set<string>(
      fullList && !isSession
        ? fullList.map(modelKey).filter((key) => !effectiveByKey.has(key))
        : lists.instanceFromFile,
    );
    const connectedProviders = new Set<string>(base.map((model) => model.provider));
    for (const provider of effective.data?.connectedProviders ?? []) connectedProviders.add(provider.id);
    const rowsOut: CatalogRow[] = base.map((model) => {
      const key = modelKey(model);
      const live = effectiveByKey.get(key);
      const state: CatalogRowState = instanceHiddenKeys.has(key)
        ? "instanceHidden"
        : lists.hidden.has(key)
          ? "myHidden"
          : newKeys.has(key)
            ? "new"
            : "visible";
      return {
        key,
        id: model.id,
        provider: model.provider,
        name: model.name || model.id,
        source: model.source,
        ...(typeof live?.contextWindow === "number" ? { contextWindow: live.contextWindow } : {}),
        reasoning: Boolean(live && (live as { thinkingLevels?: string[] }).thinkingLevels && ((live as { thinkingLevels?: string[] }).thinkingLevels?.length ?? 0) > 1),
        supportsFastMode: live?.supportsFastMode === true,
        ...((live as { thinkingLevels?: string[] } | undefined)?.thinkingLevels ? { thinkingLevels: (live as { thinkingLevels?: string[] }).thinkingLevels } : {}),
        state,
        pinned: state !== "instanceHidden" && state !== "myHidden" && lists.pinned.has(key),
        isNew: newKeys.has(key),
        connected: true,
        local: isLocalProvider(model.provider),
      };
    });
    // A provider Cody knows a key for but that has no credentials gets one
    // placeholder row so "needs a key" is a fact in the list, not an
    // absence the user has to notice.
    if (!isSession) {
      for (const provider of providerKeys.data?.providers ?? []) {
        if (provider.configured || connectedProviders.has(provider.id)) continue;
        rowsOut.push({
          key: `${provider.id}/*`,
          id: "*",
          provider: provider.id,
          name: provider.name,
          source: "placeholder",
          reasoning: false,
          supportsFastMode: false,
          state: "needsKey",
          pinned: false,
          isNew: false,
          connected: false,
          local: isLocalProvider(provider.id),
        });
      }
    }
    rowsOut.sort(compareCatalogRows);
    const curationRows = capabilities.models && fullList
      ? summarizeProviderCuration(fullList, effectiveList, enabledModels)
      : [];
    return {
      rows: rowsOut,
      catalogKeys: base.map(modelKey),
      instanceHidden: instanceHiddenKeys,
      curation: curationRows,
    };
  }, [effectiveList, fullList, isSession, sessionModels, lists, newKeys, effective.data?.connectedProviders, providerKeys.data, capabilities.models, enabledModels]);

  const providers = useMemo(() => {
    const seen = [...new Set(rows.map((row) => row.provider))].sort((a, b) => modelCollator.compare(a, b));
    const order = native.settings?.modelProviderOrder ?? [];
    return [...order.filter((provider) => seen.includes(provider)), ...seen.filter((provider) => !order.includes(provider))];
  }, [rows, native.settings?.modelProviderOrder]);

  const inUseKeys = useMemo(() => {
    const keys = Object.values(roles.data?.roles ?? {}).map(roleModelKey).filter(Boolean);
    const fallback = effective.data?.defaultModel;
    if (fallback) keys.unshift(`${fallback.provider}/${fallback.modelId}`);
    return [...new Set(keys)];
  }, [roles.data, effective.data?.defaultModel]);

  // Kept current every render so the writer callbacks below always compute
  // against what is true NOW, not a snapshot from whichever render created
  // the specific closure that ends up being invoked — an undo toast's
  // onClick can fire seconds later, after further hides changed everything
  // these callbacks read. A plain state variable closed over at creation
  // time cannot do that; a ref that every render refreshes can.
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const enabledModelsRef = useRef(enabledModels);
  enabledModelsRef.current = enabledModels;
  const fullListRef = useRef(fullList);
  fullListRef.current = fullList;
  const effectiveListRef = useRef(effectiveList);
  effectiveListRef.current = effectiveList;
  const inUseKeysRef = useRef(inUseKeys);
  inUseKeysRef.current = inUseKeys;

  // Seed the seen ledger the first time the catalog is shown: nothing is
  // new retroactively, and the diff is meaningful only from then on. On omp
  // the server diffs against the UNRESTRICTED catalog, so `catalogKeys` must
  // come from `fullList`, not the (possibly still-loading) effective list —
  // `/api/models/new` and `?catalog=full` can settle in either order, and
  // seeding from the effective list here would record every model omp's own
  // `enabledModels` curates away, so the diff reports them "new" forever.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !isAdmin || isSession || !fresh.data?.firstRun || catalogKeys.length === 0) return;
    if (capabilities.models && fullList === null) return;
    seededRef.current = true;
    void fetch("/api/models/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: catalogKeys }) })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); })
      .then(() => invalidateSettingsRoutes(NEW_MODELS_ROUTE))
      .catch(() => { seededRef.current = false; });
  }, [isAdmin, isSession, fresh.data?.firstRun, catalogKeys, capabilities.models, fullList]);

  const applyVisibility = useCallback(async (patch: Partial<Pick<VisibilityBody, "instanceHidden" | "hidden" | "pinned">>) => {
    const currentLists = listsRef.current;
    const optimistic: VisibilityBody = {
      engine: { id: engineId ?? "" },
      instanceHidden: patch.instanceHidden ?? [...currentLists.instanceFromFile],
      hidden: patch.hidden ?? [...currentLists.hidden],
      pinned: patch.pinned ?? [...currentLists.pinned],
      instanceSource: visibility.data?.instanceSource ?? "cody",
    };
    writeComposerVisibility(engineId, patch);
    setMirrorVersion((version) => version + 1);
    if (visibility.data) setSettingsRouteData(VISIBILITY_ROUTE, optimistic);
    try {
      const result = await putVisibility(patch);
      if (result !== "browser") {
        setSettingsRouteData(VISIBILITY_ROUTE, result);
        mirrorServerVisibility(engineId, result);
        setMirrorVersion((version) => version + 1);
      }
    } catch (error) {
      // The optimistic value is wrong: re-read the truth.
      invalidateSettingsRoutes(VISIBILITY_ROUTE, { exact: true });
      throw error;
    }
  }, [engineId, visibility.data]);

  // setPinned/setMyHidden/setInstanceHidden all read `listsRef`/`enabledModelsRef`
  // (etc.) rather than `lists`/`enabledModels` directly: a delta computed
  // this way is correct even when the specific function INSTANCE invoking it
  // was created on an earlier render — e.g. an undo toast's `onClick`, which
  // can fire seconds after later hides moved the state on. Reading the plain
  // state would replay that earlier render's snapshot instead of undoing
  // just the one hide the toast belongs to.
  const setPinned = useCallback(async (keys: readonly string[], pinned: boolean) => {
    const next = new Set(listsRef.current.pinned);
    for (const key of keys) if (pinned) next.add(key); else next.delete(key);
    await applyVisibility({ pinned: [...next].sort() });
  }, [applyVisibility]);

  const setMyHidden = useCallback(async (keys: readonly string[], hidden: boolean) => {
    const next = new Set(listsRef.current.hidden);
    for (const key of keys) if (hidden) next.add(key); else next.delete(key);
    await applyVisibility({ hidden: [...next].sort() });
  }, [applyVisibility]);

  /** The allow-list to edit: the persisted one, or — while the restriction
   * is off — a seed that keeps every provider open as a glob and every
   * in-use model explicit, so the first hide takes away nothing else. Reads
   * refs so a stale-closure caller (see above) still starts from the
   * current setting, not the one in force when it was created. */
  const baseAllowList = useCallback((): string[] => {
    const currentEnabledModels = enabledModelsRef.current;
    // Strip our own "nothing enabled" placeholder (`keepAllowListActive`) so
    // it never lingers once a real entry is written back in — the moment
    // this list gains an entry of its own, the sentinel that was only
    // holding the restriction open has done its job.
    if (allowListActive(currentEnabledModels)) return currentEnabledModels.filter((entry) => entry !== NOTHING_ENABLED_ENTRY);
    const catalog = fullListRef.current ?? effectiveListRef.current;
    const everyProvider = [...new Set(catalog.map((model) => model.provider))];
    return seedAllowList(inUseKeysRef.current, effectiveListRef.current, { providerGlobs: everyProvider });
  }, []);

  const providersPinnedByHiding = useCallback((keys: readonly string[]): string[] => {
    if (!capabilities.models) return [];
    const list = enabledModelsRef.current;
    const active = allowListActive(list);
    const providers = new Set<string>();
    for (const key of keys) {
      const provider = providerOfEntry(key);
      if (!provider) continue;
      if (!active || curationModeFor(list, provider) === "all") providers.add(provider);
    }
    return [...providers].sort();
  }, [capabilities.models]);

  const setInstanceHidden = useCallback(async (keys: readonly string[], hidden: boolean) => {
    if (!capabilities.models) {
      const next = new Set(listsRef.current.instanceFromFile);
      for (const key of keys) if (hidden) next.add(key); else next.delete(key);
      await applyVisibility({ instanceHidden: [...next].sort() });
      return;
    }
    // omp: per provider, the next selection is derived from the ALLOW-LIST
    // ITSELF (`list`, seeded from the optimistic `enabledModels` and updated
    // in this same loop as each provider is processed) — never from
    // `effectiveList`/`instanceHidden`, both of which lag a just-landed
    // write until `/api/models` refetches (on omp that spawns a fresh
    // utility RPC, seconds away). `applyInstanceHide` (lib/model-allow-list)
    // is what makes this a delta against current state rather than a
    // replayed snapshot — see its doc comment for the exact failure this
    // fixes (a second hide silently reverting the first).
    const catalog = fullListRef.current ?? effectiveListRef.current;
    const byProvider = new Map<string, Set<string>>();
    for (const key of keys) {
      const provider = providerOfEntry(key);
      if (!provider) continue;
      const set = byProvider.get(provider) ?? new Set<string>();
      set.add(key);
      byProvider.set(provider, set);
    }
    let list = baseAllowList();
    for (const [provider, providerKeysSet] of byProvider) {
      const catalogForProvider = catalog.filter((model) => model.provider === provider).map(modelKey);
      list = applyInstanceHide(list, provider, [...providerKeysSet], hidden, catalogForProvider);
    }
    await writer.patchTop({ enabledModels: keepAllowListActive(list) });
    // The composer's model list is its own fetch (useAgentSession.loadModels)
    // that only re-runs on session change or this bump; without it an
    // instance hide/unhide from the hub never reaches an open composer.
    callbacks.onModelsSaved();
  }, [capabilities.models, applyVisibility, baseAllowList, writer, callbacks]);

  const writeProviderCuration = useCallback(async (provider: string, selected: readonly string[], options: { includeFuture: boolean }) => {
    const catalog = fullListRef.current ?? effectiveListRef.current;
    const catalogForProvider = catalog.filter((model) => model.provider === provider).map(modelKey);
    const list = writeProviderSelection(baseAllowList(), provider, selected, catalogForProvider, options);
    // An empty result means NOTHING is enabled anywhere — this was the only
    // curated (or only connected) provider and the user chose "disable all".
    // `keepAllowListActive` keeps the restriction on with an entry that
    // matches no real model, instead of the previous bug's `provider/**`
    // substitution, which silently turned "disable everything" into
    // "enable everything" (omp reads `[]` as unrestricted).
    const nothingEnabled = list.length === 0;
    await writer.patchTop({ enabledModels: keepAllowListActive(list) });
    callbacks.onModelsSaved();
    return { nothingEnabled };
  }, [baseAllowList, writer, callbacks]);

  const markSeen = useCallback(async (keys?: readonly string[], options?: { merge?: boolean }) => {
    const response = await fetch("/api/models/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: keys ?? catalogKeys, merge: options?.merge === true }) });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    invalidateSettingsRoutes(NEW_MODELS_ROUTE);
  }, [catalogKeys]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (capabilities.models) {
        // The hour-long cache is what makes the hub cheap to open; only an
        // explicit Refresh bypasses it, and the refreshed entry then serves
        // the cached reads below.
        await fetch(`${FULL_CATALOG_ROUTE}&refresh=1`, { cache: "no-store" }).catch(() => undefined);
      }
      invalidateSettingsRoutes(MODELS_ROUTE);
      invalidateSettingsRoutes(VISIBILITY_ROUTE, { exact: true });
      invalidateSettingsRoutes(PROVIDER_KEYS_ROUTE, { exact: true });
      await Promise.all([
        fetchSettingsRoute(MODELS_ROUTE, { force: true }),
        capabilities.models ? fetchSettingsRoute(FULL_CATALOG_ROUTE, { force: true }) : Promise.resolve(),
        isSession ? Promise.resolve() : fetchSettingsRoute(NEW_MODELS_ROUTE, { force: true }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [capabilities.models, isSession]);

  const loading = (effective.loading && !effective.data) || (capabilities.models && full.loading && !full.data);
  const error = effective.error ?? effective.data?.modelError ?? (capabilities.models ? full.error : null) ?? null;

  return {
    rows,
    providers,
    catalogSource,
    loading,
    error,
    isAdmin,
    savedIn,
    instanceSource: visibility.data?.instanceSource ?? null,
    readOnly,
    curation,
    enabledModels,
    catalogKeys,
    newCount: newKeys.size,
    seenAt: fresh.data?.seenAt ?? null,
    inUseKeys,
    roleNames: roles.data?.roleNames ?? [],
    roles: roles.data?.roles ?? {},
    myHidden: lists.hidden,
    pinned: lists.pinned,
    instanceHidden,
    refresh,
    refreshing,
    setPinned,
    setMyHidden,
    setInstanceHidden,
    writeProviderCuration,
    markSeen,
    providersPinnedByHiding,
  };
}
