import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createJiti } from "jiti";

// Shadow repos live under the AGENT dir, not beside the workspace, so a test
// run with no override writes them into the real instance data dir — which is
// how a production appdata volume collected 465 stale `cody-ckpt-*` repos and
// eventually hit its quota. Point the agent dir at a temp dir for the whole
// file, before anything imports the module that reads it.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
  try {
    fs.rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // Best effort: a leaked TEMP dir is harmless, a leaked appdata dir is not.
  }
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createCheckpoint, listCheckpoints, restoreCheckpoint, checkpointGitDir, encodeCheckpointMessage, parseCheckpointMessage } = await jiti.import("./checkpoints.ts");

function snapshotFiles(workspace, hash) {
  return execFileSync("git", ["--git-dir", checkpointGitDir(workspace), "ls-tree", "-r", "--name-only", "-z", hash], { cwd: workspace })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

test("checkpoint round-trip", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-ws-"));
  fs.writeFileSync(path.join(ws, "a.txt"), "one\n");
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "b.txt"), "bee\n");
  fs.writeFileSync(path.join(ws, ".gitignore"), "ignored/\n");
  fs.mkdirSync(path.join(ws, "ignored"));
  fs.writeFileSync(path.join(ws, "ignored", "cache.bin"), "keep me\n");

  const first = await createCheckpoint(ws, "before agent edits");
  assert.ok(first, "first checkpoint created");

  // no changes -> same hash, no new checkpoint
  const again = await createCheckpoint(ws, "noop");
  assert.equal(again, first);

  // agent "edits": modify, delete, create
  fs.writeFileSync(path.join(ws, "a.txt"), "MANGLED\n");
  fs.rmSync(path.join(ws, "src", "b.txt"));
  fs.writeFileSync(path.join(ws, "new.txt"), "created later\n");
  const second = await createCheckpoint(ws, "after agent edits");
  assert.ok(second && second !== first);

  const list = await listCheckpoints(ws);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, "after agent edits");

  // restore first
  const result = await restoreCheckpoint(ws, first, "before restore");
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\n", "modified file restored");
  assert.equal(fs.readFileSync(path.join(ws, "src", "b.txt"), "utf8"), "bee\n", "deleted file restored");
  assert.equal(fs.existsSync(path.join(ws, "new.txt")), false, "later file removed");
  assert.equal(fs.readFileSync(path.join(ws, "ignored", "cache.bin"), "utf8"), "keep me\n", "ignored tree untouched");
  // the safety snapshot captured the pre-restore state
  assert.ok(result.safetyHash);
  const afterList = await listCheckpoints(ws);
  assert.ok(afterList.length >= 2);

  // restore the safety snapshot: MANGLED state comes back
  const undo = await restoreCheckpoint(ws, result.safetyHash, "undo restore");
  assert.equal(undo.ok, true, undo.error);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "MANGLED\n", "restore is undoable");
  assert.equal(fs.existsSync(path.join(ws, "new.txt")), true);
  fs.rmSync(ws, { recursive: true, force: true });
});
test("oversized untracked files are excluded, survive restore, and enter snapshots after shrinking", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-big-"));
  const largeName = " big\\*?[x]!# ";
  const largePath = path.join(ws, largeName);
  const nestedLargeName = path.join("nested", largeName);
  const nestedLargePath = path.join(ws, nestedLargeName);
  const boundaryName = "exactly-20mb.bin";
  const boundaryPath = path.join(ws, boundaryName);
  const trackedGrowingName = "tracked-growing.bin";
  const trackedGrowingPath = path.join(ws, trackedGrowingName);
  fs.writeFileSync(path.join(ws, "tracked.txt"), "base\n");
  fs.writeFileSync(largePath, Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));
  fs.mkdirSync(path.dirname(nestedLargePath), { recursive: true });
  fs.writeFileSync(nestedLargePath, "nested sibling stays included\n");
  fs.writeFileSync(boundaryPath, Buffer.alloc(20 * 1024 * 1024, 0x62));
  fs.writeFileSync(trackedGrowingPath, "small tracked file\n");

  const first = await createCheckpoint(ws, "large-file base");
  assert.ok(first);
  assert.equal(snapshotFiles(ws, first).includes(largeName), false, "large file is not stored in the commit");
  assert.ok(snapshotFiles(ws, first).includes(boundaryName), "a file exactly at the limit is included");
  assert.ok(snapshotFiles(ws, first).includes(nestedLargeName), "a root-file rule does not ignore the same name in a subdirectory");

  fs.writeFileSync(trackedGrowingPath, Buffer.alloc(20 * 1024 * 1024 + 1, 0x63));
  const grown = await createCheckpoint(ws, "tracked file grows");
  assert.ok(grown && grown !== first);
  assert.equal(execFileSync("git", ["--git-dir", checkpointGitDir(ws), "cat-file", "-s", grown + ":" + trackedGrowingName], { cwd: ws }).toString("utf8").trim(), String(20 * 1024 * 1024 + 1), "tracked files remain snapshotted after growing");

  fs.writeFileSync(path.join(ws, "tracked.txt"), "edited\n");
  fs.writeFileSync(path.join(ws, "later.txt"), "remove me\n");
  const restored = await restoreCheckpoint(ws, first, "large-file restore");
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.statSync(largePath).size, 20 * 1024 * 1024 + 1, "excluded file survives git clean during restore");
  assert.equal(fs.readFileSync(path.join(ws, "tracked.txt"), "utf8"), "base\n");
  assert.equal(fs.existsSync(path.join(ws, "later.txt")), false);

  fs.writeFileSync(largePath, "small now\n");
  const shrunk = await createCheckpoint(ws, "large-file shrunk");
  assert.ok(shrunk && shrunk !== first);
  assert.ok(snapshotFiles(ws, shrunk).includes(largeName), "the refreshed exclude list allows a shrunken file back in");
  assert.equal(execFileSync("git", ["--git-dir", checkpointGitDir(ws), "show", shrunk + ":" + largeName], { cwd: ws }).toString("utf8"), "small now\n");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("default build/cache excludes are absent from snapshots and survive restore", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-default-excludes-"));
  fs.mkdirSync(path.join(ws, "node_modules", "package"), { recursive: true });
  fs.mkdirSync(path.join(ws, "dist"), { recursive: true });
  fs.mkdirSync(path.join(ws, "target", "debug"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "package", "index.js"), "cache\n");
  fs.writeFileSync(path.join(ws, "dist", "bundle.bin"), "generated\n");
  fs.writeFileSync(path.join(ws, "target", "debug", "artifact"), "compiled\n");
  fs.writeFileSync(path.join(ws, "source.txt"), "base\n");
  const first = await createCheckpoint(ws, "default excludes");
  assert.ok(first);
  assert.ok(snapshotFiles(ws, first).includes("source.txt"));
  assert.equal(snapshotFiles(ws, first).includes("node_modules/package/index.js"), false);
  assert.equal(snapshotFiles(ws, first).includes("dist/bundle.bin"), false);
  assert.equal(snapshotFiles(ws, first).includes("target/debug/artifact"), false);

  fs.writeFileSync(path.join(ws, "source.txt"), "edited\n");
  fs.writeFileSync(path.join(ws, "later.txt"), "remove me\n");
  const restored = await restoreCheckpoint(ws, first, "default exclude restore");
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.readFileSync(path.join(ws, "node_modules", "package", "index.js"), "utf8"), "cache\n");
  assert.equal(fs.readFileSync(path.join(ws, "dist", "bundle.bin"), "utf8"), "generated\n");
  assert.equal(fs.readFileSync(path.join(ws, "target", "debug", "artifact"), "utf8"), "compiled\n");
  assert.equal(fs.existsSync(path.join(ws, "later.txt")), false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("first shadow-repo use sweeps leftover pack/object files and an old index lock", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-sweep-"));
  fs.writeFileSync(path.join(ws, "file.txt"), "snapshot\n");
  const gitDir = checkpointGitDir(ws);
  const packDir = path.join(gitDir, "objects", "pack");
  const objectDir = path.join(gitDir, "objects", "ab");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(objectDir, { recursive: true });
  const tmpPack = path.join(packDir, "tmp_pack_leaked");
  const tmpObject = path.join(objectDir, "tmp_obj_leaked");
  const staleLock = path.join(gitDir, "index.lock");
  fs.writeFileSync(tmpPack, "partial pack");
  fs.writeFileSync(tmpObject, "partial object");
  fs.writeFileSync(staleLock, "old lock");
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(staleLock, oldTime, oldTime);

  assert.ok(await createCheckpoint(ws, "sweep"));
  assert.equal(fs.existsSync(tmpPack), false);
  assert.equal(fs.existsSync(tmpObject), false);
  assert.equal(fs.existsSync(staleLock), false);
  fs.rmSync(ws, { recursive: true, force: true });
});
test("a killed add releases its index lock before the warm-up retry", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-timeout-"));
  const workspace = path.join(temp, "workspace");
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(workspace, "source.txt"), "snapshot me\n");
  const realGit = (process.env.PATH ?? "").split(path.delimiter)
    .map((directory) => path.join(directory, "git"))
    .find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(realGit, "git executable found on PATH");
  const wrapperPath = path.join(binDir, "git");
  fs.writeFileSync(wrapperPath, [
    "#!/bin/sh",
    "if [ \"$1\" = add ]; then",
    "  : > \"$GIT_DIR/index.lock\"",
    "  : > \"$CODY_TEST_ADD_STARTED\"",
    "  exec sleep 30",
    "fi",
    "exec \"$CODY_TEST_REAL_GIT\" \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  const childSource = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { createJiti } from "jiti";',
    'const agentDir = process.env.CODY_TEST_AGENT_DIR;',
    'process.env.PI_CODING_AGENT_DIR = agentDir;',
    'const jiti = createJiti(import.meta.url, { tsconfigPaths: true });',
    'const { createCheckpoint, checkpointGitDir } = await jiti.import("./lib/checkpoints.ts");',
    'const workspace = process.env.CODY_TEST_WORKSPACE;',
    'const hash = await createCheckpoint(workspace, "timeout test");',
    'const secondStarted = Date.now();',
    'const secondHash = await createCheckpoint(workspace, "while warm-up runs");',
    'const secondElapsedMs = Date.now() - secondStarted;',
    'const gitDir = checkpointGitDir(workspace);',
    'const markerPath = path.join(gitDir, "cody-backoff.json");',
    'const until = Date.now() + 5000;',
    'while (!fs.existsSync(markerPath) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));',
    'console.log(JSON.stringify({ hash, secondHash, secondElapsedMs, lockExists: fs.existsSync(path.join(gitDir, "index.lock")), backoffExists: fs.existsSync(markerPath), addStarted: fs.existsSync(process.env.CODY_TEST_ADD_STARTED) }));',
  ].join("\n");
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODY_TEST_AGENT_DIR: agentDir,
        CODY_TEST_WORKSPACE: workspace,
        CODY_TEST_REAL_GIT: realGit,
        CODY_TEST_ADD_STARTED: path.join(temp, "add-started"),
        PATH: binDir + path.delimiter + (process.env.PATH ?? ""),
        CODY_CHECKPOINT_TIMEOUT_MS: "3000",
        CODY_CHECKPOINT_WARMUP_TIMEOUT_MS: "300",
      },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }).toString("utf8");
    const result = JSON.parse(output.trim());
    assert.equal(result.hash, null);
    assert.equal(result.addStarted, true, "the test git wrapper reached add and created a lock");
    assert.equal(result.secondHash, null, "later snapshots skip while the warm-up is running");
    assert.ok(result.secondElapsedMs < 100, "the warm-up skip is immediate");
    assert.equal(result.backoffExists, true, "the background retry finished");
    assert.equal(result.lockExists, false, "killed git's fresh index lock is cleaned up");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("active backoff skips snapshots quickly and a later successful snapshot clears it", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-backoff-"));
  fs.writeFileSync(path.join(ws, "file.txt"), "base\n");
  const first = await createCheckpoint(ws, "backoff base");
  assert.ok(first);
  const markerPath = path.join(checkpointGitDir(ws), "cody-backoff.json");
  fs.writeFileSync(markerPath, JSON.stringify({ until: Date.now() + 60 * 60_000, reason: "test" }));

  const started = process.hrtime.bigint();
  assert.equal(await createCheckpoint(ws, "backoff skip"), null);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.ok(elapsedMs < 1_000, "active backoff returns without running git");

  fs.writeFileSync(markerPath, JSON.stringify({ until: Date.now() - 1, reason: "expired test marker" }));
  fs.writeFileSync(path.join(ws, "file.txt"), "changed\n");
  assert.ok(await createCheckpoint(ws, "backoff cleared"));
  assert.equal(fs.existsSync(markerPath), false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("message encode/parse", () => {
  assert.equal(parseCheckpointMessage(encodeCheckpointMessage("  hello\n world  ")), "hello world");
  assert.equal(parseCheckpointMessage("raw subject"), "raw subject");
});

test("workspace with its own git repo is untouched", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-git-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", ws, "init", "-q"]);
  fs.mkdirSync(path.join(ws, "local-cache"));
  fs.writeFileSync(path.join(ws, "local-cache", "keep.txt"), "preserve me\n");
  fs.writeFileSync(path.join(ws, ".git", "info", "exclude"), "local-cache/\n");
  execFileSync("git", ["-C", ws, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(ws, "f.txt"), "v1\n");
  execFileSync("git", ["-C", ws, "add", "."]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "init"]);
  const headBefore = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"]).toString();

  const cp = await createCheckpoint(ws, "snap");
  assert.ok(cp);
  assert.equal(snapshotFiles(ws, cp).includes("local-cache/keep.txt"), false);
  fs.writeFileSync(path.join(ws, "f.txt"), "v2\n");
  const restored = await restoreCheckpoint(ws, cp, "safety");
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.readFileSync(path.join(ws, "f.txt"), "utf8"), "v1\n");
  assert.equal(fs.readFileSync(path.join(ws, "local-cache", "keep.txt"), "utf8"), "preserve me\n");
  const headAfter = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"]).toString();
  assert.equal(headAfter, headBefore, "workspace repo HEAD untouched");
  assert.ok(fs.existsSync(path.join(ws, ".git", "config")), "workspace .git intact");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("an empty nested repo no longer disables checkpoints", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-nested-"));
  const { execFileSync } = await import("node:child_process");
  fs.writeFileSync(path.join(ws, "top.txt"), "v1\n");
  fs.mkdirSync(path.join(ws, "fresh"));
  execFileSync("git", ["-C", path.join(ws, "fresh"), "init", "-q"]);

  // Plain `git add -A` exits "fatal: adding files failed" here, which used to
  // make every checkpoint for this workspace return null forever.
  const cp = await createCheckpoint(ws, "with empty nested repo");
  assert.ok(cp, "snapshot still created");

  fs.writeFileSync(path.join(ws, "top.txt"), "v2\n");
  const restored = await restoreCheckpoint(ws, cp, "safety");
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.readFileSync(path.join(ws, "top.txt"), "utf8"), "v1\n");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("restore refuses when the safety snapshot cannot be taken", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-safety-"));
  fs.writeFileSync(path.join(ws, "keep.txt"), "precious\n");
  const cp = await createCheckpoint(ws, "base");
  assert.ok(cp);
  fs.writeFileSync(path.join(ws, "keep.txt"), "edited\n");

  // Simulate the safety snapshot failing by removing the workspace's ability
  // to be stat'd as a directory mid-flight: point restore at a path that is a
  // file, which makes createCheckpoint return null.
  const notADir = path.join(ws, "keep.txt");
  const result = await restoreCheckpoint(notADir, cp, "safety");
  assert.equal(result.ok, false, "restore must refuse");
  assert.match(result.error ?? "", /cancelled|Invalid|not found/i);
  // The real workspace is untouched.
  assert.equal(fs.readFileSync(path.join(ws, "keep.txt"), "utf8"), "edited\n");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("concurrent snapshots serialize instead of racing the index", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-race-"));
  fs.writeFileSync(path.join(ws, "a.txt"), "1\n");
  const results = await Promise.all([
    createCheckpoint(ws, "one"),
    createCheckpoint(ws, "two"),
    createCheckpoint(ws, "three"),
  ]);
  assert.ok(results.every((r) => typeof r === "string" && r.length === 40), "no index.lock casualties");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("refuses to snapshot home, filesystem roots, and Cody's own state dir", async () => {
  const { isUncheckpointableRoot } = await jiti.import("./checkpoints.ts");
  const home = process.env.HOME || os.homedir();

  // The case that grew a 3.5 GB shadow repo out of ~/.npm and ~/.gradle.
  assert.equal(isUncheckpointableRoot(home), true, "home directory");
  assert.equal(isUncheckpointableRoot(path.parse(process.cwd()).root), true, "filesystem root");
  assert.equal(isUncheckpointableRoot(agentDir), true, "agent dir");
  assert.equal(isUncheckpointableRoot(path.join(agentDir, "cody-checkpoints")), true, "inside agent dir");
  assert.equal(isUncheckpointableRoot(path.dirname(agentDir)), true, "instance data dir");

  // A real project stays checkpointable — including one nested under home.
  assert.equal(isUncheckpointableRoot(path.join(home, "projects", "app")), false);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-ok-"));
  assert.equal(isUncheckpointableRoot(ws), false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("createCheckpoint answers null for an uncheckpointable root, writing nothing", async () => {
  const home = process.env.HOME || os.homedir();
  const before = fs.existsSync(path.join(agentDir, "cody-checkpoints"))
    ? fs.readdirSync(path.join(agentDir, "cody-checkpoints")).length
    : 0;
  assert.equal(await createCheckpoint(home, "should not happen"), null);
  const after = fs.existsSync(path.join(agentDir, "cody-checkpoints"))
    ? fs.readdirSync(path.join(agentDir, "cody-checkpoints")).length
    : 0;
  assert.equal(after, before, "no shadow repo may be created for a refused root");
});
