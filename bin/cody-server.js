#!/usr/bin/env node
"use strict";

/* CommonJS is required so the packaged launcher can load Next and TypeScript modules directly. */
/* eslint-disable @typescript-eslint/no-require-imports */

const http = require("node:http");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const next = require("next");
const { WebSocket, WebSocketServer } = require("ws");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename);
const { getUserForCredentials, isAuthRequired } = jiti("../lib/auth/guard.ts");
const { canAccessSession } = jiti("../lib/auth/session-owners.ts");
const { attachDisplaySocket, disposeDisplayProviders } = jiti("../lib/display/provider.ts");
const { closeNativeGateway, proxyNativeHttp, proxyNativeUpgrade } = jiti("../lib/display/native-gateway.ts");
const { getTerminalManager } = jiti("../lib/terminal-manager.ts");

function parseArgs(argv) {
  const options = { dev: false, hostname: "127.0.0.1", port: 3000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dev") options.dev = true;
    else if (arg === "-H" || arg === "--hostname") options.hostname = argv[++i];
    else if (arg === "-p" || arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--help") { console.log("Usage: cody-server [--dev] [-H hostname] [-p port]"); process.exit(0); }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid port");
  return options;
}

function reject(socket, status, message, headers = {}) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
  socket.destroy();
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = request.headers.host;
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol = typeof forwardedProto === "string" ? forwardedProto.split(",")[0].trim() : request.headers["x-forwarded-ssl"] === "on" ? "https" : "http";
    return url.origin === `${protocol}://${host}`;
  } catch { return false; }
}

function terminalPath(url) { return /^\/api\/terminals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/socket$/i.test(new URL(url, "http://localhost").pathname); }
function displayPath(url) { return new URL(url, "http://localhost").pathname === "/api/display/socket"; }

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  process.env.CODY_INTERNAL_DISPLAY_SECRET ||= randomBytes(32).toString("base64url");
  process.env.CODY_INTERNAL_DISPLAY_ORIGIN = `http://127.0.0.1:${options.port}`;
  process.env.CODY_PACKAGE_DIR ||= path.resolve(__dirname, "..");
  const app = next({ dev: options.dev, hostname: options.hostname, port: options.port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();
  const terminalWs = new WebSocketServer({ noServer: true, maxPayload: 1_100_000 });
  const displayWs = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const server = http.createServer((request, response) => {
    if (!proxyNativeHttp(request, response)) handle(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    if (proxyNativeUpgrade(request, socket, head)) return;
    if (displayPath(request.url || "")) {
      const user = getUserForCredentials(request.headers.cookie || null, request.headers.authorization || null);
      if (isAuthRequired() && !user) { reject(socket, 401, "Unauthorized"); return; }
      if (!originAllowed(request)) { reject(socket, 403, "Forbidden"); return; }
      const parsed = new URL(request.url, "http://localhost");
      const sessionId = parsed.searchParams.get("sessionId") || "";
      if (!sessionId || !canAccessSession(sessionId, user)) { reject(socket, 404, "Not Found"); return; }
      displayWs.handleUpgrade(request, socket, head, (ws) => attachDisplaySocket(sessionId, ws));
      return;
    }
    if (!terminalPath(request.url || "")) {
      void upgrade(request, socket, head).catch(() => socket.destroy());
      return;
    }
    // Browsers attach the session cookie to same-origin upgrades automatically;
    // Basic Auth stays accepted for pre-account clients.
    if (isAuthRequired() && !getUserForCredentials(request.headers.cookie || null, request.headers.authorization || null)) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (!originAllowed(request)) { reject(socket, 403, "Forbidden"); return; }
    const parsed = new URL(request.url, "http://localhost");
    const id = parsed.pathname.split("/")[3];
    const cols = Number(parsed.searchParams.get("cols") || 80);
    const rows = Number(parsed.searchParams.get("rows") || 24);
    try { getTerminalManager().resize(id, cols, rows); } catch (error) { reject(socket, 400, error instanceof Error ? error.message : "Invalid terminal"); return; }
    terminalWs.handleUpgrade(request, socket, head, (ws) => {
      const manager = getTerminalManager();
      let unsubscribe;
      try {
        unsubscribe = manager.subscribe(id, (event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); });
        ws.on("message", (raw, isBinary) => {
          if (isBinary || raw.length > 1_000_000) { ws.close(1009, "Frame too large"); return; }
          try {
            const frame = JSON.parse(raw.toString());
            if (!frame || typeof frame !== "object" || (frame.type !== "input" && frame.type !== "resize")) throw new Error("Invalid terminal frame");
            if (frame.type === "input") { if (typeof frame.data !== "string") throw new Error("Invalid input frame"); manager.write(id, frame.data); }
            else { if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows)) throw new Error("Invalid resize frame"); manager.resize(id, frame.cols, frame.rows); }
          } catch (error) { ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Invalid frame" })); }
        });
        ws.on("close", () => unsubscribe?.());
      } catch (error) { ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Terminal unavailable" })); ws.close(1011); }
    });
  });
  const shutdown = () => {
    getTerminalManager().dispose();
    terminalWs.close();
    void disposeDisplayProviders();
    closeNativeGateway();
    displayWs.close();
    server.close(() => { void app.close(); });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(options.port, options.hostname, () => console.log(`Cody server Ready at http://${options.hostname}:${options.port}`));
  return server;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { main, parseArgs, terminalPath, displayPath, originAllowed };
