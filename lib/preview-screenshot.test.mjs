import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildScreenshotArgs,
  clampDimension,
  decideNextScreenshotStep,
  detectImageMimeType,
  MAX_WIDTH,
  MAX_HEIGHT,
  runScreenshotLadder,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MIME_TYPES,
  SCREENSHOT_STEPS,
  screenshotFileName,
  stepViewport,
} = await jiti.import("./preview-screenshot.ts");

test("buildScreenshotArgs produces a one-shot headless capture command", () => {
  const args = buildScreenshotArgs({
    url: "http://localhost:3000/",
    outPath: "/tmp/x/screenshot.png",
    userDataDir: "/tmp/x/profile",
    width: 1280,
    height: 800,
    asRoot: false,
    gpu: false,
  });
  assert.ok(args.includes("--headless"));
  assert.ok(args.includes("--screenshot=/tmp/x/screenshot.png"));
  assert.ok(args.includes("--window-size=1280,800"));
  assert.ok(args.includes("--user-data-dir=/tmp/x/profile"));
  assert.ok(args.some((a) => a.startsWith("--virtual-time-budget=")));
  // The URL is the positional argument and must come last so a URL that
  // looks flag-ish can never swallow a real flag.
  assert.equal(args[args.length - 1], "http://localhost:3000/");
  assert.ok(!args.includes("--no-sandbox"));
});

test("buildScreenshotArgs adds --no-sandbox only for root (container) runs", () => {
  const rootArgs = buildScreenshotArgs({
    url: "http://localhost:3000/", outPath: "/o.png", userDataDir: "/p", width: 800, height: 600, asRoot: true, gpu: false,
  });
  assert.ok(rootArgs.includes("--no-sandbox"));
});

// A capture that renders WebGL/canvas in software while the streamed preview of
// the same page uses the GPU is indistinguishable from a bug in the page, so the
// two Chromium call sites have to agree on these flags.
test("gpu captures carry the ANGLE/EGL flags and drop --disable-gpu", () => {
  const args = buildScreenshotArgs({
    url: "http://localhost:3000/", outPath: "/o.png", userDataDir: "/p", width: 800, height: 600, asRoot: true, gpu: true,
  });
  for (const flag of ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"]) {
    assert.ok(args.includes(flag), `expected ${flag}`);
  }
  assert.ok(!args.includes("--disable-gpu"));
  // Everything else about the invocation is unchanged by the GPU choice.
  assert.ok(args.includes("--headless"));
  assert.ok(args.includes("--screenshot=/o.png"));
  assert.equal(args[args.length - 1], "http://localhost:3000/");
});

test("software captures keep --disable-gpu and none of the GL flags", () => {
  const args = buildScreenshotArgs({
    url: "http://localhost:3000/", outPath: "/o.png", userDataDir: "/p", width: 800, height: 600, asRoot: false, gpu: false,
  });
  assert.ok(args.includes("--disable-gpu"));
  for (const flag of ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"]) {
    assert.ok(!args.includes(flag), `unexpected ${flag}`);
  }
});

test("the output file extension is what selects Chromium's encoder", () => {
  // One-shot mode has no format flag: `--screenshot=out.webp` is the whole
  // instruction, so the file name and the declared mime type must agree.
  assert.equal(screenshotFileName({ format: "png", maxEdge: null }, 0), "shot-0.png");
  assert.equal(screenshotFileName({ format: "webp", maxEdge: 1280 }, 2), "shot-2.webp");
  assert.equal(SCREENSHOT_MIME_TYPES.png, "image/png");
  assert.equal(SCREENSHOT_MIME_TYPES.webp, "image/webp");

  const args = buildScreenshotArgs({
    url: "http://localhost:3000/", outPath: "/tmp/x/shot-1.webp", userDataDir: "/tmp/x/profile-1",
    width: 1280, height: 800, asRoot: false, gpu: false,
  });
  assert.ok(args.includes("--screenshot=/tmp/x/shot-1.webp"));
});

test("declared mime type follows the bytes, not the requested extension", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x48, 0x2d, 0, 0]), Buffer.from("WEBPVP8X")]);
  assert.equal(detectImageMimeType(png), "image/png");
  assert.equal(detectImageMimeType(webp), "image/webp");
  assert.equal(detectImageMimeType(Buffer.from("not an image at all")), null);
  assert.equal(detectImageMimeType(Buffer.alloc(0)), null);
});

test("the ladder starts pixel-crisp and only then trades fidelity", () => {
  assert.deepEqual([...SCREENSHOT_STEPS], [
    { format: "png", maxEdge: null },
    { format: "webp", maxEdge: null },
    { format: "webp", maxEdge: 1280 },
    { format: "webp", maxEdge: 800 },
  ]);
  // The budget leaves room under the 1 MiB frame ceiling once base64 inflates
  // the payload by 4/3.
  assert.equal(SCREENSHOT_MAX_BYTES, 600 * 1024);
  assert.ok(Math.ceil((SCREENSHOT_MAX_BYTES / 3) * 4) < 1024 * 1024);

  // Only the capped rungs shrink the viewport, and they preserve aspect ratio.
  assert.deepEqual(stepViewport(SCREENSHOT_STEPS[0], 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(stepViewport(SCREENSHOT_STEPS[1], 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(stepViewport(SCREENSHOT_STEPS[2], 1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(stepViewport(SCREENSHOT_STEPS[3], 1920, 1080), { width: 800, height: 450 });
  // Never upscales a viewport that is already smaller than the cap.
  assert.deepEqual(stepViewport(SCREENSHOT_STEPS[3], 640, 480), { width: 640, height: 480 });
});

test("the budget decision accepts what fits and walks the ladder otherwise", () => {
  assert.deepEqual(decideNextScreenshotStep(SCREENSHOT_MAX_BYTES, 0), { kind: "accept" });
  assert.deepEqual(decideNextScreenshotStep(1, 3), { kind: "accept" });
  assert.deepEqual(decideNextScreenshotStep(SCREENSHOT_MAX_BYTES + 1, 0), {
    kind: "retry", index: 1, step: SCREENSHOT_STEPS[1],
  });
  assert.deepEqual(decideNextScreenshotStep(SCREENSHOT_MAX_BYTES + 1, 1), {
    kind: "retry", index: 2, step: SCREENSHOT_STEPS[2],
  });
  // Past the last rung there is nothing left to try.
  assert.deepEqual(decideNextScreenshotStep(SCREENSHOT_MAX_BYTES + 1, SCREENSHOT_STEPS.length - 1), { kind: "too_large" });
});

// The ladder's control flow is exercised with an injected capture step: CI has
// no browser, and the policy is what matters here.
function fakeCapture(sizes) {
  const attempts = [];
  const capture = async (step, viewport, attempt) => {
    attempts.push({ format: step.format, maxEdge: step.maxEdge, ...viewport, attempt });
    const byteLength = sizes[attempt];
    return {
      data: "x".repeat(4),
      byteLength,
      mimeType: SCREENSHOT_MIME_TYPES[step.format],
      width: viewport.width,
      height: viewport.height,
    };
  };
  return { attempts, capture };
}

test("an ordinary capture stops at PNG and never spawns a second Chromium", async () => {
  const { attempts, capture } = fakeCapture([100 * 1024]);
  const image = await runScreenshotLadder(capture, { width: 1512, height: 945 });

  assert.equal(image.mimeType, "image/png");
  assert.equal(image.width, 1512);
  assert.equal(image.height, 945);
  assert.equal(attempts.length, 1);
});

test("an oversized PNG falls to WebP, then to smaller viewports, stopping at the first fit", async () => {
  const over = SCREENSHOT_MAX_BYTES + 1;
  const { attempts, capture } = fakeCapture([over, over, 200 * 1024, 1]);
  const image = await runScreenshotLadder(capture, { width: 1920, height: 1080 });

  assert.deepEqual(attempts.map((a) => `${a.format} ${a.width}x${a.height}`), [
    "png 1920x1080",
    "webp 1920x1080",
    "webp 1280x720",
  ]);
  assert.equal(image.mimeType, "image/webp");
  assert.equal(image.byteLength, 200 * 1024);
  // The reported size is the one actually rendered, not the one requested.
  assert.equal(image.width, 1280);
  assert.equal(image.height, 720);
});

test("a capture that cannot fit fails as too_large instead of returning it", async () => {
  const over = SCREENSHOT_MAX_BYTES + 4096;
  const { attempts, capture } = fakeCapture([over, over, over, over]);

  const error = await runScreenshotLadder(capture, { width: 1920, height: 1080 }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, "an unfittable capture must reject");
  assert.equal(error.name, "ScreenshotError");
  assert.equal(error.code, "too_large");
  // The message has to name both numbers so the failure is diagnosable.
  assert.match(error.message, new RegExp(String(over)));
  assert.match(error.message, new RegExp(String(SCREENSHOT_MAX_BYTES)));
  assert.equal(attempts.length, SCREENSHOT_STEPS.length);
});

test("clampDimension bounds and defaults dimensions", () => {
  assert.equal(clampDimension(undefined, 1280, MAX_WIDTH), 1280);
  assert.equal(clampDimension("wide", 1280, MAX_WIDTH), 1280);
  assert.equal(clampDimension(Number.NaN, 800, MAX_HEIGHT), 800);
  assert.equal(clampDimension(10, 1280, MAX_WIDTH), 320);
  assert.equal(clampDimension(99999, 1280, MAX_WIDTH), MAX_WIDTH);
  assert.equal(clampDimension(1024.6, 1280, MAX_WIDTH), 1025);
  assert.equal(clampDimension(2000, 800, MAX_HEIGHT), 2000);
});
