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
  renderer: "raster";
  media: "jpeg";
  input: Array<"pointer" | "keyboard" | "resize" | "reload">;
  requestId: string;
}

export type DisplayStreamState =
  | { type: "state"; state: "connecting" | "ready" | "error"; message?: string }
  | DisplayStreamHello;

export type DisplayClientControl =
  | { type: "resize"; width: number; height: number; deviceScaleFactor?: number }
  | { type: "pointer"; action: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "middle" | "right"; deltaX?: number; deltaY?: number }
  | { type: "keyboard"; action: "down" | "up" | "text"; key?: string; code?: string; text?: string; modifiers?: number }
  | { type: "reload" };

/** Future providers (Android/X11/Wayland) implement this seam, commonly with WebRTC. */
export interface DisplayProviderDescriptor {
  renderer: "raster" | "webrtc" | "native";
  media: readonly string[];
  audio: boolean;
  interactive: boolean;
}
