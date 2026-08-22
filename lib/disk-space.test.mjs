import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeDiskError, formatBytes, getDiskSpace, getNpmCacheDir } = await jiti.import("./disk-space.ts");

test("describeDiskError names the unnamed errno npm actually printed", () => {
  // The verbatim shape from the field report: libuv has no name for EDQUOT,
  // so npm printed a number. Matching only /EDQUOT/ would have missed it.
  const real = [
    "npm error code Unknown system error -122",
    "npm error syscall open",
    "npm error errno Unknown system error -122",
    "npm error Invalid response body while trying to fetch https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent:",
    "Unknown system error -122: Unknown system error -122, open '/data/home/.npm/_cacache/tmp/ce185227'",
  ].join("\n");
  assert.equal(describeDiskError(real), "quota");

  assert.equal(describeDiskError("EDQUOT: disk quota exceeded, write"), "quota");
  assert.equal(describeDiskError("Unknown system error -69"), "quota", "macOS EDQUOT");
  assert.equal(describeDiskError("ENOSPC: no space left on device, write"), "full");
  assert.equal(describeDiskError("npm error code E404\nnpm error 404 Not Found"), null);
  assert.equal(describeDiskError("exited with code 1"), null);
  assert.equal(describeDiskError(""), null);
  // A version number that merely contains 122 must not read as a disk fault.
  assert.equal(describeDiskError("installed pi-coding-agent@1.122.0"), null);
});

test("formatBytes stays readable across magnitudes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(512 * 1024 * 1024), "512 MB");
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
  assert.equal(formatBytes(-1), "unknown");
  assert.equal(formatBytes(Number.NaN), "unknown");
});

test("getNpmCacheDir follows npm's own resolution order", () => {
  assert.equal(getNpmCacheDir({ npm_config_cache: "/explicit/cache" }), "/explicit/cache");
  const expected = process.platform === "win32" ? "npm-cache" : ".npm";
  assert.equal(getNpmCacheDir({ HOME: "/data/home" }), path.join("/data/home", expected));
  // Empty values fall through rather than yielding a bare relative path.
  assert.equal(getNpmCacheDir({ npm_config_cache: "   ", HOME: "/data/home" }), path.join("/data/home", expected));
});

test("getDiskSpace reads a real filesystem and fails soft on a bad path", () => {
  const space = getDiskSpace(os.tmpdir());
  assert.ok(space, "tmpdir must report space");
  assert.ok(space.totalBytes > 0, "total is positive");
  assert.ok(space.availableBytes >= 0, "available is non-negative");
  assert.ok(space.availableBytes <= space.totalBytes, "available never exceeds total");
  // Unknown space must be null (never 0) — a caller treating 0 as "full"
  // would block installs on any platform without statfs.
  assert.equal(getDiskSpace(path.join(os.tmpdir(), "cody-definitely-not-here-9e3f1a")), null);
});
