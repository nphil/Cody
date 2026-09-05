"use client";

/**
 * The engine roster: every coding agent this Cody can run, with what is
 * installed, which one is active, what is newer, and the actions that change
 * any of that. Two homes, one component:
 *
 *   - "manage" (Settings › System › Engines): rows with Active / verified /
 *     ahead chips, two-package parts, live install progress, Install | Use |
 *     Update | Reinstall | Revert | Changelog, and the Danger zone below it
 *     (uninstall a managed, non-active engine; restart every session).
 *   - "pick" (the onboarding EnginePicker): the same roster as cards in the
 *     login screen's design language — Install | Use | Continue — plus the
 *     "decide later" footer.
 *
 * Both modes start an install through POST /api/engines/install and follow
 * GET /api/engines/install/events (`useEngineInstalls`), the exact path the
 * container smoke gate drives, so a picker install and a Settings install
 * are one code path. Every step that interrupts sessions or removes
 * something (update, reinstall, revert, restart, uninstall) goes through a
 * ConfirmDialog that names the engine and the consequence; the changelog
 * opens in a Drawer, never a second Dialog.
 *
 * Reads go through the settings route cache (`/api/engines`,
 * `/api/engines/updates`), so the rail's status line, the dialog search and
 * this list share one body and one in-flight request.
 */
import { AlertCircle, ArrowRight, Check, Copy, Cpu, Download, Loader2, RefreshCw, RotateCcw, ScrollText, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useEngineInstalls } from "@/hooks/useEngineInstalls";
import { invalidateSettingsRoutes, useSettingsRoute } from "@/hooks/useSettingsData";
import type { EngineComponentStatus, EngineUpdateStatus } from "@/lib/harness/updates";
import { translate, translatePlural, useI18n } from "@/lib/i18n";
import { ALL_CAPABILITIES, type EngineCapabilities } from "../SettingsTabs";
import { dangerButtonStyle, ErrorNote, primaryButtonStyle, smallButtonStyle } from "./account-controls";
import { DangerZone, type DangerZoneRow } from "./DangerZone";
import { Drawer } from "./Drawer";
import { chipStyle, SettingsHighlightContext } from "./primitives";
import { ShellContext } from "./shell-context";

/** One row of GET /api/engines — see app/api/engines/route.ts. */
export interface EngineSummary {
  id: string;
  /** Human display name ("Claude Code"); `name` in the API payload. */
  name: string;
  /** Short brand used inline in copy ("Claude"). */
  shortName: string;
  tagline: string;
  experimental: boolean;
  installed: boolean;
  /** An install/update npm run is in flight server-side right now. */
  installing: boolean;
  /** The ENGINE's own version — the CLI's for an engine Cody installs as an
   * ACP adapter plus the CLI it drives, so the card never shows the adapter's
   * number under the engine's name. */
  version: string | null;
  /** The ACP adapter's own version, for a two-package engine; null otherwise.
   * Labelled by `adapterLabel` — never shown bare, since it belongs to a
   * different package than `version`. */
  adapterVersion: string | null;
  /** Exact `installSpec`-package version this Cody build was audited
   * against; null when the adapter carries no marker. */
  verifiedVersion: string | null;
  /** English labels from the adapter for those two packages ("Claude Code ACP
   * adapter", "Claude Code CLI"); null for single-package engines. Adapter
   * data, not translation keys — same as `tagline` and `authHint`. */
  adapterLabel: string | null;
  engineCliLabel: string | null;
  /** Cody can npm-install this engine itself. */
  installable: boolean;
  /** Cody itself installed the resolved binary into its tools prefix, so
   * Cody can also uninstall it. False for PATH/env-override installs. */
  managed: boolean;
  /** English sentence from the adapter; not a translation key. */
  authHint: string | null;
  binaryName: string;
}

export interface EnginesPayload {
  engines: EngineSummary[];
  active: string;
  onboarded: boolean;
  /** The post-onboarding setup wizard already ran (or was skipped). */
  setupDone: boolean;
  canManage: boolean;
}

export const ENGINES_ROUTE = "/api/engines";
export const ENGINE_UPDATES_ROUTE = "/api/engines/updates";

/** omp's own read-only self check (POST /api/omp-update {action:"check"}),
 * the fallback for members who cannot query the registry route. */
export interface OmpSelfStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

/**
 * Everything one engine row renders from, derived once from the roster, the
 * registry statuses and the member self-check. Pure so the fixture test can
 * pin the derivations (which number is shown, which chips, which actions)
 * without a browser.
 */
export interface EngineRowModel {
  engine: EngineSummary;
  active: boolean;
  /** The number a user means by the engine's name: the CLI's for a
   * two-package engine, never the adapter's. */
  installedVersion: string | null;
  updateAvailable: boolean | null;
  /** The version the Update button names: the last stale package's (the CLI
   * over the adapter), else the engine's own latest. */
  latestVersion: string | null;
  /** Broken out only for a two-package engine (admins). */
  components: EngineComponentStatus[];
  probeError: string | null;
  /** A check can answer this row: admins for every engine, members only for
   * the active omp runtime. */
  statusExpected: boolean;
  /** The active omp runtime updates through /api/omp-update (restart + health
   * check) instead of the generic installer. */
  selfUpdate: boolean;
  /** The offered version jumps past the major this Cody build was verified
   * against: `subject` names the package the warning is about. */
  compat: { subject: string; version: string } | null;
  installedAhead: boolean;
  previousVersion: string | null;
  previousEngineVersion: string | null;
  /** The member self-check's answer, for the command card. */
  self: OmpSelfStatus | null;
  canInstall: boolean;
  needsManualInstall: boolean;
  canUse: boolean;
  canUninstall: boolean;
}

export function buildEngineRows(roster: EnginesPayload, statuses: Readonly<Record<string, EngineUpdateStatus>>, opts: { ompSelf: OmpSelfStatus | null; capabilities: EngineCapabilities }): EngineRowModel[] {
  const canManage = roster.canManage;
  return roster.engines.map((engine) => {
    const active = engine.id === roster.active;
    const status = statuses[engine.id];
    const self = engine.id === "omp" && !canManage && opts.capabilities.updates ? opts.ompSelf : null;
    const installedVersion = status?.engineVersion ?? engine.version;
    const updateAvailable = canManage ? status?.updateAvailable ?? null : self ? self.updateAvailable : null;
    const components = canManage ? status?.components ?? [] : [];
    const stale = components.filter((part) => part.updateAvailable === true);
    const latestVersion = canManage
      ? (stale.length > 0 ? stale[stale.length - 1].latestVersion : status?.latestVersion ?? null)
      : self?.availableVersion ?? null;
    const compatVersion = status?.latestVersion ?? null;
    return {
      engine,
      active,
      installedVersion,
      updateAvailable,
      latestVersion,
      components,
      probeError: canManage ? status?.probeError ?? null : null,
      statusExpected: canManage || self !== null || (engine.id === "omp" && !canManage && opts.capabilities.updates),
      selfUpdate: engine.id === "omp" && active && opts.capabilities.updates && canManage,
      compat: canManage && status?.latestBeyondVerified && updateAvailable === true && compatVersion
        ? { subject: status.adapterLabel ?? engine.name, version: compatVersion }
        : null,
      installedAhead: canManage && status?.installedBeyondVerified === true,
      previousVersion: canManage ? status?.previousVersion ?? null : null,
      previousEngineVersion: canManage ? status?.previousEngineVersion ?? null : null,
      self,
      canInstall: !engine.installed && engine.installable && canManage,
      needsManualInstall: !engine.installed && !engine.installable,
      canUse: engine.installed && !active && canManage,
      canUninstall: engine.installed && engine.managed && !active && canManage,
    };
  });
}

interface ChangelogState {
  open: boolean;
  loading: boolean;
  entries: Array<{ heading: string; body: string; isNew?: boolean }> | null;
  reason: string | null;
  /** Whose changelog these entries are: the latest published package (what an
   * update would install) or the installed one (up to date, or the registry
   * fetch failed — the panel says so when the payload admits an update was
   * pending). */
  source: "latest" | "installed" | null;
  /** The payload's own update-pending admission — never inferred from the
   * row's separately-refreshed update state, which can be newer than these
   * entries. */
  updatePending: boolean;
  /** The versions the entries were computed against. Reopening compares them
   * to the row's current knowledge and refetches on any drift, so a check
   * that just discovered an update (or an out-of-band engine update) can
   * never leave cached entries wearing yesterday's "New" marks. */
  forVersions: { installed: string | null; latest: string | null } | null;
}

const CLOSED_CHANGELOG: ChangelogState = { open: false, loading: false, entries: null, reason: null, source: null, updatePending: false, forVersions: null };

export const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
};

export const cardTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
};

export const mutedLineStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--text-muted)",
  overflowWrap: "anywhere",
};

export const dimLineStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--text-dim)",
  overflowWrap: "anywhere",
};

/** A version-probe failure is raw tool output: enough of it to recognise the
 * fault, capped so one long message cannot push the card off the screen. */
const PROBE_ERROR_MAX_CHARS = 160;

export function actionButtonStyle(disabled: boolean): CSSProperties {
  return { ...smallButtonStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? "default" : "pointer" };
}

export function Spinner(): ReactElement {
  return <Loader2 size={13} aria-hidden="true" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} />;
}

export function LoadingLine({ label }: { label: string }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, ...dimLineStyle }}>
      <Loader2 size={11} aria-hidden="true" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} />
      <span>{label}</span>
    </div>
  );
}

/** `v1.2.3 -> v1.2.4` in accent mono: the "an update exists" line. */
export function VersionDelta({ current, next }: { current: string | null; next: string }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "var(--accent)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
      <span>v{current ?? "?"}</span>
      <ArrowRight size={11} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span>v{next}</span>
    </div>
  );
}

/**
 * The packages a two-package engine is installed from, each with its own
 * number. Cody installs an ACP adapter plus the CLI it drives, and those move
 * on unrelated release schedules — so a single unlabelled version under the
 * engine's name is either the wrong one or an unanswerable question. Labels
 * come from the adapter (English package names, like `tagline` and
 * `authHint`), never from a translation key.
 *
 * Only rendered when there is more than one package; a single-package engine
 * has nothing to break out.
 */
export function EngineParts({ components }: { components: EngineComponentStatus[] }): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {components.map((part) => (
        <div key={part.packageName} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ ...dimLineStyle, minWidth: 0 }}>{part.label}</span>
          {part.updateAvailable === true && part.latestVersion
            ? <VersionDelta current={part.installedVersion} next={part.latestVersion} />
            : (
              <span style={{ ...dimLineStyle, fontFamily: "var(--font-mono)" }}>
                {part.installedVersion ? `v${part.installedVersion}` : translate("updates.versionUnavailable")}
              </span>
            )}
        </div>
      ))}
    </div>
  );
}

/** The copyable terminal-command card, matching the pattern used elsewhere
 * for commands Cody cannot run itself. */
export function CommandCard({ command }: { command: string }): ReactElement {
  const { copied, copy } = useCopyFeedback();
  return (
    <div style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{translate("updates.runCommandHint")}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", wordBreak: "break-all" }}>{command}</code>
        <button
          type="button"
          onClick={() => copy(command)}
          aria-label={translate("updates.copyCommand")}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11, flexShrink: 0 }}
        >
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? translate("updates.copied") : translate("updates.copy")}
        </button>
      </div>
    </div>
  );
}

/** Live install readout: indeterminate bar + the last npm output line. The
 * picker's `.engine-progress` CSS draws the same thing. */
function InstallProgress({ line }: { line: string }): ReactElement {
  return (
    <span role="status" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span aria-hidden style={{ display: "block", height: 3, borderRadius: 2, overflow: "hidden", background: "var(--bg-subtle)" }}>
        <span style={{ display: "block", height: "100%", width: "40%", borderRadius: 2, background: "var(--accent)", animation: "engine-progress-slide 1.2s ease-in-out infinite" }} />
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{line}</span>
    </span>
  );
}

/** The search jump contract for a row that is not a NativeSetting card: the
 * shell sets the highlight id, the row scrolls itself into view and wears
 * the outline while it matches. */
function useSearchAnchor(id: string): { ref: (element: HTMLElement | null) => void; highlighted: boolean } {
  const highlightId = useContext(SettingsHighlightContext);
  const elementRef = useRef<HTMLElement | null>(null);
  const highlighted = highlightId !== null && highlightId === id;
  useEffect(() => {
    if (highlighted) elementRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  const ref = useCallback((element: HTMLElement | null) => { elementRef.current = element; }, []);
  return { ref, highlighted };
}

async function postJson(path: string, body: unknown, method = "POST"): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = typeof parsed?.error === "string" ? parsed.error : "";
    const detail = typeof parsed?.detail === "string" ? parsed.detail : "";
    throw new Error([error, detail].filter(Boolean).join(" — ") || `HTTP ${response.status}`);
  }
  return parsed ?? {};
}

/**
 * After an update of the ACTIVE engine, tell the user when its catalog grew.
 * `?cached=1` peeks the models cache without spawning the engine: a cold
 * cache answers `pending: true` and says nothing about new models, so the
 * toast stays quiet; so does any failure (an ACP engine with no catalog, a
 * network error) — this is a courtesy, not a status.
 */
async function announceNewModels(openModels: (() => void) | null): Promise<void> {
  try {
    const response = await fetch("/api/models/new?cached=1", { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return;
    const body = (await response.json().catch(() => null)) as { newModels?: unknown; pending?: boolean } | null;
    if (body?.pending === true) return;
    const count = Array.isArray(body?.newModels) ? body.newModels.length : 0;
    if (count === 0) return;
    toast.info(
      translate("updates.newModelsToast", { count }),
      undefined,
      openModels ? { durationMs: 10_000, action: { label: translate("updates.newModelsAction"), onClick: openModels } } : { durationMs: 10_000 },
    );
  } catch {
    // A courtesy toast never reports its own failure.
  }
}

type PendingAction =
  | { kind: "update"; engine: EngineSummary; version: string; compat: string | null; self: boolean; active: boolean }
  | { kind: "reinstall"; engine: EngineSummary; active: boolean }
  | { kind: "revert"; engine: EngineSummary; version: string; label: string; active: boolean }
  | { kind: "restart" }
  | { kind: "uninstall"; engine: EngineSummary };

export function EngineRoster({ mode, capabilities: capabilitiesProp, checkSeq = 0, onOmpUpdateAvailabilityChange, onSelected, initial, initialStatuses }: {
  mode: "manage" | "pick";
  /** Active engine capabilities; defaults to the shell's, then to omp's. */
  capabilities?: EngineCapabilities;
  /** Bumped by the System hub's "Check for updates": re-runs the member
   * self check. The admin registry pass is cache-driven and needs no bump. */
  checkSeq?: number;
  /** The title-bar badge follows omp's update state. */
  onOmpUpdateAvailabilityChange?: (available: boolean) => void;
  /** A selection stuck. `engineChanged` is true when the active engine is
   * not the one the page booted with. Without a handler the page reloads:
   * everything it loaded came from the old engine. */
  onSelected?: (engine: EngineSummary, engineChanged: boolean) => void;
  /** The roster AppShell already fetched, painted until the cache answers. */
  initial?: EnginesPayload | null;
  /** Registry statuses to paint until the cache answers (a caller that
   * already holds the rail's prefetch; the fixture test). */
  initialStatuses?: EngineUpdateStatus[];
}) {
  const { t } = useI18n();
  const shell = useContext(ShellContext);
  const capabilities = capabilitiesProp ?? shell?.capabilities ?? ALL_CAPABILITIES;
  const openModels = shell ? () => shell.callbacks.selectSection("models") : null;
  const openModelsRef = useRef(openModels);
  openModelsRef.current = openModels;

  const roster = useSettingsRoute<EnginesPayload>(ENGINES_ROUTE);
  const payload = roster.data ?? initial ?? null;
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const canManage = payload?.canManage === true;
  const updates = useSettingsRoute<{ updates: EngineUpdateStatus[] }>(ENGINE_UPDATES_ROUTE, { enabled: mode === "manage" && canManage });
  const statuses = useMemo(() => {
    const map: Record<string, EngineUpdateStatus> = {};
    for (const status of updates.data?.updates ?? initialStatuses ?? []) map[status.id] = status;
    return map;
  }, [updates.data, initialStatuses]);

  // Members cannot query the registry route; the active omp runtime still
  // answers its own read-only check.
  const [ompSelf, setOmpSelf] = useState<{ status: OmpSelfStatus | null; checked: boolean; checking: boolean }>({ status: null, checked: false, checking: false });
  const selfCheckWanted = mode === "manage" && payload !== null && !canManage && capabilities.updates;
  useEffect(() => {
    if (!selfCheckWanted) return;
    const controller = new AbortController();
    setOmpSelf((current) => ({ ...current, checking: true }));
    void (async () => {
      try {
        const response = await fetch("/api/omp-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check" }), signal: controller.signal });
        const data = (await response.json().catch(() => ({}))) as Partial<OmpSelfStatus> & { error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setOmpSelf({
          checked: true,
          checking: false,
          status: {
            currentVersion: typeof data.currentVersion === "string" ? data.currentVersion : null,
            availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : null,
            updateAvailable: data.updateAvailable === true,
            updateCommand: typeof data.updateCommand === "string" && data.updateCommand ? data.updateCommand : "omp update",
          },
        });
      } catch {
        if (!controller.signal.aborted) setOmpSelf((current) => ({ ...current, checked: true, checking: false }));
      }
    })();
    return () => controller.abort();
  }, [selfCheckWanted, checkSeq]);

  const reportRef = useRef(onOmpUpdateAvailabilityChange);
  reportRef.current = onOmpUpdateAvailabilityChange;
  useEffect(() => {
    const omp = statuses.omp;
    if (omp && omp.updateAvailable !== null) reportRef.current?.(omp.updateAvailable === true);
  }, [statuses]);
  useEffect(() => {
    if (ompSelf.status) reportRef.current?.(ompSelf.status.updateAvailable);
  }, [ompSelf.status]);

  // The engine the page booted with: a switch away from it means the loaded
  // UI (models, skills, chat affordances) no longer matches the server.
  const bootEngineRef = useRef<string | null>(null);
  useEffect(() => {
    if (payload) bootEngineRef.current ??= payload.active;
  }, [payload]);

  const [changelog, setChangelog] = useState<ChangelogState>(CLOSED_CHANGELOG);
  const [changelogEngine, setChangelogEngine] = useState<EngineSummary | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [ompUpdating, setOmpUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Post-uninstall honesty line ("a system copy on PATH remains"). */
  const [note, setNote] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const onInstallSettled = useCallback((id: string, ok: boolean) => {
    const current = payloadRef.current;
    const engine = current?.engines.find((entry) => entry.id === id);
    const name = engine?.name ?? id;
    const wasInstalled = engine?.installed === true;
    if (ok) toast.success(translate(wasInstalled ? "updates.engines.updated" : "updates.engines.installed", { name }));
    // The row keeps the detailed npm failure inline; the toast is the alert.
    else toast.error(translate(wasInstalled ? "updates.engines.updateFailed" : "updates.engines.installFailed", { name }));
    // An omp install also invalidates the cached changelog (its "new" marks
    // compared against the version just replaced). Only omp's — another
    // engine's install must not collapse a changelog someone is reading.
    if (id === "omp") setChangelog(CLOSED_CHANGELOG);
    // Re-read after a failure too: an install that ran but left an unusable
    // binary still recorded the version it replaced, and offering that revert
    // target is what gets the row out of a dead end. The prefix covers the
    // roster and the registry statuses in one sweep.
    invalidateSettingsRoutes(ENGINES_ROUTE);
    if (ok && wasInstalled && current?.active === id) void announceNewModels(openModelsRef.current);
  }, []);

  const { installing: installingIds, progress: installProgress, errors: installErrors, start: startInstall, watch: watchInstall } = useEngineInstalls(onInstallSettled);

  // Reattach to installs already running server-side (page reload, the
  // onboarding picker, another admin) so the row shows live progress.
  useEffect(() => {
    for (const engine of payload?.engines ?? []) {
      if (engine.installing) watchInstall(engine.id);
    }
  }, [payload, watchInstall]);

  // A running install holds the shell's busy register: closing Settings
  // would only lose the progress view (the server owns the npm run), but the
  // shell asks before it does.
  const busyRegister = shell?.busy ?? null;
  useEffect(() => {
    if (!busyRegister || installingIds.size === 0) return;
    const names = [...installingIds].map((id) => payloadRef.current?.engines.find((engine) => engine.id === id)?.name ?? id);
    return busyRegister.hold(t("updates.engines.busyInstalling", { name: names.join(", ") }));
  }, [busyRegister, installingIds, t]);

  const select = useCallback((engine: EngineSummary) => {
    setActionError(null);
    setSelecting(engine.id);
    void postJson("/api/engines/select", { id: engine.id })
      .then(() => {
        const changed = bootEngineRef.current !== null && bootEngineRef.current !== engine.id;
        if (onSelected) {
          onSelected(engine, changed);
          return;
        }
        // Everything the page loaded came from the old engine — capabilities,
        // model lists, live sessions. Reload rather than reconcile.
        //
        // assign("/") rather than reload(): a reload keeps the query string,
        // and `?session=<id>` names a session of the OLD engine. The sidebar's
        // restore then hunts for an id that is not in the new engine's list,
        // retrying for eight seconds behind a blank loading pane before giving
        // up — and because the id stays in the address bar, every later
        // refresh of that URL stalls the same way. A session id is
        // engine-scoped state, exactly like ENGINE_SCOPED_KEYS.
        window.location.assign("/");
      })
      .catch((failure: unknown) => {
        setActionError(failure instanceof Error ? failure.message : String(failure));
        setSelecting(null);
      });
  }, [onSelected]);

  // The active omp runtime updates through its dedicated route rather than
  // the generic install route: the server restarts live sessions, runs a
  // post-update health check, and reports both in one message.
  const updateOmpNow = useCallback(async () => {
    if (ompUpdating) return;
    setOmpUpdating(true);
    try {
      const data = (await postJson("/api/omp-update", { action: "update" })) as { success?: boolean; version?: string; sessionsRestarted?: number };
      if (data.success !== true) throw new Error(translate("updates.omp.updateFailed"));
      const count = typeof data.sessionsRestarted === "number" ? data.sessionsRestarted : 0;
      toast.success(translatePlural("updates.omp.updated", count, { count, version: data.version ?? "?" }));
      setChangelog(CLOSED_CHANGELOG);
      invalidateSettingsRoutes(ENGINES_ROUTE);
      void announceNewModels(openModelsRef.current);
    } catch (error) {
      toast.error(translate("updates.omp.updateFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setOmpUpdating(false);
    }
  }, [ompUpdating]);

  const restartSessions = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      const data = (await postJson("/api/omp-update", { action: "restart" })) as { success?: boolean; sessionsRestarted?: number };
      if (data.success !== true) throw new Error(translate("updates.omp.restartFailed"));
      const count = typeof data.sessionsRestarted === "number" ? data.sessionsRestarted : 0;
      toast.success(translatePlural("updates.omp.restarted", count, { count }));
    } catch (error) {
      toast.error(translate("updates.omp.restartFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setRestarting(false);
    }
  }, [restarting]);

  const uninstall = useCallback(async (engine: EngineSummary) => {
    setActionError(null);
    setNote(null);
    setUninstalling(engine.id);
    try {
      const body = (await postJson("/api/engines/install", { id: engine.id }, "DELETE")) as { remainingBinary?: string | null };
      // Removal from Cody's prefix cannot touch a system install; say so
      // rather than letting the still-"Installed" row look like a failure.
      if (body.remainingBinary) setNote(translate("updates.engines.remainingBinary", { name: engine.name, path: body.remainingBinary }));
      toast.success(translate("updates.engines.uninstalled", { name: engine.name }));
      invalidateSettingsRoutes(ENGINES_ROUTE);
      setPending(null);
    } catch (error) {
      toast.error(translate("updates.engines.uninstallFailed", { name: engine.name }), error instanceof Error ? error.message : String(error));
      setPending(null);
    } finally {
      if (mountedRef.current) setUninstalling(null);
    }
  }, []);

  const confirmPending = useCallback(() => {
    if (!pending) return;
    if (pending.kind === "uninstall") {
      // Stays open with a busy button until the DELETE settles.
      void uninstall(pending.engine);
      return;
    }
    setPending(null);
    if (pending.kind === "update") {
      if (pending.self) void updateOmpNow();
      else startInstall(pending.engine.id);
    } else if (pending.kind === "reinstall") {
      startInstall(pending.engine.id);
    } else if (pending.kind === "revert") {
      startInstall(pending.engine.id, { version: pending.version });
    } else {
      void restartSessions();
    }
  }, [pending, uninstall, updateOmpNow, startInstall, restartSessions]);

  const toggleChangelog = useCallback(async (engine: EngineSummary, installedNow: string | null, latestNow: string | null) => {
    if (changelog.open && changelogEngine?.id === engine.id) {
      setChangelog((current) => ({ ...current, open: false }));
      return;
    }
    setChangelogEngine(engine);
    const fresh = changelog.forVersions !== null
      && changelogEngine?.id === engine.id
      && changelog.forVersions.installed === installedNow
      && changelog.forVersions.latest === latestNow;
    if (changelog.entries && fresh) {
      setChangelog((current) => ({ ...current, open: true }));
      return;
    }
    setChangelog({ ...CLOSED_CHANGELOG, open: true, loading: true });
    try {
      const response = await fetch(`/api/engines/changelog?id=${encodeURIComponent(engine.id)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | {
            entries?: Array<{ heading: string; body: string; isNew?: boolean }> | null;
            reason?: string;
            source?: "latest" | "installed" | null;
            updatePending?: boolean;
            installedVersion?: string | null;
            latestVersion?: string | null;
          }
        | null;
      if (!mountedRef.current) return;
      setChangelog({
        open: true,
        loading: false,
        entries: Array.isArray(data?.entries) && data.entries.length > 0 ? data.entries : null,
        reason: data?.reason ?? null,
        source: data?.source === "latest" || data?.source === "installed" ? data.source : null,
        updatePending: data?.updatePending === true,
        forVersions: {
          installed: typeof data?.installedVersion === "string" ? data.installedVersion : null,
          latest: typeof data?.latestVersion === "string" ? data.latestVersion : null,
        },
      });
    } catch (error) {
      if (mountedRef.current) setChangelog({ ...CLOSED_CHANGELOG, open: true, reason: String(error) });
    }
  }, [changelog.entries, changelog.forVersions, changelog.open, changelogEngine]);

  // Stable: the Drawer registers a phone level in an effect keyed on its
  // onClose, so an inline arrow here would re-register on every render.
  const closeChangelog = useCallback(() => setChangelog((current) => ({ ...current, open: false })), []);

  const rows = useMemo(() => (payload ? buildEngineRows(payload, statuses, { ompSelf: ompSelf.status, capabilities }) : []), [payload, statuses, ompSelf.status, capabilities]);
  const checking = canManage ? updates.loading : ompSelf.checking;
  const statusesChecked = canManage ? updates.data !== null || updates.error !== null : ompSelf.checked;
  // Only a selection blocks the whole surface (it ends in a navigation).
  // Installs are per-engine: other rows stay usable while npm runs.
  const selectionBusy = selecting !== null;
  const activeEngine = payload?.engines.find((engine) => engine.id === payload.active) ?? null;
  const rosterAnchor = useSearchAnchor("agent-engines");
  const dangerAnchor = useSearchAnchor("engine-danger-zone");

  const confirmDialog = pending && (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open && uninstalling === null) setPending(null); }}
      title={
        pending.kind === "update" ? t("updates.engines.confirmUpdate", { name: pending.engine.name, version: pending.version })
          : pending.kind === "reinstall" ? t("updates.engines.confirmReinstall", { name: pending.engine.name })
            : pending.kind === "revert" ? t("updates.engines.confirmRevert", { name: pending.engine.name, version: pending.label })
              : pending.kind === "restart" ? t("updates.omp.restart")
                : t("updates.engines.uninstallTitle", { name: pending.engine.name })
      }
      description={
        pending.kind === "update"
          ? [
            pending.self ? t("updates.omp.updateConfirm") : pending.active ? t("updates.engines.updateConfirm", { name: pending.engine.name }) : t("updates.engines.updateInactiveNote", { name: pending.engine.name }),
            pending.compat,
          ].filter(Boolean).join(" ")
          : pending.kind === "reinstall"
            ? (pending.active ? t("updates.engines.reinstallConfirm", { name: pending.engine.name }) : t("updates.engines.updateInactiveNote", { name: pending.engine.name }))
            : pending.kind === "revert"
              ? (pending.active ? t("updates.engines.updateConfirm", { name: pending.engine.name }) : t("updates.engines.updateInactiveNote", { name: pending.engine.name }))
              : pending.kind === "restart"
                ? t("updates.omp.restartConfirm")
                : t("updates.engines.uninstallBody", { name: pending.engine.name })
      }
      confirmLabel={
        pending.kind === "update" ? t("updates.omp.update")
          : pending.kind === "reinstall" ? t("updates.engines.reinstall")
            : pending.kind === "revert" ? t("updates.engines.revertTo", { version: pending.label })
              : pending.kind === "restart" ? t("updates.omp.restart")
                : uninstalling ? t("updates.engines.uninstalling") : t("updates.engines.uninstall")
      }
      danger={pending.kind === "uninstall" || pending.kind === "restart"}
      busy={pending.kind === "uninstall" && uninstalling !== null}
      onConfirm={confirmPending}
    />
  );

  if (mode === "pick") {
    return (
      <>
        {actionError && (
          <div className="login-error engine-alert" role="alert">
            <AlertCircle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{actionError}</span>
          </div>
        )}
        {!payload && roster.error && (
          <div className="login-error engine-alert" role="alert">
            <AlertCircle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{roster.error}</span>
          </div>
        )}
        {payload === null ? (
          !roster.error && (
            <div className="engine-loading" role="status">
              <Loader2 size={15} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
              {t("engines.loading")}
            </div>
          )
        ) : (
          <div className="engine-grid">
            {rows.map(({ engine, active }, index) => {
              const installBusy = installingIds.has(engine.id);
              const selectBusy = selecting === engine.id;
              const installError = installErrors[engine.id];
              return (
                <section key={engine.id} className="engine-card" data-active={active ? "true" : undefined} style={{ animationDelay: `${index * 70}ms` }}>
                  <header className="engine-card-head">
                    <h2 className="engine-name">{engine.name}</h2>
                    <div className="engine-chips">
                      {/* Engines Cody cannot install and cannot run without: experimental ones. */}
                      {!engine.experimental && (
                        <span className="engine-chip" data-tone="recommended">
                          <Sparkles size={10} aria-hidden /> {t("engines.recommended")}
                        </span>
                      )}
                      {engine.experimental && (
                        <span className="engine-chip" data-tone="experimental">
                          <TriangleAlert size={10} aria-hidden /> {t("engines.experimental")}
                        </span>
                      )}
                    </div>
                  </header>

                  <p className="engine-tagline">{engine.tagline}</p>

                  <dl className="engine-facts">
                    <div className="engine-fact">
                      <dt>{t("engines.statusLabel")}</dt>
                      <dd data-state={engine.installed ? "installed" : "missing"}>
                        {engine.installed
                          ? engine.version
                            ? t("engines.installedVersion", { version: engine.version })
                            : t("engines.installed")
                          : t("engines.notInstalled")}
                      </dd>
                    </div>
                    {engine.authHint && (
                      <div className="engine-fact">
                        <dt>{t("engines.authLabel")}</dt>
                        <dd>{engine.authHint}</dd>
                      </div>
                    )}
                    {engine.experimental && (
                      <div className="engine-fact">
                        <dt>{t("engines.caveatLabel")}</dt>
                        <dd>{t("engines.caveat")}</dd>
                      </div>
                    )}
                  </dl>

                  <div className="engine-actions">
                    {active && (
                      <span className="engine-active-note">
                        <Check size={13} aria-hidden /> {t("engines.activeNow")}
                      </span>
                    )}
                    {!engine.installed && engine.installable && (
                      <button type="button" className="login-ghost engine-button" onClick={() => startInstall(engine.id)} disabled={selectionBusy || installBusy}>
                        {installBusy
                          ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
                          : <Download size={14} aria-hidden />}
                        {installBusy ? t("engines.installing") : t("engines.install")}
                      </button>
                    )}
                    {!engine.installed && !engine.installable && (
                      <span className="engine-blocked">{t("engines.installManually", { binary: engine.binaryName })}</span>
                    )}
                    {engine.installed && (
                      <button type="button" className="login-primary engine-button" onClick={() => select(engine)} disabled={selectionBusy}>
                        {selectBusy && <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
                        {active
                          ? t("engines.continueWith", { name: engine.shortName })
                          : selectBusy ? t("engines.switching") : t("engines.use", { name: engine.shortName })}
                      </button>
                    )}
                  </div>

                  {installBusy && (
                    <div className="engine-progress" role="status" aria-live="polite">
                      <span className="engine-progress-bar" aria-hidden><span /></span>
                      <span className="engine-progress-line">{installProgress[engine.id] || t("engines.installing")}</span>
                    </div>
                  )}
                  {installError && (
                    <div className="login-error engine-alert" role="alert">
                      <AlertCircle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{installError}</span>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <div className="engine-footer">
          <span>{t("engines.switchNote")}</span>
          {activeEngine && (
            <button type="button" className="engine-link" onClick={() => select(activeEngine)} disabled={selectionBusy}>
              {t("engines.decideLater", { name: activeEngine.shortName })}
            </button>
          )}
        </div>
        {confirmDialog}
      </>
    );
  }

  const dangerRows: DangerZoneRow[] = [];
  if (canManage) {
    for (const row of rows) {
      if (!row.canUninstall) continue;
      const busy = uninstalling !== null || installingIds.has(row.engine.id) || selectionBusy;
      dangerRows.push({
        title: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {row.engine.name}
            <span style={{ ...chipStyle, fontFamily: "var(--font-mono)" }}>{row.installedVersion ? `v${row.installedVersion}` : t("updates.versionUnavailable")}</span>
          </span>
        ),
        description: t("updates.engines.uninstallHint"),
        action: (
          <button type="button" onClick={() => setPending({ kind: "uninstall", engine: row.engine })} disabled={busy} style={{ ...dangerButtonStyle, opacity: busy ? 0.6 : 1 }}>
            {uninstalling === row.engine.id ? <Spinner /> : <Trash2 size={13} aria-hidden />}
            {uninstalling === row.engine.id ? t("updates.engines.uninstalling") : t("updates.engines.uninstall")}
          </button>
        ),
      });
    }
    if (capabilities.updates) {
      dangerRows.push({
        title: t("updates.omp.restart"),
        description: t("updates.omp.restartHint"),
        action: (
          <button type="button" onClick={() => setPending({ kind: "restart" })} disabled={restarting} style={{ ...dangerButtonStyle, opacity: restarting ? 0.6 : 1 }}>
            {restarting ? <Spinner /> : <RotateCcw size={13} aria-hidden="true" />}
            {restarting ? t("updates.omp.restarting") : t("updates.omp.restart")}
          </button>
        ),
      });
    }
  }

  const highlightBox = (highlighted: boolean): CSSProperties => (highlighted ? { boxShadow: "0 0 0 2px var(--accent)", borderColor: "var(--accent)" } : {});

  return (
    <>
      <section
        ref={rosterAnchor.ref}
        data-search-id="agent-engines"
        style={{ ...cardStyle, padding: 0, gap: 0, transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)", ...highlightBox(rosterAnchor.highlighted) }}
        aria-label={t("updates.engines.title")}
      >
        <div style={{ padding: "12px 14px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={cardTitleStyle}>
            <Cpu size={13} aria-hidden="true" />
            {t("updates.engines.title")}
          </div>
          <div style={dimLineStyle}>{t("updates.engines.description")}</div>
          {activeEngine && (
            <div style={dimLineStyle}>{t("updates.engines.activeLine", { name: activeEngine.name, version: activeEngine.version ? `v${activeEngine.version}` : "" }).trim()}</div>
          )}
        </div>

        {actionError && <div style={{ padding: "0 14px 10px" }}><ErrorNote message={actionError} /></div>}
        {/* Not fetched yet reads as loading: the cache fills on mount. */}
        {!payload && !roster.error && (
          <div style={{ padding: "0 14px 12px" }}>
            <LoadingLine label={t("updates.checking")} />
          </div>
        )}
        {!payload && !roster.loading && roster.error && (
          <div style={{ padding: "0 14px 12px", ...dimLineStyle }}>{t("updates.engines.loadFailed")}</div>
        )}
        {payload && rows.length === 0 && (
          <div style={{ padding: "0 14px 12px", ...dimLineStyle }}>{t("updates.engines.none")}</div>
        )}

        {rows.map((row) => (
          <EngineRow
            key={row.engine.id}
            row={row}
            canManage={canManage}
            checking={checking}
            statusesChecked={statusesChecked}
            npmBusy={installingIds.has(row.engine.id)}
            ompUpdating={ompUpdating}
            selecting={selecting}
            selectionBusy={selectionBusy}
            progressLine={installProgress[row.engine.id] || t("updates.omp.updating")}
            installError={installErrors[row.engine.id] ?? null}
            changelogOpen={changelog.open && changelogEngine?.id === row.engine.id}
            changelogLoading={changelog.loading && changelogEngine?.id === row.engine.id}
            onInstall={() => startInstall(row.engine.id)}
            onUse={() => select(row.engine)}
            onUpdate={(compatWarning) => setPending({ kind: "update", engine: row.engine, version: row.latestVersion ?? "", compat: compatWarning, self: row.selfUpdate, active: row.active })}
            onReinstall={() => setPending({ kind: "reinstall", engine: row.engine, active: row.active })}
            onRevert={(version, label) => setPending({ kind: "revert", engine: row.engine, version, label, active: row.active })}
            onChangelog={() => void toggleChangelog(row.engine, row.installedVersion, row.latestVersion)}
          />
        ))}

        {note && (
          <p role="status" style={{ margin: 0, padding: "10px 14px", borderTop: "1px solid var(--border)", ...mutedLineStyle }}>{note}</p>
        )}
        {payload && !canManage && rows.some((row) => row.engine.installed) && (
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", ...dimLineStyle }}>
            {t("updates.engines.adminNote")}
          </div>
        )}
      </section>

      {dangerRows.length > 0 && (
        <div ref={dangerAnchor.ref} data-search-id="engine-danger-zone" style={{ borderRadius: "var(--radius-card)", transition: "box-shadow var(--dur-fast)", ...(dangerAnchor.highlighted ? { boxShadow: "0 0 0 2px var(--accent)" } : {}) }}>
          <DangerZone title={t("updates.engines.dangerZone")} rows={dangerRows} />
        </div>
      )}

      <Drawer
        open={changelog.open}
        title={t("updates.engines.changelogTitle", { name: changelogEngine?.name ?? "" }).trim()}
        presentation="side"
        width={480}
        onClose={closeChangelog}
      >
        {changelog.loading && <LoadingLine label={t("updates.checking")} />}
        {!changelog.loading && changelog.entries && changelog.source === "installed" && changelog.updatePending && (
          // The payload itself admits an update was pending and the published
          // notes could not be fetched, so these entries stop at the installed
          // version — say so instead of letting old notes read as the
          // update's. Keyed off the payload, never the row's state.
          <div style={{ ...dimLineStyle, color: "var(--status-warning)" }}>{t("updates.omp.changelogStale")}</div>
        )}
        {!changelog.loading && changelog.entries && changelog.entries.map((entry) => (
          <div key={entry.heading} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{entry.heading}</span>
              {entry.isNew && <span style={{ ...chipStyle, color: "var(--accent)" }}>{t("updates.omp.changelogNew")}</span>}
            </div>
            <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.55, color: "var(--text-muted)", fontFamily: "inherit" }}>{entry.body}</pre>
          </div>
        ))}
        {!changelog.loading && !changelog.entries && (
          <div style={dimLineStyle}>{changelog.reason ?? t("updates.omp.changelogUnavailable")}</div>
        )}
      </Drawer>
      {confirmDialog}
    </>
  );
}

function EngineRow({ row, canManage, checking, statusesChecked, npmBusy, ompUpdating, selecting, selectionBusy, progressLine, installError, changelogOpen, changelogLoading, onInstall, onUse, onUpdate, onReinstall, onRevert, onChangelog }: {
  row: EngineRowModel;
  canManage: boolean;
  checking: boolean;
  statusesChecked: boolean;
  npmBusy: boolean;
  ompUpdating: boolean;
  selecting: string | null;
  selectionBusy: boolean;
  progressLine: string;
  installError: string | null;
  changelogOpen: boolean;
  changelogLoading: boolean;
  onInstall: () => void;
  onUse: () => void;
  onUpdate: (compatWarning: string | null) => void;
  onReinstall: () => void;
  onRevert: (version: string, label: string) => void;
  onChangelog: () => void;
}) {
  const { t } = useI18n();
  const { engine, active, installedVersion, updateAvailable, latestVersion, components, probeError, statusExpected, selfUpdate, compat, installedAhead, previousVersion, previousEngineVersion, self } = row;
  const anchor = useSearchAnchor(`engine-${engine.id}`);
  const busy = npmBusy || (selfUpdate && ompUpdating) || selectionBusy;
  const compatWarning = compat ? t("updates.engines.aheadNote", { name: compat.subject, version: compat.version }) : null;
  const selectBusy = selecting === engine.id;
  return (
    <div
      ref={anchor.ref}
      data-search-id={`engine-${engine.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderTop: "1px solid var(--border)",
        background: active ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "transparent",
        boxShadow: anchor.highlighted ? "inset 0 0 0 2px var(--accent)" : undefined,
        transition: "box-shadow var(--dur-fast)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{engine.name}</span>
        {active && <span style={{ ...chipStyle, color: "var(--accent)" }}>{t("updates.engines.active")}</span>}
        {engine.experimental && <span style={{ ...chipStyle, color: "var(--status-warning)" }}>{t("engines.experimental")}</span>}
        <span style={{ ...chipStyle, fontFamily: "var(--font-mono)" }}>
          {engine.installed
            ? installedVersion ? `v${installedVersion}` : t("updates.versionUnavailable")
            : t("engines.notInstalled")}
        </span>
        {installedAhead && (
          <span style={{ ...chipStyle, color: "var(--status-warning)" }} title={t("updates.engines.aheadInstalledTitle")} aria-label={t("updates.engines.aheadInstalledTitle")}>
            <TriangleAlert size={10} aria-hidden="true" style={{ flexShrink: 0, marginRight: 3, verticalAlign: "-1px" }} />
            {t("updates.engines.aheadChip")}
          </span>
        )}
        {engine.installed && engine.verifiedVersion && (
          <span
            style={{ ...chipStyle, color: "var(--text-dim)" }}
            title={t("updates.engines.verifiedTitle", { name: engine.adapterLabel ?? engine.name, version: engine.verifiedVersion })}
            aria-label={t("updates.engines.verifiedTitle", { name: engine.adapterLabel ?? engine.name, version: engine.verifiedVersion })}
          >
            {t("updates.engines.verifiedChip", { version: engine.verifiedVersion })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {engine.installed && checking && !busy && <LoadingLine label={t("updates.checking")} />}
        {engine.installed && !checking && !busy && updateAvailable === false && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, ...dimLineStyle }}>
            <Check size={11} aria-hidden="true" style={{ flexShrink: 0 }} />
            {t("updates.upToDate")}
          </span>
        )}
        {engine.installed && !checking && !busy && updateAvailable === null && statusExpected && statusesChecked && (
          <span style={dimLineStyle}>{t("updates.checkUnavailable")}</span>
        )}
        {engine.installed && !checking && !busy && updateAvailable === true && latestVersion && components.length === 0 && (
          <VersionDelta current={installedVersion} next={latestVersion} />
        )}
      </div>

      <div style={dimLineStyle}>{engine.tagline}</div>
      {!engine.installed && engine.authHint && <div style={dimLineStyle}>{engine.authHint}</div>}

      {components.length > 0 && !npmBusy && <EngineParts components={components} />}

      {npmBusy && <InstallProgress line={progressLine} />}

      {!npmBusy && !checking && engine.installed && probeError && (
        // Gated on the probe failure itself, not on a missing version: the
        // registry route only reports probeError when the INSTALLED PACKAGE
        // would not run, and for a two-package engine the CLI beside it can
        // still answer — which would leave the row wearing a healthy-looking
        // version over a broken adapter with nothing on screen to say so.
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={mutedLineStyle}>{t("updates.engines.probeFailed")}</div>
          <div style={{ ...dimLineStyle, fontFamily: "var(--font-mono)" }} title={probeError}>
            {probeError.length > PROBE_ERROR_MAX_CHARS ? `${probeError.slice(0, PROBE_ERROR_MAX_CHARS)}…` : probeError}
          </div>
        </div>
      )}

      {row.needsManualInstall && <div style={dimLineStyle}>{t("engines.installManually", { binary: engine.binaryName })}</div>}

      {!npmBusy && (canManage || engine.id === "omp") && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {row.canInstall && (
            <button type="button" onClick={onInstall} disabled={busy} style={{ ...primaryButtonStyle, opacity: busy ? 0.6 : 1 }}>
              <Download size={13} aria-hidden="true" />
              {t("engines.install")}
            </button>
          )}
          {row.canUse && (
            <button type="button" onClick={onUse} disabled={busy} style={{ ...primaryButtonStyle, opacity: busy ? 0.6 : 1 }}>
              {selectBusy && <Spinner />}
              {selectBusy ? t("engines.switching") : t("engines.use", { name: engine.shortName })}
            </button>
          )}
          {canManage && engine.installed && updateAvailable === true && latestVersion && (
            <button type="button" onClick={() => onUpdate(compatWarning)} disabled={busy} style={actionButtonStyle(busy)}>
              {selfUpdate && ompUpdating ? <Spinner /> : <Download size={13} aria-hidden="true" />}
              {selfUpdate && ompUpdating ? t("updates.omp.updating") : t("updates.engines.updateTo", { version: latestVersion })}
            </button>
          )}
          {canManage && engine.installed && (
            <button type="button" onClick={onReinstall} disabled={busy} title={t("updates.engines.reinstallTitle")} style={actionButtonStyle(busy)}>
              <RefreshCw size={13} aria-hidden="true" />
              {t("updates.engines.reinstall")}
            </button>
          )}
          {canManage && engine.installed && previousVersion && (
            // The escape hatch after an update breaks the engine: reinstall
            // exactly the version the update replaced. Shown whenever history
            // has one, not just when an update exists. The label names the
            // version the user recognizes (the CLI's for a two-package
            // engine); the POST carries the adapter's — the pin the server
            // recorded — and the server restores the recorded PAIR from it.
            <button type="button" onClick={() => onRevert(previousVersion, previousEngineVersion ?? previousVersion)} disabled={busy} title={t("updates.engines.revertTitle")} style={actionButtonStyle(busy)}>
              <RotateCcw size={13} aria-hidden="true" />
              {t("updates.engines.revertTo", { version: previousEngineVersion ?? previousVersion })}
            </button>
          )}
          {engine.id === "omp" && engine.installed && (
            <button type="button" onClick={onChangelog} aria-expanded={changelogOpen} style={actionButtonStyle(changelogLoading)}>
              {changelogLoading ? <Spinner /> : <ScrollText size={13} aria-hidden="true" />}
              {changelogOpen ? t("updates.omp.changelogHide") : t("updates.omp.changelog")}
            </button>
          )}
        </div>
      )}

      {/* Before the jump the note names the offered version; after it
          (installed ahead, nothing newer offered) the chip's full explanation
          renders inline — a tooltip alone is unreachable for keyboard and
          touch. */}
      {!npmBusy && (compatWarning || installedAhead) && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.5, color: "var(--status-warning)", overflowWrap: "anywhere" }}>
          <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ minWidth: 0 }}>{compatWarning ?? t("updates.engines.aheadInstalledTitle")}</span>
        </div>
      )}

      {!npmBusy && updateAvailable === true && !canManage && self && <CommandCard command={self.updateCommand} />}

      {installError && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.5, color: "var(--status-error)", overflowWrap: "anywhere" }}>
          <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ minWidth: 0 }}>{installError}</span>
        </div>
      )}
    </div>
  );
}
