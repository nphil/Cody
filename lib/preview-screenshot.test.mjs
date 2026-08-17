import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildScreenshotArgs, clampDimension, MAX_WIDTH, MAX_HEIGHT } = await jiti.import("./preview-screenshot.ts");

test("buildScreenshotArgs produces a one-shot headless capture command", () => {
  const args = buildScreenshotArgs({
    url: "http://localhost:3000/",
    outPath: "/tmp/x/screenshot.png",
    userDataDir: "/tmp/x/profile",
    width: 1280,
    height: 800,
    asRoot: false,
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
    url: "http://localhost:3000/", outPath: "/o.png", userDataDir: "/p", width: 800, height: 600, asRoot: true,
  });
  assert.ok(rootArgs.includes("--no-sandbox"));
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
