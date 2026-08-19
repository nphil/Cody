import puppeteer, { type Browser, type CDPSession, type MouseButton, type Page } from "puppeteer-core";
import type { WebSocket } from "ws";
// Mutually recursive with this module by design: the two providers are one
// subsystem — the H.264 one degrades INTO the raster one and reuses its
// Chromium flags, input table and clamps. Both directions are referenced only
// inside function bodies, never at module-evaluation time, so the cycle
// resolves under both jiti/CJS and native ESM.
import { H264WebProvider, h264Available } from "./h264-provider";
import { getLatestDisplayRequest } from "./bus";
import { attachAppLogCapture, type AppLogDetach } from "../logs/capture";
import type { DisplayClientControl, DisplayProviderDescriptor, DisplayRequestV1, DisplayStreamState } from "./types";
import { CHROMIUM_GPU_ARGS, CHROMIUM_SOFTWARE_ARGS, SOFTWARE_RENDERERS, gpuRenderNode } from "../chromium-gpu";

export interface DisplayProvider {
  readonly descriptor: DisplayProviderDescriptor;
  readonly requestId: string;
  attach(socket: WebSocket): void;
  dispose(): Promise<void>;
}

interface ProviderState {
  providers: Map<string, DisplayProvider>;
}

declare global {
  var __codyDisplayProviders: ProviderState | undefined;
}

export const IDLE_DISPOSE_MS = 30_000;
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/**
 * Text-friendly encode. 82 was cheap but visibly muddied antialiased glyph
 * edges — the one thing a dev-server preview cannot afford — and 90 is the knee
 * where JPEG stops smearing 1px stems, for a modest bitrate rise.
 */
const JPEG_QUALITY = 90;
/** Clamp on the client's reported device pixel ratio (CDP `deviceScaleFactor`). */
export const MIN_DEVICE_SCALE = 1;
export const MAX_DEVICE_SCALE = 3;
/** Per-axis ceiling on the captured bitmap, so a large panel at high density cannot ask for an absurd surface. */
export const MAX_FRAME_EDGE = 4_096;
/**
 * How long the first attach waits for a client `resize` before launching
 * Chromium anyway. Capture density is a launch-time property (see `start`), and
 * the client's device pixel ratio only arrives on that first resize — so the
 * choice is a sub-RTT pause here or a soft stream for the whole session. A real
 * client answers in one round trip and never spends the full grace.
 */
export const START_GRACE_MS = 400;
/** Retry cadence for an ack withheld by socket backpressure. */
const ACK_DRAIN_MS = 16;
/** Upper bound on a clipboard payload in either direction. */
export const MAX_CLIPBOARD_CHARS = 1024 * 1024;
/** `Input.insertText` is a synthetic typing burst, not a paste; keep it bounded. */
export const MAX_INSERT_TEXT_CHARS = 8_192;
/**
 * Flags every launch carries, GPU or not. `--no-sandbox` +
 * `--disable-setuid-sandbox`: the container runs as uid 0, where Chromium's
 * sandbox refuses to start. `--disable-dev-shm-usage`: Docker's default 64MB
 * /dev/shm is smaller than the compositor's transport buffers expect. Both
 * branches append `--force-device-scale-factor` after these — see `start()` for
 * why that one is load-bearing.
 */
export const CHROMIUM_BASE_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"];

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/**
 * Runs inside the remote surface. Chromium keeps a form control's selection out
 * of `window.getSelection()`, so a textarea/input has to be read off
 * `activeElement` first or "copy from the preview" silently returns nothing on
 * exactly the elements people select text in.
 */
export const READ_SELECTION_JS = `(() => {
  try {
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && start !== end) return String(el.value).slice(start, end);
    }
  } catch { /* selectionStart throws on input types that cannot hold one */ }
  return String(window.getSelection() ?? "");
})()`;

/**
 * Chromium routes a keyDown to an editor command — select-all, caret movement,
 * delete-word — through `windowsVirtualKeyCode`, NOT through `key`/`code`.
 * Dispatch without one and Ctrl+A, Home/End, Backspace and the arrows are
 * silently inert: the event reaches the page, but no editing command runs.
 */
const VIRTUAL_KEY_BY_CODE: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20,
  Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100,
  Numpad5: 101, Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189,
  Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
  BracketRight: 221, Quote: 222,
};

export function virtualKeyCode(key: string, code: string): number {
  const named = VIRTUAL_KEY_BY_CODE[code];
  if (named !== undefined) return named;
  // KeyA -> 65, Digit1 -> 49: for letters and digits the trailing character of
  // the physical code already IS the Windows virtual key.
  if (code.length === 4 && code.startsWith("Key")) return code.charCodeAt(3);
  if (code.length === 6 && code.startsWith("Digit")) return code.charCodeAt(5);
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

export function providerState(): ProviderState {
  return globalThis.__codyDisplayProviders ??= { providers: new Map() };
}

export function chromiumPath(): string {
  const configured = process.env.CODY_CHROMIUM_BIN?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return "chrome.exe";
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/chromium";
}

/**
 * The GPU process's real GL renderer, or null when it is software or cannot be
 * read. Never throws: an unanswerable probe reads as "not hardware", which sends
 * the caller down the software relaunch — the safe direction.
 */
export async function hardwareRenderer(browser: Browser): Promise<string | null> {
  try {
    const cdp = await browser.target().createCDPSession();
    const info = await cdp.send("SystemInfo.getInfo");
    await cdp.detach().catch(() => { /* the browser is about to be used or closed either way */ });
    // `auxAttributes` is untyped in the protocol definition; glRenderer is the
    // one field here worth trusting (see SOFTWARE_RENDERERS).
    const aux = info.gpu.auxAttributes as { glRenderer?: unknown } | undefined;
    const renderer = typeof aux?.glRenderer === "string" ? aux.glRenderer : "";
    if (!renderer) return null;
    const lower = renderer.toLowerCase();
    return SOFTWARE_RENDERERS.some((name) => lower.includes(name)) ? null : renderer;
  } catch {
    return null;
  }
}

export function sendJson(socket: WebSocket, value: DisplayStreamState): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

export class RasterWebProvider implements DisplayProvider {
  readonly descriptor = { renderer: "raster", media: ["image/jpeg"], audio: false, interactive: true } as const;
  readonly requestId: string;
  private request: DisplayRequestV1;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private clients = new Set<WebSocket>();
  private latestFrame: Buffer | null = null;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private sessionId: string;
  private viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
  /**
   * Density Chromium was launched at; fixed for the browser's lifetime because
   * it is a process flag, not a page property. A client reporting a HIGHER
   * deviceScaleFactor later — a monitor drag, or zooming past the launch
   * density — is deliberately NOT honoured: the only way to act on it is
   * relaunching, which re-navigates and destroys the page's scroll position,
   * form input and JS state. A soft frame costs the user one reopen (the idle
   * dispose then hands them a fresh provider at the current density); lost form
   * state costs them their work. This follows from the launch flag itself, not
   * from how the client noticed the change — removing any client-side density
   * watcher will not make it go away. DECREASES need no relaunch at all,
   * fractional ones included (150% zoom reports 1.5): they re-clamp against
   * this surface in `startScreencast`. A provider whose surface owns its own
   * density (X11/Wayland, Android) should honour both directions; the wire
   * already carries what it needs.
   */
  private captureScale = 1;
  private startTimer: NodeJS.Timeout | null = null;
  /** Screencast frame awaiting an ack that backpressure is holding back. */
  private pendingAck: number | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  /** Teardown for the console/network capture feeding lib/logs/ring. */
  private detachLogs: AppLogDetach | null = null;

  constructor(sessionId: string, request: DisplayRequestV1) {
    this.sessionId = sessionId;
    this.request = request;
    this.requestId = request.id;
  }

  attach(socket: WebSocket): void {
    if (this.disposed) { socket.close(1011, "Display disposed"); return; }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clients.add(socket);
    sendJson(socket, { type: "hello", version: 1, renderer: "raster", media: "jpeg", input: ["pointer", "keyboard", "resize", "reload", "clipboard"], requestId: this.request.id });
    sendJson(socket, { type: "state", state: this.page ? "ready" : "connecting" });
    if (this.latestFrame && socket.bufferedAmount < MAX_BUFFERED_BYTES) socket.send(this.latestFrame, { binary: true });
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const payload = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (payload.byteLength > 64 * 1024) return;
      try { this.control(socket, JSON.parse(payload.toString("utf8")) as DisplayClientControl).catch(() => { /* input races with navigation are non-fatal */ }); } catch { /* invalid controls are ignored */ }
    });
    socket.once("close", () => this.detach(socket));
    if (this.starting === null && this.startTimer === null) {
      this.startTimer = setTimeout(() => { this.startTimer = null; this.starting ??= this.start(); }, START_GRACE_MS);
    }
  }

  private async start(): Promise<void> {
    try {
      // Capture density is decided HERE and cannot be changed afterwards:
      // `Page.startScreencast` ignores the emulated deviceScaleFactor entirely
      // (that only changes what the page believes `devicePixelRatio` is) and
      // captures the host surface, whose density comes from this launch flag.
      // Measured on Chromium 1280x800: setViewport dsf 2 still yields a
      // 1280x800 JPEG, while --force-device-scale-factor=2 yields 2560x1600.
      // Cap it so the compositor surface for the launch viewport stays inside
      // MAX_FRAME_EDGE on both axes.
      const fit = Math.min(MAX_FRAME_EDGE / this.viewport.width, MAX_FRAME_EDGE / this.viewport.height);
      this.captureScale = Math.round(Math.max(MIN_DEVICE_SCALE, Math.min(this.viewport.deviceScaleFactor, fit)) * 100) / 100;
      this.browser = await this.launchBrowser();
      // dispose() cannot close a browser that did not exist yet, so a launch
      // that was abandoned mid-flight has to notice and clean up after itself.
      // The GPU branch widens this window — a capability probe, and possibly a
      // second launch — so it is checked rather than left to chance.
      if (this.disposed) {
        await this.browser.close().catch(() => { /* already gone is the desired end state */ });
        this.browser = null;
        return;
      }
      await this.grantClipboard();
      this.page = await this.browser.newPage();
      await this.page.setViewport(this.viewport);
      // The clipboard API refuses to run in an unfocused document, and a
      // headless page is not focused by default.
      await this.page.bringToFront().catch(() => { /* focus is best-effort */ });
      this.cdp = await this.page.createCDPSession();
      this.cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        // CDP hands us base64 inside its event JSON — that hop is internal to
        // the protocol and cannot be removed. Our own wire is this decoded
        // buffer as a binary WebSocket frame, so the client pays neither the
        // +33% base64 tax nor a JSON parse; JSON carries control/state only.
        const image = Buffer.from(frame.data, "base64");
        this.latestFrame = image;
        let sent = 0;
        let stalled = 0;
        for (const client of this.clients) {
          if (client.readyState !== client.OPEN) continue;
          // Drop-newest / keep-latest: a client that cannot keep up skips this
          // frame outright rather than queueing a backlog of stale ones.
          if (client.bufferedAmount >= MAX_BUFFERED_BYTES) { stalled += 1; continue; }
          client.send(image, { binary: true });
          sent += 1;
        }
        // Chromium renders no further frame until this ack, so the ack IS the
        // frame clock: ack the instant the frame is handed to the sockets, with
        // no artificial delay, and the stream runs at whatever fps the encoder
        // sustains. The single reason to withhold it is that every live client
        // is over the buffered-bytes threshold — then the socket itself, not a
        // timer, is reporting a saturated link, and stalling the encoder beats
        // encoding frames we would only discard. One slow client among several
        // does not stall the rest; it just keeps losing frames above.
        if (sent === 0 && stalled > 0) { this.pendingAck = frame.sessionId; this.scheduleAckDrain(); return; }
        void this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
      // Attached before navigation so the first load's own errors are caught.
      // This page's console is the only view the model has of the app it is
      // building, and the capture is shared with the H.264 rung — one copy of
      // the protocol handling, in lib/logs/capture.
      this.detachLogs = await attachAppLogCapture(this.sessionId, this.page);
      await this.page.goto(this.request.source.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.startScreencast();
      for (const client of this.clients) sendJson(client, { type: "state", state: "ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start preview renderer";
      for (const client of this.clients) sendJson(client, { type: "state", state: "error", message });
    }
  }

  /**
   * Launches Chromium, preferring GPU rasterization when the boot probe found a
   * DRM render node. Fail-safe by construction: a throwing launch, a GPU process
   * that quietly landed on llvmpipe/SwiftShader, and a probe that cannot answer
   * all take the same exit — close that browser, say why, and relaunch once on
   * the software flags. A broken GPU stack costs the operator a log line, never
   * their preview.
   *
   * Both branches end in `--force-device-scale-factor`, which is load-bearing
   * (see `start()`): it alone decides the captured surface's density, so it has
   * to survive every path through here.
   */
  private async launchBrowser(): Promise<Browser> {
    const density = `--force-device-scale-factor=${this.captureScale}`;
    const node = gpuRenderNode();
    if (node) {
      let candidate: Browser | null = null;
      let downgrade = "";
      try {
        candidate = await puppeteer.launch({
          executablePath: chromiumPath(),
          headless: true,
          args: [...CHROMIUM_BASE_ARGS, ...CHROMIUM_GPU_ARGS, density],
        });
        const renderer = await hardwareRenderer(candidate);
        if (renderer) {
          console.log(`[Cody] display: GPU rasterization on ${node} — ${renderer}`);
          return candidate;
        }
        downgrade = "GPU process reported a software renderer";
      } catch (error) {
        downgrade = error instanceof Error ? error.message.slice(0, 200) : "Chromium did not start with GPU flags";
      }
      // A half-started browser still owns a process and a profile dir; letting
      // that leak would cost more than the failed launch did.
      await candidate?.close().catch(() => { /* nothing left to salvage */ });
      console.log(`[Cody] display: GPU launch failed on ${node} (${downgrade}) — falling back to software rendering`);
    }
    return puppeteer.launch({
      executablePath: chromiumPath(),
      headless: true,
      args: [...CHROMIUM_BASE_ARGS, ...CHROMIUM_SOFTWARE_ARGS, density],
    });
  }

  /**
   * Clipboard access is permission-gated even on a loopback secure origin, and
   * headless Chromium has no prompt anyone could answer. Grant it up front for
   * the target origin only (puppeteer maps this onto CDP
   * `Browser.grantPermissions`): `clipboard-read` becomes the protocol's
   * `clipboardReadWrite`, and `clipboard-sanitized-write` is the one
   * `navigator.clipboard.writeText()` actually checks.
   */
  private async grantClipboard(): Promise<void> {
    const browser = this.browser;
    if (!browser) return;
    try {
      const origin = new URL(this.request.source.url).origin;
      await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-sanitized-write"]);
    } catch { /* clipboard degrades to empty reads; never block the stream on it */ }
  }

  private scheduleAckDrain(): void {
    if (this.ackTimer !== null) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      const sessionId = this.pendingAck;
      if (sessionId === null || this.disposed) return;
      let open = 0;
      let ready = 0;
      for (const client of this.clients) {
        if (client.readyState !== client.OPEN) continue;
        open += 1;
        if (client.bufferedAmount < MAX_BUFFERED_BYTES) ready += 1;
      }
      if (open > 0 && ready === 0) { this.scheduleAckDrain(); return; }
      this.pendingAck = null;
      void this.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    }, ACK_DRAIN_MS);
  }

  private async startScreencast(): Promise<void> {
    const { width, height, deviceScaleFactor } = this.viewport;
    // maxWidth/maxHeight only ever SHRINK the frame — Chromium clamps its own
    // scale factor to <=1 — so these cannot recover density, they can only stop
    // us shipping more pixels than the client owns. The surface is
    // width x height at `captureScale`; ask for the client's real device pixels,
    // and when the client is denser than the surface just take the surface.
    // The old fixed 1920x1200 pair silently downscaled any panel wider than
    // 1920 CSS px, blurring exactly the frames that needed detail most.
    const scale = Math.min(deviceScaleFactor, this.captureScale);
    const maxWidth = Math.min(MAX_FRAME_EDGE, Math.ceil(width * scale));
    const maxHeight = Math.min(MAX_FRAME_EDGE, Math.ceil(height * scale));
    // Frames from the previous screencast session can never be acked now.
    this.pendingAck = null;
    await this.cdp?.send("Page.startScreencast", { format: "jpeg", quality: JPEG_QUALITY, maxWidth, maxHeight, everyNthFrame: 1 });
  }

  /** Evaluates in the remote surface; a thrown or non-string result reads as "". */
  private async evaluate(expression: string, awaitPromise: boolean): Promise<string> {
    const cdp = this.cdp;
    if (!cdp) return "";
    try {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true, timeout: 2_000 });
      if (result.exceptionDetails) return "";
      const value: unknown = result.result?.value;
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  private async readSelection(): Promise<string> {
    const page = this.page;
    if (!page) return "";
    // A selection lives in whichever frame owns it and is invisible to the top
    // frame, so walk them all and take the first that holds one.
    for (const frame of page.frames()) {
      const text: unknown = await frame.evaluate(READ_SELECTION_JS).catch(() => "");
      if (typeof text === "string" && text.length > 0) return text.slice(0, MAX_CLIPBOARD_CHARS);
    }
    return "";
  }

  /** Never rejects: the client blocks its copy affordance on an answer. */
  private async clipboardRead(): Promise<string> {
    const selection = await this.readSelection().catch(() => "");
    if (selection) return selection;
    const clipboard = await this.evaluate("navigator.clipboard.readText()", true);
    return clipboard.slice(0, MAX_CLIPBOARD_CHARS);
  }

  private async clipboardWrite(text: string): Promise<void> {
    const payload = text.slice(0, MAX_CLIPBOARD_CHARS);
    if (!payload) return;
    // Seed the remote clipboard first so a subsequent in-surface Ctrl+V yields
    // the whole payload, then type its head at the caret. The two limits differ
    // on purpose: insertText is a keystroke burst, the clipboard is storage.
    await this.evaluate(`navigator.clipboard.writeText(${JSON.stringify(payload)})`, true);
    await this.cdp?.send("Input.insertText", { text: payload.slice(0, MAX_INSERT_TEXT_CHARS) }).catch(() => {});
  }

  private async control(socket: WebSocket, frame: DisplayClientControl): Promise<void> {
    const page = this.page;
    // Resize is handled before the page guard on purpose: the first one lands
    // while Chromium is still launching, and it is the only message that
    // carries the client's pixel density.
    if (frame.type === "resize") {
      const width = Math.max(320, Math.min(2560, Math.round(frame.width)));
      const height = Math.max(240, Math.min(1600, Math.round(frame.height)));
      const deviceScaleFactor = Math.max(MIN_DEVICE_SCALE, Math.min(MAX_DEVICE_SCALE, frame.deviceScaleFactor ?? 1));
      if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(deviceScaleFactor)) return;
      this.viewport = { width, height, deviceScaleFactor };
      if (this.startTimer !== null) {
        // The density we were waiting for just arrived — stop waiting.
        clearTimeout(this.startTimer);
        this.startTimer = null;
        this.starting ??= this.start();
        return;
      }
      if (!page) return;
      await page.setViewport(this.viewport);
      // Device-metrics changes drop the screencast's pending frame, and a
      // static page produces no further damage on its own; restart so every
      // client gets a fresh frame at the new size — and so the capture bounds
      // pick up the new dimensions.
      await this.cdp?.send("Page.stopScreencast").catch(() => {});
      await this.startScreencast().catch(() => {});
      return;
    }
    if (!page) return;
    if (frame.type === "reload") { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); return; }
    if (frame.type === "clipboard") {
      if (frame.action === "read") { sendJson(socket, { type: "clipboard", text: await this.clipboardRead() }); return; }
      if (typeof frame.text === "string") await this.clipboardWrite(frame.text);
      return;
    }
    if (frame.type === "pointer") {
      if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return;
      const button = (frame.button ?? "left") as MouseButton;
      if (frame.action === "move") await page.mouse.move(frame.x, frame.y);
      else if (frame.action === "down") await page.mouse.down({ button });
      else if (frame.action === "up") await page.mouse.up({ button });
      else await page.mouse.wheel({ deltaX: frame.deltaX ?? 0, deltaY: frame.deltaY ?? 0 });
      return;
    }
    if (frame.type === "keyboard" && this.cdp) {
      if (frame.action === "text") {
        if (frame.text) await this.cdp.send("Input.insertText", { text: frame.text.slice(0, MAX_INSERT_TEXT_CHARS) });
        return;
      }
      const type = frame.action === "down" ? "keyDown" : "keyUp";
      const key = frame.key ?? "";
      const code = frame.code ?? "";
      // Printable characters are deliberately NOT resolved into `text` here:
      // they arrive on the `insertText` path above, and setting both would type
      // every character twice.
      const virtual = virtualKeyCode(key, code);
      await this.cdp.send("Input.dispatchKeyEvent", { type, key, code, modifiers: frame.modifiers ?? 0, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    }
  }

  private detach(socket: WebSocket): void {
    this.clients.delete(socket);
    if (this.clients.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { void this.dispose(); }, IDLE_DISPOSE_MS);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer ?? undefined);
    clearTimeout(this.startTimer ?? undefined);
    this.startTimer = null;
    clearTimeout(this.ackTimer ?? undefined);
    this.ackTimer = null;
    this.pendingAck = null;
    for (const client of this.clients) client.close(1001, "Display closed");
    this.clients.clear();
    this.detachLogs?.();
    this.detachLogs = null;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.cdp = null;
    this.browser = null;
    const state = providerState();
    if (state.providers.get(this.sessionId) === this) state.providers.delete(this.sessionId);
  }
}

export function attachDisplaySocket(sessionId: string, socket: WebSocket): void {
  const request = getLatestDisplayRequest(sessionId);
  // Every ladder terminates in a stream candidate, so any published request is
  // legitimately streamable — the client either resolved to the floor or fell
  // back to it. Only a session with nothing published is refused.
  if (!request) {
    sendJson(socket, { type: "state", state: "error", message: "No streamed preview is available for this session" });
    socket.close(1008, "No display request");
    return;
  }
  const state = providerState();
  let provider = state.providers.get(sessionId);
  if (!provider || provider.requestId !== request.id) {
    if (provider) void provider.dispose();
    // The H.264 rung is chosen optimistically, before the client has said a
    // word: the wire demands `hello` first, and `hello` carries the renderer.
    // Everything the encoder needs that a client can veto — a supported
    // `avc1.*` decoder, a working Xvfb/ffmpeg pipeline, a first frame — is
    // checked afterwards, and any of those failing hands the session's sockets
    // to a fresh RasterWebProvider (see H264WebProvider.degrade).
    provider = h264Available() ? new H264WebProvider(sessionId, request) : new RasterWebProvider(sessionId, request);
    state.providers.set(sessionId, provider);
  }
  provider.attach(socket);
}

export async function disposeDisplayProviders(): Promise<void> {
  const providers = [...providerState().providers.values()];
  providerState().providers.clear();
  await Promise.all(providers.map((provider) => provider.dispose()));
}
