"use client";

import { ArrowRight, Check, Copy, Cpu, Download, Loader2, PlugZap, RefreshCw, RotateCcw, ScrollText, Settings2, Sparkles, Store, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { SkillsStore } from "@/components/SkillsStore";
import { PluginMarketplace } from "@/components/PluginMarketplace";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useEngineInstalls } from "@/hooks/useEngineInstalls";
import type { SkillInfo, SkillInstallScope, SkillUpdateResult } from "@/lib/api-types";
import type { EngineUpdateStatus } from "@/lib/harness/updates";
import { translate, translatePlural, useI18n } from "@/lib/i18n";
import type { EngineSummary, EnginesPayload } from "../EnginePicker";
import type { EngineCapabilities } from "../SettingsTabs";
import { smallButtonStyle } from "./account-controls";
import { chipStyle } from "./primitives";

/**
 * Settings › System & Updates: the single home for every update surface —
 * the Cody application, all installed agent engines (from the registry
 * roster), and workspace skills. One "Check for updates" button refreshes
 * every row; an update action (button for admins, copyable command
 * otherwise) renders only when a newer version is actually known.
 *
 * Sources: GET /api/app-update (Cody), GET /api/engines +
 * GET /api/engines/updates (admin-only registry comparison; members fall
 * back to omp's own POST /api/omp-update check when the active engine
 * supports it), POST /api/skills/check (workspace-scoped).
 */

interface AppUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  /** Which channel ships to this deployment; a container is updated by
   * pulling its image, so it must never be handed an npm command. */
  managedBy: "docker" | "npm" | "bun";
}

interface OmpSelfStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

type RowState = "loading" | "ready" | "error";

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

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
};

const cardTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
};

const mutedLineStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--text-muted)",
  overflowWrap: "anywhere",
};

const dimLineStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--text-dim)",
  overflowWrap: "anywhere",
};

/** A version-probe failure is raw tool output: enough of it to recognise the
 * fault, capped so one long message cannot push the card off the screen. */
const PROBE_ERROR_MAX_CHARS = 160;

function actionButtonStyle(disabled: boolean): React.CSSProperties {
  return { ...smallButtonStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? "default" : "pointer" };
}

function Spinner(): React.ReactElement {
  return <Loader2 size={13} aria-hidden="true" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} />;
}

function LoadingLine({ label }: { label: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, ...dimLineStyle }}>
      <Loader2 size={11} aria-hidden="true" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} />
      <span>{label}</span>
    </div>
  );
}

/** `v1.2.3 -> v1.2.4` in accent mono: the "an update exists" line. */
function VersionDelta({ current, next }: { current: string | null; next: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "var(--accent)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
      <span>v{current ?? "?"}</span>
      <ArrowRight size={11} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span>v{next}</span>
    </div>
  );
}

/** The copyable terminal-command card, matching the pattern used elsewhere
 * for commands Cody cannot run itself. */
function CommandCard({ command }: { command: string }): React.ReactElement {
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

export function SystemUpdates({ cwd, capabilities, onOmpUpdateAvailabilityChange, onOpenSkills }: {
  cwd: string | null;
  /** Active engine capabilities: `updates` enables omp's self-check fallback
   * and the session-restart control; `skills` shows the skills card. */
  capabilities: EngineCapabilities;
  onOmpUpdateAvailabilityChange: (available: boolean) => void;
  /** Deep link to Settings › Skills, where per-skill updates are applied. */
  onOpenSkills: () => void;
}): React.ReactElement {
  const { t, tn } = useI18n();
  const [app, setApp] = useState<{ state: RowState; data: AppUpdateStatus | null }>({ state: "loading", data: null });
  const [roster, setRoster] = useState<EnginesPayload | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [engineStatuses, setEngineStatuses] = useState<Record<string, EngineUpdateStatus>>({});
  const [ompSelf, setOmpSelf] = useState<OmpSelfStatus | null>(null);
  // An update-status pass finished (even unsuccessfully): rows may say
  // "check unavailable" instead of implying a check is still running.
  const [statusesChecked, setStatusesChecked] = useState(false);
  const [skills, setSkills] = useState<{ state: RowState | "no-workspace"; updates: SkillUpdateResult[] }>({ state: "loading", updates: [] });
  const [storeOpen, setStoreOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [installedPackages, setInstalledPackages] = useState<Record<SkillInstallScope, ReadonlySet<string>>>({ global: new Set(), project: new Set() });

  /** Installed-package sets for the store's "Installed" states — cheap local
   * disk read, refreshed on open and after each install. */
  const refreshInstalled = useCallback(async (targetCwd: string) => {
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(targetCwd)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { skills?: SkillInfo[] };
      const globalSet = new Set<string>();
      const projectSet = new Set<string>();
      for (const skill of data.skills ?? []) {
        if (!skill.install) continue;
        (skill.install.scope === "project" ? projectSet : globalSet).add(skill.install.package);
      }
      setInstalledPackages({ global: globalSet, project: projectSet });
    } catch {
      // Store falls back to session-local installed marks.
    }
  }, []);
  const [checking, setChecking] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [ompUpdating, setOmpUpdating] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogState>(CLOSED_CHANGELOG);

  // A monotonic request id plus an AbortController keeps a slow response for
  // a previous check (or a previous workspace) from landing on newer state.
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Held in refs so parents that re-create callbacks (and the check pass that
  // install completion triggers) never restart the fetch effect.
  const reportOmpRef = useRef(onOmpUpdateAvailabilityChange);
  reportOmpRef.current = onOmpUpdateAvailabilityChange;
  const rosterRef = useRef<EnginesPayload | null>(null);
  rosterRef.current = roster;

  const runCheck = useCallback(async (force: boolean) => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const stale = () => requestId !== requestRef.current || !mountedRef.current;
    // Automatic passes fail quietly into per-row states; only a check the
    // user asked for surfaces its failures as toasts.
    const notify = (title: string, detail?: string) => {
      if (force) toast.error(title, detail);
    };

    setChecking(true);
    setApp((current) => ({ state: "loading", data: current.data }));
    setSkills(capabilities.skills && cwd ? { state: "loading", updates: [] } : { state: "no-workspace", updates: [] });

    const loadApp = async () => {
      try {
        const response = await fetch(`/api/app-update${force ? "?force=1" : ""}`, { signal });
        const data = await response.json().catch(() => ({})) as Partial<AppUpdateStatus> & { error?: string };
        if (stale()) return;
        if (!response.ok || typeof data.currentVersion !== "string") {
          setApp({ state: "error", data: null });
          notify(translate("updates.checkFailed"), data.error);
          return;
        }
        setApp({
          state: "ready",
          data: {
            currentVersion: data.currentVersion,
            availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : null,
            updateAvailable: data.updateAvailable === true,
            updateCommand: typeof data.updateCommand === "string" ? data.updateCommand : "",
            managedBy: data.managedBy === "docker" || data.managedBy === "bun" ? data.managedBy : "npm",
          },
        });
      } catch (error) {
        if (signal.aborted || stale()) return;
        setApp({ state: "error", data: null });
        notify(translate("updates.checkFailed"), error instanceof Error ? error.message : String(error));
      }
    };

    const loadEngines = async () => {
      let payload: EnginesPayload | null = null;
      try {
        const response = await fetch("/api/engines", { cache: "no-store", signal });
        if (response.ok) payload = (await response.json()) as EnginesPayload;
      } catch {
        // Handled below: an unreachable roster fails the whole section.
      }
      if (stale()) return;
      if (!payload) {
        setRosterFailed(true);
        notify(translate("updates.engines.loadFailed"));
        return;
      }
      setRosterFailed(false);
      setRoster(payload);

      if (payload.canManage) {
        // Registry comparison for every installed engine (admin route).
        try {
          const response = await fetch(`/api/engines/updates${force ? "?force=1" : ""}`, { cache: "no-store", signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { updates: EngineUpdateStatus[] };
          if (stale()) return;
          const statuses = Object.fromEntries(body.updates.map((status) => [status.id, status]));
          setEngineStatuses(statuses);
          const omp = statuses.omp;
          if (omp && omp.updateAvailable !== null) reportOmpRef.current(omp.updateAvailable === true);
        } catch (error) {
          if (signal.aborted || stale()) return;
          notify(translate("updates.checkFailed"), error instanceof Error ? error.message : String(error));
        } finally {
          if (!stale()) setStatusesChecked(true);
        }
        return;
      }

      if (capabilities.updates) {
        // Members cannot query the registry route; the active omp runtime
        // still answers its own read-only check.
        try {
          const response = await fetch("/api/omp-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "check" }),
            signal,
          });
          const data = await response.json().catch(() => ({})) as Partial<OmpSelfStatus> & { error?: string };
          if (stale()) return;
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
          const status: OmpSelfStatus = {
            currentVersion: typeof data.currentVersion === "string" ? data.currentVersion : null,
            availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : null,
            updateAvailable: data.updateAvailable === true,
            updateCommand: typeof data.updateCommand === "string" && data.updateCommand ? data.updateCommand : "omp update",
          };
          setOmpSelf(status);
          reportOmpRef.current(status.updateAvailable);
        } catch (error) {
          if (signal.aborted || stale()) return;
          notify(translate("updates.checkFailed"), error instanceof Error ? error.message : String(error));
        } finally {
          if (!stale()) setStatusesChecked(true);
        }
        return;
      }

      setStatusesChecked(true);
    };

    const loadSkills = async () => {
      if (!capabilities.skills || !cwd) return;
      try {
        const response = await fetch("/api/skills/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
          signal,
        });
        const data = await response.json().catch(() => ({})) as { updates?: unknown; error?: string };
        if (stale()) return;
        if (!response.ok || !Array.isArray(data.updates)) {
          setSkills({ state: "error", updates: [] });
          notify(translate("updates.skills.checkFailed"), data.error);
          return;
        }
        setSkills({ state: "ready", updates: data.updates as SkillUpdateResult[] });
      } catch (error) {
        if (signal.aborted || stale()) return;
        setSkills({ state: "error", updates: [] });
        notify(translate("updates.skills.checkFailed"), error instanceof Error ? error.message : String(error));
      }
    };

    await Promise.all([loadApp(), loadEngines(), loadSkills()]);
    if (!stale()) setChecking(false);
  }, [cwd, capabilities.skills, capabilities.updates]);

  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;

  // First render, and any later workspace switch (the skills check is
  // workspace-scoped, so a new cwd invalidates the whole pass).
  useEffect(() => {
    void runCheck(false);
  }, [runCheck]);

  const onInstallSettled = useCallback((id: string, ok: boolean) => {
    const name = rosterRef.current?.engines.find((engine) => engine.id === id)?.name ?? id;
    if (ok) {
      toast.success(translate("updates.engines.updated", { name }));
    } else {
      // The row keeps the detailed npm failure inline; the toast is the alert.
      toast.error(translate("updates.engines.updateFailed", { name }));
    }
    // Re-checked after a failure too: an install that ran but left an unusable
    // binary still recorded the version it replaced, and offering that revert
    // target is what gets the row out of a dead end.
    // An omp install also invalidates the cached changelog (its "new" marks
    // compared against the version just replaced). Only omp's — another
    // engine's install must not collapse a changelog someone is reading.
    if (id === "omp") setChangelog(CLOSED_CHANGELOG);
    void runCheckRef.current(false);
  }, []);

  const {
    installing: installingIds,
    progress: installProgress,
    errors: installErrors,
    start: startInstall,
    watch: watchInstall,
  } = useEngineInstalls(onInstallSettled);

  // Reattach to installs already running server-side (page reload, the
  // Accounts card, another admin) so rows show live progress here too.
  useEffect(() => {
    for (const engine of roster?.engines ?? []) {
      if (engine.installing) watchInstall(engine.id);
    }
  }, [roster, watchInstall]);

  const updateEngine = useCallback((engine: EngineSummary, compatWarning?: string | null) => {
    const active = rosterRef.current?.active === engine.id;
    const message = translate("updates.engines.updateConfirm", { name: engine.name })
      + (compatWarning ? `\n\n${compatWarning}` : "");
    if (active && !window.confirm(message)) return;
    startInstall(engine.id);
  }, [startInstall]);

  // Repair, not upgrade: re-runs the installer at the adapter's own spec. The
  // one action that stays available when the version probe fails, because that
  // is precisely when no update can be computed.
  const reinstallEngine = useCallback((engine: EngineSummary) => {
    const active = rosterRef.current?.active === engine.id;
    if (active && !window.confirm(translate("updates.engines.reinstallConfirm", { name: engine.name }))) return;
    startInstall(engine.id);
  }, [startInstall]);

  const revertEngine = useCallback((engine: EngineSummary, version: string) => {
    const active = rosterRef.current?.active === engine.id;
    if (active && !window.confirm(translate("updates.engines.updateConfirm", { name: engine.name }))) return;
    startInstall(engine.id, { version });
  }, [startInstall]);

  // The active omp runtime updates through its dedicated route rather than
  // the generic install route: the server restarts live sessions, runs a
  // post-update health check, and reports both in one message.
  const updateOmpNow = useCallback(async (compatWarning?: string | null) => {
    if (ompUpdating) return;
    const message = translate("updates.omp.updateConfirm") + (compatWarning ? `\n\n${compatWarning}` : "");
    if (!window.confirm(message)) return;
    setOmpUpdating(true);
    try {
      const response = await fetch("/api/omp-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update" }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; version?: string; sessionsRestarted?: number; error?: string; detail?: string };
      if (!response.ok || data.success !== true) {
        const detail = data.detail ? ` (${data.detail})` : "";
        throw new Error(`${data.error ?? `HTTP ${response.status}`}${detail}`);
      }
      const count = typeof data.sessionsRestarted === "number" ? data.sessionsRestarted : 0;
      toast.success(translatePlural("updates.omp.updated", count, { count, version: data.version ?? "?" }));
      setChangelog(CLOSED_CHANGELOG);
      void runCheckRef.current(false);
    } catch (error) {
      toast.error(translate("updates.omp.updateFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setOmpUpdating(false);
    }
  }, [ompUpdating]);

  const restartSessions = useCallback(async () => {
    if (restarting) return;
    if (!window.confirm(translate("updates.omp.restartConfirm"))) return;
    setRestarting(true);
    try {
      const response = await fetch("/api/omp-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; sessionsRestarted?: number; error?: string };
      if (!response.ok || data.success !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
      const count = typeof data.sessionsRestarted === "number" ? data.sessionsRestarted : 0;
      toast.success(translatePlural("updates.omp.restarted", count, { count }));
    } catch (error) {
      toast.error(translate("updates.omp.restartFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setRestarting(false);
    }
  }, [restarting]);

  const toggleChangelog = useCallback(async (installedNow: string | null, latestNow: string | null) => {
    if (changelog.open) {
      setChangelog((current) => ({ ...current, open: false }));
      return;
    }
    const fresh = changelog.forVersions !== null
      && changelog.forVersions.installed === installedNow
      && changelog.forVersions.latest === latestNow;
    if (changelog.entries && fresh) {
      setChangelog((current) => ({ ...current, open: true }));
      return;
    }
    setChangelog((current) => ({ ...current, open: true, loading: true }));
    try {
      const response = await fetch("/api/engines/changelog?id=omp", { cache: "no-store" });
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
      setChangelog({ ...CLOSED_CHANGELOG, open: true, reason: String(error) });
    }
  }, [changelog.entries, changelog.forVersions, changelog.open]);

  const canManage = roster?.canManage === true;
  const installedEngines = (roster?.engines ?? []).filter((engine) => engine.installed);
  const skillUpdateCount = skills.updates.filter((update) => update.state === "update-available").length;

  return (
    <div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("updates.system.title")}</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{t("updates.system.description")}</p>
        </div>
        <button
          type="button"
          onClick={() => void runCheck(true)}
          disabled={checking}
          aria-label={t("updates.checkForUpdates")}
          style={actionButtonStyle(checking)}
        >
          {checking ? <Spinner /> : <RefreshCw size={13} aria-hidden="true" />}
          {t("updates.checkForUpdates")}
        </button>
      </div>

      {/* ── Cody application ─────────────────────────────────────────── */}
      <section style={cardStyle} aria-label={t("updates.cody.title")}>
        <div style={cardTitleStyle}>
          <Sparkles size={13} aria-hidden="true" />
          {t("updates.cody.title")}
        </div>
        {app.state === "loading" && <LoadingLine label={t("updates.checking")} />}
        {app.state === "error" && <div style={dimLineStyle}>{t("updates.checkUnavailable")}</div>}
        {app.state === "ready" && app.data && (
          app.data.updateAvailable && app.data.availableVersion ? (
            <>
              <VersionDelta current={app.data.currentVersion} next={app.data.availableVersion} />
              {/* Never fall back to an npm command in a container: it cannot
                  update an image-based deployment. */}
              <CommandCard command={app.data.updateCommand || (app.data.managedBy === "docker" ? "docker pull ghcr.io/nphil/cody:latest" : "npm install -g @nphil/cody")} />
            </>
          ) : (
            <>
              <div style={mutedLineStyle}>
                <span style={{ fontFamily: "var(--font-mono)" }}>v{app.data.currentVersion}</span>
                {" · "}
                {app.data.availableVersion
                  ? t("updates.upToDate")
                  : app.data.managedBy === "docker"
                    ? t("updates.cody.dockerManaged")
                    : t("updates.checkUnavailable")}
              </div>
              {app.data.managedBy === "docker" && <div style={dimLineStyle}>{t("updates.cody.dockerPullHint")}</div>}
            </>
          )
        )}
      </section>

      {/* ── Agent engines ────────────────────────────────────────────── */}
      <section style={{ ...cardStyle, padding: 0, gap: 0 }} aria-label={t("updates.engines.title")}>
        <div style={{ padding: "12px 14px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={cardTitleStyle}>
            <Cpu size={13} aria-hidden="true" />
            {t("updates.engines.title")}
          </div>
          <div style={dimLineStyle}>{t("updates.engines.description")}</div>
        </div>

        {!roster && !rosterFailed && (
          <div style={{ padding: "0 14px 12px" }}>
            <LoadingLine label={t("updates.checking")} />
          </div>
        )}
        {!roster && rosterFailed && (
          <div style={{ padding: "0 14px 12px", ...dimLineStyle }}>{t("updates.engines.loadFailed")}</div>
        )}
        {roster && installedEngines.length === 0 && (
          <div style={{ padding: "0 14px 12px", ...dimLineStyle }}>{t("updates.engines.none")}</div>
        )}

        {installedEngines.map((engine) => {
          const isActive = engine.id === roster?.active;
          const status = engineStatuses[engine.id];
          const self = engine.id === "omp" && !canManage && capabilities.updates ? ompSelf : null;
          const installedVersion = status?.installedVersion ?? engine.version;
          const updateAvailable = canManage ? status?.updateAvailable ?? null : self ? self.updateAvailable : null;
          const latestVersion = canManage ? status?.latestVersion ?? null : self?.availableVersion ?? null;
          // Why the version is unknown. Only the registry route reports it, and
          // only for a row whose probe actually failed.
          const probeError = canManage ? status?.probeError ?? null : null;
          // A status is expected for this row (a check can answer it): admins
          // for every engine, members only for the active omp runtime.
          const statusExpected = canManage || self !== null || (engine.id === "omp" && !canManage && capabilities.updates);
          // The active omp runtime goes through /api/omp-update (session
          // restart + health check); everything else re-runs the installer.
          const selfUpdate = engine.id === "omp" && isActive && capabilities.updates && canManage;
          const npmBusy = installingIds.has(engine.id);
          const busy = npmBusy || (selfUpdate && ompUpdating);
          const installError = installErrors[engine.id];
          // The engine has moved (or would move) past the newest major this
          // Cody build was verified against: warn before the jump, mark after
          // it. Core surfaces keep working — the point is that brand-new
          // engine features may not show up in Cody until Cody updates.
          const compatWarning = canManage && status?.latestBeyondVerified && updateAvailable === true && latestVersion
            ? t("updates.engines.aheadNote", { name: engine.name, version: latestVersion })
            : null;
          const installedAhead = canManage && status?.installedBeyondVerified === true;
          return (
            <div key={engine.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{engine.name}</span>
                {isActive && <span style={{ ...chipStyle, color: "var(--accent)" }}>{t("updates.engines.active")}</span>}
                <span style={{ ...chipStyle, fontFamily: "var(--font-mono)" }}>
                  {installedVersion ? `v${installedVersion}` : t("updates.versionUnavailable")}
                </span>
                {installedAhead && (
                  <span
                    style={{ ...chipStyle, color: "var(--status-warning)" }}
                    title={t("updates.engines.aheadInstalledTitle")}
                    aria-label={t("updates.engines.aheadInstalledTitle")}
                  >
                    <TriangleAlert size={10} aria-hidden="true" style={{ flexShrink: 0, marginRight: 3, verticalAlign: "-1px" }} />
                    {t("updates.engines.aheadChip")}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {checking && !busy && <LoadingLine label={t("updates.checking")} />}
                {!checking && !busy && updateAvailable === false && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, ...dimLineStyle }}>
                    <Check size={11} aria-hidden="true" style={{ flexShrink: 0 }} />
                    {t("updates.upToDate")}
                  </span>
                )}
                {!checking && !busy && updateAvailable === null && statusExpected && statusesChecked && (
                  <span style={dimLineStyle}>{t("updates.checkUnavailable")}</span>
                )}
                {!checking && !busy && updateAvailable === true && latestVersion && (
                  <VersionDelta current={installedVersion} next={latestVersion} />
                )}
              </div>

              {npmBusy && (
                <span role="status" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span aria-hidden style={{ display: "block", height: 3, borderRadius: 2, overflow: "hidden", background: "var(--bg-subtle)" }}>
                    <span style={{ display: "block", height: "100%", width: "40%", borderRadius: 2, background: "var(--accent)", animation: "engine-progress-slide 1.2s ease-in-out infinite" }} />
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {installProgress[engine.id] || t("updates.omp.updating")}
                  </span>
                </span>
              )}

              {!npmBusy && !checking && !installedVersion && probeError && (
                // The chip alone just says "Version unavailable". This says what
                // that means and what to do, ahead of the raw tool output.
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={mutedLineStyle}>{t("updates.engines.probeFailed")}</div>
                  <div style={{ ...dimLineStyle, fontFamily: "var(--font-mono)" }} title={probeError}>
                    {probeError.length > PROBE_ERROR_MAX_CHARS ? `${probeError.slice(0, PROBE_ERROR_MAX_CHARS)}…` : probeError}
                  </div>
                </div>
              )}

              {!npmBusy && canManage && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {updateAvailable === true && latestVersion && (
                    <button
                      type="button"
                      onClick={() => (selfUpdate ? void updateOmpNow(compatWarning) : updateEngine(engine, compatWarning))}
                      disabled={busy}
                      style={actionButtonStyle(busy)}
                    >
                      {busy ? <Spinner /> : <Download size={13} aria-hidden="true" />}
                      {busy ? t("updates.omp.updating") : t("updates.engines.updateTo", { version: latestVersion })}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => reinstallEngine(engine)}
                    disabled={busy}
                    title={t("updates.engines.reinstallTitle")}
                    style={actionButtonStyle(busy)}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {t("updates.engines.reinstall")}
                  </button>
                  {status?.previousVersion && (
                    // The escape hatch after an update breaks the engine:
                    // reinstall exactly the version the update replaced. Shown
                    // whenever history has one, not just when an update exists.
                    <button
                      type="button"
                      onClick={() => revertEngine(engine, status.previousVersion as string)}
                      disabled={busy}
                      title={t("updates.engines.revertTitle")}
                      style={actionButtonStyle(busy)}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      {t("updates.engines.revertTo", { version: status.previousVersion })}
                    </button>
                  )}
                </div>
              )}

              {/* Before the jump the note names the offered version; after it
                  (installed ahead, nothing newer offered) the chip's full
                  explanation renders inline — a tooltip alone is unreachable
                  for keyboard and touch. */}
              {!npmBusy && (compatWarning || installedAhead) && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.5, color: "var(--status-warning)", overflowWrap: "anywhere" }}>
                  <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ minWidth: 0 }}>{compatWarning ?? t("updates.engines.aheadInstalledTitle")}</span>
                </div>
              )}

              {!npmBusy && updateAvailable === true && !canManage && self && (
                <CommandCard command={self.updateCommand} />
              )}

              {installError && (
                <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.5, color: "var(--status-error)", overflowWrap: "anywhere" }}>
                  <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ minWidth: 0 }}>{installError}</span>
                </div>
              )}

              {engine.id === "omp" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div>
                    <button
                      type="button"
                      onClick={() => void toggleChangelog(installedVersion ?? null, latestVersion)}
                      aria-expanded={changelog.open}
                      style={actionButtonStyle(changelog.loading)}
                    >
                      {changelog.loading ? <Spinner /> : <ScrollText size={13} aria-hidden="true" />}
                      {changelog.open ? t("updates.omp.changelogHide") : t("updates.omp.changelog")}
                    </button>
                  </div>
                  {changelog.open && changelog.entries && changelog.source === "installed" && changelog.updatePending && (
                    // The payload itself admits an update was pending and the
                    // published notes could not be fetched, so these entries
                    // stop at the installed version — say so instead of
                    // letting old notes read as the update's. Keyed off the
                    // payload, never the row's separately-refreshed state.
                    <div style={{ ...dimLineStyle, color: "var(--status-warning)" }}>{t("updates.omp.changelogStale")}</div>
                  )}
                  {changelog.open && changelog.entries && changelog.entries.map((entry) => (
                    <div key={entry.heading} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", padding: "8px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{entry.heading}</span>
                        {entry.isNew && <span style={{ ...chipStyle, color: "var(--accent)" }}>{t("updates.omp.changelogNew")}</span>}
                      </div>
                      <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.55, color: "var(--text-muted)", fontFamily: "inherit" }}>{entry.body}</pre>
                    </div>
                  ))}
                  {changelog.open && !changelog.entries && !changelog.loading && (
                    <div style={dimLineStyle}>{changelog.reason ?? t("updates.omp.changelogUnavailable")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {roster && !canManage && installedEngines.length > 0 && (
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", ...dimLineStyle }}>
            {t("updates.engines.adminNote")}
          </div>
        )}
        {canManage && capabilities.updates && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
            <span style={{ ...dimLineStyle, flex: "1 1 220px" }}>{t("updates.omp.restartHint")}</span>
            <button
              type="button"
              onClick={() => void restartSessions()}
              disabled={restarting}
              style={actionButtonStyle(restarting)}
            >
              {restarting ? <Spinner /> : <RotateCcw size={13} aria-hidden="true" />}
              {restarting ? t("updates.omp.restarting") : t("updates.omp.restart")}
            </button>
          </div>
        )}
      </section>

      {/* ── Skills ───────────────────────────────────────────────────── */}
      {capabilities.skills && (
        <section style={cardStyle} aria-label={t("updates.skills.title")}>
          <div style={cardTitleStyle}>
            <Settings2 size={13} aria-hidden="true" />
            {t("updates.skills.title")}
          </div>
          {skills.state === "no-workspace" && <div style={dimLineStyle}>{t("updates.skills.noWorkspace")}</div>}
          {skills.state === "loading" && <LoadingLine label={t("updates.skills.checking")} />}
          {skills.state === "error" && <div style={dimLineStyle}>{t("updates.checkUnavailable")}</div>}
          {skills.state === "ready" && (
            skills.updates.length === 0 ? (
              <div style={mutedLineStyle}>{t("updates.skills.none")}</div>
            ) : skillUpdateCount > 0 ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                  {tn("updates.skills.available", skillUpdateCount, { count: skillUpdateCount })}
                </div>
                <div>
                  <button type="button" onClick={onOpenSkills} style={actionButtonStyle(false)}>
                    <Settings2 size={13} aria-hidden="true" />
                    {t("updates.skills.openSettings")}
                  </button>
                </div>
              </>
            ) : (
              <div style={mutedLineStyle}>{t("updates.skills.upToDate")}</div>
            )
          )}
          {cwd && (
            <div>
              <button
                type="button"
                onClick={() => {
                  setStoreOpen(true);
                  void refreshInstalled(cwd);
                }}
                style={actionButtonStyle(false)}
              >
                <Store size={13} aria-hidden="true" />
                {t("skillsConfig.store.open")}
              </button>
            </div>
          )}
        </section>
      )}
      {storeOpen && cwd && (
        <SkillsStore
          cwd={cwd}
          installedPackages={installedPackages}
          onInstalled={() => void refreshInstalled(cwd)}
          onClose={() => setStoreOpen(false)}
        />
      )}

      {/* ── Plugins ──────────────────────────────────────────────────── */}
      {capabilities.plugins && cwd && (
        <section style={cardStyle} aria-label={t("pluginMarket.title")}>
          <div style={cardTitleStyle}>
            <PlugZap size={13} aria-hidden="true" />
            {t("pluginMarket.title")}
          </div>
          <div>
            <button type="button" onClick={() => setMarketplaceOpen(true)} style={actionButtonStyle(false)}>
              <Store size={13} aria-hidden="true" />
              {t("pluginMarket.openButton")}
            </button>
          </div>
        </section>
      )}
      {marketplaceOpen && cwd && (
        <PluginMarketplace cwd={cwd} onClose={() => setMarketplaceOpen(false)} />
      )}
    </div>
  );
}
