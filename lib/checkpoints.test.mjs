import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
const { createCheckpoint, listCheckpoints, restoreCheckpoint, encodeCheckpointMessage, parseCheckpointMessage } = await jiti.import("./checkpoints.ts");

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

test("message encode/parse", () => {
  assert.equal(parseCheckpointMessage(encodeCheckpointMessage("  hello\n world  ")), "hello world");
  assert.equal(parseCheckpointMessage("raw subject"), "raw subject");
});

test("workspace with its own git repo is untouched", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cody-ckpt-git-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", ws, "init", "-q"]);
  execFileSync("git", ["-C", ws, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(ws, "f.txt"), "v1\n");
  execFileSync("git", ["-C", ws, "add", "."]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "init"]);
  const headBefore = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"]).toString();

  const cp = await createCheckpoint(ws, "snap");
  assert.ok(cp);
  fs.writeFileSync(path.join(ws, "f.txt"), "v2\n");
  const restored = await restoreCheckpoint(ws, cp, "safety");
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.readFileSync(path.join(ws, "f.txt"), "utf8"), "v1\n");
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
