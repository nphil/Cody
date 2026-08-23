"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clipboard, RotateCw, TriangleAlert } from "lucide-react";
import { translate, useI18n } from "@/lib/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { formatBytes } from "@/lib/format-bytes";

export interface InfoPanelProps {
  cwd: string | null;
  active: boolean;
  gitBranch?: string | null;
  gitRepoRoot?: string | null;
}

interface RuntimeInfo {
  codyVersion: string;
  /** Named for the founding engine, but it is `harness.getVersion()` — the
   * version of whatever engine is ACTIVE. */
  ompVersion: string | null;
  /** Who that engine is. The version and agent dir below have always been the
   * active engine's; only the labels around them said "OMP", so a Hermes
   * user's pasted diagnostics read "OMP: 0.19.0". */
  engineName: string;
  nodeVersion: string;
  platform: string;
  agentDir: string;
  storage: { availableBytes: number; totalBytes: number } | null;
}

const PACKAGE_NAME = "@nphil/cody";

/** Below this the data dir is close enough to full that an engine install is
 * likely to fail partway through; the row turns warning-colored. */
const LOW_DISK_BYTES = 2 * 1024 * 1024 * 1024;

/** pi-web formatVersion semantics: undefined/empty reads as "unknown" rather
 * than a blank row, so a missing probe is visibly missing. */
function formatVersion(version: string | null | undefined): string {
  return version === undefined || version === null || version === "" ? translate("info.unknown") : version;
}

/** Same fallback for the clipboard block, but never localized: a diagnostics
 * paste lands in an English bug report regardless of the UI language. */
function diagnosticValue(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "unknown" : value;
}

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

function hoverIn(event: React.MouseEvent<HTMLButtonElement>) {
  if (event.currentTarget.disabled) return;
  event.currentTarget.style.background = "var(--bg-selected)";
}

function hoverOut(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = "var(--bg-panel)";
}

const sectionHeadingStyle: React.CSSProperties = {
  marginBottom: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

function Row({ label, value, mono = false, tone }: { label: string; value: string; mono?: boolean; tone?: "warning" }): React.ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(96px, auto) minmax(0, 1fr)",
        gap: "2px 10px",
        padding: "5px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
      <span
        style={{
          minWidth: 0,
          fontSize: 12,
          lineHeight: 1.45,
          color: tone === "warning" ? "var(--status-warning)" : "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** Read-only runtime facts + a one-click diagnostics block for bug reports.
 * Everything actionable lives in the Settings dialog; this panel only reports. */
export function InfoPanel({ cwd, active, gitBranch, gitRepoRoot }: InfoPanelProps): React.ReactElement | null {
  const { t } = useI18n();
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const { copied, copy } = useCopyFeedback();

  // Monotonic request id + AbortController: a slow response from a previous
  // refresh must never land after a newer one (or after unmount).
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

  // Lazy: no fetch until the panel has been shown at least once.
  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const stale = () => requestId !== requestRef.current || !mountedRef.current;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/info", { signal: controller.signal });
      const data = await response.json().catch(() => ({})) as Partial<RuntimeInfo> & {
        error?: string;
        engine?: { shortName?: unknown; displayName?: unknown };
      };
      if (stale()) return;
      if (!response.ok || typeof data.codyVersion !== "string") {
        setError(data.error ?? translate("info.loadFailed"));
        return;
      }
      const engine = data.engine;
      setInfo({
        codyVersion: data.codyVersion,
        ompVersion: typeof data.ompVersion === "string" ? data.ompVersion : null,
        engineName: typeof engine?.shortName === "string" && engine.shortName
          ? engine.shortName
          : typeof engine?.displayName === "string" && engine.displayName
            ? engine.displayName
            : translate("info.engineFallbackName"),
        nodeVersion: typeof data.nodeVersion === "string" ? data.nodeVersion : "",
        platform: typeof data.platform === "string" ? data.platform : "",
        agentDir: typeof data.agentDir === "string" ? data.agentDir : "",
        storage: data.storage && typeof data.storage.availableBytes === "number" && typeof data.storage.totalBytes === "number"
          ? { availableBytes: data.storage.availableBytes, totalBytes: data.storage.totalBytes }
          : null,
      });
    } catch (err) {
      if (controller.signal.aborted || stale()) return;
      setError(err instanceof Error ? err.message : translate("info.loadFailed"));
    } finally {
      if (!stale()) setLoading(false);
    }
  }, []);

  // Fetched once on first activation; the Refresh button re-runs it.
  useEffect(() => {
    if (!started) return;
    void load();
  }, [started, load]);

  // The Cody version is inlined at build time, so it renders before /api/info
  // has answered (and stays correct even if that call fails).
  const codyVersion = formatVersion(process.env.NEXT_PUBLIC_CODY_VERSION ?? info?.codyVersion);

  const copyDiagnostics = useCallback(() => {
    const lines = [
      "Cody diagnostics",
      `Cody: v${diagnosticValue(process.env.NEXT_PUBLIC_CODY_VERSION ?? info?.codyVersion)} (${PACKAGE_NAME})`,
      // The label follows the engine, never the founding one: a diagnostics
      // paste that says "OMP" under Hermes sends the reader after the wrong
      // changelog. Never localized — a paste lands in an English bug report.
      `Engine: ${info?.engineName ?? "unknown"} ${diagnosticValue(info?.ompVersion)}`,
      `Node: ${diagnosticValue(info?.nodeVersion)}`,
      `Platform: ${diagnosticValue(info?.platform)}`,
      `Agent dir: ${diagnosticValue(info?.agentDir)}`,
      `Workspace: ${cwd ?? "none"}`,
    ];
    if (gitRepoRoot) lines.push(`Repo: ${gitRepoRoot}${gitBranch ? ` @ ${gitBranch}` : ""}`);
    copy(lines.join("\n"));
  }, [info, cwd, gitRepoRoot, gitBranch, copy]);

  if (!active) return null;

  return (
    <section
      aria-label={t("info.title")}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
    >
      <div
        className="workspace-subtitle-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("info.title")}
        </span>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={copyDiagnostics}
          title={t("info.copyDiagnostics")}
          aria-label={t("info.copyDiagnostics")}
          style={toolbarButtonStyle(false)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {copied
            ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
            : <Clipboard size={11} strokeWidth={2.2} aria-hidden="true" />}
          {copied ? t("info.copied") : t("info.copyDiagnostics")}
        </button>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => void load()}
          disabled={loading}
          title={t("info.refresh")}
          aria-label={t("info.refresh")}
          style={toolbarButtonStyle(loading)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          <RotateCw size={11} strokeWidth={2.2} aria-hidden="true" />
          {t("info.refresh")}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
        {error && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              padding: "6px 8px",
              border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))",
              borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              fontSize: 11,
              lineHeight: 1.4,
              color: "var(--status-error)",
              overflowWrap: "anywhere",
            }}
          >
            <TriangleAlert size={12} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span style={{ minWidth: 0 }}>{error}</span>
          </div>
        )}

        <div>
          <div style={sectionHeadingStyle}>{t("info.section.cody")}</div>
          <Row label={t("info.label.version")} value={`v${codyVersion}`} mono />
          <Row label={t("info.label.package")} value={PACKAGE_NAME} mono />
        </div>

        <div>
          <div style={sectionHeadingStyle}>{t("info.section.engine", { name: info?.engineName ?? t("info.engineFallbackName") })}</div>
          <Row label={t("info.label.version")} value={formatVersion(info?.ompVersion)} mono />
          <Row label={t("info.label.agentDir")} value={formatVersion(info?.agentDir)} mono />
          {info?.storage ? (
            <Row
              label={t("info.label.diskFree")}
              value={t("info.diskFreeValue", {
                free: formatBytes(info.storage.availableBytes),
                total: formatBytes(info.storage.totalBytes),
              })}
              // A nearly-full data dir is the reason engine installs fail with
              // an unreadable errno, so it is called out before it bites.
              tone={info.storage.availableBytes < LOW_DISK_BYTES ? "warning" : undefined}
            />
          ) : null}
        </div>

        <div>
          <div style={sectionHeadingStyle}>{t("info.section.environment")}</div>
          <Row label={t("info.label.node")} value={formatVersion(info?.nodeVersion)} mono />
          <Row label={t("info.label.platform")} value={formatVersion(info?.platform)} />
        </div>

        <div>
          <div style={sectionHeadingStyle}>{t("info.section.workspace")}</div>
          <Row label={t("info.label.cwd")} value={cwd ?? t("info.noWorkspace")} mono={Boolean(cwd)} />
          {gitRepoRoot ? <Row label={t("info.label.repoRoot")} value={gitRepoRoot} mono /> : null}
          {gitBranch ? <Row label={t("info.label.branch")} value={gitBranch} mono /> : null}
        </div>
      </div>
    </section>
  );
}
