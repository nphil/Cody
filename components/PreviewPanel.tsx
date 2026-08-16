"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ExternalLink, Globe, ListTodo, RotateCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { STORAGE_PREFIXES } from "@/lib/storage-keys";

export interface PreviewPanelProps {
  cwd: string | null;
  /** This panel is the visible tab. */
  active: boolean;
  /** Jump to the Tasks tab (the usual way to start a dev server). */
  onOpenTasks?: () => void;
}

const DEFAULT_URL = "http://localhost:3000";

/**
 * Only loopback origins are previewable: Cody's CSP frame-src is restricted to
 * localhost/127.0.0.1 (any port), and embedding arbitrary origins in an
 * authenticated tool would be a phishing surface. Everything else gets the
 * "open in its own window" affordance instead.
 */
function normalizePreviewUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return null;
  return url.toString();
}

function storageKeyFor(cwd: string): string {
  return `${STORAGE_PREFIXES.previewUrl}${cwd}`;
}

type Reachability = "unknown" | "checking" | "up" | "down";

export function PreviewPanel({ cwd, active, onOpenTasks }: PreviewPanelProps): ReactElement | null {
  const { t } = useI18n();
  const [input, setInput] = useState(DEFAULT_URL);
  /** The validated URL the iframe is (or will be) pointed at. */
  const [target, setTarget] = useState<string | null>(null);
  const [reachability, setReachability] = useState<Reachability>("unknown");
  const [inputError, setInputError] = useState(false);
  // Bumping remounts the iframe — the only reliable cross-origin reload.
  const [frameKey, setFrameKey] = useState(0);
  const probeSeqRef = useRef(0);
  /** Reset per workspace so each one auto-loads once on its first activation. */
  const autoLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Restore the workspace's last URL; a workspace switch drops the old frame
  // so one project's app is never shown beside another project's chat.
  useEffect(() => {
    probeSeqRef.current += 1;
    setTarget(null);
    setReachability("unknown");
    setInputError(false);
    autoLoadedRef.current = false;
    if (!cwd) return;
    try {
      const stored = localStorage.getItem(storageKeyFor(cwd));
      setInput(stored && normalizePreviewUrl(stored) ? stored : DEFAULT_URL);
    } catch {
      setInput(DEFAULT_URL);
    }
  }, [cwd]);

  /** Probe reachability without CORS: an opaque response still proves a
   * server answered; a network error means nothing is listening. */
  const probe = useCallback(async (url: string): Promise<boolean> => {
    const seq = ++probeSeqRef.current;
    setReachability("checking");
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(4_000) });
      if (seq !== probeSeqRef.current || !mountedRef.current) return false;
      setReachability("up");
      return true;
    } catch {
      if (seq !== probeSeqRef.current || !mountedRef.current) return false;
      setReachability("down");
      return false;
    }
  }, []);

  const load = useCallback(() => {
    const normalized = normalizePreviewUrl(input);
    if (!normalized) {
      setInputError(true);
      return;
    }
    setInputError(false);
    if (cwd) {
      try { localStorage.setItem(storageKeyFor(cwd), normalized); } catch { /* best-effort */ }
    }
    setTarget(normalized);
    setFrameKey((k) => k + 1);
    void probe(normalized);
  }, [cwd, input, probe]);

  // First activation with a stored URL: try it automatically so the panel is
  // useful without a click when the dev server is already running. Read the
  // stored value rather than `input`, which may still hold the previous
  // workspace's URL in the render pass where cwd just changed.
  useEffect(() => {
    if (!active || !cwd || autoLoadedRef.current || target !== null) return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(storageKeyFor(cwd)); } catch { /* unavailable */ }
    const normalized = normalizePreviewUrl(stored ?? DEFAULT_URL);
    if (!normalized) return;
    autoLoadedRef.current = true;
    setInput(normalized);
    setTarget(normalized);
    void probe(normalized);
  }, [active, cwd, probe, target]);

  const detach = useCallback(() => {
    const normalized = normalizePreviewUrl(input) ?? target;
    if (normalized) window.open(normalized, "_blank", "noopener");
  }, [input, target]);

  const reload = useCallback(() => {
    if (target === null) { load(); return; }
    setFrameKey((k) => k + 1);
    void probe(target);
  }, [load, probe, target]);

  const controlStyle = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    padding: 0,
    border: "none",
    borderRadius: "var(--radius-control)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  } as const;

  return (
    <section aria-label={t("preview.title")} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, padding: "6px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <Globe size={13} strokeWidth={2} color="var(--text-muted)" aria-hidden="true" style={{ flexShrink: 0 }} />
        <input
          type="text"
          value={input}
          onChange={(event) => { setInput(event.target.value); setInputError(false); }}
          onKeyDown={(event) => { if (event.key === "Enter") load(); }}
          placeholder={DEFAULT_URL}
          aria-label={t("preview.urlLabel")}
          aria-invalid={inputError}
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "4px 8px",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            border: `1px solid ${inputError ? "var(--status-error)" : "var(--border)"}`,
            borderRadius: "var(--radius-control)",
            background: "var(--bg)",
            color: "var(--text)",
          }}
        />
        <button type="button" className="ui-focus-ring" onClick={reload} title={t("preview.reload")} aria-label={t("preview.reload")} style={controlStyle}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
          <RotateCw size={13} strokeWidth={2} aria-hidden="true" style={reachability === "checking" ? { animation: "spin 0.8s linear infinite" } : undefined} />
        </button>
        <button type="button" className="ui-focus-ring" onClick={detach} title={t("preview.detach")} aria-label={t("preview.detach")} style={controlStyle}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
          <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {inputError && (
        <div role="alert" style={{ flexShrink: 0, padding: "5px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--status-error) 9%, var(--bg-panel))", color: "var(--status-error)", fontSize: 11, lineHeight: 1.4 }}>
          {t("preview.loopbackOnly")}
        </div>
      )}

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {/* The probe is advisory only: an app that is slow, redirects, or
            answers 404 at "/" is still worth framing. The iframe stays mounted
            once a target exists, and the probe result only drives the hint
            below it. */}
        {target !== null ? (
          <iframe
            key={frameKey}
            src={target}
            title={t("preview.frameTitle")}
            referrerPolicy="no-referrer"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "#fff" }}
          />
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
            {reachability === "down" && target === null ? (
              <>
                <span>{t("preview.notReachable", { url: target ?? input })}</span>
                <span style={{ color: "var(--text-muted)" }}>{t("preview.startHint")}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  {onOpenTasks && (
                    <button type="button" className="ui-focus-ring" onClick={onOpenTasks}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", fontSize: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
                      <ListTodo size={13} aria-hidden="true" /> {t("preview.openTasks")}
                    </button>
                  )}
                  <button type="button" className="ui-focus-ring" onClick={reload}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", fontSize: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
                    <RotateCw size={13} aria-hidden="true" /> {t("preview.retry")}
                  </button>
                </div>
              </>
            ) : (
              <span>{t("preview.emptyHint")}</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
