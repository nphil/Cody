import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { CANDIDATE_NAMES, REBUILD_RULES, isWithin, labelFor, matchRebuildRule } = await jiti.import("./usage-rules.ts");

const context = { home: "/h", agentDir: "/h/.omp/agent", tmpDir: "/t" };
const label = (path, parentMarks = [], ownMarks = []) => labelFor({ path, parentMarks, ownMarks }, context);

test("build output is recognised only when the folder beside it says what builds it", () => {
  assert.equal(label("/h/p/target", ["Cargo.toml"])?.rule, "cargo-target");
  assert.equal(label("/h/p/target", ["package.json"]), null, "a target next to a package.json is not Cargo's");
  assert.equal(label("/h/p/target", []), null, "a bare target folder is somebody's folder");
  assert.equal(label("/h/p/node_modules", ["package.json"])?.rule, "node-modules");
  assert.equal(label("/h/p/node_modules", []), null);
  assert.equal(label("/h/p/.next", ["package.json"])?.rule, "web-build");
  assert.equal(label("/h/p/.zig-cache", ["build.zig"])?.rule, "zig-cache");
  assert.equal(label("/h/p/zig-out", ["build.zig"])?.rule, "zig-cache");
  assert.equal(label("/h/p/.gradle", ["build.gradle.kts"])?.rule, "gradle-project");
  assert.equal(label("/h/p/__pycache__")?.rule, "python-cache");
  assert.equal(label("/h/p/.venv", ["pyproject.toml"], ["pyvenv.cfg"])?.rule, "python-venv");
  assert.equal(label("/h/p/.venv", ["pyproject.toml"], []), null, "a .venv without pyvenv.cfg is not an environment");
  assert.equal(label("/h/p/.venv", [], ["pyvenv.cfg"]), null, "an environment with no project beside it is left alone");
  for (const rule of REBUILD_RULES) assert.equal(label(`/h/p/${rule.names[0]}`, rule.parentHasAny, rule.ownHasAny)?.rule, rule.id);
});

test("a folder that is itself a project or a repository is never build output", () => {
  assert.equal(label("/h/p/target", ["Cargo.toml"], [".git"]), null);
  assert.equal(label("/h/p/target", ["Cargo.toml"], ["Cargo.toml"]), null);
  assert.equal(label("/h/p/node_modules", ["package.json"], ["package.json"]), null);
  assert.equal(matchRebuildRule("target", ["Cargo.toml"], ["build.zig"]), null);
});

test("build output outside home and temp is not recognised, and anything unknown is not labelled", () => {
  assert.equal(label("/srv/p/target", ["Cargo.toml"]), null);
  assert.equal(label("/h/p/src", ["Cargo.toml"]), null);
  assert.equal(label("/t/job/target", ["Cargo.toml"])?.rule, "cargo-target");
});

test("caches: ~/.cache entries and known package caches download again, installed tools do not", () => {
  assert.deepEqual(label("/h/.cache/pip"), { kind: "cache", rule: "xdg-cache", deletable: true });
  assert.equal(label("/h/.npm")?.rule, "npm-cache");
  assert.equal(label("/h/.cargo/registry")?.rule, "cargo-registry");
  assert.equal(label("/h/.bun/install/cache")?.rule, "bun-cache");
  assert.equal(label("/h/.cargo")?.deletable ?? false, false, "the whole .cargo folder holds installed tools");
  assert.equal(label("/h/.cargo/bin"), null);
  const tool = label("/h/.cache/toolchains");
  assert.equal(tool?.kind, "mine");
  assert.equal(tool?.deletable, false);
  assert.equal(label("/h/.cache/venv")?.deletable, false);
});

test("the engine's folder is Cody's: nothing in it is deletable by path", () => {
  assert.deepEqual(label("/h/.omp/agent/sessions"), { kind: "engine", rule: "sessions", deletable: false, action: "chats" });
  assert.equal(label("/h/.omp/agent/blobs")?.action, "blobs");
  assert.equal(label("/h/.omp/agent/cody-checkpoints")?.action, "janitor");
  assert.equal(label("/h/.omp/agent/cody-data-scratch")?.action, "janitor");
  assert.equal(label("/h/.omp/agent/tools")?.kind, "engine-keep");
  assert.equal(label("/h/.omp/agent/agent.db")?.kind, "engine-keep");
  assert.equal(label("/h/.omp/agent/agent.db")?.deletable, false);
  assert.equal(label("/h/.omp/agent")?.rule, "agent-root");
  // A build folder somewhere inside the engine's folder is still the engine's.
  assert.equal(label("/h/.omp/agent/sessions/x/target", ["Cargo.toml"]), null);
});

test("temp and ~/tmp entries are the janitor's", () => {
  assert.deepEqual(label("/t/cs"), { kind: "engine", rule: "chat-scratch", deletable: false, action: "janitor" });
  assert.equal(label("/t/anything")?.rule, "tmp-entry");
  assert.equal(label("/h/tmp/scratch")?.rule, "home-tmp");
  assert.equal(label("/h/tmp/scratch")?.deletable, false);
});

test("isWithin is by whole path segments", () => {
  assert.equal(isWithin("/h/a", "/h"), true);
  assert.equal(isWithin("/h", "/h"), true);
  assert.equal(isWithin("/hx/a", "/h"), false);
  assert.ok(CANDIDATE_NAMES.includes("target") && CANDIDATE_NAMES.includes("node_modules"));
});
