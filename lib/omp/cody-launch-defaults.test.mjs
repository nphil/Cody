import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { parse } from "yaml";
import { ompTestPackageBin } from "./omp-test-package.mjs";

/**
 * Cody's launch defaults (lib/omp/cody-launch-defaults.yml): the config layer every
 * main omp chat starts with, and the rule that a value the user set themselves wins.
 * The last test runs the real omp (CODY_OMP_BIN selects which one): both the engine
 * that has `display.shellVisualization` (18.17+) and the one that predates it must
 * start with the layer in place.
 */

// Before the environment below changes: where omp is installed depends on PI_CODING_AGENT_DIR.
const ompBin = ompTestPackageBin();

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "cody-launch-defaults-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "CODY_PACKAGE_DIR", "OMP_PROFILE", "PI_PROFILE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
process.env.PI_CONFIG_FILES = "";
process.env.CODY_PACKAGE_DIR = repoRoot;
// A named omp profile outranks PI_CODING_AGENT_DIR: never let one point these tests at a real agent dir.
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const defaults = await jiti.import("./cody-launch-defaults.ts");
const { buildEngineRpcLaunch } = await jiti.import("../rpc-manager.ts");

const LAYER = path.join(repoRoot, "lib", "omp", "cody-launch-defaults.yml");
const LAYER2 = path.join(repoRoot, "lib", "omp", "cody-launch-defaults-async-widgets.yml");
const BOTH = `${LAYER}:${LAYER2}`;
const ompHarness = { id: "omp", displayName: "omp", binaryName: "omp", resolveBinary: () => "/bin/omp", rpcUi: { mode: "rpc-ui", supportsCwdFlag: true, resumeFlag: "--resume", supportsAdvisor: true } };

function writeConfig(text) {
  const dir = process.env.PI_CODING_AGENT_DIR;
  rmSync(dir, { recursive: true, force: true });
  if (text === null) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.yml"), text);
}

test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("each layer file sets exactly its one setting", () => {
  // A new key here changes every Cody chat's behaviour: it must be added on purpose, with its reason in the file.
  assert.deepEqual(parse(readFileSync(LAYER, "utf8")), { display: { shellVisualization: false } });
  assert.deepEqual(parse(readFileSync(LAYER2, "utf8")), { async: { widgets: false } });
  assert.deepEqual(defaults.CODY_LAUNCH_DEFAULTS_LAYERS.map((l) => l.file), ["cody-launch-defaults.yml", "cody-launch-defaults-async-widgets.yml"]);
});

test("each layer applies unless the user explicitly turned its setting on", () => {
  writeConfig(null);
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), [LAYER, LAYER2], "no config.yml: the engine default is nobody's choice");
  writeConfig("display:\n  shellVisualization: false\nasync:\n  widgets: false\n");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), [LAYER, LAYER2]);
  writeConfig("compaction:\n  enabled: true\n");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), [LAYER, LAYER2], "a config that never mentions the settings");
  writeConfig("display:\n  shellVisualization: true\n");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), [LAYER2], "an explicit On drops only that key's layer");
  writeConfig("async:\n  widgets: true\n");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), [LAYER], "an explicit On drops only that key's layer");
  writeConfig("display:\n  shellVisualization: true\nasync:\n  widgets: true\n");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), []);
  writeConfig("display: [unterminated\n");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(repoRoot), [LAYER, LAYER2], "an unreadable config is read as 'not set', never as a failed launch");
  assert.deepEqual(defaults.codyLaunchDefaultsLayers(path.join(scratch, "no-such-package")), [], "a tree without the files keeps the engine's defaults");
});

test("the layers go first and every inherited layer keeps its place, once", () => {
  writeConfig(null);
  assert.deepEqual(defaults.codyLaunchDefaultsEnv(undefined, repoRoot), { PI_CONFIG_FILES: BOTH });
  assert.deepEqual(defaults.codyLaunchDefaultsEnv("", repoRoot), { PI_CONFIG_FILES: BOTH });
  assert.deepEqual(defaults.codyLaunchDefaultsEnv("/a.yml:/b.yml", repoRoot), { PI_CONFIG_FILES: `${BOTH}:/a.yml:/b.yml` });
  assert.deepEqual(defaults.codyLaunchDefaultsEnv(`/a.yml:${LAYER2}:${LAYER}`, repoRoot), { PI_CONFIG_FILES: `${BOTH}:/a.yml` }, "a relaunch never stacks a second copy");
  writeConfig("display:\n  shellVisualization: true\n");
  assert.deepEqual(defaults.codyLaunchDefaultsEnv("/a.yml", repoRoot), { PI_CONFIG_FILES: `${LAYER2}:/a.yml` });
  writeConfig("display:\n  shellVisualization: true\nasync:\n  widgets: true\n");
  assert.equal(defaults.codyLaunchDefaultsEnv("/a.yml", repoRoot), undefined, "nothing to add: the launch env stays as it was");
});

test("main omp chats launch with the layers; sidebars and other engines do not", () => {
  writeConfig(null);
  const main = buildEngineRpcLaunch(ompHarness, { cwd: "/work", sessionFile: "/abs/s.jsonl" });
  assert.equal(main.env?.PI_CONFIG_FILES, BOTH);
  const withOverlays = buildEngineRpcLaunch(ompHarness, { cwd: "/work", sessionFile: "/abs/s.jsonl", profile: { profileId: "full", env: { PI_CONFIG_FILES: "/preset.yml:/credits.yml", OTHER: "kept" } } });
  assert.equal(withOverlays.env.PI_CONFIG_FILES, `${BOTH}:/preset.yml:/credits.yml`);
  assert.equal(withOverlays.env.OTHER, "kept");
  process.env.PI_CONFIG_FILES = "/instance.yml";
  try {
    assert.equal(buildEngineRpcLaunch(ompHarness, { cwd: "/work", sessionFile: "" }).env.PI_CONFIG_FILES, `${BOTH}:/instance.yml`, "the instance's own layers survive");
  } finally {
    process.env.PI_CONFIG_FILES = "";
  }
  const sidebar = buildEngineRpcLaunch(ompHarness, { cwd: "/work", sessionFile: "", kind: "sidebar" });
  assert.equal(sidebar.env?.PI_CONFIG_FILES, undefined, "a sidebar has no tools and its own settings");
  const pi = buildEngineRpcLaunch({ ...ompHarness, id: "pi", binaryName: "pi", rpcUi: { mode: "rpc", supportsCwdFlag: false, resumeFlag: "--session" } }, { cwd: "/work", sessionFile: "" });
  assert.equal(pi.env, undefined, "another engine is not given omp's config layers");
  writeConfig("display:\n  shellVisualization: true\nasync:\n  widgets: true\n");
  assert.equal(buildEngineRpcLaunch(ompHarness, { cwd: "/work", sessionFile: "" }).env, undefined, "an explicit On leaves the launch untouched");
});

test("a real omp starts with the layers in place and reads them where it knows the settings", { skip: ompBin ? false : "no omp available" }, () => {
  writeConfig(null);
  const get = (key, layered) => spawnSync(ompBin, ["config", "get", key, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CONFIG_FILES: layered ? BOTH : "" },
  });
  // Any engine: an unknown key in a layer is ignored, not a launch failure.
  const known = get("compaction.enabled", true);
  assert.equal(known.status, 0, `omp config get compaction.enabled failed: ${known.stderr}`);
  assert.equal(JSON.parse(known.stdout).value, true);
  for (const key of ["display.shellVisualization", "async.widgets"]) {
    const plain = get(key, false);
    // An engine that predates the setting refuses the key: nothing more to prove there.
    if (plain.status !== 0) {
      assert.match(`${plain.stdout}${plain.stderr}`, /unknown setting/i);
      continue;
    }
    assert.equal(JSON.parse(plain.stdout).value, true, `the engine's own default for ${key} is on`);
    const layered = get(key, true);
    assert.equal(layered.status, 0, layered.stderr);
    assert.equal(JSON.parse(layered.stdout).value, false, `the layers turn ${key} off for the chat`);
  }
});
