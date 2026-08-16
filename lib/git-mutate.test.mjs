import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { mutateGit } = await jiti.import("./git-changes.ts");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mutate-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { dir, git };
}

test("discard does not retarget a neighbour whose name is the trimmed form", async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, "report.txt"), "committed\n");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "report.txt"), "PRECIOUS UNCOMMITTED\n");
  // legal filename with a trailing space
  fs.writeFileSync(path.join(dir, "report.txt "), "scratch\n");

  const result = await mutateGit(dir, "discard", path.join(dir, "report.txt "));
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(path.join(dir, "report.txt ")), false, "the clicked file is gone");
  assert.equal(fs.readFileSync(path.join(dir, "report.txt"), "utf8"), "PRECIOUS UNCOMMITTED\n",
    "the neighbour's uncommitted work survived");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discard works on a staged-new file that HEAD has never seen", async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, "seed"), "x\n");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "added.txt"), "staged\n");
  git("add", "added.txt");
  fs.appendFileSync(path.join(dir, "added.txt"), "then modified\n"); // porcelain "AM"

  const result = await mutateGit(dir, "discard", path.join(dir, "added.txt"));
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(path.join(dir, "added.txt")), false, "AM file discarded");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unstaging a rename releases both sides", async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, "old.txt"), "content\n");
  git("add", "-A"); git("commit", "-qm", "init");
  git("mv", "old.txt", "new.txt");

  const result = await mutateGit(dir, "unstage", path.join(dir, "new.txt"));
  assert.equal(result.ok, true, result.error);
  const status = git("status", "--porcelain=v1");
  assert.ok(!/^D  old\.txt/m.test(status), `old path left staged-deleted:\n${status}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("commit is scoped to the workspace subtree, not the whole repo", async () => {
  const { dir, git } = repo();
  fs.mkdirSync(path.join(dir, "frontend"));
  fs.writeFileSync(path.join(dir, "seed"), "x\n");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "frontend", "app.js"), "in scope\n");
  fs.writeFileSync(path.join(dir, "secret.env"), "OUT of scope\n");
  git("add", "-A");

  const result = await mutateGit(path.join(dir, "frontend"), "commit", undefined, "scoped");
  assert.equal(result.ok, true, result.error);
  const files = git("show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["frontend/app.js"], `committed the wrong set: ${files.join(",")}`);
  assert.match(git("status", "--porcelain=v1"), /secret\.env/, "out-of-scope file stays staged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discard removes an untracked file inside an untracked directory", () => {
  // getGitStatus runs `status -uall`, so git never collapses a directory into
  // a single "?? vendor/" row — every untracked FILE gets its own entry, and
  // that is the only shape the panel can send. (mutateGit still normalizes a
  // trailing slash defensively in case that flag ever changes.)
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, "seed"), "x\n");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.mkdirSync(path.join(dir, "vendor"));
  fs.writeFileSync(path.join(dir, "vendor", "lib.js"), "junk\n");

  return mutateGit(dir, "discard", path.join(dir, "vendor", "lib.js")).then((result) => {
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.existsSync(path.join(dir, "vendor", "lib.js")), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
