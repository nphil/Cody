import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const usage = await jiti.import("./usage.ts");
const { PathMentions } = await jiti.import("./mentions.ts");
const { removeTree } = await jiti.import("./walk.ts");
const { MARKER_FILES, CANDIDATE_NAMES } = await jiti.import("./usage-rules.ts");

// tmpfs when there is one: some disks (ZFS) report a fresh file's allocation late, which the size assertions below cannot wait for.
const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "cody-usage-test-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const scanner = path.resolve(import.meta.dirname, "../../bin/cody-disk-usage.mjs");

const home = path.join(base, "home");
const agentDir = path.join(base, "agent");
const tmpDir = path.join(base, "tmp");
const outside = path.join(base, "outside");
const context = { home, agentDir, tmpDir };
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_PACKAGE_DIR = path.resolve(import.meta.dirname, "../..");

const HOUR = 3_600_000;
const NOW = Date.now() + 2 * HOUR; // "now" for the fixture: what it holds was written two hours ago, well past the 15-minute rule.

function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, randomBytes(bytes));
}

function build() {
  fs.rmSync(base, { recursive: true, force: true });
  for (const dir of [home, agentDir, tmpDir, outside]) fs.mkdirSync(dir, { recursive: true });
  put(path.join(home, "rusty/Cargo.toml"), 10);
  put(path.join(home, "rusty/src/main.rs"), 8_000);
  put(path.join(home, "rusty/.git/HEAD"), 10);
  put(path.join(home, "rusty/target/debug/big.bin"), 200_000);
  put(path.join(home, "web/package.json"), 10);
  put(path.join(home, "web/node_modules/dep/index.js"), 120_000);
  put(path.join(home, "web/.next/cache/blob"), 60_000);
  put(path.join(home, "web/src/app.ts"), 4_000);
  put(path.join(home, "plain/target/thing.bin"), 50_000);
  put(path.join(home, "docs/big.txt"), 300_000);
  put(path.join(home, ".cache/foo/data.bin"), 90_000);
  put(path.join(home, ".cache/toolchains/rustc"), 70_000);
  put(path.join(agentDir, "sessions/a.jsonl"), 40_000);
  put(path.join(agentDir, "blobs/b"), 10_000);
  put(path.join(agentDir, "agent.db"), 5_000);
  put(path.join(outside, "secret.txt"), 500_000);
  fs.symlinkSync(outside, path.join(home, "escape"));
}

function scan(minBytes = 1) {
  const spec = { volume: "data", roots: [{ path: agentDir, label: "agent" }, { path: home, label: "home" }, { path: tmpDir, label: "tmp" }], markers: MARKER_FILES, candidates: CANDIDATE_NAMES, levels: [24, 14, 10, 8], minBytes, maxCandidates: 50, deadlineMs: 60_000 };
  const files = usage.usageFiles("data");
  execFileSync(process.execPath, [scanner, "scan", "--spec", JSON.stringify(spec), "--out", files.result, "--partial", files.partial]);
  return files;
}

const find = (node, ...names) => names.reduce((current, name) => current?.children?.find((child) => child.name === name), node);
const homeRoot = (payload) => payload.result.roots.find((root) => root.label === "home").node;

test("the scanner reports sizes and markers, never follows a link, and leaves no progress file", () => {
  build();
  const files = scan();
  assert.equal(fs.existsSync(files.partial), false);
  assert.equal(fs.statSync(files.result).mode & 0o777, 0o600);
  const payload = usage.readUsage("data", new Set(), true, context, NOW);
  assert.equal(payload.result.complete, true);
  assert.equal(payload.partial, false);
  const homeNode = homeRoot(payload);
  assert.ok(homeNode.bytes >= 200_000 + 120_000 + 300_000, "the files under home are counted");
  assert.ok(homeNode.bytes < 500_000 + 200_000 + 120_000 + 300_000 + 400_000, "what the link points at is not counted");
  const names = homeNode.children.map((child) => child.name);
  assert.ok(names.includes("docs") && names.includes("rusty") && names.includes("web"));
  const sorted = homeNode.children.map((child) => child.bytes);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), "biggest first");
});

test("labels: build output next to its project file is rebuildable, a bare target and your documents are not", () => {
  build();
  scan();
  const payload = usage.readUsage("data", new Set([path.join(home, "rusty")]), true, context, NOW);
  const root = homeRoot(payload);
  const target = find(root, "rusty", "target");
  assert.equal(target.kind, "rebuild");
  assert.equal(target.rule, "cargo-target");
  assert.equal(target.deletable, true);
  assert.equal(find(root, "web", "node_modules").rule, "node-modules");
  assert.equal(find(root, "web", ".next").rule, "web-build");
  const bare = find(root, "plain", "target");
  assert.equal(bare?.kind ?? "mine", "mine", "a target with no Cargo.toml is somebody's folder");
  assert.equal(bare?.deletable ?? false, false);
  assert.equal(find(root, "docs").kind, "mine");
  assert.equal(find(root, "docs").deletable ?? false, false);
  assert.equal(find(root, ".cache", "foo").rule, "xdg-cache");
  assert.equal(find(root, ".cache", "toolchains").kind, "mine");
  // Only the exact folder the file viewer lists gets "Show in Files".
  assert.equal(find(root, "rusty").inFiles, true);
  assert.equal(find(root, "web").inFiles ?? false, false);
  // Inside build output everything inherits: no buttons.
  const dep = find(root, "web", "node_modules", "dep");
  if (dep) {
    assert.equal(dep.inherited, true);
    assert.equal(dep.deletable ?? false, false);
  }
  const agent = payload.result.roots.find((entry) => entry.label === "agent").node;
  assert.equal(find(agent, "sessions").action, "chats");
  assert.equal(find(agent, "blobs").action, "blobs");
  assert.equal(find(agent, "agent.db").kind, "engine-keep");
  assert.equal(find(agent, "agent.db").deletable ?? false, false);
  const candidates = payload.result.rebuildable.map((item) => item.path);
  assert.ok(candidates.includes(path.join(home, "rusty/target")));
  assert.ok(candidates.includes(path.join(home, "web/node_modules")));
  assert.ok(!candidates.includes(path.join(home, "plain/target")), "no recognised rule, no candidate");
  assert.ok(payload.result.rebuildable.every((item, index, list) => index === 0 || list[index - 1].bytes >= item.bytes));
});

test("the cache is shown with its age, a scan runs one at a time, and a finished one replaces the progress", async () => {
  build();
  fs.rmSync(usage.usageFiles("data").result, { force: true });
  assert.equal(usage.readUsage("data", new Set(), true, context, NOW).result, null, "never measured");
  assert.equal(usage.startUsageScan("data", context), "started");
  assert.equal(usage.startUsageScan("tmp", context), "running", "a second scan waits for the first");
  assert.equal(usage.readUsage("data", new Set(), true, context).scan.running, true);
  for (let waited = 0; usage.runningScanVolume() !== null && waited < 30_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(usage.runningScanVolume(), null);
  const done = usage.readUsage("data", new Set(), true, context);
  assert.equal(done.scan.running, false);
  assert.ok(done.result && done.result.finishedAt > 0 && done.result.complete);
  assert.equal(fs.existsSync(usage.usageFiles("data").partial), false);
  assert.deepEqual(fs.readdirSync(agentDir).filter((name) => name.endsWith(".tmp")), [], "no half-written file is left");
});

test("pruning removes a dead scan's progress file and a result nobody has read for 30 days, never a fresh one", () => {
  build();
  const files = usage.usageFiles("data");
  fs.writeFileSync(files.result, "{}");
  fs.writeFileSync(files.partial, "{}");
  usage.pruneUsageCache(Date.now());
  assert.equal(fs.existsSync(files.result), true);
  assert.equal(fs.existsSync(files.partial), true, "a progress file touched a moment ago may belong to a running scan");
  usage.pruneUsageCache(Date.now() + 5 * 60_000);
  assert.equal(fs.existsSync(files.partial), false);
  assert.equal(fs.existsSync(files.result), true);
  usage.pruneUsageCache(Date.now() + 31 * 24 * HOUR);
  assert.equal(fs.existsSync(files.result), false);
});

const idle = { ids: new Set(), cwds: new Set(), dirs: new Set() };
function measureReal(target) {
  return Promise.resolve(JSON.parse(execFileSync(process.execPath, [scanner, "measure", target], { encoding: "utf8" }).trim().split("\n").pop()));
}
function deps(over = {}) {
  return { context, liveSessions: () => idle, processes: async () => new PathMentions([{ path: home }, { path: tmpDir }]), measure: measureReal, remove: removeTree, now: () => NOW, ...over };
}
const refusal = async (target, over) => (await usage.previewClear(target, deps(over))).refused?.code;

test("clearing refuses everything that is not recognised build output or a cache, and says why", async () => {
  build();
  const rusty = path.join(home, "rusty");
  assert.equal((await usage.previewClear(path.join(rusty, "target"), deps())).plan?.rule, "cargo-target");
  assert.equal(await refusal(path.join(home, "docs")), "not-recognised", "your files");
  assert.equal(await refusal(path.join(home, "plain/target")), "not-recognised", "a target with no Cargo.toml");
  assert.equal(await refusal(rusty), "not-recognised", "a project root");
  assert.equal(await refusal(path.join(rusty, ".git")), "not-recognised", ".git");
  assert.equal(await refusal(path.join(rusty, "src")), "not-recognised", "source");
  assert.equal(await refusal(home), "outside", "home itself");
  assert.equal(await refusal(base), "outside", "above home");
  assert.equal(await refusal(path.join(base, "outside")), "outside", "a folder outside home and temp");
  assert.equal(await refusal(agentDir), "outside", "the engine's folder");
  assert.equal(await refusal(path.join(agentDir, "sessions")), "outside");
  assert.equal(await refusal(path.join(agentDir, "agent.db")), "not-recognised", "files beside the database are not folders, so never recognised");
  assert.equal(await refusal("relative/target"), "outside");
  assert.equal(await refusal(`${rusty}/../rusty/target`), "outside", "an unnormalised path");
  assert.equal(await refusal(42), "outside");
  assert.equal(await refusal(path.join(rusty, "nope")), "missing");
  assert.equal(await refusal(path.join(rusty, "Cargo.toml")), "not-recognised", "a file, not a folder");
});

test("clearing never follows a link: not as the item, not as a parent", async () => {
  build();
  const victim = path.join(outside, "target");
  put(path.join(outside, "Cargo.toml"), 10);
  put(path.join(victim, "x.bin"), 1000);
  fs.symlinkSync(victim, path.join(home, "rusty/linked-target"));
  assert.equal(await refusal(path.join(home, "rusty/linked-target")), "symlink");
  fs.symlinkSync(outside, path.join(home, "via"));
  assert.equal(await refusal(path.join(home, "via/target")), "symlink", "a link in the middle of the path");
  assert.equal((await usage.clearUsageItem(path.join(home, "via/target"), deps())).cleared, undefined);
  assert.equal(fs.existsSync(path.join(victim, "x.bin")), true, "what the link points at is untouched");
  // A link swapped in after the checks is caught by the last look before the delete.
  const rusty = path.join(home, "rusty/target");
  const answer = await usage.clearUsageItem(rusty, deps({
    measure: async (target) => {
      const measured = await measureReal(target);
      if (fs.existsSync(rusty)) {
        fs.rmSync(rusty, { recursive: true });
        fs.symlinkSync(outside, rusty);
      }
      return measured;
    },
  }));
  assert.equal(answer.refused?.code, "symlink");
  assert.equal(fs.existsSync(path.join(outside, "secret.txt")), true);
});

test("clearing refuses what changed in the last 15 minutes, what a process or a chat uses, and anything it cannot judge", async () => {
  build();
  const target = path.join(home, "rusty/target");
  const recent = await usage.previewClear(target, deps({ now: () => Date.now() + 5.5 * 60_000 }));
  assert.equal(recent.refused?.code, "recent");
  assert.equal(recent.refused?.detail, 5, "minutes since the last change");
  assert.equal(await refusal(target, { now: () => Date.now() + 14.5 * 60_000 }), "recent");
  assert.equal(await refusal(target, { now: () => Date.now() + 16 * 60_000 }), undefined);

  const mentions = new PathMentions([{ path: home }, { path: tmpDir }]);
  mentions.addText(`cargo run --manifest-path ${home}/rusty/target/debug/app`);
  assert.equal(await refusal(target, { processes: async () => mentions }), "in-use");
  assert.equal(await refusal(path.join(home, "web/node_modules"), { processes: async () => mentions }), undefined, "another folder is not in use");

  assert.equal(await refusal(target, { liveSessions: () => ({ ...idle, cwds: new Set([path.join(home, "rusty/target/debug")]) }) }), "chat-cwd");
  assert.equal(await refusal(target, { liveSessions: () => null }), "process-table", "the chat registry cannot be read");
  assert.equal(await refusal(target, { processes: async () => null }), "process-table", "the process table cannot be trusted");
  assert.equal(await refusal(target, { measure: async () => null }), "unmeasurable");
  assert.equal(await refusal(target, { measure: async (t) => ({ ...(await measureReal(t)), complete: false }) }), "unmeasurable");
  assert.equal(await refusal(target, { measure: async (t) => ({ ...(await measureReal(t)), crossedDevice: true }) }), "mount");
  assert.equal(fs.existsSync(target), true, "nothing was deleted by any of these");
});

test("clearing frees exactly what was measured, reports it, and updates the cached tree", async () => {
  build();
  scan();
  const target = path.join(home, "rusty/target");
  const before = usage.readUsage("data", new Set(), true, context, NOW);
  const rustyBefore = find(homeRoot(before), "rusty");
  const plan = (await usage.previewClear(target, deps())).plan;
  assert.ok(plan.bytes >= 200_000);

  const answer = await usage.clearUsageItem(target, deps());
  assert.equal(answer.cleared, true);
  assert.equal(answer.freedBytes, plan.bytes);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(home, "rusty/Cargo.toml")), true, "the project beside it is untouched");
  assert.equal(fs.existsSync(path.join(home, "rusty/.git/HEAD")), true);
  assert.equal(fs.existsSync(path.join(outside, "secret.txt")), true);

  const after = usage.readUsage("data", new Set(), true, context, NOW);
  assert.equal(find(homeRoot(after), "rusty", "target"), undefined, "gone from the tree");
  assert.equal(find(homeRoot(after), "rusty").bytes, rustyBefore.bytes - plan.bytes, "and the folder above it shrank");
  assert.equal(homeRoot(after).bytes, homeRoot(before).bytes - plan.bytes);
  assert.ok(!after.result.rebuildable.some((item) => item.path === target));
  assert.equal((await usage.previewClear(target, deps())).refused?.code, "missing");
});

test("only one clear runs at a time", async () => {
  build();
  const release = Promise.withResolvers();
  const first = usage.clearUsageItem(path.join(home, "rusty/target"), deps({ measure: async (t) => (await release.promise, measureReal(t)) }));
  const second = await usage.clearUsageItem(path.join(home, "web/node_modules"), deps());
  assert.equal(second.refused?.code, "busy");
  release.resolve();
  assert.equal((await first).cleared, true);
});

test("clearing everything older than N days takes only recognised folders that old, and skips what is in use", async () => {
  build();
  scan();
  // Pretend the scan saw ages: rusty/target 30 days old, node_modules 20 days, .next brand new.
  const file = usage.usageFiles("data").result;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const age = { "rusty/target": 30, "web/node_modules": 20, "web/.next": 1 };
  for (const item of raw.rebuildable) {
    const key = path.relative(home, item.path);
    if (key in age) item.mtimeMs = NOW - age[key] * 24 * HOUR;
  }
  fs.writeFileSync(file, JSON.stringify(raw));
  const mentions = new PathMentions([{ path: home }, { path: tmpDir }]);
  mentions.addPath(path.join(home, "web/node_modules"));
  const answer = await usage.clearOlderThan("data", 14, new Set(), deps({ processes: async () => mentions }));
  assert.equal(answer.cleared, 1);
  assert.equal(answer.refused, 1, "the one in use");
  assert.equal(answer.stoppedEarly, false);
  assert.equal(fs.existsSync(path.join(home, "rusty/target")), false);
  assert.equal(fs.existsSync(path.join(home, "web/node_modules")), true);
  assert.equal(fs.existsSync(path.join(home, "web/.next")), true, "newer than the cutoff");
  assert.equal(fs.existsSync(path.join(home, "docs/big.txt")), true);
});
