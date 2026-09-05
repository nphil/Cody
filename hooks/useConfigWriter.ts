"use client";

/**
 * The one writer for the engine's config. Every settings panel that changes
 * omp's config.yml (a curated card, a schema row, a model-visibility hide, a
 * role assignment) goes through here, so writes to the same file cannot race
 * each other and every write invalidates the same cached reads.
 *
 * Queues are FIFO PER FAMILY: section/top-level partials ("settings"), schema
 * patches ("schema", coalesced 350 ms), roles, plans and deletes each drain in
 * order, but a slow plan POST cannot starve a schema patch. "delete" is the
 * exception that waits for the settings and schema queues first: a section
 * reset must land AFTER the patches queued before it, or it deletes what the
 * user just changed.
 *
 * The trap this module owns (formerly SettingsConfig.patchSection): a section
 * write spreads the SECTION under its key, never the whole settings object.
 * Spreading the whole object into `advisor` once filled config.yml sections
 * with every top-level key after the first save. `patchTop` is the deliberate
 * whole-object spread for top-level keys and arrays (`enabledModels`,
 * `disabledProviders`, `modelProviderOrder`).
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { invalidateSettingsRoutes, readSettingsRouteEntry, setSettingsRouteData, subscribeSettingsRoutes, useSettingsRoute } from "./useSettingsData";

export type WriteFamily = "settings" | "schema" | "roles" | "plan" | "delete";

export const SETTINGS_ROUTE = "/api/omp-settings";
export const SCHEMA_ROUTE = "/api/omp-settings/schema";

/** Reads a settled write can have changed; every family invalidates all of
 * them because a role, a plan and a section patch all end in the same file. */
export const WRITE_INVALIDATION_PREFIXES: readonly string[] = [
  "/api/omp-settings",
  "/api/omp-settings/schema",
  "/api/models",
  "/api/model-roles",
  "/api/providers",
  "/api/models/new",
];

export const SCHEMA_COALESCE_MS = 350;

// Mirrors omp 17.4's compaction.methodOrder (session/compaction-methods.ts):
// an ordered preference list replaced the old single `strategy`.
export type CompactionMethod = "remote" | "snapcompact" | "handoff" | "shake" | "soft";

/** The client's structural view of omp's config.yml (lib/omp/settings-config
 * NativeSettings), limited to what the curated cards read. Unknown keys pass
 * through untouched because every write is read, spread, PUT. */
export type NativeSettings = {
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
  enabledModels?: string[];
  disabledProviders?: string[];
  modelProviderOrder?: string[];
  [key: string]: unknown;
};

type SettingsBody = { settings?: NativeSettings; error?: string };

const tails: Record<WriteFamily, Promise<void>> = {
  settings: Promise.resolve(),
  schema: Promise.resolve(),
  roles: Promise.resolve(),
  plan: Promise.resolve(),
  delete: Promise.resolve(),
};
const pendingCounts: Record<WriteFamily, number> = { settings: 0, schema: 0, roles: 0, plan: 0, delete: 0 };

/** The freshest settings object known to this page: the optimistic value of
 * the last patch, or the last body read. Null until something read it. */
let latestSettings: NativeSettings | null = null;
/** The last body the SERVER confirmed (a GET or a PUT echo): what the cache
 * falls back to when an optimistic write is rejected. */
let confirmedSettings: NativeSettings | null = null;
/** True from the moment `patchWith`'s fast path shows an optimistic value
 * until the PUT that actually carries it settles. `pendingCounts.settings`
 * cannot cover that first write on its own: the fast path calls
 * `setSettingsRouteData` (which notifies synchronously) BEFORE it enqueues
 * the job that would bump the count, so without this flag the listener
 * below mistakes the not-yet-sent value for a confirmed one — and a PUT
 * that then fails "reverts" to that same unconfirmed value instead of the
 * last real server body. */
let settingsUnconfirmed = false;

// A GET landing while no write is queued is the truth; while one is queued —
// or shown optimistically but not yet confirmed — it must not replace the
// optimistic value.
subscribeSettingsRoutes(() => {
  if (pendingCounts.settings > 0 || settingsUnconfirmed) return;
  const entry = readSettingsRouteEntry<SettingsBody>(SETTINGS_ROUTE);
  if (entry.data?.settings && !entry.stale) {
    latestSettings = entry.data.settings;
    confirmedSettings = entry.data.settings;
  }
});

/** A promise this module controls the settlement of, so a caller whose
 * snapshot is superseded before its own turn can still be told the truth
 * once some later PUT actually carries its change. */
function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Shared by every `patchWith` fast-path call queued before the winner among
 * them actually runs its PUT: whichever one settles the file resolves this
 * for all of them. Cleared as soon as a job actually starts running (a call
 * arriving after that point is a fresh batch, not part of this one). */
let currentSettingsDeferred: ReturnType<typeof createDeferred> | null = null;

let writeSeq = 0;
const seqListeners = new Set<() => void>();
function settled(): void {
  writeSeq += 1;
  for (const prefix of WRITE_INVALIDATION_PREFIXES) invalidateSettingsRoutes(prefix);
  seqListeners.forEach((listener) => listener());
}

/** A promise that resolves once every family has drained. Tests. */
export function configWriterIdle(): Promise<void> {
  return Promise.all(Object.values(tails)).then(() => undefined);
}

/** Tests only. */
export function resetConfigWriter(): void {
  latestSettings = null;
  confirmedSettings = null;
  settingsUnconfirmed = false;
  currentSettingsDeferred = null;
  pendingSchemaPatch = {};
  if (schemaTimer) clearTimeout(schemaTimer);
  schemaTimer = null;
  schemaWaiters = [];
}

/**
 * Run `fn` after everything queued before it in the same family. The
 * returned promise settles with `fn`'s outcome; a rejection never blocks the
 * family (the next write still runs). Every settled write bumps the write
 * sequence and invalidates the cached reads.
 */
export function enqueueConfigWrite(family: WriteFamily, fn: () => Promise<void>): Promise<void> {
  pendingCounts[family] += 1;
  if (family === "delete") {
    // writeNativeSettings only ever SETS keys, it never removes them: the
    // freshest known settings object still carries whatever this delete is
    // about to remove. Force the next settings-family patch to re-read the
    // file rather than spread that stale snapshot back (which would
    // silently undo the reset), and make it WAIT for this delete so the
    // re-read happens after the delete has actually landed, not while the
    // DELETE request is still in flight.
    latestSettings = null;
    invalidateSettingsRoutes(SETTINGS_ROUTE, { exact: true });
  }
  const gate = family === "delete"
    ? Promise.all([tails.settings, tails.schema, tails.delete]).then(() => undefined)
    : family === "settings"
      ? Promise.all([tails.settings, tails.delete]).then(() => undefined)
      : tails[family];
  const run = gate.then(fn);
  tails[family] = run.catch(() => undefined).then(() => {
    pendingCounts[family] -= 1;
    settled();
  });
  return run;
}

async function readCurrentSettings(): Promise<NativeSettings> {
  if (latestSettings) return latestSettings;
  // A cached body serves as the base only while it is fresh: after a
  // rejected write the entry is stale and the file is the truth.
  const cached = readSettingsRouteEntry<SettingsBody>(SETTINGS_ROUTE);
  if (cached.data?.settings && !cached.stale) {
    latestSettings = cached.data.settings;
    return latestSettings;
  }
  const response = await fetch(SETTINGS_ROUTE, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as SettingsBody;
  if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
  latestSettings = body.settings ?? {};
  confirmedSettings = latestSettings;
  setSettingsRouteData(SETTINGS_ROUTE, { settings: latestSettings });
  return latestSettings;
}

/** PUTs `snapshot`, unless a newer one is already queued behind it (it
 * carries these changes too, so this PUT would only add a round trip).
 * Returns whether it actually ran — the fast path's caller uses that to
 * know whose outcome should settle a skipped write's promise. */
async function putSettings(snapshot: NativeSettings): Promise<boolean> {
  if (latestSettings !== snapshot) return false;
  try {
    const response = await fetch(SETTINGS_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
    const body = (await response.json().catch(() => ({}))) as SettingsBody;
    if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
    if (body.settings) confirmedSettings = body.settings;
    if (latestSettings === snapshot && body.settings) {
      latestSettings = body.settings;
      setSettingsRouteData(SETTINGS_ROUTE, { settings: body.settings });
    }
    return true;
  } catch (error) {
    // The optimistic value is now a lie: show the last confirmed body again,
    // forget the optimistic chain so the next base is read from the file,
    // and let the caller report the failure.
    latestSettings = null;
    if (confirmedSettings) setSettingsRouteData(SETTINGS_ROUTE, { settings: confirmedSettings });
    invalidateSettingsRoutes(SETTINGS_ROUTE, { exact: true });
    throw error;
  }
}

/** Apply `next(base)` to the freshest settings, show it immediately, and
 * queue the PUT. When nothing has read the file yet the read happens inside
 * the queue so the spread still sees the freshest base.
 *
 * The fast path (below) can queue several snapshots before any of their
 * jobs run — each later one builds on and supersedes the last, and
 * `putSettings` skips the PUT for every snapshot but the one still current
 * when its turn comes. A skipped write must not report "saved" on its own:
 * its caller gets a shared, module-controlled promise that settles only
 * once some job's PUT actually carries the change (or fails to). */
function patchWith(next: (base: NativeSettings) => NativeSettings): Promise<void> {
  if (latestSettings) {
    const snapshot = next(latestSettings);
    latestSettings = snapshot;
    settingsUnconfirmed = true;
    setSettingsRouteData(SETTINGS_ROUTE, { settings: snapshot });
    const deferred = currentSettingsDeferred ?? createDeferred();
    currentSettingsDeferred = deferred;
    void enqueueConfigWrite("settings", async () => {
      // From here on, a call that supersedes `latestSettings` again starts
      // a fresh batch with its own deferred: this job's outcome (carry the
      // change, or skip because something newer already has) is fixed now.
      if (currentSettingsDeferred === deferred) currentSettingsDeferred = null;
      try {
        const didRun = await putSettings(snapshot);
        if (didRun) {
          settingsUnconfirmed = false;
          deferred.resolve();
        }
        // A skip leaves `deferred` open for whichever later job actually
        // carries the change to settle.
      } catch (error) {
        settingsUnconfirmed = false;
        deferred.reject(error);
      }
    });
    return deferred.promise;
  }
  return enqueueConfigWrite("settings", async () => {
    const base = await readCurrentSettings();
    const snapshot = next(base);
    latestSettings = snapshot;
    setSettingsRouteData(SETTINGS_ROUTE, { settings: snapshot });
    await putSettings(snapshot);
  });
}

/** Merge `partial` into the object-valued SECTION under `section`. The
 * section is spread, never the whole settings object (see the module note). */
export function patchSettingsSection<K extends keyof NativeSettings & string>(section: K, partial: Partial<NonNullable<NativeSettings[K]>> & object): Promise<void> {
  return patchWith((base) => {
    const current = (base[section] ?? {}) as object;
    return { ...base, [section]: { ...current, ...partial } };
  });
}

/** Merge top-level keys, arrays included, into the settings object. This is
 * the ONE place the whole object is spread, and only ever at the top. */
export function patchSettingsTop(partial: Partial<NativeSettings>): Promise<void> {
  return patchWith((base) => ({ ...base, ...partial }));
}

let pendingSchemaPatch: Record<string, unknown> = {};
let schemaTimer: ReturnType<typeof setTimeout> | null = null;
let schemaWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

async function flushSchemaPatch(): Promise<void> {
  const patch = pendingSchemaPatch;
  const waiters = schemaWaiters;
  pendingSchemaPatch = {};
  schemaWaiters = [];
  schemaTimer = null;
  if (Object.keys(patch).length === 0) {
    waiters.forEach((waiter) => waiter.resolve());
    return;
  }
  try {
    await enqueueConfigWrite("schema", async () => {
      const response = await fetch(SCHEMA_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patch }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; rejected?: string[] };
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
    });
    waiters.forEach((waiter) => waiter.resolve());
  } catch (error) {
    waiters.forEach((waiter) => waiter.reject(error));
  }
}

/** Queue `{path: value}` pairs for PUT /api/omp-settings/schema, coalescing
 * everything that arrives within 350 ms into one request (a slider or a
 * text field fires many). Resolves when the request carrying this patch
 * settles; `null` values reset a key to the engine's default. */
export function patchSettingsSchema(patch: Record<string, unknown>): Promise<void> {
  pendingSchemaPatch = { ...pendingSchemaPatch, ...patch };
  if (schemaTimer) clearTimeout(schemaTimer);
  schemaTimer = setTimeout(() => { void flushSchemaPatch(); }, SCHEMA_COALESCE_MS);
  return new Promise((resolve, reject) => schemaWaiters.push({ resolve, reject }));
}

export interface ConfigWriter {
  patchSection: typeof patchSettingsSection;
  patchTop: typeof patchSettingsTop;
  patchSchema: typeof patchSettingsSchema;
  enqueue: typeof enqueueConfigWrite;
}

const WRITER: ConfigWriter = {
  patchSection: patchSettingsSection,
  patchTop: patchSettingsTop,
  patchSchema: patchSettingsSchema,
  enqueue: enqueueConfigWrite,
};

export function useConfigWriter(): ConfigWriter {
  return WRITER;
}

function subscribeSeq(listener: () => void): () => void {
  seqListeners.add(listener);
  return () => seqListeners.delete(listener);
}

/** Counts settled writes. A panel that keeps its own copy of the file (the
 * schema list) reloads when this changes, and only then, so its own save
 * does not bounce it. */
export function useConfigWriteSeq(): number {
  return useSyncExternalStore(subscribeSeq, () => writeSeq, () => 0);
}

export interface NativeSettingsHandle {
  settings: NativeSettings | null;
  error: string | null;
  loading: boolean;
  unsupported: boolean;
  /** False when the active engine has no config.yml editor: nothing is
   * fetched and every patch is a no-op that resolves. */
  enabled: boolean;
  patchSection: typeof patchSettingsSection;
  patchTop: typeof patchSettingsTop;
  /** `tools.approval` is a nested object; this spreads it from the freshest
   * copy so two approval cards cannot clobber each other. */
  patchApproval: (patch: Partial<NonNullable<NonNullable<NativeSettings["tools"]>["approval"]>>) => Promise<void>;
}

const NOOP_PATCH = () => Promise.resolve();

/**
 * omp's config.yml for the curated cards: read through the cache, written
 * through the writer. Gate on `configEditor`, not `nativeSettings`: the
 * route serves omp's file and refuses every other engine, and Hermes
 * declares `nativeSettings` for its own schema panel.
 */
export function useNativeSettings(enabled: boolean): NativeSettingsHandle {
  const route = useSettingsRoute<SettingsBody>(SETTINGS_ROUTE, { enabled });
  const patchApproval = useCallback<NativeSettingsHandle["patchApproval"]>((patch) => patchWith((base) => {
    const tools = base.tools ?? {};
    return { ...base, tools: { ...tools, approval: { ...(tools.approval ?? {}), ...patch } } };
  }), []);
  return useMemo(() => ({
    settings: enabled ? route.data?.settings ?? null : null,
    error: route.error,
    loading: route.loading,
    unsupported: route.unsupported,
    enabled,
    patchSection: enabled ? patchSettingsSection : NOOP_PATCH,
    patchTop: enabled ? patchSettingsTop : NOOP_PATCH,
    patchApproval: enabled ? patchApproval : NOOP_PATCH,
  }), [enabled, route.data, route.error, route.loading, route.unsupported, patchApproval]);
}
