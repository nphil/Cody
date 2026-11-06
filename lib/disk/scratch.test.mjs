import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * Per-chat scratch dirs: the one place everything an agent throws away goes,
 * so Cody can size it, tell the agent about it and delete it. These tests pin
 * what the janitor, the chat-delete route and the engine launch rely on: one
 * dir per chat found under any id the chat has had, nothing outside the root
 * is ever removed or followed, a lost or hostile index is harmless, and the
 * engine child's real tools (node, mktemp, python) honour the variables.
 *
 * Everything is pointed into one private directory first (temp dir, home, data
 * dir, scratch root), so a run can never touch the machine it runs on.
 */
const root = mkdtempSync(join(tmpdir(), "cody-scratch-test-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.TMPDIR = join(root, "tmp");
process.env.HOME = join(root, "home");
delete process.env.CODY_SCRATCH_ROOT;
delete process.env.CODY_DISK_AREAS;
mkdirSync(process.env.TMPDIR, { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const scratch = await jiti.import("./scratch.ts");
const { diskAreaPaths } = await jiti.import("./status.ts");
const { engineChildEnv } = await jiti.import("../harness/provider-keys.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  delete process.env.CODY_SCRATCH_ROOT;
  rmSync(scratch.scratchRoot(), { recursive: true, force: true });
  rmSync(scratch.getScratchIndexPath(), { force: true });
});

const entryFor = (dir) => scratch.listSessionScratch().find((entry) => entry.dir === dir);

test("a chat gets one short private dir, the same on every call, and two chats never share one", () => {
  const dir = scratch.ensureSessionScratch("chat-one");
  assert.ok(dir);
  assert.equal(dirname(dir), scratch.scratchRoot(), "a direct child of the root");
  assert.match(basename(dir), /^[0-9a-f]{12}$/, "short, so a unix socket made under it stays under 108 bytes");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "private to the user running Cody");
  assert.equal(scratch.ensureSessionScratch("chat-one"), dir);

  const other = scratch.ensureSessionScratch("chat-two");
  assert.ok(other);
  assert.notEqual(other, dir);
  assert.equal(readdirSync(scratch.scratchRoot()).length, 2, "one dir per chat and nothing else");
  assert.equal(scratch.ensureSessionScratch(""), null, "no id, no dir");
});

test("every id a chat has had leads to its dir, and an id with a dir of its own is never taken over", () => {
  const dir = scratch.ensureSessionScratch("__new__abc");
  scratch.noteScratchAlias("__new__abc", "real-id");
  assert.equal(scratch.ensureSessionScratch("real-id"), dir, "the real id, after the temporary one is renamed");
  scratch.noteScratchAlias("real-id", "moved-id");
  assert.equal(scratch.ensureSessionScratch("moved-id"), dir, "and the id omp moved the chat to");
  assert.equal(scratch.ensureSessionScratch("__new__abc"), dir, "older ids keep working");
  assert.deepEqual(entryFor(dir).sessionIds, ["__new__abc", "real-id", "moved-id"]);

  const own = scratch.ensureSessionScratch("has-its-own");
  scratch.noteScratchAlias("real-id", "has-its-own");
  assert.equal(scratch.ensureSessionScratch("has-its-own"), own, "another chat's dir is not re-pointed");
  assert.equal(entryFor(dir).sessionIds.includes("has-its-own"), false);

  scratch.noteScratchAlias("nobody-knows-me", "stranger");
  const stranger = scratch.ensureSessionScratch("stranger");
  assert.notEqual(stranger, dir, "an alias from an id with no dir changes nothing");
  assert.notEqual(stranger, own);
});

test("a dir that vanished (a reboot emptied the root) comes back under the same name when the chat resumes", () => {
  const dir = scratch.ensureSessionScratch("resumed-after-reboot");
  writeFileSync(join(dir, "old-build"), "gone with the reboot");
  rmSync(scratch.scratchRoot(), { recursive: true });

  assert.equal(scratch.ensureSessionScratch("resumed-after-reboot"), dir, "the path the transcript mentions is valid again");
  assert.deepEqual(readdirSync(dir), []);
});

test("a name taken by something that is not a directory is never reused", () => {
  const dir = scratch.ensureSessionScratch("squatted");
  rmSync(dir, { recursive: true });
  symlinkSync(join(root, "elsewhere"), dir);

  const fresh = scratch.ensureSessionScratch("squatted");
  assert.ok(fresh);
  assert.notEqual(fresh, dir);
  assert.equal(lstatSync(fresh).isDirectory(), true);
  assert.equal(scratch.ensureSessionScratch("squatted"), fresh, "and the chat keeps the new one");
});

test("the list holds indexed dirs with every id, and unlisted dirs dated by their own mtime, never links or files", () => {
  const listed = scratch.ensureSessionScratch("listed");
  const rootDir = scratch.scratchRoot();
  const orphan = join(rootDir, "never-indexed");
  mkdirSync(orphan);
  const longAgo = new Date(Date.now() - 5 * DAY_MS);
  utimesSync(orphan, longAgo, longAgo);
  const outside = join(root, "list-outside");
  mkdirSync(outside);
  symlinkSync(outside, join(rootDir, "a-link"));
  writeFileSync(join(rootDir, "a-file"), "x");
  const gone = scratch.ensureSessionScratch("deleted-by-hand");
  rmSync(gone, { recursive: true });

  const entries = scratch.listSessionScratch();
  assert.deepEqual(entries.map((entry) => entry.dir).sort(), [listed, orphan].sort());
  assert.deepEqual(entryFor(listed).sessionIds, ["listed"]);
  const unlisted = entryFor(orphan);
  assert.deepEqual(unlisted.sessionIds, []);
  assert.ok(Math.abs(unlisted.lastUsedAt - longAgo.getTime()) < 1_000, "dated by the dir's own modification time");
  assert.equal(unlisted.createdAt, unlisted.lastUsedAt);
});

test("touching a chat moves its last-used time and nothing else", (t) => {
  const clock = t.mock.method(Date, "now", () => 1_000_000);
  const dir = scratch.ensureSessionScratch("busy");
  assert.equal(entryFor(dir).lastUsedAt, 1_000_000);

  clock.mock.mockImplementation(() => 9_000_000);
  scratch.touchSessionScratch("busy");
  assert.equal(entryFor(dir).lastUsedAt, 9_000_000);
  assert.equal(entryFor(dir).createdAt, 1_000_000);

  scratch.touchSessionScratch("nobody");
  scratch.touchSessionScratch("");
  assert.equal(scratch.listSessionScratch().length, 1, "touching an unknown chat creates nothing");

  clock.mock.mockImplementation(() => 12_000_000);
  assert.equal(scratch.ensureSessionScratch("busy"), dir);
  assert.equal(entryFor(dir).lastUsedAt, 12_000_000, "using the dir again counts as use");
});

test("an index entry whose dir is gone is kept for a month, so a resumed chat gets its old path, then forgotten", (t) => {
  const clock = t.mock.method(Date, "now", () => 1_000_000);
  const kept = scratch.ensureSessionScratch("comes-back");
  const forgotten = scratch.ensureSessionScratch("never-comes-back");
  rmSync(scratch.scratchRoot(), { recursive: true });

  clock.mock.mockImplementation(() => 1_000_000 + 29 * DAY_MS);
  assert.deepEqual(scratch.listSessionScratch(), []);
  assert.equal(scratch.ensureSessionScratch("comes-back"), kept, "still remembered after 29 days");

  clock.mock.mockImplementation(() => 1_000_000 + 31 * DAY_MS);
  scratch.listSessionScratch();
  assert.equal(scratch.ensureSessionScratch("comes-back"), kept, "used since, so still remembered");
  assert.notEqual(scratch.ensureSessionScratch("never-comes-back"), forgotten, "forgotten after a month of silence");
});

test("removal refuses anything that is not a real directory directly under the root", async () => {
  const dir = scratch.ensureSessionScratch("protected");
  const rootDir = scratch.scratchRoot();
  const outside = join(tmpdir(), "outside-for-refusal");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious"), "keep");
  const link = join(rootDir, "link-to-outside");
  symlinkSync(outside, link);
  const file = join(rootDir, "plain-file");
  writeFileSync(file, "x");
  const nested = join(dir, "inner");
  mkdirSync(nested);

  const refused = [outside, rootDir, join(rootDir, ".."), join(rootDir, "..", "outside-for-refusal"), join(root, "agent"), nested, link, file, ""];
  for (const target of refused) {
    assert.equal(await scratch.removeScratchDir(target), false, `refused: ${target || "(empty)"}`);
  }
  assert.equal(existsSync(join(outside, "precious")), true, "a link is never followed");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "and never deleted either");
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(nested), true);
  assert.equal(scratch.ensureSessionScratch("protected"), dir, "the chat's own dir is untouched");
});

test("removing a dir deletes everything in it without following links, and the chat starts a new one", async () => {
  const dir = scratch.ensureSessionScratch("to-remove");
  const outside = join(root, "outside-target");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious"), "keep");
  mkdirSync(join(dir, "deep", "er"), { recursive: true });
  writeFileSync(join(dir, "deep", "er", "build.o"), "x");
  symlinkSync(outside, join(dir, "escape"));
  symlinkSync(join(outside, "precious"), join(dir, "deep", "file-escape"));

  assert.equal(await scratch.removeScratchDir(dir), true);
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(join(outside, "precious"), "utf8"), "keep", "links inside were removed, not followed");
  assert.equal(entryFor(dir), undefined, "forgotten");
  assert.notEqual(scratch.ensureSessionScratch("to-remove"), dir, "the old dir is gone for good");

  assert.equal(await scratch.removeScratchDir(join(scratch.scratchRoot(), "aaaaaaaaaaaa")), true, "already gone counts as removed");
});

test("a tree with read-only directories is removed too", async () => {
  const dir = scratch.ensureSessionScratch("read-only-tree");
  const pkgDir = join(dir, "pkg", "mod@v1");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "main.go"), "package main");
  chmodSync(pkgDir, 0o555);
  chmodSync(join(dir, "pkg"), 0o555);

  assert.equal(await scratch.removeScratchDir(dir), true);
  assert.equal(existsSync(dir), false);
});

test("deleting a chat removes its dir by any id it has had", async () => {
  const dir = scratch.ensureSessionScratch("__new__tmp");
  scratch.noteScratchAlias("__new__tmp", "real-session");
  writeFileSync(join(dir, "big"), "x");

  assert.equal(await scratch.removeSessionScratch("real-session"), true);
  assert.equal(existsSync(dir), false);
  assert.equal(await scratch.removeSessionScratch("real-session"), false, "nothing left to remove");
  assert.equal(await scratch.removeSessionScratch("never-had-one"), false);
  assert.equal(await scratch.removeSessionScratch(""), false);
});

test("a root that would make unrelated directories look like scratch is refused", async () => {
  const bystander = join(tmpdir(), "bystander");
  mkdirSync(bystander);
  for (const dangerous of [tmpdir(), process.env.HOME, process.env.PI_CODING_AGENT_DIR, "/"]) {
    process.env.CODY_SCRATCH_ROOT = dangerous;
    assert.equal(scratch.ensureSessionScratch("chat"), null, dangerous);
    assert.deepEqual(scratch.listSessionScratch(), [], dangerous);
    assert.equal(await scratch.removeScratchDir(bystander), false, dangerous);
    assert.equal(await scratch.removeSessionScratch("chat"), false, dangerous);
  }
  assert.equal(existsSync(bystander), true);
});

test("when no dir can be made the answer is null and nothing throws", () => {
  const blocker = join(root, "a-file-where-a-dir-should-be");
  writeFileSync(blocker, "x");
  process.env.CODY_SCRATCH_ROOT = join(blocker, "cs");

  assert.equal(scratch.ensureSessionScratch("chat"), null);
  assert.deepEqual(scratch.listSessionScratch(), []);
  scratch.touchSessionScratch("chat");
  scratch.noteScratchAlias("chat", "other");
});

test("a root owned by another user is not trusted", (t) => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return t.skip("needs root to hand a directory to another user");
  const shared = join(root, "planted-by-someone-else");
  mkdirSync(shared);
  chownSync(shared, 12345, 12345);
  process.env.CODY_SCRATCH_ROOT = shared;

  assert.equal(scratch.ensureSessionScratch("chat"), null);
  assert.deepEqual(readdirSync(shared), []);
});

test("a damaged or hostile index reads as empty and can never point outside the root", () => {
  const dir = scratch.ensureSessionScratch("before");
  writeFileSync(scratch.getScratchIndexPath(), "{ this is not json");
  assert.deepEqual(
    scratch.listSessionScratch().map((entry) => [entry.dir, entry.sessionIds]),
    [[dir, []]],
    "the dir is still found, as one the index never heard of",
  );

  const hostile = [
    { id: "../../escape", sessionIds: ["evil"], createdAt: 1, lastUsedAt: 1 },
    { id: "/etc", sessionIds: ["evil"], createdAt: 1, lastUsedAt: 1 },
    { id: "0123456789ab", sessionIds: "not a list", createdAt: "yesterday", lastUsedAt: null },
  ];
  writeFileSync(scratch.getScratchIndexPath(), JSON.stringify({ entries: hostile }));
  const evil = scratch.ensureSessionScratch("evil");
  assert.equal(dirname(evil), scratch.scratchRoot(), "a name that is not 12 hex characters is never trusted");
  assert.equal(statSync(scratch.getScratchIndexPath()).mode & 0o777, 0o600);
  assert.ok(Array.isArray(JSON.parse(readFileSync(scratch.getScratchIndexPath(), "utf8")).entries), "the next write is a good index again");
});

test("scratchEnv points every temp variable at the dir", () => {
  assert.deepEqual(scratch.scratchEnv("/x/abcdef012345"), {
    TMPDIR: "/x/abcdef012345",
    TMP: "/x/abcdef012345",
    TEMP: "/x/abcdef012345",
    CODY_SCRATCH: "/x/abcdef012345",
  });
});

test("the engine child's environment names the scratch dir before the caller's variables and always names the disk areas", () => {
  const dir = scratch.ensureSessionScratch("env-chat");
  const withScratch = engineChildEnv({ KEEP: "yes" }, { scratchDir: dir });
  for (const name of ["TMPDIR", "TMP", "TEMP", "CODY_SCRATCH"]) assert.equal(withScratch[name], dir, name);
  assert.equal(withScratch.KEEP, "yes");
  assert.equal(engineChildEnv({ TMPDIR: "/explicit" }, { scratchDir: dir }).TMPDIR, "/explicit", "an adapter's own variable still wins");

  for (const none of [engineChildEnv(), engineChildEnv(undefined, { scratchDir: null }), engineChildEnv(undefined, { timeZone: "UTC" })]) {
    assert.equal(none.TMPDIR, process.env.TMPDIR, "a terminal or a one-shot helper keeps the server's temp dir");
    assert.equal(none.CODY_SCRATCH, undefined);
  }

  process.env.CODY_DISK_AREAS = JSON.stringify([{ id: "tmp", path: "/inherited" }]);
  try {
    for (const env of [withScratch, engineChildEnv(), engineChildEnv(undefined, { scratchDir: dir })]) {
      assert.deepEqual(JSON.parse(env.CODY_DISK_AREAS), diskAreaPaths(), "what the extension probes, never an inherited value");
    }
    assert.deepEqual(diskAreaPaths().map((area) => area.id), ["tmp", "data"]);
  } finally {
    delete process.env.CODY_DISK_AREAS;
  }
});

test("real tools put their temp files in the scratch dir: node, mktemp and python", (t) => {
  if (process.platform === "win32") return t.skip("POSIX tools");
  const dir = scratch.ensureSessionScratch("tools-chat");
  const env = engineChildEnv({}, { scratchDir: dir });
  const run = (command, args) => spawnSync(command, args, { env, encoding: "utf8" });

  const node = run(process.execPath, ["-e", "console.log(require('os').tmpdir())"]);
  assert.equal(node.stdout.trim(), dir, "Node's os.tmpdir()");

  const mktemp = run("mktemp", ["-d"]);
  if (mktemp.error) t.diagnostic("mktemp is not installed here");
  else assert.equal(dirname(mktemp.stdout.trim()), dir, "mktemp -d");

  const python = run("python3", ["-c", "import tempfile; print(tempfile.mkdtemp())"]);
  if (python.error) t.diagnostic("python3 is not installed here");
  else assert.equal(dirname(python.stdout.trim()), dir, "Python's tempfile");
});
