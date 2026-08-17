import { execFile } from "child_process";
import { existsSync, readdirSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { readEnv } from "./env";
import { normalizePreviewUrl } from "./preview-url";

/**
 * Server-side screenshots of loopback web apps, shared by the
 * `preview_screenshot` host tool (the agent checking its own work) and the
 * Preview panel's capture button. The capture runs where the dev server runs
 * — inside the Cody host/container — so it works even when the viewer's
 * browser cannot reach the app as `localhost` (e.g. Tailscale deployments).
 *
 * Rendering uses a headless Chromium in one-shot `--screenshot` mode: no CDP
 * client, no new npm dependency, one process per capture.
 */

export interface ScreenshotResult {
  data: string; // base64 PNG
  mimeType: "image/png";
  width: number;
  height: number;
  /** The normalized loopback URL that was actually rendered. */
  url: string;
}

export class ScreenshotError extends Error {
  readonly code: "invalid_url" | "chromium_missing" | "capture_failed";
  readonly hint?: string;

  constructor(code: ScreenshotError["code"], message: string, hint?: string) {
    super(message);
    this.name = "ScreenshotError";
    this.code = code;
    this.hint = hint;
  }
}

const BIN_NAMES = process.platform === "win32"
  ? ["chrome.exe", "chromium.exe", "msedge.exe"]
  : ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome", "headless_shell"];

let cachedBin: string | null = null;
let binMissAt = 0;
const MISS_TTL_MS = 30_000;

/** Newest playwright-style browser dir (chromium-1234) under a cache root. */
function playwrightChromium(root: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  const candidates = dirs.filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const dir of candidates) {
    for (const suffix of [
      join("chrome-linux", "chrome"),
      join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join("chrome-win", "chrome.exe"),
    ]) {
      const candidate = join(root, dir, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function probeChromiumBin(): string | null {
  const override = readEnv("CHROMIUM_BIN");
  if (override) return existsSync(override) ? override : null;

  // Playwright-managed browsers: the project the agent is working on very
  // often has them already (this repo does).
  for (const root of [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), "AppData", "Local", "ms-playwright"),
  ]) {
    if (!root) continue;
    // A PLAYWRIGHT_BROWSERS_PATH may point straight at a binary or symlink
    // (as Cody's own dev containers do with /opt/pw-browsers/chromium).
    const direct = join(root, "chromium");
    if (existsSync(direct)) return direct;
    const found = playwrightChromium(root);
    if (found) return found;
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of BIN_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const fallbacks = process.platform === "darwin"
    ? [
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ]
    : process.platform === "win32"
      ? [
          join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/snap/bin/chromium"];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve a Chromium-family binary for headless captures. Hits cache for the
 * process lifetime; misses retry after a short TTL (mirrors omp-cli.ts). */
export function resolveChromiumBin(): string | null {
  if (cachedBin) return cachedBin;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probeChromiumBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

export const MIN_DIMENSION = 320;
export const MAX_WIDTH = 3840;
export const MAX_HEIGHT = 2160;

export function clampDimension(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(MIN_DIMENSION, n));
}

/** Pure arg builder (unit-tested). `asRoot` decides --no-sandbox: container
 * deployments run as uid 0, where Chromium's sandbox cannot start. */
export function buildScreenshotArgs(options: {
  url: string;
  outPath: string;
  userDataDir: string;
  width: number;
  height: number;
  asRoot: boolean;
}): string[] {
  const args = [
    // Plain --headless is the new headless mode on every Chromium this
    // resolver can find (the old mode was removed in 132, and even there it
    // still honored --screenshot).
    "--headless",
    `--screenshot=${options.outPath}`,
    `--window-size=${options.width},${options.height}`,
    `--user-data-dir=${options.userDataDir}`,
    "--hide-scrollbars",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    // Fast-forward timers/rAF so SPAs settle without a real-time wait.
    "--virtual-time-budget=8000",
  ];
  if (options.asRoot) args.push("--no-sandbox");
  args.push(options.url);
  return args;
}

const CAPTURE_TIMEOUT_MS = 30_000;

const INSTALL_HINT =
  "Install a Chromium (Debian/Ubuntu: `apt-get install chromium`; or `npx playwright install chromium`) "
  + "or point CODY_CHROMIUM_BIN at an existing Chrome/Chromium binary.";

/** Capture a screenshot of a loopback URL. Throws ScreenshotError. */
export async function captureLoopbackScreenshot(
  rawUrl: string,
  options: { width?: number; height?: number } = {},
): Promise<ScreenshotResult> {
  const url = normalizePreviewUrl(rawUrl);
  if (!url) {
    throw new ScreenshotError(
      "invalid_url",
      "Only loopback URLs (http://localhost:PORT or http://127.0.0.1:PORT) can be captured.",
    );
  }
  const bin = resolveChromiumBin();
  if (!bin) {
    throw new ScreenshotError("chromium_missing", "No Chromium/Chrome binary found for screenshots.", INSTALL_HINT);
  }
  const width = clampDimension(options.width, 1280, MAX_WIDTH);
  const height = clampDimension(options.height, 800, MAX_HEIGHT);

  const workDir = await mkdtemp(join(tmpdir(), "cody-shot-"));
  const outPath = join(workDir, "screenshot.png");
  const args = buildScreenshotArgs({
    url,
    outPath,
    userDataDir: join(workDir, "profile"),
    width,
    height,
    asRoot: typeof process.getuid === "function" && process.getuid() === 0,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(bin, args, { timeout: CAPTURE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr ? `\n${String(stderr).slice(-500)}` : ""}`));
        else resolve();
      });
    });
    const png = await readFile(outPath);
    if (png.length === 0) throw new Error("Chromium produced an empty screenshot file");
    return { data: png.toString("base64"), mimeType: "image/png", width, height, url };
  } catch (error) {
    throw new ScreenshotError(
      "capture_failed",
      `Screenshot of ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      "Confirm the dev server answers at that URL from inside the Cody host, then retry.",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Test hook — the bin probe is cached for the process lifetime. */
export function clearChromiumBinCache(): void {
  cachedBin = null;
  binMissAt = 0;
}
