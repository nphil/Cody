"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Camera, Clipboard, ClipboardPaste, ExternalLink, Globe, ListTodo, Loader2, Maximize2, RotateCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { toast } from "./ui/toast";
import { codecLabelFor, StreamedDisplay, type StreamRenderMode, type StreamedDisplayHandle } from "./StreamedDisplay";
import type { DisplayCandidate, DisplayCandidateKind, DisplayRequestV1 } from "@/lib/display/types";
import { orderDisplayCandidates } from "@/lib/display/ladder";
// Loopback-only rules + rationale live in lib/preview-url, shared with the
// agent-facing open_preview host tool and the assistant-URL auto-open path.
// probeLoopbackUrl itself only answers "did anything reply?", so the ladder
// reuses it for LAN and gateway candidates too.
import { normalizePreviewUrl, probeLoopbackUrl } from "@/lib/preview-url";

export interface PreviewPanelProps {
  cwd: string | null;
  sessionId: string | null;
  active: boolean;
  request: DisplayRequestV1 | null;
  /** Jump to the Tasks tab (the usual way to start a dev server). */
  onOpenTasks?: () => void;
  /** Receive a server-side screenshot of the previewed app (attached to the
   * composer by the shell). */
  onCaptureToChat?: (image: { data: string; mimeType: string }) => void;
}

const DEFAULT_URL = "http://127.0.0.1:3000";

/** Lifetime of the transient "which path is live" notice. The
 *  preview-mode-notice keyframe fades itself out over the same span, so one
 *  dismiss timer is enough. */
const MODE_NOTICE_MS = 2_000;

/** Per-candidate probe budget. Tighter than the auto-open probe in AppShell:
 *  the ladder can walk several candidates in series, and the panel sits on a
 *  resolving overlay for the whole walk. */
const CANDIDATE_PROBE_MS = 2_500;

const MODE_LABEL_KEY: Record<DisplayCandidateKind, string> = {
  direct: "preview.modeDirect",
  native: "preview.modeGateway",
  stream: "preview.modeStreamed",
};

export function PreviewPanel({ sessionId, active, request, onOpenTasks, onCaptureToChat }: PreviewPanelProps): ReactElement {
  const { t } = useI18n();
  const [input, setInput] = useState(DEFAULT_URL);
  const [inputError, setInputError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  // Resolution is keyed by request id: the server ranks candidates by fidelity,
  // this browser decides which of them it can actually reach. A re-delivered
  // snapshot for the live request keeps its winner on screen instead of
  // flashing back through the resolving state.
  const [resolution, setResolution] = useState<{ id: string; candidate: DisplayCandidate | null } | null>(null);
  const [notice, setNotice] = useState<{ id: string; kind: DisplayCandidateKind } | null>(null);
  // DOM-typed handle (see TerminalPanel): window.setTimeout returns a number,
  // and window.clearTimeout takes `number | undefined`, so the dismiss timer
  // needs no null guard before clearing.
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const reducedMotion = usePrefersReducedMotion();
  // The streamed rung is driven imperatively from this bar: a clipboard
  // transfer is a round-trip on its socket, and the pop-out window resizes the
  // remote surface that this panel is also watching.
  const streamRef = useRef<StreamedDisplayHandle | null>(null);
  const popoutRef = useRef<Window | null>(null);
  const [streamInput, setStreamInput] = useState<{ id: string; input: readonly string[] } | null>(null);
  // The streamed rung's own answer about what it is presenting. Kept beside
  // `streamInput` rather than folded into it: one is the provider's input
  // capabilities, this is the codec actually decoding in this browser.
  const [streamMode, setStreamMode] = useState<{ id: string; mode: StreamRenderMode } | null>(null);

  useEffect(() => { if (request?.source.kind === "web") setInput(request.source.url); }, [request]);

  useEffect(() => {
    if (!request) { setResolution(null); return; }
    const id = request.id;
    const ladder = orderDisplayCandidates(request.candidates, window.location.protocol, window.location.hostname);
    // Per-run cancellation: a superseding request (or an unmount) runs this
    // effect's cleanup before the next walk starts, so an in-flight walk can
    // never commit a stale winner over a newer one.
    let cancelled = false;
    void (async () => {
      for (const candidate of ladder) {
        // The floor has no URL and always works, so it is never probed.
        if (candidate.kind === "stream" || !candidate.url) {
          if (!cancelled) setResolution({ id, candidate });
          return;
        }
        const answered = await probeLoopbackUrl(candidate.url, CANDIDATE_PROBE_MS);
        if (cancelled) return;
        if (answered) { setResolution({ id, candidate }); return; }
      }
      if (!cancelled) setResolution({ id, candidate: null });
    })();
    return () => { cancelled = true; };
  }, [request]);

  const resolved = request && resolution?.id === request.id ? resolution.candidate : null;
  const resolving = !!request && resolution?.id !== request.id;
  const frameUrl = resolved && resolved.kind !== "stream" ? resolved.url ?? null : null;
  const streamedRequest = resolved?.kind === "stream" && sessionId ? request : null;
  // Strictly the provider's own answer. A renderer that cannot bridge the
  // clipboard never advertises it and gets no clipboard UI — the capability is
  // never inferred from the renderer being raster.
  const clipboardReady = streamedRequest !== null && streamInput !== null && streamInput.id === streamedRequest.id && streamInput.input.includes("clipboard");
  // A streamed session names its CODEC next to its method, in the badge and in
  // the transient pill: H.264 and JPEG stills are the same "Streamed" rung and
  // would otherwise look identical, and a silent drop to stills is precisely the
  // fidelity loss the badge exists to expose.
  const liveMode = streamedRequest && streamMode?.id === streamedRequest.id ? streamMode.mode : null;
  const streamedLabel = liveMode
    ? t("preview.modeStreamedVia", { mode: t(MODE_LABEL_KEY.stream), codec: codecLabelFor(liveMode, t) })
    : t(MODE_LABEL_KEY.stream);

  // Announce the winner once per resolved request id. The deps are the commit
  // itself, so re-renders, panel toggles and reload presses stay quiet, while a
  // fresh open_preview announces again — the winning path may have changed.
  const committedId = resolution?.id;
  const committedKind = resolution?.candidate?.kind;
  useEffect(() => {
    if (!committedId || !committedKind) return;
    setNotice({ id: committedId, kind: committedKind });
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), MODE_NOTICE_MS);
    // Covers unmount and supersession alike, so a stale timer can never hide a
    // newer notice.
    return () => window.clearTimeout(noticeTimerRef.current);
  }, [committedId, committedKind]);

  // A notice whose request is no longer live never shows: a slow walk must not
  // label the new preview with the previous request's path.
  const liveNotice = notice && notice.id === request?.id ? notice : null;

  const open = useCallback(async () => {
    if (!sessionId) { setInputError(t("preview.sessionRequired")); return; }
    setSubmitting(true);
    setInputError("");
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/display`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: input, mode: "auto" }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : t("preview.connectionFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [input, sessionId, t]);

  // Server-side capture: the screenshot renders where the dev server runs,
  // so it works even when this browser cannot reach the app as localhost.
  const [capturing, setCapturing] = useState(false);
  const captureToChat = useCallback(async () => {
    const normalized = normalizePreviewUrl(input) ?? (request?.source.kind === "web" ? request.source.url : null);
    if (!normalized || capturing) {
      if (!normalized) setInputError(t("preview.loopbackOnly"));
      return;
    }
    setCapturing(true);
    try {
      const res = await fetch("/api/preview/screenshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const payload = await res.json().catch(() => null) as { data?: string; mimeType?: string; error?: string; hint?: string } | null;
      if (!res.ok || !payload?.data || !payload.mimeType) {
        toast.error(t("preview.captureFailed"), [payload?.error, payload?.hint].filter(Boolean).join(" "), { clamp: true });
        return;
      }
      onCaptureToChat?.({ data: payload.data, mimeType: payload.mimeType });
      toast.success(t("preview.captureAttached"));
    } catch {
      toast.error(t("preview.captureFailed"));
    } finally {
      setCapturing(false);
    }
  }, [capturing, input, onCaptureToChat, request, t]);

  const reload = useCallback(() => {
    if (!request) { void open(); return; }
    if (frameUrl) setFrameKey((value) => value + 1);
    else setReloadToken((value) => value + 1);
  }, [frameUrl, open, request]);

  // A window, not a tab: it is genuinely larger, so it reports its own size and
  // device scale over the same display socket and the remote surface renders at
  // that size natively instead of being upscaled from this panel's. One window
  // per session — pressing again focuses the one already open.
  const popOut = useCallback(() => {
    if (!sessionId) return;
    const existing = popoutRef.current;
    if (existing && !existing.closed) { existing.focus(); return; }
    const width = Math.min(Math.round(window.screen.availWidth * 0.9), 1920);
    const height = Math.min(Math.round(window.screen.availHeight * 0.9), 1200);
    popoutRef.current = window.open(`/display/${encodeURIComponent(sessionId)}`, `cody-display-${sessionId}`, `popup=1,width=${width},height=${height}`);
  }, [sessionId]);

  // Every client of a session shares one remote surface, so closing the pop-out
  // leaves it at the pop-out's size — and this panel's ResizeObserver has
  // nothing to fire on. Reclaim the viewport when focus returns here.
  useEffect(() => {
    const reclaim = () => {
      if (!popoutRef.current?.closed) return;
      popoutRef.current = null;
      streamRef.current?.resyncViewport();
    };
    window.addEventListener("focus", reclaim);
    return () => window.removeEventListener("focus", reclaim);
  }, []);

  const controlStyle = { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" } as const;

  return (
    <section aria-label={t("preview.title")} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <div className="workspace-subtitle-bar" style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <Globe size={13} strokeWidth={2} color="var(--text-muted)" aria-hidden="true" style={{ flexShrink: 0 }} />
        <input value={input} onChange={(event) => { setInput(event.target.value); setInputError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void open(); }} placeholder={DEFAULT_URL} aria-label={t("preview.urlLabel")} aria-invalid={!!inputError} spellCheck={false} style={{ flex: 1, minWidth: 0, padding: "2px 7px", fontSize: 11, fontFamily: "var(--font-mono)", border: `1px solid ${inputError ? "var(--status-error)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }} />
        {resolved && <span title={frameUrl ?? undefined} style={{ flexShrink: 0, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 10, whiteSpace: "nowrap" }}>{resolved.kind === "stream" ? streamedLabel : t(MODE_LABEL_KEY[resolved.kind])}</span>}
        {clipboardReady && (
          <>
            <button type="button" className="ui-focus-ring" onClick={() => streamRef.current?.copyFromRemote()} title={t("preview.clipboardCopy")} aria-label={t("preview.clipboardCopy")} style={controlStyle}><Clipboard size={13} strokeWidth={2} aria-hidden="true" /></button>
            <button type="button" className="ui-focus-ring" onClick={() => streamRef.current?.pasteToRemote()} title={t("preview.clipboardPaste")} aria-label={t("preview.clipboardPaste")} style={controlStyle}><ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" /></button>
          </>
        )}
        <button type="button" className="ui-focus-ring" onClick={reload} disabled={submitting} title={t("preview.reload")} aria-label={t("preview.reload")} style={controlStyle}><RotateCw size={13} strokeWidth={2} aria-hidden="true" style={submitting ? { animation: "spin 0.8s linear infinite" } : undefined} /></button>
        {onCaptureToChat && (
          <button type="button" className="ui-focus-ring" onClick={() => { void captureToChat(); }} disabled={capturing}
            title={t("preview.capture")} aria-label={t("preview.capture")}
            style={{ ...controlStyle, cursor: capturing ? "progress" : "pointer", opacity: capturing ? 0.6 : 1 }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
            <Camera size={13} strokeWidth={2} aria-hidden="true" style={capturing ? { animation: "pulse 1s ease-in-out infinite" } : undefined} />
          </button>
        )}
        {frameUrl && <button type="button" className="ui-focus-ring" onClick={() => window.open(frameUrl, "_blank", "noopener")} title={t("preview.detach")} aria-label={t("preview.detach")} style={controlStyle}><ExternalLink size={13} strokeWidth={2} aria-hidden="true" /></button>}
        {/* Distinct from the detach button above: that one hands a direct or
            gateway URL to the browser, this one carries the streamed surface
            into a full window over the same authenticated socket. */}
        {streamedRequest && <button type="button" className="ui-focus-ring" onClick={popOut} title={t("preview.popOut")} aria-label={t("preview.popOut")} style={controlStyle}><Maximize2 size={13} strokeWidth={2} aria-hidden="true" /></button>}
      </div>
      {inputError && <div role="alert" style={{ flexShrink: 0, padding: "5px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--status-error) 9%, var(--bg-panel))", color: "var(--status-error)", fontSize: 11 }}>{inputError}</div>}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {resolving ? (
          <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, background: "var(--bg)", color: "var(--text-muted)", textAlign: "center", fontSize: 12 }}>
            <div><Loader2 size={20} aria-hidden="true" style={{ display: "block", margin: "0 auto 10px", animation: "spin 0.8s linear infinite" }} />{t("preview.resolving")}</div>
          </div>
        ) : frameUrl ? (
          <iframe key={frameKey} src={frameUrl} title={request?.title ?? t("preview.frameTitle")} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "#fff" }} />
        ) : streamedRequest && sessionId ? (
          <StreamedDisplay key={streamedRequest.id} ref={streamRef} sessionId={sessionId} request={streamedRequest} active={active} reloadToken={reloadToken} onCapabilities={(requestId, input) => setStreamInput({ id: requestId, input })} onRenderMode={(requestId, mode) => setStreamMode({ id: requestId, mode })} />
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
            <span>{t("preview.emptyHint")}</span>
            {onOpenTasks && <button type="button" className="ui-focus-ring" onClick={onOpenTasks} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", fontSize: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer" }}><ListTodo size={13} aria-hidden="true" /> {t("preview.openTasks")}</button>}
          </div>
        )}
        {/* Names the path that won, then dismisses itself. pointer-events are
            off so it can never swallow a click meant for the app or canvas. */}
        {liveNotice && (
          <div role="status" style={{ position: "absolute", top: 8, left: 0, right: 0, width: "fit-content", maxWidth: "calc(100% - 20px)", margin: "0 auto", zIndex: 1, pointerEvents: "none", padding: "3px 9px", border: "1px solid var(--border)", borderRadius: 999, background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)", boxShadow: "var(--shadow-card)", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap", animation: reducedMotion ? undefined : `preview-mode-notice ${MODE_NOTICE_MS}ms var(--ease-out-warm) forwards` }}>
            {t(liveNotice.kind === "stream" ? "preview.noticeFallback" : "preview.noticeFullFidelity", { mode: liveNotice.kind === "stream" ? streamedLabel : t(MODE_LABEL_KEY[liveNotice.kind]) })}
          </div>
        )}
      </div>
    </section>
  );
}
