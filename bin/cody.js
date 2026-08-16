#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions, readEnv } = require("./cody-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isPortAvailable } = require("./port-availability");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");
const serverBin = path.join(__dirname, "cody-server.js");

const { port, hostname, openBrowser } = parseLaunchOptions();
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const passwordEnabled = Boolean(readEnv("PASSWORD"));

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

if (!loopbackHostnames.has(hostname)) {
  if (!passwordEnabled) {
    console.error(`Refusing to listen on ${hostname} without CODY_PASSWORD. Set a strong password or bind to 127.0.0.1.`);
    process.exit(1);
  }
  console.warn(`Warning: Cody is listening on ${hostname} with Basic Auth over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`);
}

const serverArgs = ["--experimental-strip-types", serverBin, "-p", port, "-H", hostname];

// Run Cody's custom Next server so terminal WebSocket upgrades share the same
// authenticated origin as the rest of the application.
const url = `http://${hostname}:${port}`;

async function main() {
  if (!await isPortAvailable(port, hostname)) {
    console.error(`Port ${port} on ${hostname} is already in use.`);
    console.error(`If Cody is already running, open ${url}. Otherwise, stop the process using it or run: cody --port ${Number(port) + 1}`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, serverArgs, {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      CODY_PACKAGE_DIR: pkgDir,
      CODY_LAUNCHER_PID: String(process.pid),
      CODY_PORT: port,
      CODY_HOSTNAME: hostname,
    },
  });

  let browserOpened = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (openBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      const openCmd = isWindows ? "explorer.exe" : isMac ? "open" : "xdg-open";
      const opener = spawn(openCmd, [url], {
        stdio: "ignore",
        detached: true,
      });

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(`Could not check whether ${url} is available: ${error.message}`);
  process.exit(1);
});
