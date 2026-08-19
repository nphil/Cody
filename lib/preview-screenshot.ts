import { execFile } from "child_process";
import { existsSync, readdirSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { readEnv } from "./env";
import { fitWithinEdge } from "./image-compress";
import { normalizePreviewUrl } from "./preview-url";
import { CHROMIUM_GPU_ARGS, CHROMIUM_SOFTWARE_ARGS, gpuRenderNode } from "./chromium-gpu";

/**
 * Server-side screenshots of loopback web apps, shared by the
 * `preview_screenshot` host tool (the agent checking its own work) and the
 * Preview panel's capture button. The capture runs where the dev server runs
 * — inside the Cody host/container — so it works even when the viewer's
 * browser cannot reach the app as `localhost` (e.g. Tailscale deployments).
 *
 * Rendering uses a headless Chromium in one-shot `--screenshot` mode: no CDP
 * client, no new npm dependency, one process per capture.
 *
 * Every capture must also FIT: the host-tool result carries the image as
 * base64 inside one NDJSON frame, and omp cannot reassemble inbound chunks, so
 * a frame over 1 MiB is dropped by the transport — which reads to the agent as
 * a tool call that never answers. A tall or busy page is easily over that as
 * PNG, so captures walk a format/size ladder against an explicit byte budget
 * and a capture that still cannot fit fails loudly (`too_large`) instead of
 * returning something undeliverable.
 */

export type ScreenshotFormat = "png" | "webp";
export type ScreenshotMimeType = "image/png" | "image/webp";

/** Chromium's one-shot mode picks its encoder from the output file extension
 * (verified on Chromium 151: `--screenshot=out.webp` really writes WebP), so
 * the file name IS the format selector — there is no separate flag. */
export const SCREENSHOT_MIME_TYPES: Record<ScreenshotFormat, ScreenshotMimeType> = {
  png: "image/png",
  webp: "image/webp",
};

export interface ScreenshotResult {
  /** base64 payload of `mimeType`, no `data:` prefix. */
  data: string;
  mimeType: ScreenshotMimeType;
  /** Size actually rendered — a ladder step may have capped it. */
  width: number;
  height: number;
  /** The normalized loopback URL that was actually rendered. */
  url: string;
  /** Raw (pre-base64) size of `data`. */
  byteLength: number;
}

export class ScreenshotError extends Error {
  readonly code: "invalid_url" | "chromium_missing" | "capture_failed" | "too_large";
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

/**
 * Raw image bytes a capture may return. The result is base64'd into a JSON
 * frame (×4/3 → ~800 KiB), which leaves headroom under the transport's 1 MiB
 * single-frame ceiling for the text line and JSON envelope around it.
 */
export const SCREENSHOT_MAX_BYTES = 600 * 1024;

export interface ScreenshotStep {
  format: ScreenshotFormat;
  /** Cap on the longest viewport edge; null renders at the requested size. */
  maxEdge: number | null;
}

/**
 * PNG at the requested size first — an ordinary capture stays pixel-crisp, so
 * the agent can read UI text in it. Only when that overshoots does the capture
 * trade fidelity for deliverability: same size as WebP (typically an order of
 * magnitude smaller), then progressively smaller viewports.
 */
export const SCREENSHOT_STEPS: readonly ScreenshotStep[] = [
  { format: "png", maxEdge: null },
  { format: "webp", maxEdge: null },
  { format: "webp", maxEdge: 1280 },
  { format: "webp", maxEdge: 800 },
];

export type ScreenshotLadderDecision =
  | { kind: "accept" }
  | { kind: "retry"; index: number; step: ScreenshotStep }
  | { kind: "too_large" };

/** Pure budget decision: what to do after `attempt` produced `byteLength`. */
export function decideNextScreenshotStep(
  byteLength: number,
  attempt: number,
  maxBytes: number = SCREENSHOT_MAX_BYTES,
  steps: readonly ScreenshotStep[] = SCREENSHOT_STEPS,
): ScreenshotLadderDecision {
  if (byteLength <= maxBytes) return { kind: "accept" };
  const next = attempt + 1;
  if (next >= steps.length) return { kind: "too_large" };
  return { kind: "retry", index: next, step: steps[next] };
}

/** Viewport a ladder step renders at, given what the caller asked for. */
export function stepViewport(
  step: ScreenshotStep,
  width: number,
  height: number,
): { width: number; height: number } {
  return fitWithinEdge(width, height, step.maxEdge ?? Number.POSITIVE_INFINITY);
}

/** Output file name for a step — its extension selects Chromium's encoder. */
export function screenshotFileName(step: ScreenshotStep, attempt: number): string {
  return `shot-${attempt}.${step.format}`;
}

/**
 * What the bytes actually are. Chromium honors the extension, but a build that
 * did not would otherwise have its PNG announced to the model as WebP; sniffing
 * keeps the declared mime type honest either way.
 */
export function detectImageMimeType(bytes: Uint8Array): ScreenshotMimeType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export interface CapturedImage {
  /** base64 payload, no `data:` prefix. */
  data: string;
  /** Raw (pre-base64) size — what the budget is measured against. */
  byteLength: number;
  mimeType: ScreenshotMimeType;
  width: number;
  height: number;
}

/**
 * Walk the ladder with an injected capture step and return the first result
 * within budget. Pure control flow — the injected step is the only part that
 * needs a browser, which is what makes the policy testable without one.
 *
 * Every rung over budget is a hard failure: an over-budget result would be
 * dropped by the transport and hang the agent's tool call, so it must never be
 * returned.
 */
export async function runScreenshotLadder(
  capture: (step: ScreenshotStep, viewport: { width: number; height: number }, attempt: number) => Promise<CapturedImage>,
  options: {
    width: number;
    height: number;
    maxBytes?: number;
    steps?: readonly ScreenshotStep[];
  },
): Promise<CapturedImage> {
  const steps = options.steps ?? SCREENSHOT_STEPS;
  const maxBytes = options.maxBytes ?? SCREENSHOT_MAX_BYTES;
  if (steps.length === 0) throw new Error("screenshot ladder has no steps");
  for (let attempt = 0; attempt < steps.length; attempt++) {
    const step = steps[attempt];
    const image = await capture(step, stepViewport(step, options.width, options.height), attempt);
    const decision = decideNextScreenshotStep(image.byteLength, attempt, maxBytes, steps);
    if (decision.kind === "accept") return image;
    if (decision.kind === "too_large") {
      const format = image.mimeType === "image/webp" ? "WebP" : "PNG";
      throw new ScreenshotError(
        "too_large",
        `Screenshot is ${image.byteLength} bytes even as ${format} at ${image.width}x${image.height}, `
        + `over the ${maxBytes}-byte limit for an image that still fits one message to the engine.`,
        "Capture a smaller viewport (width/height), or a simpler page — a very tall or image-heavy page cannot be returned whole.",
      );
    }
  }
  // Unreachable: the last rung either accepts or throws above.
  throw new ScreenshotError("too_large", `No screenshot within ${maxBytes} bytes could be produced.`);
}

/** Pure arg builder (unit-tested). `asRoot` decides --no-sandbox: container
 * deployments run as uid 0, where Chromium's sandbox cannot start. `gpu`
 * selects the same ANGLE/EGL configuration the display provider uses, so a
 * capture of a WebGL or canvas page is rasterized by the same GPU that renders
 * the streamed preview of it. */
export function buildScreenshotArgs(options: {
  url: string;
  outPath: string;
  userDataDir: string;
  width: number;
  height: number;
  asRoot: boolean;
  gpu: boolean;
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
    ...(options.gpu ? CHROMIUM_GPU_ARGS : CHROMIUM_SOFTWARE_ARGS),
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

/**
 * Whether GPU flags are usable for captures in this process: null until a
 * capture has settled the question, then sticky. A host with no render node
 * never asks, so it stays null and every capture goes straight to software.
 */
let gpuUsable: boolean | null = null;

/**
 * Capture a screenshot of a loopback URL, small enough to actually deliver.
 *
 * Throws ScreenshotError — including `too_large` when even the last ladder rung
 * overshoots `maxBytes`. An over-budget result is never returned.
 */
export async function captureLoopbackScreenshot(
  rawUrl: string,
  options: { width?: number; height?: number; maxBytes?: number } = {},
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
  const maxBytes = typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.round(options.maxBytes)
    : SCREENSHOT_MAX_BYTES;
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  const workDir = await mkdtemp(join(tmpdir(), "cody-shot-"));
  try {
    // One fresh Chromium run per rung, against the same URL — the extension is
    // what selects the encoder, and a per-attempt profile keeps a previous
    // run's lock out of the next one's way.
    const image = await runScreenshotLadder(async (step, viewport, attempt) => {
      // Mirrors the display provider's posture: prefer the GPU, but never let a
      // broken GPU stack cost the capture itself. The verdict is learned once
      // per process, so the retry is paid on the first failing capture rather
      // than on every one.
      const runOnce = async (gpu: boolean, tag: string) => {
        const name = screenshotFileName(step, attempt);
        // The suffix goes BEFORE the extension: the extension is what selects
        // Chromium's encoder, and the ladder's budget logic is measuring the
        // format it asked for.
        const dot = name.lastIndexOf(".");
        const outPath = join(workDir, tag ? `${name.slice(0, dot)}${tag}${name.slice(dot)}` : name);
        const args = buildScreenshotArgs({
          url,
          outPath,
          userDataDir: join(workDir, `profile-${attempt}${tag}`),
          width: viewport.width,
          height: viewport.height,
          asRoot,
          gpu,
        });
        await new Promise<void>((resolve, reject) => {
          execFile(bin, args, { timeout: CAPTURE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
            if (error) reject(new Error(`${error.message}${stderr ? `\n${String(stderr).slice(-500)}` : ""}`));
            else resolve();
          });
        });
        const bytes = await readFile(outPath);
        if (bytes.length === 0) throw new Error("Chromium produced an empty screenshot file");
        return bytes;
      };

      const wantsGpu = gpuUsable ?? Boolean(gpuRenderNode());
      let bytes: Buffer;
      try {
        bytes = await runOnce(wantsGpu, "");
        if (wantsGpu) gpuUsable = true;
      } catch (error) {
        // Only a GPU-flagged attempt earns a retry, and only the first one:
        // a software failure is the real answer.
        if (!wantsGpu || gpuUsable === false) throw error;
        gpuUsable = false;
        bytes = await runOnce(false, "-sw");
      }
      return {
        data: bytes.toString("base64"),
        byteLength: bytes.length,
        mimeType: detectImageMimeType(bytes) ?? SCREENSHOT_MIME_TYPES[step.format],
        width: viewport.width,
        height: viewport.height,
      };
    }, { width, height, maxBytes });

    return {
      data: image.data,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      url,
      byteLength: image.byteLength,
    };
  } catch (error) {
    // A ladder verdict (too_large) is already the honest answer — only render
    // failures become capture_failed.
    if (error instanceof ScreenshotError) throw error;
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

/** Test hook — pairs with clearChromiumBinCache() so a test starts from an
 * undecided GPU verdict rather than inheriting a previous test's. */
export function clearScreenshotGpuCache(): void {
  gpuUsable = null;
}
