import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAPABILITY_PATH = join(DESKTOP_DIR, "src-tauri", "capabilities", "remote-server.json");
const REMOTE_ENV_KEY = "CODY_DESKTOP_REMOTE_URL";

const APP_PERMISSIONS = [
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "core:window:allow-start-dragging",
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-internal-toggle-maximize",
  "core:window:allow-is-maximized",
  "core:window:allow-close",
  "allow-desktop-info",
  "allow-desktop-config",
  "allow-desktop-config-save",
  "allow-open-external",
  "allow-runtime-update-check",
  "allow-runtime-update-apply",
  "allow-desktop-status",
  "allow-desktop-status-update",
  "allow-desktop-mark-read",
  "allow-desktop-test-sound",
];

/**
 * Parse only the small KEY=value subset needed by the desktop configuration.
 * This intentionally does not expand variables or load .env.example: the
 * example is documentation, never a build input.
 */
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return new Map();
  const values = new Map();
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"')) value = value.replace(/\\([\\"nrt])/g, (_, escaped) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escaped]);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(match[1], value);
  }
  return values;
}

/**
 * Resolve configuration in documented precedence order. A present but empty
 * process variable deliberately disables lower-precedence env files.
 */
function configuredRemoteUrl() {
  if (Object.prototype.hasOwnProperty.call(process.env, REMOTE_ENV_KEY)) {
    return process.env[REMOTE_ENV_KEY]?.trim() || null;
  }
  for (const fileName of [".env.local", ".env"]) {
    const value = parseEnvFile(join(DESKTOP_DIR, fileName));
    if (value.has(REMOTE_ENV_KEY)) return value.get(REMOTE_ENV_KEY)?.trim() || null;
  }
  return null;
}

/** Return the exact HTTPS origin, or throw before a build can widen the ACL. */
function exactRemoteOrigin(raw) {
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) throw new Error("CODY_DESKTOP_REMOTE_URL contains control characters");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CODY_DESKTOP_REMOTE_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error("CODY_DESKTOP_REMOTE_URL must be an HTTPS URL without credentials, query, or fragment");
  }
  if (url.port && url.port !== "443") throw new Error("CODY_DESKTOP_REMOTE_URL may not use an arbitrary port");
  return url.origin;
}

function writeCapability(origin) {
  const capability = {
    $schema: "../gen/schemas/windows-schema.json",
    identifier: "cody-remote-server",
    description: "IPC granted to the one configured Cody HTTPS origin; local loopback access is declared separately.",
    windows: ["main"],
    local: false,
    ...(origin ? { remote: { urls: [`${origin}/*`] } } : {}),
    permissions: APP_PERMISSIONS,
  };
  writeFileSync(CAPABILITY_PATH, `${JSON.stringify(capability, null, 2)}\n`, "utf8");
}

const configured = configuredRemoteUrl();
let origin = null;
try {
  if (configured) origin = exactRemoteOrigin(configured);
} catch (error) {
  // Do not leave a previously generated remote grant active when a newly
  // supplied value is invalid. The command still fails rather than silently
  // turning a typo into a different build mode.
  writeCapability(null);
  throw error;
}
writeCapability(origin);

const childEnv = { ...process.env };
const hasProcessOverride = Object.prototype.hasOwnProperty.call(process.env, REMOTE_ENV_KEY);
if (hasProcessOverride) childEnv[REMOTE_ENV_KEY] = process.env[REMOTE_ENV_KEY] ?? "";
else if (configured) childEnv[REMOTE_ENV_KEY] = configured;
else delete childEnv[REMOTE_ENV_KEY];

const cli = join(DESKTOP_DIR, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: DESKTOP_DIR,
  env: childEnv,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
