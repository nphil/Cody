"use client";

import { AlertCircle, Check, Download, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEngineInstalls } from "@/hooks/useEngineInstalls";
import { useI18n } from "@/lib/i18n";

/**
 * The onboarding engine picker: a full-screen step, in the login screen's
 * design language, that runs once per instance right after the first account
 * exists. It answers one question — which coding agent drives this Cody — and
 * it is the only place that answer is asked for before Settings.
 *
 * Mounted by AppShell only when GET /api/engines reports `canManage &&
 * !onboarded`, so it never renders for members or for an instance whose
 * administrator already chose. Picking an engine (or keeping the active one)
 * marks the instance onboarded server-side, which is what retires this screen.
 */

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
  version: string | null;
  /** Cody can npm-install this engine itself. */
  installable: boolean;
  /** English sentence from the adapter; not a translation key. */
  authHint: string | null;
  binaryName: string;
}

export interface EnginesPayload {
  engines: EngineSummary[];
  active: string;
  onboarded: boolean;
  canManage: boolean;
}

/** Engines Cody cannot install and cannot run without: experimental ones. */
function isRecommended(engine: EngineSummary): boolean {
  return !engine.experimental;
}

async function postEngine(path: string, id: string): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const body = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
  if (!response.ok) {
    throw new Error([body?.error, body?.detail].filter(Boolean).join(" — ") || `HTTP ${response.status}`);
  }
  return body;
}

export function EnginePicker({ initial, onDone }: {
  /** Roster AppShell already fetched; the picker refetches only after installs. */
  initial?: EnginesPayload | null;
  /** Called once the selection stuck. `engineChanged` is true when the active
   * engine is not the one the app booted with, so the shell can reload. */
  onDone: (engineChanged: boolean) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<EnginesPayload | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  // The engine the app booted with: a switch away from it means the loaded UI
  // (models, skills, chat affordances) no longer matches the server.
  const bootEngineRef = useRef<string | null>(initial?.active ?? null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/engines", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as EnginesPayload;
    bootEngineRef.current ??= payload.active;
    setData(payload);
  }, []);

  useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    load(controller.signal).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => controller.abort();
  }, [initial, load]);

  const onInstallSettled = useCallback((_id: string, ok: boolean) => {
    if (ok) void load().catch(() => {});
  }, [load]);
  const {
    installing: installingIds,
    progress: installProgress,
    errors: installErrors,
    start: startInstall,
    watch: watchInstall,
  } = useEngineInstalls(onInstallSettled);

  // Reattach to installs that were already running server-side (page reload,
  // another admin's click) so the row shows live progress, not a dead button.
  useEffect(() => {
    for (const engine of data?.engines ?? []) {
      if (engine.installing) watchInstall(engine.id);
    }
  }, [data, watchInstall]);

  const select = useCallback((engine: EngineSummary) => {
    setError(null);
    setSelecting(engine.id);
    void postEngine("/api/engines/select", engine.id)
      .then(() => {
        onDone(bootEngineRef.current !== null && bootEngineRef.current !== engine.id);
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setSelecting(null);
      });
  }, [onDone]);

  const engines = data?.engines ?? [];
  const active = engines.find((engine) => engine.id === data?.active) ?? null;
  // Only a selection blocks the whole screen (it ends in a navigation).
  // Installs are per-engine: other rows stay usable while npm runs.
  const busy = selecting !== null;

  return (
    <div className="engine-overlay" role="dialog" aria-modal="true" aria-label={t("engines.title")}>
      <div className="engine-column">
        <div className="engine-brand">
          <div className="login-wordmark" aria-label="Cody">
            <span style={{ color: "var(--accent)" }}>co</span>
            <span style={{ color: "var(--text)" }}>dy</span>
            <span className="login-caret" aria-hidden />
          </div>
        </div>

        <div className="engine-intro">
          <h1 className="engine-title">{t("engines.title")}</h1>
          <p className="engine-subtitle">{t("engines.subtitle")}</p>
        </div>

        {error && (
          <div className="login-error engine-alert" role="alert">
            <AlertCircle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        {data === null ? (
          <div className="engine-loading" role="status">
            <Loader2 size={15} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
            {t("engines.loading")}
          </div>
        ) : (
          <div className="engine-grid">
            {engines.map((engine, index) => {
              const isActive = engine.id === data.active;
              const installBusy = installingIds.has(engine.id);
              const selectBusy = selecting === engine.id;
              const installError = installErrors[engine.id];
              return (
                <section
                  key={engine.id}
                  className="engine-card"
                  data-active={isActive ? "true" : undefined}
                  style={{ animationDelay: `${index * 70}ms` }}
                >
                  <header className="engine-card-head">
                    <h2 className="engine-name">{engine.name}</h2>
                    <div className="engine-chips">
                      {isRecommended(engine) && (
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
                    {isActive ? (
                      <span className="engine-active-note">
                        <Check size={13} aria-hidden /> {t("engines.activeNow")}
                      </span>
                    ) : null}
                    {!engine.installed && engine.installable && (
                      <button
                        type="button"
                        className="login-ghost engine-button"
                        onClick={() => startInstall(engine.id)}
                        disabled={busy || installBusy}
                      >
                        {installBusy
                          ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
                          : <Download size={14} aria-hidden />}
                        {installBusy ? t("engines.installing") : t("engines.install")}
                      </button>
                    )}
                    {!engine.installed && !engine.installable && (
                      <span className="engine-blocked">{t("engines.installManually", { binary: engine.binaryName })}</span>
                    )}
                    {engine.installed && !isActive && (
                      <button
                        type="button"
                        className="login-primary engine-button"
                        onClick={() => select(engine)}
                        disabled={busy}
                      >
                        {selectBusy && <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
                        {selectBusy ? t("engines.switching") : t("engines.use", { name: engine.shortName })}
                      </button>
                    )}
                    {engine.installed && isActive && (
                      <button
                        type="button"
                        className="login-primary engine-button"
                        onClick={() => select(engine)}
                        disabled={busy}
                      >
                        {selectBusy && <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
                        {t("engines.continueWith", { name: engine.shortName })}
                      </button>
                    )}
                  </div>

                  {installBusy && (
                    <div className="engine-progress" role="status" aria-live="polite">
                      <span className="engine-progress-bar" aria-hidden><span /></span>
                      <span className="engine-progress-line">
                        {installProgress[engine.id] || t("engines.installing")}
                      </span>
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
          {active && (
            <button
              type="button"
              className="engine-link"
              onClick={() => select(active)}
              disabled={busy}
            >
              {t("engines.decideLater", { name: active.shortName })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
