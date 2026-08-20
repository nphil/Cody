import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isNewerVersion,
  detectInstallMethod,
  detectContainerDeployment,
  checkNpmUpdate,
} = jiti("./npm-update.ts");

const DOCKER_PULL = "docker pull ghcr.io/nphil/cody:latest";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Swaps in a fetch that answers from `reply(url)` and records every call, so
 * a test can prove which release channel was queried — the bug was querying
 * the wrong one, which no assertion on the returned version alone catches.
 * Restored after the test so one case never leaks into the next. */
function stubFetch(t, reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(init?.signal instanceof AbortSignal, "probe must keep its timeout signal");
    return reply(String(url));
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A directory holding a container marker that does or does not exist, so
 * both deployment shapes are drivable without writing to the real root. */
function markerPaths(t) {
  const root = mkdtempSync(join(tmpdir(), "cody-npm-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const present = join(root, ".dockerenv");
  writeFileSync(present, "");
  return { present, absent: join(root, "not-a-container") };
}

/** Every status case passes `force` so the module-level TTL cache from a
 * previous case can never answer for the current one. */
function packageDir(t, value) {
  const previous = process.env.CODY_PACKAGE_DIR;
  process.env.CODY_PACKAGE_DIR = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CODY_PACKAGE_DIR;
    else process.env.CODY_PACKAGE_DIR = previous;
  });
}

test("recognizes newer npm package versions", () => {
  assert.equal(isNewerVersion("0.2.1", "0.2.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.9", "0.2.0"), false);
});

test("only treats a stable build as newer than the matching prerelease", () => {
  assert.equal(isNewerVersion("0.2.0", "0.2.0-beta.1"), true);
  assert.equal(isNewerVersion("0.2.0-beta.2", "0.2.0"), false);
  assert.equal(isNewerVersion("latest", "0.2.0"), false);
});

test("detectInstallMethod routes bun-global installs to bun", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\@nphil\\cody"), "bun");
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\.bin\\cody.cmd"), "bun");
  // Mixed separators (Windows-style path on a POSIX host, e.g. CI) must classify identically.
  assert.equal(detectInstallMethod("C:/Users/khaled/node_modules/@nphil/cody"), "bun");
});

test("detectInstallMethod falls back to npm for anything else", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\AppData\\Roaming\\npm\\node_modules\\@nphil\\cody"), "npm");
  assert.equal(detectInstallMethod("C:\\Program Files\\nodejs\\node_modules\\@nphil\\cody"), "npm");
  assert.equal(detectInstallMethod("D:\\OtherProjects\\Cody"), "npm");
});

test("detectContainerDeployment follows the marker path it is handed", (t) => {
  const { present, absent } = markerPaths(t);
  assert.equal(detectContainerDeployment(present), true);
  assert.equal(detectContainerDeployment(absent), false);
});

test("a container is measured against the release that ships its image", async (t) => {
  const { present } = markerPaths(t);
  const calls = stubFetch(t, () => jsonResponse({ tag_name: "v99.0.0" }));

  const status = await checkNpmUpdate(true, present);

  assert.equal(status.managedBy, "docker");
  assert.equal(status.updateCommand, DOCKER_PULL);
  // Release tags carry a `v`; the comparable version does not.
  assert.equal(status.availableVersion, "99.0.0");
  assert.equal(status.updateAvailable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/nphil/Cody/releases/latest");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
});

test("a container already at the newest release reports no update", async (t) => {
  const { present } = markerPaths(t);
  stubFetch(t, () => jsonResponse({ tag_name: "v0.0.1" }));

  const status = await checkNpmUpdate(true, present);

  assert.equal(status.managedBy, "docker");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.updateCommand, DOCKER_PULL);
});

test("a rate-limited release probe leaves the container card without a version", async (t) => {
  const { present } = markerPaths(t);
  stubFetch(t, () => new Response("rate limited", { status: 403 }));

  const status = await checkNpmUpdate(true, present);

  assert.equal(status.availableVersion, null);
  assert.equal(status.updateAvailable, false);
  // The card still names the channel that can update this deployment.
  assert.equal(status.managedBy, "docker");
  assert.equal(status.updateCommand, DOCKER_PULL);
});

test("an unreachable release feed degrades instead of throwing", async (t) => {
  const { present } = markerPaths(t);
  stubFetch(t, () => {
    throw new Error("simulated network failure");
  });

  const status = await checkNpmUpdate(true, present);

  assert.equal(status.availableVersion, null);
  assert.equal(status.managedBy, "docker");
  assert.equal(status.updateCommand, DOCKER_PULL);
});

test("without the marker the npm channel and command are untouched", async (t) => {
  const { absent } = markerPaths(t);
  packageDir(t, join("/usr", "lib", "node_modules", "@nphil", "cody"));
  const calls = stubFetch(t, () => jsonResponse({ version: "99.0.0" }));

  const status = await checkNpmUpdate(true, absent);

  assert.equal(status.managedBy, "npm");
  assert.equal(status.updateCommand, "npm install -g @nphil/cody");
  assert.equal(status.availableVersion, "99.0.0");
  assert.equal(status.updateAvailable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registry.npmjs.org/%40nphil%2Fcody/latest");
});

test("a bun global install outside a container keeps its bun command", async (t) => {
  const { absent } = markerPaths(t);
  packageDir(t, join(homedir(), ".bun", "install", "global", "node_modules", "@nphil", "cody"));
  stubFetch(t, () => jsonResponse({ version: "99.0.0" }));

  const status = await checkNpmUpdate(true, absent);

  assert.equal(status.managedBy, "bun");
  assert.equal(status.updateCommand, "bun add -g @nphil/cody");
});
