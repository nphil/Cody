"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Camera, ExternalLink, Globe, ListTodo, Loader2, RotateCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "./ui/toast";
import type { DisplayRequestV1, DisplayStreamState } from "@/lib/display/types";
// Loopback-only rules + rationale live in lib/preview-url, shared with the
// agent-facing open_preview host tool and the assistant-URL auto-open path.
import { normalizePreviewUrl } from "@/lib/preview-url";

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

type ConnectionState = "idle" | "connecting" | "ready" | "error";

function StreamedDisplay({ sessionId, request, active, reloadToken }: { sessionId: string; request: DisplayRequestV1; active: boolean; reloadToken: number }): ReactElement {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [message, setMessage] = useState("");
  const pendingFrame = useRef<Blob | null>(null);
  const drawing = useRef(false);

  const send = useCallback((frame: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }, []);
  const viewportRef = useRef<{ width: number; height: number; deviceScaleFactor: number } | null>(null);
  const sendViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) send({ type: "resize", ...viewport });
  }, [send]);

  useEffect(() => {
    if (!active) { socketRef.current?.close(); socketRef.current = null; setState("idle"); return; }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/display/socket?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(request.id)}`);
    socket.binaryType = "blob";
    socketRef.current = socket;
    setState("connecting");
    setMessage("");

    const drawNewest = async () => {
      if (drawing.current) return;
      drawing.current = true;
      try {
        while (pendingFrame.current) {
          const blob = pendingFrame.current;
          pendingFrame.current = null;
          const bitmap = await createImageBitmap(blob);
          const canvas = canvasRef.current;
          if (canvas) canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
        }
      } finally {
        drawing.current = false;
      }
    };

    socket.onmessage = (event) => {
      if (event.data instanceof Blob) {
        pendingFrame.current = event.data;
        void drawNewest();
        return;
      }
      try {
        const frame = JSON.parse(String(event.data)) as DisplayStreamState;
        if (frame.type === "state") {
          setState(frame.state === "error" ? "error" : frame.state);
          setMessage(frame.message ?? "");
          if (frame.state === "ready") sendViewport();
        }
      } catch { /* ignore unknown negotiated extensions */ }
    };
    socket.onerror = () => { setState("error"); setMessage(t("preview.connectionFailed")); };
    socket.onclose = () => setState((current) => current === "error" ? current : "idle");
    return () => { socket.close(); socketRef.current = null; pendingFrame.current = null; };
  }, [active, request.id, sessionId, t, sendViewport]);

  useEffect(() => { if (reloadToken > 0) send({ type: "reload" }); }, [reloadToken, send]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(320, Math.round(entry.contentRect.width));
      const height = Math.max(240, Math.round(entry.contentRect.height));
      canvas.width = width;
      canvas.height = height;
      viewportRef.current = { width, height, deviceScaleFactor: Math.min(window.devicePixelRatio || 1, 2) };
      send({ type: "resize", ...viewportRef.current });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, send]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * event.currentTarget.width / rect.width, y: (event.clientY - rect.top) * event.currentTarget.height / rect.height };
  };
  const button = (value: number): "left" | "middle" | "right" => value === 1 ? "middle" : value === 2 ? "right" : "left";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#fff" }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={request.title ?? t("preview.frameTitle")}
        onContextMenu={(event) => event.preventDefault()}
        onPointerMove={(event) => send({ type: "pointer", action: "move", ...point(event) })}
        onPointerDown={(event) => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); send({ type: "pointer", action: "down", button: button(event.button), ...point(event) }); }}
        onPointerUp={(event) => send({ type: "pointer", action: "up", button: button(event.button), ...point(event) })}
        onWheel={(event) => { event.preventDefault(); send({ type: "pointer", action: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, ...point(event as unknown as React.PointerEvent<HTMLCanvasElement>) }); }}
        onKeyDown={(event) => {
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) send({ type: "keyboard", action: "text", text: event.key });
          else send({ type: "keyboard", action: "down", key: event.key, code: event.code, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
          event.preventDefault();
        }}
        onKeyUp={(event) => { if (event.key.length !== 1 || event.ctrlKey || event.metaKey) send({ type: "keyboard", action: "up", key: event.key, code: event.code }); event.preventDefault(); }}
        onPaste={(event) => { const text = event.clipboardData.getData("text"); if (text) send({ type: "keyboard", action: "text", text }); event.preventDefault(); }}
        style={{ width: "100%", height: "100%", display: "block", outline: "none", touchAction: "none", cursor: "default" }}
      />
      {state !== "ready" && (
        <div role={state === "error" ? "alert" : "status"} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, background: "var(--bg)", color: state === "error" ? "var(--status-error)" : "var(--text-muted)", textAlign: "center", fontSize: 12 }}>
          <div>{state === "connecting" && <Loader2 size={20} aria-hidden="true" style={{ display: "block", margin: "0 auto 10px", animation: "spin 0.8s linear infinite" }} />}{message || t(state === "error" ? "preview.connectionFailed" : "preview.connecting")}</div>
        </div>
      )}
    </div>
  );
}

export function PreviewPanel({ sessionId, active, request, onOpenTasks, onCaptureToChat }: PreviewPanelProps): ReactElement {
  const { t } = useI18n();
  const [input, setInput] = useState(DEFAULT_URL);
  const [inputError, setInputError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [nativeKey, setNativeKey] = useState(0);

  useEffect(() => { if (request?.source.kind === "web") setInput(request.source.url); }, [request]);

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
    if (request.transport === "native") setNativeKey((value) => value + 1);
    else setReloadToken((value) => value + 1);
  }, [open, request]);

  const controlStyle = { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" } as const;
  const detachedUrl = request?.transport === "native" ? request.nativeUrl : null;

  return (
    <section aria-label={t("preview.title")} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <div className="workspace-subtitle-bar" style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <Globe size={13} strokeWidth={2} color="var(--text-muted)" aria-hidden="true" style={{ flexShrink: 0 }} />
        <input value={input} onChange={(event) => { setInput(event.target.value); setInputError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void open(); }} placeholder={DEFAULT_URL} aria-label={t("preview.urlLabel")} aria-invalid={!!inputError} spellCheck={false} style={{ flex: 1, minWidth: 0, padding: "2px 7px", fontSize: 11, fontFamily: "var(--font-mono)", border: `1px solid ${inputError ? "var(--status-error)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }} />
        <button type="button" className="ui-focus-ring" onClick={reload} disabled={submitting} title={t("preview.reload")} aria-label={t("preview.reload")} style={controlStyle}><RotateCw size={13} strokeWidth={2} aria-hidden="true" style={submitting ? { animation: "spin 0.8s linear infinite" } : undefined} /></button>
        {onCaptureToChat && (
          <button type="button" className="ui-focus-ring" onClick={() => { void captureToChat(); }} disabled={capturing}
            title={t("preview.capture")} aria-label={t("preview.capture")}
            style={{ ...controlStyle, cursor: capturing ? "progress" : "pointer", opacity: capturing ? 0.6 : 1 }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
            <Camera size={13} strokeWidth={2} aria-hidden="true" style={capturing ? { animation: "pulse 1s ease-in-out infinite" } : undefined} />
          </button>
        )}
        {detachedUrl && <button type="button" className="ui-focus-ring" onClick={() => window.open(detachedUrl, "_blank", "noopener")} title={t("preview.detach")} aria-label={t("preview.detach")} style={controlStyle}><ExternalLink size={13} strokeWidth={2} aria-hidden="true" /></button>}
      </div>
      {inputError && <div role="alert" style={{ flexShrink: 0, padding: "5px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--status-error) 9%, var(--bg-panel))", color: "var(--status-error)", fontSize: 11 }}>{inputError}</div>}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {request?.transport === "native" && request.nativeUrl ? (
          <iframe key={nativeKey} src={request.nativeUrl} title={request.title ?? t("preview.frameTitle")} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "#fff" }} />
        ) : request?.transport === "stream" && sessionId ? (
          <StreamedDisplay key={request.id} sessionId={sessionId} request={request} active={active} reloadToken={reloadToken} />
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
            <span>{t("preview.emptyHint")}</span>
            {onOpenTasks && <button type="button" className="ui-focus-ring" onClick={onOpenTasks} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", fontSize: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer" }}><ListTodo size={13} aria-hidden="true" /> {t("preview.openTasks")}</button>}
          </div>
        )}
      </div>
    </section>
  );
}
