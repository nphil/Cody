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

/** What the session is actually presenting, for the render-mode badge. A silent
 *  downgrade from H.264 to JPEG stills is the thing this exists to prevent. */
export interface StreamRenderMode {
  /** `hello.renderer` verbatim — a provider name, not something this client
   *  interprets. Today "raster" (JPEG stills) or "h264". */
  renderer: string;
  /** RFC 6381 codec of the running video stream; null while frames are stills. */
  codec: string | null;
  /** "recovering": the decoder faulted and a fresh keyframe was requested.
   *  "unsupported": this device cannot decode the codec the session runs. */
  status: "live" | "recovering" | "unsupported";
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
  /** Every renderer transition: `hello`, the first frame of a codec, a decoder
   *  fault, and a mid-session drop back to stills. */
  onRenderMode?: (requestId: string, mode: StreamRenderMode) => void;
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

/** Profiles offered to the provider, best first — it picks ONE codec for the
 *  whole session, so the order is a preference, not a list of equals. High
 *  buys CABAC and the 8x8 transform, which is real bitrate on text; Main and
 *  Constrained Baseline are floors any encoder can produce. These are the
 *  leading four hex digits of an RFC 6381 `avc1` string: profile_idc and the
 *  constraint-flags byte. */
const VIDEO_PROFILES = ["6400", "4D40", "42E0"];

/** level_idc in hex, HIGHEST first: 6.0, 5.2, 5.1, 5.0, 4.2, 4.1, 4.0, 3.1,
 *  3.0. A level in a decoder capability string is a ceiling, and H.264 levels
 *  are nested, so the highest one an engine accepts states its whole answer for
 *  that profile — and probing downward can never advertise a level BELOW what
 *  it really decodes. That matters here: this hardware's encoder derives
 *  level_idc from the frame size (5.0 at 2560x1600, 5.1 at 2880x1800), so a
 *  client that only ever claimed 3.0 would be claiming less than the truth. */
const VIDEO_LEVELS = ["3C", "34", "33", "32", "2A", "29", "28", "1F", "1E"];

/** H.264 codes in 16x16 macroblocks, so a coded frame can carry up to 15 px of
 *  alignment padding on the right and bottom edges. */
const MACROBLOCK = 16;

/** Consecutive decoder faults tolerated before the surface says so instead of
 *  cycling keyframe requests forever. Each fault costs one IDR. */
const VIDEO_FAULT_LIMIT = 4;

/** Nominal 30 fps in microseconds. The wire carries no timestamps — this is a
 *  live stream, painted the moment it decodes — but a decoder still wants a
 *  monotonic clock, so one is synthesized per access unit. */
const VIDEO_FRAME_INTERVAL_US = 33_333;

/** How far the PRESENTED picture may fall behind what the socket has already
 *  delivered before this client throws its queue away and rejoins on the next
 *  IDR. Ten frames at 30 fps, which is about a third of a second: past that an
 *  interactive surface stops being one, because a click lands on a page the
 *  viewer cannot see yet.
 *
 *  This ceiling has to exist somewhere, and only the client can measure it.
 *  Nothing throttles a WebCodecs decoder: `decode()` queues, the decoder hands
 *  frames back at whatever rate the pipeline sustains, and the provider's own
 *  backpressure watches `bufferedAmount`, which stays near zero here precisely
 *  BECAUSE this client drains the socket into that queue. Measured on this host,
 *  the queue is real: 2880x1808 decodes at 124 fps but decode-plus-drawImage
 *  runs at 19.8 fps against a 30 fps stream, and an unbounded queue turned that
 *  10 fps deficit into a stream that was minutes into the past while looking
 *  perfectly live — clicks reached the page, their effect was invisible. */
const VIDEO_MAX_BACKLOG_US = 10 * VIDEO_FRAME_INTERVAL_US;

/** Probed once per document: the answer is a property of the engine, and the
 *  provider holds off encoding until it has it, so a reconnect must not pay for
 *  a second round of async config checks. Advertising a codec this device
 *  cannot decode would strand the whole session on it, so nothing goes in this
 *  list that `VideoDecoder` has not accepted. */
let videoSupport: Promise<string[]> | null = null;
function supportedVideoCodecs(): Promise<string[]> {
  return videoSupport ??= (async () => {
    if (typeof VideoDecoder === "undefined") return [];
    const decodes = async (codec: string): Promise<boolean> => {
      try {
        const support = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
        return support.supported === true;
      } catch {
        // A codec string this engine cannot even parse is simply not offered.
        return false;
      }
    };
    const ceilings = await Promise.all(VIDEO_PROFILES.map(async (profile) => {
      for (const level of VIDEO_LEVELS) {
        const codec = `avc1.${profile}${level}`;
        if (await decodes(codec)) return codec;
      }
      return null;
    }));
    return ceilings.filter((codec): codec is string => codec !== null);
  })();
}

/** Inbound frames. `hello`, `video`, `state` and the clipboard answer all come
 *  from the server's own union; the extra clipboard variant only relaxes `text`,
 *  which the wire may omit. Every field read off one of these is still validated
 *  at runtime — the union is a claim about a JSON.parse result, not a check —
 *  and an unknown `type` falls through untouched, because an older provider must
 *  never break a newer client and a renderer this build has never heard of must
 *  still connect and stream. */
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
  { sessionId, request, active, reloadToken = 0, onCapabilities, onRenderMode },
  ref,
): ReactElement {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<StreamConnectionState>("idle");
  const [message, setMessage] = useState("");
  const [clipboardReady, setClipboardReady] = useState(false);
  /** Which surface is mounted. A canvas cannot change context kind once one is
   *  acquired — the JPEG path holds a `bitmaprenderer`, video needs a 2d
   *  context — so the negotiated renderer keys the canvas ELEMENT and the
   *  choice is made before the first frame of either kind lands. */
  const [presented, setPresented] = useState<"raster" | "video">("raster");
  const pendingFrame = useRef<Blob | null>(null);
  const drawing = useRef(false);
  /** From `hello.media`: a bare subtype ("jpeg") or a full MIME type. */
  const mediaType = useRef("image/jpeg");
  /** Contexts are cached per canvas ELEMENT, never per component: after a
   *  renderer swap the old element is gone, and presenting into it would paint
   *  a canvas nobody is showing. */
  const rasterSurface = useRef<{ canvas: HTMLCanvasElement; context: ImageBitmapRenderingContext | CanvasRenderingContext2D } | null>(null);
  const videoSurface = useRef<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null>(null);
  const viewportRef = useRef<{ width: number; height: number; deviceScaleFactor: number; storeWidth: number; storeHeight: number } | null>(null);
  const capabilityHandler = useRef(onCapabilities);
  capabilityHandler.current = onCapabilities;
  const renderModeHandler = useRef(onRenderMode);
  renderModeHandler.current = onRenderMode;
  /** Last mode handed to `onRenderMode`, so a per-frame report costs one string
   *  compare instead of a re-render. */
  const lastMode = useRef("");

  // --- H.264 rung ------------------------------------------------------------
  /** The running stream, from the provider's `video` announcement. Non-null is
   *  also what routes a binary message to the decoder instead of the JPEG path:
   *  frame bytes are never sniffed. */
  const videoTrack = useRef<{ codec: string; codedWidth?: number; codedHeight?: number } | null>(null);
  /** `hello.renderer`, for the badge. */
  const rungRenderer = useRef("raster");
  const decoderRef = useRef<VideoDecoder | null>(null);
  /** A delta before the first key is undecodable and throws: drop them. */
  const sawKey = useRef(false);
  /** At most one decoded frame is held, and only until the next paint. */
  const heldFrame = useRef<VideoFrame | null>(null);
  const paintHandle = useRef(0);
  const faults = useRef(0);
  /** True between a decoder fault and the first frame that decodes after it.
   *  Held as a ref so the badge is only reported on the transition, never once
   *  per decoded frame. */
  const recovering = useRef(false);
  const videoClock = useRef(0);
  /** Set when the decoder is past recovery: binary frames then stay away from
   *  the JPEG decoder too (H.264 bytes are not an image) until a fresh `hello`. */
  const videoDead = useRef(false);
  /** Access units decode in arrival order, so a Blob — readable only
   *  asynchronously — must not overtake the ArrayBuffer behind it. */
  const blobUnits = useRef(0);
  const unitChain = useRef<Promise<void>>(Promise.resolve());
  /** Breaks the openDecoder <-> faultVideo cycle. */
  const faultHandler = useRef<(error: unknown) => void>(() => {});
  /** Same, for the holdVideoFrame -> openDecoder direction. */
  const resyncHandler = useRef<() => void>(() => {});

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
    viewportRef.current = { width, height, deviceScaleFactor, storeWidth, storeHeight };
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
        // Cached per element, and only re-acquired on a miss: a renderer swap
        // replaces the canvas, and presenting into the old one would paint a
        // canvas nobody is showing.
        const cached = rasterSurface.current;
        let context = cached?.canvas === canvas ? cached.context : null;
        if (!context) {
          context = (typeof createImageBitmap === "function" ? canvas.getContext("bitmaprenderer") : null)
            ?? canvas.getContext("2d", { alpha: false });
          if (!context) continue;
          rasterSurface.current = { canvas, context };
        }
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

  // --- H.264 decode and present ----------------------------------------------

  const reportRenderMode = useCallback((mode: StreamRenderMode) => {
    // Reported on every decoded frame, so identical modes are dropped here
    // rather than churning the badge sixty times a second.
    const key = `${mode.renderer}|${mode.codec}|${mode.status}`;
    if (key === lastMode.current) return;
    lastMode.current = key;
    renderModeHandler.current?.(request.id, mode);
  }, [request.id]);

  /** Paints the newest decoded frame and closes it. Newest-wins matches the
   *  JPEG path, and closing is not optional: a `VideoFrame` pins a decoder
   *  buffer, the pool is a handful deep, and leaking one per frame stalls the
   *  stream outright — the classic WebCodecs bug. */
  const paintVideo = useCallback(() => {
    paintHandle.current = 0;
    const frame = heldFrame.current;
    if (!frame) return;
    heldFrame.current = null;
    try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cached = videoSurface.current;
      let context = cached?.canvas === canvas ? cached.context : null;
      if (!context) {
        // `desynchronized` skips a compositor round-trip on a surface whose only
        // future is being overwritten by the next frame. A null answer means
        // this element already holds the JPEG path's bitmaprenderer: the swap
        // has not committed yet, so drop the frame rather than paint an element
        // that is about to be replaced.
        context = canvas.getContext("2d", { alpha: false, desynchronized: true });
        if (!context) return;
        videoSurface.current = { canvas, context };
      }
      const visible = frame.visibleRect;
      const store = viewportRef.current;
      const width = presentedExtent(visible?.width ?? frame.codedWidth, store?.storeWidth);
      const height = presentedExtent(visible?.height ?? frame.codedHeight, store?.storeHeight);
      // The backing store adopts the frame's own presented size, exactly as
      // transferFromImageBitmap does for JPEG: the blit is 1:1 and CSS does the
      // only scaling there is.
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(frame, visible?.x ?? 0, visible?.y ?? 0, width, height, 0, 0, width, height);
    } finally {
      frame.close();
    }
  }, []);

  /** Decoder output. Frames arrive as fast as the encoder sent them, so
   *  painting on this callback would present two frames in one vsync for
   *  nothing; the paint is coalesced onto the next one instead. */
  const holdVideoFrame = useCallback((frame: VideoFrame) => {
    // A decoded frame is proof the pipeline is whole again: it clears the fault
    // budget, and takes the badge back out of "recovering" if it is showing it.
    faults.current = 0;
    const track = videoTrack.current;
    if (recovering.current && track) {
      recovering.current = false;
      reportRenderMode({ renderer: rungRenderer.current, codec: track.codec, status: "live" });
    }
    heldFrame.current?.close();
    heldFrame.current = frame;
    // A rAF handle is never 0, so 0 means "no paint scheduled".
    if (!paintHandle.current) paintHandle.current = requestAnimationFrame(paintVideo);
    // Presentation lag, measured where it is the difference between two numbers
    // this client already owns: the stream clock advances once per unit FED, and
    // the frame that just came out carries the clock value it was fed at. So this
    // is the whole pipeline's backlog — queued chunks, frames in the decoder's
    // pool, and output callbacks the main thread has not run yet — and not just
    // the part `decodeQueueSize` can see.
    if (videoClock.current - frame.timestamp > VIDEO_MAX_BACKLOG_US) resyncHandler.current();
  }, [paintVideo, reportRenderMode]);

  /** Drops the decoder and everything it still owns. */
  const releaseVideo = useCallback(() => {
    if (paintHandle.current) { cancelAnimationFrame(paintHandle.current); paintHandle.current = 0; }
    heldFrame.current?.close();
    heldFrame.current = null;
    const decoder = decoderRef.current;
    decoderRef.current = null;
    sawKey.current = false;
    if (decoder && decoder.state !== "closed") {
      try { decoder.close(); } catch { /* the engine had already torn it down */ }
    }
  }, []);

  /** (Re)configures the decoder for `track`. Annex-B, so NO `description`:
   *  every IDR carries its own SPS and PPS, which is what lets a late joiner —
   *  or a decoder that just reset — recover on the next keyframe. Returns false
   *  when this engine cannot run the codec at all. */
  const openDecoder = useCallback((track: { codec: string; codedWidth?: number; codedHeight?: number }): boolean => {
    if (typeof VideoDecoder === "undefined") return false;
    try {
      let decoder = decoderRef.current;
      // A reconfigure (the encoder restarted for a resize) keeps the decoder and
      // its hardware context; only its state and queued work are thrown away.
      if (decoder && decoder.state !== "closed") decoder.reset();
      else {
        decoder = new VideoDecoder({ output: holdVideoFrame, error: (error) => faultHandler.current(error) });
        decoderRef.current = decoder;
      }
      decoder.configure({ codec: track.codec, codedWidth: track.codedWidth, codedHeight: track.codedHeight, optimizeForLatency: true });
      sawKey.current = false;
      return true;
    } catch {
      releaseVideo();
      return false;
    }
  }, [holdVideoFrame, releaseVideo]);

  /** A decoder error is recoverable in principle: the stream is live, so the fix
   *  is a fresh IDR and a decoder to feed it to. It is reported either way — a
   *  surface that quietly stops updating is worse than one that says why. */
  const faultVideo = useCallback((error: unknown) => {
    const track = videoTrack.current;
    faults.current += 1;
    releaseVideo();
    if (!track || faults.current > VIDEO_FAULT_LIMIT || !openDecoder(track)) {
      videoDead.current = true;
      reportRenderMode({ renderer: rungRenderer.current, codec: track?.codec ?? null, status: "unsupported" });
      setState("error");
      setMessage(t("preview.videoDecodeFailed", { detail: error instanceof Error ? error.message : String(error) }));
      return;
    }
    recovering.current = true;
    reportRenderMode({ renderer: rungRenderer.current, codec: track.codec, status: "recovering" });
    // The provider stops sending deltas to this client until it has emitted the
    // next IDR, so this is cheap and idempotent; it does not restart anyone
    // else's encoder and does not answer with a fresh `video`.
    send({ type: "keyframe" });
  }, [openDecoder, releaseVideo, reportRenderMode, send, t]);
  faultHandler.current = faultVideo;

  /** Rejoins a stream this client has fallen too far behind to be interactive on.
   *  `reset()` is what makes it work: it drops every queued chunk and every frame
   *  the decoder still owns, so the backlog is gone in one call rather than paid
   *  off frame by frame. The next IDR restarts the picture, at most a GOP away,
   *  and the request for one costs the provider a flag: it stops sending THIS
   *  client deltas until then, which is also the bytes it would have wasted. A
   *  client that keeps up never gets here; one that cannot trades frame rate for
   *  being in the present, which is the only trade worth making on a surface
   *  someone is clicking on. */
  const resyncVideo = useCallback(() => {
    const track = videoTrack.current;
    if (!track) return;
    if (!openDecoder(track)) { faultHandler.current(new Error("the decoder could not be reset")); return; }
    send({ type: "keyframe" });
  }, [openDecoder, send]);
  resyncHandler.current = resyncVideo;

  /** The provider's `video` announcement: the start of a stream, and again on
   *  every encoder restart (a resize). */
  const startVideo = useCallback((announcement: { codec: string; codedWidth?: number; codedHeight?: number }) => {
    const track = {
      codec: announcement.codec,
      codedWidth: typeof announcement.codedWidth === "number" ? announcement.codedWidth : undefined,
      codedHeight: typeof announcement.codedHeight === "number" ? announcement.codedHeight : undefined,
    };
    videoTrack.current = track;
    videoDead.current = false;
    faults.current = 0;
    // Bytes, not Blobs: finding the NAL boundaries of an access unit has to
    // happen synchronously, in arrival order.
    const socket = socketRef.current;
    if (socket) socket.binaryType = "arraybuffer";
    if (!openDecoder(track)) {
      // The session's codec is fixed by its FIRST client, so this one cannot
      // renegotiate: it explains itself instead of showing a blank canvas.
      // `videoDead` also keeps the encoded bytes away from the JPEG decoder,
      // which would reject every one of them.
      videoDead.current = true;
      reportRenderMode({ renderer: rungRenderer.current, codec: track.codec, status: "unsupported" });
      setState("error");
      setMessage(t("preview.videoUnsupported", { codec: track.codec }));
      return;
    }
    setPresented("video");
    reportRenderMode({ renderer: rungRenderer.current, codec: track.codec, status: "live" });
  }, [openDecoder, reportRenderMode, t]);

  /** Back to stills. `hello` is authoritative about the rung, and the provider
   *  re-sends it when it drops H.264 mid-session — encoder failure, or a viewer
   *  that cannot decode what the session runs. */
  const stopVideo = useCallback((renderer: string) => {
    rungRenderer.current = renderer;
    releaseVideo();
    videoTrack.current = null;
    videoDead.current = false;
    faults.current = 0;
    recovering.current = false;
    setPresented("raster");
    reportRenderMode({ renderer, codec: null, status: "live" });
  }, [releaseVideo, reportRenderMode]);

  /** One WebSocket binary message is exactly one access unit. */
  const feedVideo = useCallback((bytes: Uint8Array) => {
    const decoder = decoderRef.current;
    if (!decoder || decoder.state !== "configured") return;
    const key = containsIdr(bytes);
    if (!key && !sawKey.current) return;
    sawKey.current = true;
    videoClock.current += VIDEO_FRAME_INTERVAL_US;
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: videoClock.current, data: bytes }));
    } catch (error) {
      faultVideo(error);
    }
  }, [faultVideo]);

  const pushVideoUnit = useCallback((data: ArrayBuffer | Blob) => {
    if (videoDead.current) return;
    // The fast path, and the only one the provider's binaryType ever produces.
    if (data instanceof ArrayBuffer && blobUnits.current === 0) { feedVideo(new Uint8Array(data)); return; }
    blobUnits.current += 1;
    unitChain.current = unitChain.current.then(async () => {
      try {
        feedVideo(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
      } finally {
        blobUnits.current -= 1;
      }
    });
  }, [feedVideo]);

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
    // Stills start as Blobs so they feed createImageBitmap directly, without the
    // frame ever crossing the main thread as a typed array. An H.264 stream
    // switches this to "arraybuffer" when `video` arrives: access units have to
    // be scanned for their NAL types synchronously, in arrival order.
    socket.binaryType = "blob";
    // Warmed now so the answer is ready when `hello` asks for it: the provider
    // will not start encoding until this client has told it what it can decode.
    void supportedVideoCodecs();
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
      // Which decoder a binary message belongs to is decided by the provider's
      // `video` announcement, never by sniffing the bytes.
      if (data instanceof Blob) {
        if (videoTrack.current) { pushVideoUnit(data); return; }
        pendingFrame.current = data; void drawNewest(); return;
      }
      if (data instanceof ArrayBuffer) {
        if (videoTrack.current) { pushVideoUnit(data); return; }
        pendingFrame.current = new Blob([data], { type: mediaType.current }); void drawNewest(); return;
      }
      try {
        const frame = JSON.parse(String(data)) as StreamInbound;
        if (frame.type === "clipboard") { settleRead(typeof frame.text === "string" ? frame.text : ""); return; }
        if (frame.type === "hello") {
          const media = String(frame.media);
          // On the H.264 rung `media` names a video codec, and this is only ever
          // the label a still frame is handed to createImageBitmap with, so a
          // video MIME type must never land in it.
          if (!media.startsWith("video/")) mediaType.current = media.includes("/") ? media : `image/${media}`;
          const input: readonly string[] = frame.input ?? [];
          setClipboardReady(input.includes("clipboard"));
          capabilityHandler.current?.(request.id, input);
          // A second `hello` is the provider re-establishing the rung, so it
          // tears any live stream down: that is how a mid-session drop back to
          // JPEG is followed instead of decoding stills as H.264.
          stopVideo(String(frame.renderer));
          // The provider is holding off encoding until it knows what this
          // browser can decode, so the answer goes out the moment the probe
          // settles — on THIS socket, never a reconnected one.
          void supportedVideoCodecs().then((decoders) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "capabilities", decoders }));
          });
          // `hello` is the one message every client is guaranteed on attach.
          // `state: "ready"` is NOT: a provider that is already running (the
          // pop-out joining the panel's live surface) never re-announces it, so
          // without this a late client keeps whatever its first ResizeObserver
          // pass computed and can stream at 1x on a retina display forever.
          applyViewport(true);
          return;
        }
        // Immediately precedes the first access unit of a stream, and is re-sent
        // whenever the encoder restarts.
        if (frame.type === "video") { startVideo(frame); return; }
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
    return () => { settleRead(null); socket.close(); socketRef.current = null; pendingFrame.current = null; releaseVideo(); videoTrack.current = null; };
  }, [active, applyViewport, drawNewest, pushVideoUnit, releaseVideo, request.id, sessionId, settleRead, startVideo, stopVideo, t]);

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
  }, [active, applyViewport, presented]);

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
      {/* A canvas cannot change context kind once one is acquired, so the
          renderer keys the ELEMENT: JPEG presents through a bitmaprenderer,
          H.264 through a 2d context. Swapping it is also what guarantees the
          choice is made before the first frame of either kind lands. */}
      <canvas
        key={presented}
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

/** The active rung's codec, named for a human. Shared by the panel's badge and
 *  the pop-out window so both say the same thing, and deliberately NOT a lookup
 *  keyed on the renderer: a codec this build has never heard of is shown
 *  verbatim rather than guessed at, because labelling a future VP9 or AV1 rung
 *  "H.264" would be exactly the silent lie the badge exists to prevent. */
export function codecLabelFor(mode: StreamRenderMode, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (mode.status === "unsupported") return t("preview.codecUnsupported");
  const name = mode.codec === null ? t("preview.codecStills")
    : mode.codec.startsWith("avc1.") || mode.codec.startsWith("avc3.") ? t("preview.codecH264")
      : mode.codec;
  return mode.status === "recovering" ? t("preview.codecRecovering", { codec: name }) : name;
}

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

/** Annex-B access unit → does it contain an IDR slice (NAL type 5)? The unit
 *  carries its own SPS and PPS, so the scan walks every start code rather than
 *  trusting the first: `[SPS][PPS][IDR]` is exactly what a keyframe looks like
 *  on this wire. Load-bearing, not a hint — a delta submitted to a decoder that
 *  has not seen a key throws, and the throw kills the decoder, not the frame. */
function containsIdr(bytes: Uint8Array): boolean {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    // Both start-code lengths occur in one stream: ffmpeg writes the 4-byte form
    // ahead of parameter sets and either form ahead of slices.
    const header = bytes[i + 2] === 1 ? i + 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? i + 4 : -1;
    if (header < 0 || header >= bytes.length) continue;
    if ((bytes[header] & 0x1f) === 5) return true;
    i = header - 1;
  }
  return false;
}

/** How much of a coded axis is real content. The provider aligns its capture
 *  rectangle up to a macroblock and puts the surface in the top-left, so the
 *  last <16 px of each axis can be alignment padding — never content, and it
 *  must not be shown. It must not be scaled away either: the pointer maps into
 *  the content size, so stretching padding into view would move every click.
 *  A difference of a macroblock or more is a genuine mismatch — a resize the
 *  encoder has not caught up with — and is presented whole so CSS scales it,
 *  exactly as a JPEG frame of the wrong size is today. Deliberate: CROP the
 *  padding, never letterbox, never stretch. */
function presentedExtent(coded: number, content: number | undefined): number {
  if (content === undefined || content >= coded) return coded;
  return coded - content < MACROBLOCK ? content : coded;
}
