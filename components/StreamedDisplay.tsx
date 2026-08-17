"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "./ui/toast";
import type { DisplayRequestV1, DisplayStreamState } from "@/lib/display/types";

/** The streamed rung's client half: one WebSocket, one canvas, and the
 *  surface-agnostic control protocol from `lib/display/types.ts`. Shared by the
 *  Preview panel and the pop-out window route so there is exactly one
 *  implementation of the wire protocol in the browser. Nothing here knows the
 *  remote surface is a web page — an X11/Wayland desktop or an Android screen
 *  arrives as the same frames and takes the same controls. */

export type StreamConnectionState = "idle" | "connecting" | "ready" | "error";

export interface StreamedDisplayHandle {
  /** Remote selection → this device's clipboard. */
  copyFromRemote: () => void;
  /** This device's clipboard → the remote surface. */
  pasteToRemote: () => void;
  /** Re-assert this client's viewport. Every client of a session shares one
   *  remote surface, so a larger window's resize outlives that window; the
   *  panel it was opened from has to claim the size back. */
  resyncViewport: () => void;
}

export interface StreamedDisplayProps {
  sessionId: string;
  request: DisplayRequestV1;
  /** False tears the socket down: an unseen surface must not burn a renderer. */
  active: boolean;
  /** Increments to ask the provider to reload the surface. */
  reloadToken?: number;
  /** Input capabilities advertised in the provider's `hello`, per request id.
   *  Callers match capability strings, never a renderer name, so a provider
   *  that cannot bridge the clipboard simply never offers it. */
  onCapabilities?: (requestId: string, input: readonly string[]) => void;
}

/** Ceiling on the device-scale factor we ask the provider to render at. The
 *  server clamps to the same range: past 3 the encode cost buys pixels no
 *  panel resolves. */
const MAX_DEVICE_SCALE = 3;

/** Matches the provider's `Input.insertText` slice. The display socket also
 *  caps one client frame at 64 KiB, and an oversized frame is dropped whole
 *  rather than truncated, so the clamp has to happen here. */
const CLIPBOARD_MAX_CHARS = 8_192;

/** The provider always answers a read, so this only covers a socket that died
 *  mid-flight — without it the copy button would hang forever. */
const CLIPBOARD_TIMEOUT_MS = 4_000;

/** Inbound frames. The union with the server's own type keeps this file
 *  compiling whether or not `DisplayStreamState` already carries the clipboard
 *  answer, and unknown `type` values fall through untouched — an older
 *  provider must never break a newer client. */
type StreamInbound = DisplayStreamState | { type: "clipboard"; text?: string };

/** Ctrl/Cmd+C and Ctrl/Cmd+V only. Alt and Shift variants keep their
 *  surface-specific meanings (inspect element, paste-as-plain-text) and are
 *  forwarded like every other key. `event.key` respects the user's layout, so
 *  this matches whatever their own browser would treat as copy/paste. */
function clipboardAccelerator(event: React.KeyboardEvent): "copy" | "paste" | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return key === "c" ? "copy" : key === "v" ? "paste" : null;
}

export const StreamedDisplay = forwardRef<StreamedDisplayHandle, StreamedDisplayProps>(function StreamedDisplay(
  { sessionId, request, active, reloadToken = 0, onCapabilities },
  ref,
): ReactElement {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<StreamConnectionState>("idle");
  const [message, setMessage] = useState("");
  const [clipboardReady, setClipboardReady] = useState(false);
  const pendingFrame = useRef<Blob | null>(null);
  const drawing = useRef(false);
  /** From `hello.media`: a bare subtype ("jpeg") or a full MIME type. */
  const mediaType = useRef("image/jpeg");
  /** One context kind per canvas — `getContext` refuses a second kind — so the
   *  choice is made on the first frame and cached. */
  const renderer = useRef<ImageBitmapRenderingContext | CanvasRenderingContext2D | null>(null);
  const viewportRef = useRef<{ width: number; height: number; deviceScaleFactor: number } | null>(null);
  const capabilityHandler = useRef(onCapabilities);
  capabilityHandler.current = onCapabilities;

  const send = useCallback((frame: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }, []);

  /** Measures the CSS box, sizes the backing store in device pixels, and tells
   *  the provider what to render. `force` re-sends an unchanged viewport, which
   *  is how this client takes the shared surface back from another one. */
  const applyViewport = useCallback((force = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(240, Math.round(rect.height));
    const deviceScaleFactor = Math.min(MAX_DEVICE_SCALE, Math.max(1, window.devicePixelRatio || 1));
    // CSS size is untouched; the backing store carries the device pixels, so a
    // provider honoring deviceScaleFactor lands its frame 1:1 on the physical
    // grid instead of being resampled into a CSS-sized canvas.
    const storeWidth = Math.round(width * deviceScaleFactor);
    const storeHeight = Math.round(height * deviceScaleFactor);
    if (canvas.width !== storeWidth || canvas.height !== storeHeight) {
      canvas.width = storeWidth;
      canvas.height = storeHeight;
    }
    const previous = viewportRef.current;
    viewportRef.current = { width, height, deviceScaleFactor };
    // A resize restarts the screencast, which costs a visible frame, so an
    // identical viewport is never re-announced unless the caller insists.
    if (!force && previous && previous.width === width && previous.height === height && previous.deviceScaleFactor === deviceScaleFactor) return;
    send({ type: "resize", width, height, deviceScaleFactor });
  }, [send]);

  /** Paints the newest frame and drops everything older: a stale frame is worth
   *  nothing, and queueing them would trade latency for frames nobody sees. */
  const drawNewest = useCallback(async () => {
    if (drawing.current) return;
    drawing.current = true;
    try {
      while (pendingFrame.current) {
        const blob = pendingFrame.current;
        pendingFrame.current = null;
        const canvas = canvasRef.current;
        if (!canvas) continue;
        const context = renderer.current ??= (typeof createImageBitmap === "function" ? canvas.getContext("bitmaprenderer") : null)
          ?? canvas.getContext("2d", { alpha: false });
        if (!context) continue;
        if ("transferFromImageBitmap" in context) {
          // Decoding happens off the main thread and the bitmap is handed
          // straight to the compositor — no copy, no drawImage resample. The
          // canvas adopts the frame's own pixel size, which is exactly the
          // backing store we asked for above.
          const bitmap = await createImageBitmap(blob);
          context.transferFromImageBitmap(bitmap);
          continue;
        }
        await drawViaImage(context, canvas, blob);
      }
    } finally {
      drawing.current = false;
    }
  }, []);

  // --- Remote clipboard round-trip ------------------------------------------
  // Reads are answered by an unlabelled frame, so at most one is in flight; a
  // second press supersedes the first rather than queueing behind it.
  const pendingRead = useRef<{ resolve: (text: string) => void; reject: (error: Error) => void; timer: number } | null>(null);
  const settleRead = useCallback((text: string | null) => {
    const pending = pendingRead.current;
    if (!pending) return;
    pendingRead.current = null;
    window.clearTimeout(pending.timer);
    if (text === null) pending.reject(new Error("Remote clipboard read did not complete"));
    else pending.resolve(text);
  }, []);

  const readRemoteClipboard = useCallback(() => new Promise<string>((resolve, reject) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) { reject(new Error("Display socket is not open")); return; }
    settleRead(null);
    pendingRead.current = { resolve, reject, timer: window.setTimeout(() => settleRead(null), CLIPBOARD_TIMEOUT_MS) };
    socket.send(JSON.stringify({ type: "clipboard", action: "read" }));
  }), [settleRead]);

  const copyFromRemote = useCallback(async () => {
    // navigator.clipboard exists only in a secure context; over plain http on a
    // LAN address there is nothing to fall back to, so say so plainly.
    if (!navigator.clipboard) { toast.error(t("preview.clipboardUnavailable")); return; }
    try {
      const text = await readRemoteClipboard();
      if (!text) { toast.info(t("preview.clipboardEmpty")); return; }
      await navigator.clipboard.writeText(text);
      toast.success(t("preview.clipboardCopied"));
    } catch {
      toast.error(t("preview.clipboardFailed"));
    }
  }, [readRemoteClipboard, t]);

  const pasteToRemote = useCallback(async () => {
    if (!navigator.clipboard) { toast.error(t("preview.clipboardUnavailable")); return; }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast.info(t("preview.clipboardEmpty")); return; }
      send({ type: "clipboard", action: "write", text: text.slice(0, CLIPBOARD_MAX_CHARS) });
      toast.success(t("preview.clipboardPasted"));
    } catch {
      toast.error(t("preview.clipboardFailed"));
    }
  }, [send, t]);

  useImperativeHandle(ref, () => ({
    copyFromRemote: () => { void copyFromRemote(); },
    pasteToRemote: () => { void pasteToRemote(); },
    resyncViewport: () => applyViewport(true),
  }), [applyViewport, copyFromRemote, pasteToRemote]);

  useEffect(() => {
    if (!active) { socketRef.current?.close(); socketRef.current = null; setState("idle"); return; }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/display/socket?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(request.id)}`);
    // Blobs feed createImageBitmap directly, so the frame never crosses the
    // main thread as a typed array.
    socket.binaryType = "blob";
    socketRef.current = socket;
    setState("connecting");
    setMessage("");
    setClipboardReady(false);

    // The very first resize is load-bearing beyond geometry: the provider reads
    // its device scale from it to pick the remote surface's render density, and
    // it only waits a moment before falling back to 1x. Announcing on open is
    // the earliest this client can possibly speak.
    socket.onopen = () => applyViewport(true);

    socket.onmessage = (event) => {
      const data: unknown = event.data;
      if (data instanceof Blob) { pendingFrame.current = data; void drawNewest(); return; }
      if (data instanceof ArrayBuffer) { pendingFrame.current = new Blob([data], { type: mediaType.current }); void drawNewest(); return; }
      try {
        const frame = JSON.parse(String(data)) as StreamInbound;
        if (frame.type === "clipboard") { settleRead(typeof frame.text === "string" ? frame.text : ""); return; }
        if (frame.type === "hello") {
          const media = String(frame.media);
          mediaType.current = media.includes("/") ? media : `image/${media}`;
          const input: readonly string[] = frame.input ?? [];
          setClipboardReady(input.includes("clipboard"));
          capabilityHandler.current?.(request.id, input);
          // `hello` is the one message every client is guaranteed on attach.
          // `state: "ready"` is NOT: a provider that is already running (the
          // pop-out joining the panel's live surface) never re-announces it, so
          // without this a late client keeps whatever its first ResizeObserver
          // pass computed and can stream at 1x on a retina display forever.
          applyViewport(true);
          return;
        }
        if (frame.type === "state") {
          setState(frame.state === "error" ? "error" : frame.state);
          setMessage(frame.message ?? "");
          // A fresh provider renders at its own default size until told
          // otherwise, so the viewport is re-asserted on every ready.
          if (frame.state === "ready") applyViewport(true);
        }
      } catch { /* ignore unknown negotiated extensions */ }
    };
    socket.onerror = () => { settleRead(null); setState("error"); setMessage(t("preview.connectionFailed")); };
    socket.onclose = () => { settleRead(null); setState((current) => current === "error" ? current : "idle"); };
    return () => { settleRead(null); socket.close(); socketRef.current = null; pendingFrame.current = null; };
  }, [active, applyViewport, drawNewest, request.id, sessionId, settleRead, t]);

  useEffect(() => { if (reloadToken > 0) send({ type: "reload" }); }, [reloadToken, send]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    // Fires once on observe, which is what establishes the initial viewport.
    const observer = new ResizeObserver(() => applyViewport());
    observer.observe(canvas);
    // Zooming fires resize, so the CSS box and the device grid both stay
    // honest through it.
    const onWindowResize = () => applyViewport();
    window.addEventListener("resize", onWindowResize);
    // Dragging the window to a display with a different density, however,
    // changes devicePixelRatio with NO resize and NO CSS box change, and the
    // density is exactly what the provider renders at — leaving it stale is how
    // a whole session ends up soft. A resolution query is the only thing that
    // reports it: it matches while the ratio holds and fires once when it
    // stops, so each change re-arms the next watch.
    let density: MediaQueryList | null = null;
    function onDensityChange(): void {
      applyViewport();
      watchDensity();
    }
    function watchDensity(): void {
      density?.removeEventListener("change", onDensityChange);
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      density.addEventListener("change", onDensityChange);
    }
    watchDensity();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      density?.removeEventListener("change", onDensityChange);
    };
  }, [active, applyViewport]);

  /** Remote input space is the viewport we asked for, in its CSS pixels — NOT
   *  the backing store, which is that size times the device scale factor. */
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = viewportRef.current;
    const width = viewport?.width ?? rect.width;
    const height = viewport?.height ?? rect.height;
    return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height };
  };

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#fff" }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={request.title ?? t("preview.frameTitle")}
        onContextMenu={(event) => event.preventDefault()}
        onPointerMove={(event) => send({ type: "pointer", action: "move", ...point(event) })}
        onPointerDown={(event) => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); send({ type: "pointer", action: "down", button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left", ...point(event) }); }}
        onPointerUp={(event) => send({ type: "pointer", action: "up", button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left", ...point(event) })}
        onWheel={(event) => { event.preventDefault(); send({ type: "pointer", action: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, ...point(event as unknown as React.PointerEvent<HTMLCanvasElement>) }); }}
        onKeyDown={(event) => {
          // Copy/paste are intercepted rather than forwarded: the accelerator
          // has to act on THIS device's clipboard for the transfer to feel
          // native, exactly like a remote-desktop client. Every other key,
          // Ctrl+A and Tab included, still reaches the surface untouched.
          const accelerator = clipboardReady ? clipboardAccelerator(event) : null;
          if (accelerator) {
            event.preventDefault();
            if (accelerator === "copy") void copyFromRemote();
            else void pasteToRemote();
            return;
          }
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) send({ type: "keyboard", action: "text", text: event.key });
          else send({ type: "keyboard", action: "down", key: event.key, code: event.code, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
          event.preventDefault();
        }}
        onKeyUp={(event) => {
          // An intercepted accelerator was never pressed remotely, so releasing
          // it must not be reported either.
          if (clipboardReady && clipboardAccelerator(event)) { event.preventDefault(); return; }
          if (event.key.length !== 1 || event.ctrlKey || event.metaKey) send({ type: "keyboard", action: "up", key: event.key, code: event.code });
          event.preventDefault();
        }}
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
});

/** Fallback for engines without createImageBitmap: decode on the main thread
 *  and blit into the existing backing store, exactly as transferFromImageBitmap
 *  does — the store the viewport established stays authoritative, and a frame
 *  that already matches it is a 1:1 copy. Softer only in latency, never in
 *  sharpness. */
function drawViaImage(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const decoded = new Promise<void>((resolve) => {
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve();
    };
    // A frame that fails to decode is skipped, never retried: the next one is
    // milliseconds away and more current anyway.
    image.onerror = () => { URL.revokeObjectURL(url); resolve(); };
  });
  image.src = url;
  return decoded;
}
