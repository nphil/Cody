export type DisplayRequestMode = "auto" | "stream" | "native";
export type DisplayCandidateKind = "direct" | "native" | "stream";

/**
 * One way to show the preview, ordered by fidelity. A "direct" candidate is
 * the dev server's own origin on a routable interface (probed reachable by the
 * server), "native" is the authority-minted gateway URL, and "stream" is the
 * raster Chromium fallback that always works.
 */
export interface DisplayCandidate {
  kind: DisplayCandidateKind;
  /** Absent only for kind:"stream" (it uses the session WebSocket). */
  url?: string;
  /** Hostname the URL targets, for client-side preference ranking. */
  host?: string;
}

export interface WebDisplaySource {
  kind: "web";
  /** Loopback URL as seen by Cody's server/container. */
  url: string;
}

/** Provider-neutral request retained by Cody and delivered to the browser. */
export interface DisplayRequestV1 {
  version: 1;
  id: string;
  sessionId: string;
  source: WebDisplaySource;
  title?: string;
  requestedMode: DisplayRequestMode;
  /** Ranked best-fidelity-first. ALWAYS ends with { kind: "stream" }. */
  candidates: DisplayCandidate[];
  requestedAt: number;
}

export interface DisplayRequestInput {
  url: string;
  title?: string;
  mode?: DisplayRequestMode;
}

export type DisplayBusEvent =
  | { type: "snapshot"; request: DisplayRequestV1 | null }
  | { type: "request"; request: DisplayRequestV1 };

export interface DisplayStreamHello {
  type: "hello";
  version: 1;
  renderer: "raster" | "h264";
  media: "jpeg" | "video/H264";
  /**
   * Input channels this provider actually implements. The client MUST gate its
   * UI on this array rather than on `renderer`: a future X11/Wayland or Android
   * provider is free to advertise a different subset, and an older provider
   * that predates a channel simply omits it.
   */
  input: Array<"pointer" | "keyboard" | "resize" | "reload" | "clipboard">;
  requestId: string;
}

/**
 * Sent immediately before the first access unit of a stream, and again after
 * every encoder restart (resize, forced recovery). `codec` is the RFC 6381
 * string parsed out of the real SPS, so it always describes the bitstream on
 * the wire rather than what the server intended to produce.
 *
 * There is deliberately no `description` field: the bitstream is Annex-B, which
 * per the WebCodecs AVC registration is signalled by the ABSENCE of an
 * `AVCDecoderConfigurationRecord`. A client that sets `description` from this
 * message would be configuring the wrong format.
 */
export interface DisplayStreamVideo {
  type: "video";
  /** e.g. "avc1.4D4028" — profile_idc, constraint flags, level_idc as hex. */
  codec: string;
  /**
   * True coded (macroblock-aligned) size. The provider aligns its capture
   * rectangle up to a multiple of 16 so this equals what was captured and the
   * SPS carries no cropping; page content occupies the top-left
   * `viewport x deviceScaleFactor` pixels and the client crops to it.
   */
  codedWidth: number;
  codedHeight: number;
}

/** Answer to a client `{ type: "clipboard", action: "read" }`. Always sent, even empty. */
export interface DisplayStreamClipboard {
  type: "clipboard";
  text: string;
}

export type DisplayStreamState =
  | { type: "state"; state: "connecting" | "ready" | "error"; message?: string }
  | DisplayStreamHello
  | DisplayStreamVideo
  | DisplayStreamClipboard;

export type DisplayClientControl =
  | { type: "resize"; width: number; height: number; deviceScaleFactor?: number }
  | { type: "pointer"; action: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "middle" | "right"; deltaX?: number; deltaY?: number }
  | { type: "keyboard"; action: "down" | "up" | "text"; key?: string; code?: string; text?: string; modifiers?: number }
  | { type: "clipboard"; action: "read" }
  | { type: "clipboard"; action: "write"; text: string }
  /**
   * RFC 6381 codec strings the client verified with
   * `VideoDecoder.isConfigSupported`. Sent once, on receipt of `hello`. An empty
   * array means "no video decode" and pins the session to JPEG.
   */
  | { type: "capabilities"; decoders: string[] }
  /** Re-arm request after a decoder error: stop my deltas until the next IDR. */
  | { type: "keyframe" }
  | { type: "reload" };

/** Future providers (Android/X11/Wayland) implement this seam, commonly with WebRTC. */
export interface DisplayProviderDescriptor {
  renderer: "raster" | "h264" | "webrtc" | "native";
  media: readonly string[];
  audio: boolean;
  interactive: boolean;
}
