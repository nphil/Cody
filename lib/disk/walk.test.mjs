import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { findRecentChange, lowPriorityCommand, mapLimit, measureTree, removeTree } = await jiti.import("./walk.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cody-walk-test-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
/** A fresh directory holding `files` (relative path → byte count or text). */
function tree(files) {
  const dir = path.join(base, `tree-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "number" ? Buffer.alloc(content, 1) : content);
  }
  return dir;
}

test("a tree's size is the sum of its files, a hard-linked file counts once, and a link is never entered", async () => {
  const dir = tree({ "a.txt": 100, "sub/b.txt": 50 });
  fs.linkSync(path.join(dir, "sub", "b.txt"), path.join(dir, "sub", "b-again.txt"));
  const outside = tree({ "huge.bin": 1_000_000 });
  fs.symlinkSync(outside, path.join(dir, "out"));

  const stats = await measureTree(dir);
  assert.equal(stats.complete, true);
  assert.equal(stats.crossedDevice, false);
  assert.equal(stats.bytes, 150 + fs.lstatSync(path.join(dir, "out")).size, "files once each, the link as a link");
  assert.ok(stats.bytes < 1_000_000, "what the link points at is not part of the tree");
});

test("a missing path measures as empty and complete; a plain file as its own size", async () => {
  const gone = await measureTree(path.join(base, "no-such-path"));
  assert.deepEqual([gone.bytes, gone.entries, gone.complete], [0, 0, true]);
  const dir = tree({ "only.txt": 42 });
  assert.equal((await measureTree(path.join(dir, "only.txt"))).bytes, 42);
});

test("modification time and status change are told apart: a restored tree keeps old mtimes but is new", async () => {
  const dir = tree({ "restored.txt": 10 });
  const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(dir, "restored.txt"), longAgo, longAgo);
  fs.utimesSync(dir, longAgo, longAgo);

  const stats = await measureTree(dir);
  assert.ok(stats.newestModifiedMs <= longAgo.getTime() + 1000, "by modification alone it is ten days old");
  assert.ok(stats.newestMs >= Date.now() - 60_000, "but its status changed just now, so it is not");
});

test("stopping at the first newer entry reports an incomplete walk that still shows the newer time", async () => {
  const files = {};
  for (let index = 0; index < 20; index++) files[`dir${index}/file.txt`] = 1;
  const dir = tree(files);
  const threshold = Date.now() - 3600_000;

  const early = await measureTree(dir, { stopWhenNewerThanMs: threshold });
  assert.equal(early.complete, false);
  assert.ok(early.newestMs > threshold);

  const quiet = await measureTree(dir, { stopWhenNewerThanMs: Date.now() + 3600_000 });
  assert.equal(quiet.complete, true, "nothing newer: the whole tree was read");
  assert.equal(quiet.entries, 1 + 20 + 20);
});

test("a limit or a passed deadline that leaves something unread never looks complete", async () => {
  const files = {};
  for (let index = 0; index < 30; index++) files[`dir${index}/f.txt`] = 1;
  const limited = await measureTree(tree(files), { maxEntries: 5 });
  assert.equal(limited.complete, false);
  assert.ok(limited.bytes < 30, "the files in the unread directories are not counted");

  const late = await measureTree(tree(files), { deadline: Date.now() - 1 });
  assert.equal(late.complete, false);

  const whole = await measureTree(tree(files), { maxEntries: 5000 });
  assert.deepEqual([whole.complete, whole.bytes], [true, 30]);
});

test("find, when this machine can be asked, agrees with the walk about recent changes", async () => {
  const dir = tree({ "a/b/c.txt": 5 });
  const recent = await findRecentChange(dir, Date.now() - 3600_000);
  const quiet = await findRecentChange(dir, Date.now() + 3600_000);
  if (recent === "unsupported") return; // no usable `find` here: callers fall back to measureTree
  assert.equal(recent, "recent");
  assert.equal(quiet, "quiet");
  assert.equal(await findRecentChange(path.join(base, "no-such-path"), 0), "unknown", "an error is never a 'quiet'");
});

test("a read-only tree is removed, and a link inside is unlinked, not followed", async () => {
  const dir = tree({ "locked/inner/file.txt": 3 });
  const outside = tree({ "keep.txt": 7 });
  fs.symlinkSync(outside, path.join(dir, "locked", "to-outside"));
  fs.chmodSync(path.join(dir, "locked", "inner"), 0o555);
  fs.chmodSync(path.join(dir, "locked"), 0o555);

  await removeTree(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8").length, 7, "the link's target survives");
});

test("the low-priority wrapper still runs the same command with the same arguments", () => {
  const wrapped = lowPriorityCommand("find", ["/x", "-print"]);
  const argv = [wrapped.command, ...wrapped.args];
  assert.deepEqual(argv.slice(-3), ["find", "/x", "-print"], "the command, then its arguments, last");
});

test("mapLimit runs everything and never more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(item);
    running -= 1;
  });
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(peak <= 3 && peak >= 2);
});
