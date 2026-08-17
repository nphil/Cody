"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Download, Loader2, RotateCw, ScrollText, Settings2, Sparkles, TriangleAlert } from "lucide-react";
import type { SkillUpdateResult } from "@/lib/api-types";
import { translate, translatePlural, useI18n } from "@/lib/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";

export interface UpdatesPanelProps {
  cwd: string | null;
  active: boolean;
  /** Active engine exposes self-update checks (omp). False hides the runtime
   * card entirely — the Cody app card is engine-independent and always shows. */
  engineUpdates?: boolean;
  onOpenSettings: (tab: "system" | "skills") => void;
  /** Number of sources reporting an update (0-3), for the tab badge. */
  onAvailableCountChange?: (n: number) => void;
}

interface AppUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

interface OmpUpdateStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

type CardStatus = "idle" | "loading" | "ready" | "error";

interface AppCard {
  status: CardStatus;
  data: AppUpdateStatus | null;
  error: string | null;
}

interface OmpCard {
  status: CardStatus;
  /** `omp --version` output, independent of the update check. */
  installed: string | null;
  data: OmpUpdateStatus | null;
  error: string | null;
}

interface SkillsCard {
  status: CardStatus | "no-workspace";
  updates: SkillUpdateResult[];
  error: string | null;
}

type Note = { kind: "success" | "error"; text: string };

const IDLE_APP: AppCard = { status: "idle", data: null, error: null };
const IDLE_OMP: OmpCard = { status: "idle", installed: null, data: null, error: null };
const IDLE_SKILLS: SkillsCard = { status: "idle", updates: [], error: null };

function toolbarButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    height: 22,
    padding: "0 7px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    opacity: disabled ? 0.6 : 1,
    transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
  };
}

function cardButtonStyle(disabled: boolean, accent = false): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    height: 24,
    padding: "0 9px",
    border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    background: accent ? "transparent" : "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : accent ? "var(--accent)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    opacity: disabled ? 0.6 : 1,
    transition: "background var(--dur-fast) var(--ease-out-warm)",
  };
}

function hoverIn(event: React.MouseEvent<HTMLButtonElement>) {
  if (event.currentTarget.disabled) return;
  event.currentTarget.style.background = "var(--bg-selected)";
}

function hoverOut(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = "var(--bg-panel)";
}

function accentHoverIn(event: React.MouseEvent<HTMLButtonElement>) {
  if (event.currentTarget.disabled) return;
  event.currentTarget.style.background = "color-mix(in srgb, var(--accent) 12%, transparent)";
}

function accentHoverOut(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = "transparent";
}

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  flexShrink: 0,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
};

const cardTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
};

const mutedLineStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: "var(--text-muted)",
  overflowWrap: "anywhere",
};

const dimLineStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.45,
  color: "var(--text-dim)",
  overflowWrap: "anywhere",
};

const codeChipStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "3px 6px",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  whiteSpace: "nowrap",
  overflowX: "auto",
};

function CardError({ message }: { message: string }): React.ReactElement {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        fontSize: 11,
        lineHeight: 1.45,
        color: "var(--status-error)",
        overflowWrap: "anywhere",
      }}
    >
      <TriangleAlert size={12} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>{message}</span>
    </div>
  );
}

function LoadingLine({ label }: { label: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, ...dimLineStyle }}>
      <Loader2 size={11} strokeWidth={2.2} style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Read-only dashboard over the app / omp / skills update checks. Deep
 * management (installing, per-skill updates) stays in the Settings dialog —
 * every card links there instead of duplicating it. */
export function UpdatesPanel({ cwd, active, engineUpdates = true, onOpenSettings, onAvailableCountChange }: UpdatesPanelProps): React.ReactElement | null {
  const { t, tn } = useI18n();
  const [app, setApp] = useState<AppCard>(IDLE_APP);
  const [omp, setOmp] = useState<OmpCard>(IDLE_OMP);
  const [skills, setSkills] = useState<SkillsCard>(IDLE_SKILLS);
  const [restarting, setRestarting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [restartNote, setRestartNote] = useState<Note | null>(null);
  const [started, setStarted] = useState(false);
  const [changelog, setChangelog] = useState<{
    open: boolean;
    loading: boolean;
    entries: Array<{ heading: string; body: string }> | null;
    reason: string | null;
  }>({ open: false, loading: false, entries: null, reason: null });

  const toggleChangelog = useCallback(async () => {
    if (changelog.open) {
      setChangelog((current) => ({ ...current, open: false }));
      return;
    }
    if (changelog.entries) {
      setChangelog((current) => ({ ...current, open: true }));
      return;
    }
    setChangelog((current) => ({ ...current, open: true, loading: true }));
    try {
      const response = await fetch("/api/engines/changelog?id=omp", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { entries?: Array<{ heading: string; body: string }> | null; reason?: string }
        | null;
      setChangelog({
        open: true,
        loading: false,
        entries: Array.isArray(data?.entries) ? data.entries : null,
        reason: data?.reason ?? null,
      });
    } catch (error) {
      setChangelog({ open: true, loading: false, entries: null, reason: String(error) });
    }
  }, [changelog.entries, changelog.open]);

  const appCopy = useCopyFeedback();
  const ompCopy = useCopyFeedback();

  // A monotonic request id plus an AbortController keeps a slow response for a
  // previous refresh (or a previous workspace) from landing on top of newer state.
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Held in a ref so a parent that re-creates the callback every render cannot
  // restart the fetch effect.
  const reportRef = useRef(onAvailableCountChange);
  reportRef.current = onAvailableCountChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Lazy: nothing is fetched until the panel has been shown at least once.
  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  const loadAll = useCallback(async () => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const stale = () => requestId !== requestRef.current || !mountedRef.current;

    setApp({ status: "loading", data: null, error: null });
    setOmp(engineUpdates ? { status: "loading", installed: null, data: null, error: null } : IDLE_OMP);
    setRestartNote(null);
    if (!cwd) setSkills({ status: "no-workspace", updates: [], error: null });
    else setSkills({ status: "loading", updates: [], error: null });

    const loadApp = async (): Promise<boolean> => {
      try {
        const response = await fetch("/api/app-update", { signal });
        const data = await response.json().catch(() => ({})) as Partial<AppUpdateStatus> & { error?: string };
        if (stale()) return false;
        if (!response.ok || typeof data.currentVersion !== "string") {
          setApp({ status: "error", data: null, error: data.error ?? translate("updates.checkFailed") });
          return false;
        }
        const status: AppUpdateStatus = {
          currentVersion: data.currentVersion,
          availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : null,
          updateAvailable: data.updateAvailable === true,
          updateCommand: typeof data.updateCommand === "string" ? data.updateCommand : "",
        };
        setApp({ status: "ready", data: status, error: null });
        return status.updateAvailable;
      } catch (error) {
        if (signal.aborted || stale()) return false;
        setApp({ status: "error", data: null, error: error instanceof Error ? error.message : translate("updates.checkFailed") });
        return false;
      }
    };

    const loadOmp = async (): Promise<boolean> => {
      // The runtime card is hidden on engines without self-update support, so
      // its probes are skipped rather than fired and discarded.
      if (!engineUpdates) return false;
      let installed: string | null = null;
      try {
        const response = await fetch("/api/omp-version", { signal });
        const data = await response.json().catch(() => ({})) as { version?: unknown };
        if (response.ok && typeof data.version === "string") installed = data.version;
      } catch {
        // The version probe is best-effort: the update check below still runs
        // and owns the card's error state.
      }
      if (stale()) return false;

      try {
        const response = await fetch("/api/omp-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check" }),
          signal,
        });
        const data = await response.json().catch(() => ({})) as Partial<OmpUpdateStatus> & { error?: string };
        if (stale()) return false;
        if (!response.ok) {
          setOmp({ status: "error", installed, data: null, error: data.error ?? translate("updates.checkFailed") });
          return false;
        }
        const status: OmpUpdateStatus = {
          currentVersion: typeof data.currentVersion === "string" ? data.currentVersion : null,
          availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : null,
          updateAvailable: data.updateAvailable === true,
          updateCommand: typeof data.updateCommand === "string" && data.updateCommand ? data.updateCommand : "omp update",
        };
        setOmp({ status: "ready", installed, data: status, error: null });
        return status.updateAvailable;
      } catch (error) {
        if (signal.aborted || stale()) return false;
        setOmp({ status: "error", installed, data: null, error: error instanceof Error ? error.message : translate("updates.checkFailed") });
        return false;
      }
    };

    const loadSkills = async (): Promise<boolean> => {
      if (!cwd) return false;
      try {
        const response = await fetch("/api/skills/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
          signal,
        });
        const data = await response.json().catch(() => ({})) as { updates?: unknown; error?: string };
        if (stale()) return false;
        if (!response.ok || !Array.isArray(data.updates)) {
          setSkills({ status: "error", updates: [], error: data.error ?? translate("updates.skills.checkFailed") });
          return false;
        }
        const updates = data.updates as SkillUpdateResult[];
        setSkills({ status: "ready", updates, error: null });
        return updates.some((update) => update.state === "update-available");
      } catch (error) {
        if (signal.aborted || stale()) return false;
        setSkills({ status: "error", updates: [], error: error instanceof Error ? error.message : translate("updates.skills.checkFailed") });
        return false;
      }
    };

    const results = await Promise.all([loadApp(), loadOmp(), loadSkills()]);
    if (stale()) return;
    reportRef.current?.(results.filter(Boolean).length);
  }, [cwd, engineUpdates]);

  // First activation, and any later workspace switch (the skills check is
  // workspace-scoped, so a new cwd invalidates the whole pass).
  useEffect(() => {
    if (!started) return;
    void loadAll();
  }, [started, loadAll]);

  const restartSessions = useCallback(async () => {
    if (restarting) return;
    if (!window.confirm(translate("updates.omp.restartConfirm"))) return;
    setRestarting(true);
    setRestartNote(null);
    try {
      const response = await fetch("/api/omp-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; sessionsRestarted?: number; error?: string };
      if (!mountedRef.current) return;
      if (!response.ok || data.success !== true) {
        setRestartNote({ kind: "error", text: data.error ?? translate("updates.omp.restartFailed") });
        return;
      }
      const count = typeof data.sessionsRestarted === "number" ? data.sessionsRestarted : 0;
      setRestartNote({ kind: "success", text: translatePlural("updates.omp.restarted", count, { count }) });
    } catch (error) {
      if (!mountedRef.current) return;
      setRestartNote({ kind: "error", text: error instanceof Error ? error.message : translate("updates.omp.restartFailed") });
    } finally {
      if (mountedRef.current) setRestarting(false);
    }
  }, [restarting]);

  const updateNow = useCallback(async () => {
    if (updating || restarting) return;
    if (!window.confirm(translate("updates.omp.updateConfirm"))) return;
    setUpdating(true);
    setRestartNote(null);
    try {
      const response = await fetch("/api/omp-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update" }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; version?: string; sessionsRestarted?: number; error?: string; detail?: string };
      if (!mountedRef.current) return;
      if (!response.ok || data.success !== true) {
        const detail = data.detail ? ` (${data.detail})` : "";
        setRestartNote({ kind: "error", text: `${data.error ?? translate("updates.omp.updateFailed")}${detail}` });
        return;
      }
      const count = typeof data.sessionsRestarted === "number" ? data.sessionsRestarted : 0;
      const version = data.version ?? translate("updates.unknown");
      // Refresh the card (and its siblings) so the new "up to date" state
      // lands before the success note — loadAll clears restartNote itself,
      // so the note is set only after it resolves.
      await loadAll();
      if (!mountedRef.current) return;
      setRestartNote({ kind: "success", text: translatePlural("updates.omp.updated", count, { count, version }) });
    } catch (error) {
      if (!mountedRef.current) return;
      setRestartNote({ kind: "error", text: error instanceof Error ? error.message : translate("updates.omp.updateFailed") });
    } finally {
      if (mountedRef.current) setUpdating(false);
    }
  }, [updating, restarting, loadAll]);

  if (!active) return null;

  const loading = app.status === "loading" || omp.status === "loading" || skills.status === "loading";
  const skillUpdateCount = skills.updates.filter((update) => update.state === "update-available").length;
  const ompInstalledLabel = omp.installed ?? omp.data?.currentVersion ?? null;

  return (
    <section
      aria-label={t("updates.title")}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("updates.title")}
        </span>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => void loadAll()}
          disabled={loading}
          title={t("updates.refresh")}
          aria-label={t("updates.refresh")}
          style={toolbarButtonStyle(loading)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          <RotateCw size={11} strokeWidth={2.2} aria-hidden="true" />
          {t("updates.refresh")}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
        {/* ── Cody application ─────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>
            <Sparkles size={13} strokeWidth={2.2} aria-hidden="true" />
            {t("updates.cody.title")}
          </div>
          {(app.status === "loading" || app.status === "idle") && <LoadingLine label={t("updates.checking")} />}
          {app.status === "error" && <CardError message={app.error ?? t("updates.checkFailed")} />}
          {app.status === "ready" && app.data && (
            <>
              {app.data.updateAvailable && app.data.availableVersion ? (
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "var(--accent)", overflowWrap: "anywhere" }}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>v{app.data.currentVersion}</span>
                  <ArrowRight size={11} strokeWidth={2.2} aria-hidden="true" />
                  <span style={{ fontFamily: "var(--font-mono)" }}>v{app.data.availableVersion}</span>
                </div>
              ) : (
                <div style={mutedLineStyle}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>v{app.data.currentVersion}</span>
                  {` · ${app.data.availableVersion ? t("updates.upToDate") : t("updates.checkUnavailable")}`}
                </div>
              )}
              {app.data.updateAvailable && app.data.updateCommand && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <code style={codeChipStyle}>{app.data.updateCommand}</code>
                  <button
                    type="button"
                    className="ui-focus-ring"
                    onClick={() => appCopy.copy(app.data?.updateCommand ?? "")}
                    title={t("updates.copyCommand")}
                    aria-label={t("updates.copyCommand")}
                    style={cardButtonStyle(false)}
                    onMouseEnter={hoverIn}
                    onMouseLeave={hoverOut}
                  >
                    {appCopy.copied
                      ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
                      : <Copy size={11} strokeWidth={2.2} aria-hidden="true" />}
                    {appCopy.copied ? t("updates.copied") : t("updates.copy")}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── OMP runtime ──────────────────────────────────────────────── */}
        {engineUpdates && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>
              <RotateCw size={13} strokeWidth={2.2} aria-hidden="true" />
              {t("updates.omp.title")}
            </div>
            <div style={mutedLineStyle}>
              {ompInstalledLabel
                ? <>{`${t("updates.omp.installed")} `}<span style={{ fontFamily: "var(--font-mono)" }}>{ompInstalledLabel}</span></>
                : omp.status === "loading" || omp.status === "idle" ? t("updates.omp.installedUnknown") : t("updates.omp.notInstalled")}
            </div>
            {(omp.status === "loading" || omp.status === "idle") && <LoadingLine label={t("updates.checking")} />}
            {omp.status === "error" && <CardError message={omp.error ?? t("updates.checkFailed")} />}
            {omp.status === "ready" && omp.data && (
              <>
                {omp.data.updateAvailable ? (
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", overflowWrap: "anywhere" }}>
                    {t("updates.omp.updateAvailable", { version: omp.data.availableVersion ?? t("updates.unknown") })}
                  </div>
                ) : (
                  <div style={mutedLineStyle}>{t("updates.upToDate")}</div>
                )}
                {omp.data.updateAvailable && (
                  <>
                    <div>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        onClick={() => void updateNow()}
                        disabled={updating || restarting}
                        title={t("updates.omp.update")}
                        aria-label={t("updates.omp.update")}
                        style={cardButtonStyle(updating || restarting, true)}
                        onMouseEnter={accentHoverIn}
                        onMouseLeave={accentHoverOut}
                      >
                        {updating
                          ? <Loader2 size={11} strokeWidth={2.2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                          : <Download size={11} strokeWidth={2.2} aria-hidden="true" />}
                        {updating ? t("updates.omp.updating") : t("updates.omp.update")}
                      </button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <code style={codeChipStyle}>{omp.data.updateCommand}</code>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        onClick={() => ompCopy.copy(omp.data?.updateCommand ?? "omp update")}
                        title={t("updates.copyCommand")}
                        aria-label={t("updates.copyCommand")}
                        style={cardButtonStyle(false)}
                        onMouseEnter={hoverIn}
                        onMouseLeave={hoverOut}
                      >
                        {ompCopy.copied
                          ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
                          : <Copy size={11} strokeWidth={2.2} aria-hidden="true" />}
                        {ompCopy.copied ? t("updates.copied") : t("updates.copy")}
                      </button>
                    </div>
                    <div style={dimLineStyle}>{t("updates.omp.restartHint")}</div>
                    <div>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        onClick={() => void restartSessions()}
                        disabled={restarting || updating}
                        title={t("updates.omp.restart")}
                        aria-label={t("updates.omp.restart")}
                        style={cardButtonStyle(restarting || updating, true)}
                        onMouseEnter={accentHoverIn}
                        onMouseLeave={accentHoverOut}
                      >
                        {restarting
                          ? <Loader2 size={11} strokeWidth={2.2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                          : <RotateCw size={11} strokeWidth={2.2} aria-hidden="true" />}
                        {restarting ? t("updates.omp.restarting") : t("updates.omp.restart")}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {ompInstalledLabel && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button
                  type="button"
                  className="ui-focus-ring"
                  onClick={() => void toggleChangelog()}
                  style={cardButtonStyle(changelog.loading)}
                  onMouseEnter={hoverIn}
                  onMouseLeave={hoverOut}
                  aria-expanded={changelog.open}
                >
                  {changelog.loading
                    ? <Loader2 size={11} strokeWidth={2.2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                    : <ScrollText size={11} strokeWidth={2.2} aria-hidden="true" />}
                  {changelog.open ? t("updates.omp.changelogHide") : t("updates.omp.changelog")}
                </button>
                {changelog.open && changelog.entries && changelog.entries.map((entry) => (
                  <div key={entry.heading} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{entry.heading}</div>
                    <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.55, color: "var(--text-muted)", fontFamily: "inherit" }}>{entry.body}</pre>
                  </div>
                ))}
                {changelog.open && !changelog.entries && !changelog.loading && (
                  <div style={dimLineStyle}>{changelog.reason ?? t("updates.omp.changelogUnavailable")}</div>
                )}
              </div>
            )}
            {restartNote && (
              restartNote.kind === "error"
                ? <CardError message={restartNote.text} />
                : (
                  <div role="status" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--status-success)", overflowWrap: "anywhere" }}>
                    <Check size={12} strokeWidth={2.4} style={{ flexShrink: 0 }} aria-hidden="true" />
                    {restartNote.text}
                  </div>
                )
            )}
          </div>
        )}

        {/* ── Skills ───────────────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>
            <Settings2 size={13} strokeWidth={2.2} aria-hidden="true" />
            {t("updates.skills.title")}
          </div>
          {skills.status === "no-workspace" && <div style={dimLineStyle}>{t("updates.skills.noWorkspace")}</div>}
          {(skills.status === "loading" || skills.status === "idle") && <LoadingLine label={t("updates.skills.checking")} />}
          {skills.status === "error" && <CardError message={skills.error ?? t("updates.skills.checkFailed")} />}
          {skills.status === "ready" && (
            skills.updates.length === 0 ? (
              <div style={mutedLineStyle}>{t("updates.skills.none")}</div>
            ) : skillUpdateCount > 0 ? (
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                {tn("updates.skills.available", skillUpdateCount, { count: skillUpdateCount })}
              </div>
            ) : (
              <div style={mutedLineStyle}>{t("updates.skills.upToDate")}</div>
            )
          )}
          <div>
            <button
              type="button"
              className="ui-focus-ring"
              onClick={() => onOpenSettings("skills")}
              title={t("updates.skills.openSettings")}
              aria-label={t("updates.skills.openSettings")}
              style={cardButtonStyle(false)}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              <Settings2 size={11} strokeWidth={2.2} aria-hidden="true" />
              {t("updates.skills.openSettings")}
            </button>
          </div>
        </div>

        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          <button
            type="button"
            className="ui-focus-ring"
            onClick={() => onOpenSettings("system")}
            title={t("updates.openSystemSettings")}
            aria-label={t("updates.openSystemSettings")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 0,
              border: "none",
              background: "transparent",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {t("updates.openSystemSettings")}
          </button>
        </div>
      </div>
    </section>
  );
}
