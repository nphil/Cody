import puppeteer, { type Browser, type CDPSession, type MouseButton, type Page } from "puppeteer-core";
import type { WebSocket } from "ws";
import { getLatestDisplayRequest } from "./bus";
import type { DisplayClientControl, DisplayProviderDescriptor, DisplayRequestV1, DisplayStreamState } from "./types";

export interface DisplayProvider {
  readonly descriptor: DisplayProviderDescriptor;
  readonly requestId: string;
  attach(socket: WebSocket): void;
  dispose(): Promise<void>;
}

interface ProviderState {
  providers: Map<string, RasterWebProvider>;
}

declare global {
  var __codyDisplayProviders: ProviderState | undefined;
}

const IDLE_DISPOSE_MS = 30_000;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function providerState(): ProviderState {
  return globalThis.__codyDisplayProviders ??= { providers: new Map() };
}

function chromiumPath(): string {
  const configured = process.env.CODY_CHROMIUM_BIN?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return "chrome.exe";
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/chromium";
}

function sendJson(socket: WebSocket, value: DisplayStreamState): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

class RasterWebProvider implements DisplayProvider {
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
    sendJson(socket, { type: "hello", version: 1, renderer: "raster", media: "jpeg", input: ["pointer", "keyboard", "resize", "reload"], requestId: this.request.id });
    sendJson(socket, { type: "state", state: this.page ? "ready" : "connecting" });
    if (this.latestFrame && socket.bufferedAmount < MAX_BUFFERED_BYTES) socket.send(this.latestFrame, { binary: true });
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const payload = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (payload.byteLength > 64 * 1024) return;
      try { this.control(JSON.parse(payload.toString("utf8")) as DisplayClientControl).catch(() => { /* input races with navigation are non-fatal */ }); } catch { /* invalid controls are ignored */ }
    });
    socket.once("close", () => this.detach(socket));
    this.starting ??= this.start();
  }

  private async start(): Promise<void> {
    try {
      this.browser = await puppeteer.launch({
        executablePath: chromiumPath(),
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
      this.cdp = await this.page.createCDPSession();
      this.cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        void this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        this.latestFrame = Buffer.from(frame.data, "base64");
        for (const client of this.clients) {
          if (client.readyState === client.OPEN && client.bufferedAmount < MAX_BUFFERED_BYTES) client.send(this.latestFrame, { binary: true });
        }
      });
      await this.page.goto(this.request.source.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.startScreencast();
      for (const client of this.clients) sendJson(client, { type: "state", state: "ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start preview renderer";
      for (const client of this.clients) sendJson(client, { type: "state", state: "error", message });
    }
  }

  private async startScreencast(): Promise<void> {
    await this.cdp?.send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  }

  private async control(frame: DisplayClientControl): Promise<void> {
    const page = this.page;
    if (!page) return;
    if (frame.type === "reload") { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); return; }
    if (frame.type === "resize") {
      const width = Math.max(320, Math.min(2560, Math.round(frame.width)));
      const height = Math.max(240, Math.min(1600, Math.round(frame.height)));
      const deviceScaleFactor = Math.max(0.5, Math.min(2, frame.deviceScaleFactor ?? 1));
      if (Number.isFinite(width) && Number.isFinite(height)) {
        await page.setViewport({ width, height, deviceScaleFactor });
        // Device-metrics changes drop the screencast's pending frame, and a
        // static page produces no further damage on its own; restart so every
        // client gets a fresh frame at the new size.
        await this.cdp?.send("Page.stopScreencast").catch(() => {});
        await this.startScreencast().catch(() => {});
      }
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
        if (frame.text) await this.cdp.send("Input.insertText", { text: frame.text.slice(0, 8_192) });
        return;
      }
      const type = frame.action === "down" ? "keyDown" : "keyUp";
      await this.cdp.send("Input.dispatchKeyEvent", { type, key: frame.key ?? "", code: frame.code ?? "", modifiers: frame.modifiers ?? 0 });
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
    for (const client of this.clients) client.close(1001, "Display closed");
    this.clients.clear();
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
  if (!request || request.transport !== "stream") {
    sendJson(socket, { type: "state", state: "error", message: "No streamed preview is available for this session" });
    socket.close(1008, "No display request");
    return;
  }
  const state = providerState();
  let provider = state.providers.get(sessionId);
  if (!provider || provider.requestId !== request.id) {
    if (provider) void provider.dispose();
    provider = new RasterWebProvider(sessionId, request);
    state.providers.set(sessionId, provider);
  }
  provider.attach(socket);
}

export async function disposeDisplayProviders(): Promise<void> {
  const providers = [...providerState().providers.values()];
  providerState().providers.clear();
  await Promise.all(providers.map((provider) => provider.dispose()));
}
