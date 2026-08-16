import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJiti } from "jiti";
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
