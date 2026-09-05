"use client";

import { RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { fetchSettingsRoute, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import type { EngineUpdateStatus } from "@/lib/harness/updates";
import { translate, useI18n } from "@/lib/i18n";
import type { EngineCapabilities } from "../SettingsTabs";
import { actionButtonStyle, cardStyle, cardTitleStyle, CommandCard, dimLineStyle, ENGINE_UPDATES_ROUTE, ENGINES_ROUTE, EngineRoster, LoadingLine, mutedLineStyle, Spinner, VersionDelta, type EnginesPayload } from "./EngineRoster";
import { SettingsHighlightContext } from "./primitives";

/**
 * Settings › System: the Cody card (this instance's version and how it
 * updates) above `EngineRoster`, the home of every engine action. One
 * "Check for updates" button refreshes the app row and every engine row; an
 * update action (button for admins, copyable command otherwise) renders only
 * when a newer version is actually known.
 *
 * Sources: GET /api/app-update (Cody), GET /api/engines + GET
 * /api/engines/updates (admin-only registry comparison; members fall back to
 * omp's own POST /api/omp-update check when the active engine supports it),
 * all read through the settings route cache so the rail's status line and
 * this panel share one body. Skills moved to Extensions › Skills.
 */

export const APP_UPDATE_ROUTE = "/api/app-update";

interface AppUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  /** Which channel ships to this deployment; a container is updated by
   * pulling its image, so it must never be handed an npm command. */
  managedBy: "docker" | "npm" | "bun";
}

function normalizeApp(data: Partial<AppUpdateStatus> | null): AppUpdateStatus | null {
  if (!data || typeof data.currentVersion !== "string") return null;
  return {
    currentVersion: data.currentVersion,
    availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : null,
    updateAvailable: data.updateAvailable === true,
    updateCommand: typeof data.updateCommand === "string" ? data.updateCommand : "",
    managedBy: data.managedBy === "docker" || data.managedBy === "bun" ? data.managedBy : "npm",
  };
}

export function SystemUpdates({ capabilities, onOmpUpdateAvailabilityChange }: {
  /** Active engine capabilities: `updates` enables omp's self-check fallback
   * and the session-restart control. */
  capabilities: EngineCapabilities;
  onOmpUpdateAvailabilityChange: (available: boolean) => void;
}): React.ReactElement {
  const { t } = useI18n();
  const app = useSettingsRoute<Partial<AppUpdateStatus>>(APP_UPDATE_ROUTE);
  const roster = useSettingsRoute<EnginesPayload>(ENGINES_ROUTE);
  const canManage = roster.data?.canManage === true;
  const updates = useSettingsRoute<{ updates: EngineUpdateStatus[] }>(ENGINE_UPDATES_ROUTE, { enabled: canManage });
  const [forcing, setForcing] = useState(false);
  const [checkSeq, setCheckSeq] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const highlightId = useContext(SettingsHighlightContext);
  const codyCardRef = useRef<HTMLElement | null>(null);
  const codyHighlighted = highlightId === "cody-application";
  useEffect(() => {
    if (codyHighlighted) codyCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [codyHighlighted]);

  // A check the user asked for bypasses every server-side cache (`?force=1`)
  // and surfaces its failures as toasts; the automatic passes the cache runs
  // on mount fail quietly into per-row states.
  const runCheck = useCallback(async () => {
    if (forcing) return;
    setForcing(true);
    const failures: string[] = [];
    const forcedApp = (async () => {
      try {
        const response = await fetch(`${APP_UPDATE_ROUTE}?force=1`, { cache: "no-store" });
        const data = (await response.json().catch(() => ({}))) as Partial<AppUpdateStatus> & { error?: string };
        if (!response.ok || typeof data.currentVersion !== "string") throw new Error(data.error ?? `HTTP ${response.status}`);
        setSettingsRouteData(APP_UPDATE_ROUTE, data);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    })();
    const forcedRoster = fetchSettingsRoute<EnginesPayload>(ENGINES_ROUTE, { force: true }).then((entry) => {
      if (entry.error) failures.push(translate("updates.engines.loadFailed"));
      return entry.data;
    });
    const forcedStatuses = forcedRoster.then(async (payload) => {
      if (payload?.canManage !== true) return;
      try {
        const response = await fetch(`${ENGINE_UPDATES_ROUTE}?force=1`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setSettingsRouteData(ENGINE_UPDATES_ROUTE, (await response.json()) as { updates: EngineUpdateStatus[] });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    });
    await Promise.all([forcedApp, forcedStatuses]);
    if (!mountedRef.current) return;
    // The member self-check inside the roster re-runs on this bump.
    setCheckSeq((seq) => seq + 1);
    setForcing(false);
    if (failures.length > 0) toast.error(translate("updates.checkFailed"), failures[0]);
  }, [forcing]);

  const appStatus = normalizeApp(app.data);
  const appLoading = app.loading && !appStatus;
  const checking = forcing || appLoading || roster.loading || updates.loading;

  return (
    <div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("updates.system.title")}</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{t("updates.system.description")}</p>
        </div>
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={checking}
          aria-label={t("updates.checkForUpdates")}
          style={actionButtonStyle(checking)}
        >
          {checking ? <Spinner /> : <RefreshCw size={13} aria-hidden="true" />}
          {t("updates.checkForUpdates")}
        </button>
      </div>

      {/* ── Cody application ─────────────────────────────────────────── */}
      <section
        ref={codyCardRef}
        data-search-id="cody-application"
        style={{ ...cardStyle, transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)", ...(codyHighlighted ? { boxShadow: "0 0 0 2px var(--accent)", borderColor: "var(--accent)" } : {}) }}
        aria-label={t("updates.cody.title")}
      >
        <div style={cardTitleStyle}>
          <Sparkles size={13} aria-hidden="true" />
          {t("updates.cody.title")}
        </div>
        {appLoading && <LoadingLine label={t("updates.checking")} />}
        {!appLoading && !appStatus && <div style={dimLineStyle}>{t("updates.checkUnavailable")}</div>}
        {appStatus && (
          appStatus.updateAvailable && appStatus.availableVersion ? (
            <>
              <VersionDelta current={appStatus.currentVersion} next={appStatus.availableVersion} />
              {/* Never fall back to an npm command in a container: it cannot
                  update an image-based deployment. */}
              <CommandCard command={appStatus.updateCommand || (appStatus.managedBy === "docker" ? "docker pull ghcr.io/nphil/cody:latest" : "npm install -g @nphil/cody")} />
            </>
          ) : (
            <>
              <div style={mutedLineStyle}>
                <span style={{ fontFamily: "var(--font-mono)" }}>v{appStatus.currentVersion}</span>
                {" · "}
                {appStatus.availableVersion
                  ? t("updates.upToDate")
                  : appStatus.managedBy === "docker"
                    ? t("updates.cody.dockerManaged")
                    : t("updates.checkUnavailable")}
              </div>
              {appStatus.managedBy === "docker" && <div style={dimLineStyle}>{t("updates.cody.dockerPullHint")}</div>}
            </>
          )
        )}
      </section>

      {/* ── Agent engines + Danger zone ──────────────────────────────── */}
      <EngineRoster mode="manage" capabilities={capabilities} checkSeq={checkSeq} onOmpUpdateAvailabilityChange={onOmpUpdateAvailabilityChange} />
    </div>
  );
}
