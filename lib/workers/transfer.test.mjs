// The two trips of a job's files (lib/workers/transfer.ts), against ./local-shell.mjs
// whose "worker" is this machine: the REAL tar, the REAL generated copy-in and
// copy-back scripts. copyIn: files arrive intact (symlink, empty file, odd
// names, 2 MB), progress is monotonic, faults are told apart (worker / local /
// cancelled) and a stuck worker is given up on promptly. copyBack: results come
// home, missing paths are listed, and a hostile or garbled answer (../, absolute
// names, unrequested paths, links out of the project, cut-off archive) is
// refused with nothing written outside the project.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, lstatSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { copyIn, copyBack } = await jiti.import("./transfer.ts");
const { newJobId, newToken, jobDirectory, copyBackMarker } = await jiti.import("./remote.ts");
const { localShell } = await import("./local-shell.mjs");

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-transfer-")));
const workRoot = `${base}/work`;
mkdirSync(workRoot);
const shells = [];
after(() => {
  for (const shell of shells) shell.stop();
  rmSync(base, { recursive: true, force: true });
});

function newShell(behave) {
  const shell = localShell({ behave });
  shells.push(shell);
  return shell;
}

let counter = 0;
function freshDir(name) {
  counter += 1;
  const dir = `${base}/${name}-${counter}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const treeOf = (root, cwdRel = "") => ({ root, cwd: cwdRel ? `${root}/${cwdRel}` : root, cwdRel, isGit: false });
const newJob = () => jobDirectory(workRoot, newJobId());

// ── a project to send ────────────────────────────────────────────────────────

const WEIRD = "with space ünï 😀 'q'.txt";
const BIG = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < BIG.length; i += 1) BIG[i] = (i * 31 + (i >> 8)) & 0xff;

const project = freshDir("project");
mkdirSync(`${project}/sub/deep`, { recursive: true });
writeFileSync(`${project}/a.txt`, "alpha\n");
writeFileSync(`${project}/sub/deep/b.txt`, "bravo\n".repeat(1000));
writeFileSync(`${project}/empty.txt`, "");
writeFileSync(`${project}/${WEIRD}`, "odd name\n");
writeFileSync(`${project}/big.bin`, BIG);
symlinkSync("a.txt", `${project}/link`);
const FILES = ["a.txt", "sub/deep/b.txt", "empty.txt", WEIRD, "big.bin", "link"];

// ── copyIn ───────────────────────────────────────────────────────────────────

test("copyIn: every file arrives under the job directory with the same path and content, and progress only grows", async () => {
  const shell = newShell();
  const directory = newJob();
  const moved = [];
  const result = await copyIn({ shell: shell.shell, destination: "w", directory, tree: treeOf(project, "sub/deep"), files: FILES, onMoved: (n) => moved.push(n) });
  assert.equal(result.ok, true);
  assert.ok(result.bytes > BIG.length, "the archive holds at least the big file");
  assert.ok(result.ms >= 0);
  assert.ok(moved.length > 0);
  for (let i = 1; i < moved.length; i += 1) assert.ok(moved[i] >= moved[i - 1], "non-decreasing");
  assert.equal(moved.at(-1), result.bytes);
  for (const file of FILES) {
    if (file === "link") continue;
    assert.deepEqual(readFileSync(`${directory}/${file}`), readFileSync(`${project}/${file}`), file);
  }
  assert.equal(lstatSync(`${directory}/link`).isSymbolicLink(), true);
  assert.equal(readlinkSync(`${directory}/link`), "a.txt");
  assert.equal(lstatSync(`${directory}/sub/deep`).isDirectory(), true, "the working directory exists");
  assert.equal(shell.of("in").length, 1);
});

test("copyIn: the working directory is created even when no file lives in it", async () => {
  const shell = newShell();
  const directory = newJob();
  const result = await copyIn({ shell: shell.shell, destination: "w", directory, tree: treeOf(project, "pkg/app"), files: ["a.txt"] });
  assert.equal(result.ok, true);
  assert.equal(lstatSync(`${directory}/pkg/app`).isDirectory(), true);
  assert.equal(readFileSync(`${directory}/a.txt`, "utf8"), "alpha\n");
});

test("copyIn: with no files only the directories are made", async () => {
  const shell = newShell();
  const directory = newJob();
  const moved = [];
  const result = await copyIn({ shell: shell.shell, destination: "w", directory, tree: treeOf(project, "pkg/app"), files: [], onMoved: (n) => moved.push(n) });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 0);
  assert.deepEqual(moved, []);
  assert.deepEqual(readdirSync(directory), ["pkg"]);
  assert.deepEqual(readdirSync(`${directory}/pkg`), ["app"]);
  assert.deepEqual(readdirSync(`${directory}/pkg/app`), []);
});

test("copyIn: a connection that is refused or not allowed is the worker's fault, with the reason", async () => {
  const refused = newShell(() => ({ fail: { stderr: "ssh: connect to host w port 22: Connection refused\n" } }));
  const one = await copyIn({ shell: refused.shell, destination: "w", directory: newJob(), tree: treeOf(project), files: FILES });
  assert.equal(one.ok, false);
  assert.equal(one.fault, "worker");
  assert.equal(one.reason, "refused");
  assert.match(one.detail, /Connection refused/);

  const denied = newShell(() => ({ fail: { stderr: "Permission denied (publickey).\n" } }));
  const two = await copyIn({ shell: denied.shell, destination: "w", directory: newJob(), tree: treeOf(project), files: FILES });
  assert.deepEqual({ ok: two.ok, fault: two.fault, reason: two.reason }, { ok: false, fault: "worker", reason: "auth" });
  assert.equal(two.detail, "Permission denied (publickey).");
});

test("copyIn: a worker that is connected but stuck is given up on promptly as unreachable", async () => {
  const shell = newShell(() => ({ hang: true }));
  const startedAt = Date.now();
  const result = await copyIn({ shell: shell.shell, destination: "w", directory: newJob(), tree: treeOf(project), files: ["big.bin"], stallMs: 150 });
  assert.equal(result.ok, false);
  assert.equal(result.fault, "worker");
  assert.equal(result.reason, "unreachable");
  assert.match(result.detail, /nothing was transferred/);
  assert.ok(Date.now() - startedAt < 3000);
});

test("copyIn: an already cancelled call starts nothing", async () => {
  const shell = newShell();
  const controller = new AbortController();
  controller.abort();
  const result = await copyIn({ shell: shell.shell, destination: "w", directory: newJob(), tree: treeOf(project), files: FILES, signal: controller.signal });
  assert.deepEqual(result, { ok: false, fault: "cancelled" });
  assert.equal(shell.calls.length, 0);
});

test("copyIn: cancelling in the middle of a stuck transfer ends it as cancelled", async () => {
  const shell = newShell(() => ({ hang: true }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const startedAt = Date.now();
  const result = await copyIn({ shell: shell.shell, destination: "w", directory: newJob(), tree: treeOf(project), files: ["big.bin"], signal: controller.signal });
  assert.deepEqual(result, { ok: false, fault: "cancelled" });
  assert.ok(Date.now() - startedAt < 3000);
});

test("copyIn: a file that cannot be packed is a local fault, whichever worker is used", async () => {
  const shell = newShell();
  const result = await copyIn({ shell: shell.shell, destination: "w", directory: newJob(), tree: treeOf(project), files: ["a.txt", "does-not-exist.txt"] });
  assert.equal(result.ok, false);
  assert.equal(result.fault, "local");
  assert.match(result.message, /^tar could not pack the project/);
  assert.match(result.message, /does-not-exist\.txt/);
});

test("copyIn: a job directory with unusual characters is refused here and nothing is started", async () => {
  const shell = newShell();
  const result = await copyIn({ shell: shell.shell, destination: "w", directory: "/tmp/has space/x", tree: treeOf(project), files: FILES });
  assert.equal(result.ok, false);
  assert.equal(result.fault, "local");
  assert.match(result.message, /unusual characters/);
  assert.equal(shell.calls.length, 0);
});

// ── copyBack ─────────────────────────────────────────────────────────────────

/** A job directory that plays the worker's copy, with some results in it. */
function makeJobWithResults() {
  const jobDir = newJob();
  mkdirSync(`${jobDir}/dist/sub`, { recursive: true });
  writeFileSync(`${jobDir}/dist/a.txt`, "built a\n");
  writeFileSync(`${jobDir}/dist/sub/b.bin`, Buffer.from([0, 1, 2, 3, 255, 254]));
  writeFileSync(`${jobDir}/out.txt`, "output\n");
  return jobDir;
}

/** A sandbox with an empty project root inside, so a stray write next to the root can be seen. */
function makeHome() {
  const sandbox = freshDir("home");
  const root = `${sandbox}/root`;
  mkdirSync(root);
  return { sandbox, root, tree: treeOf(root) };
}

function tarBuffer(cwd, args, extra = []) {
  const run = spawnSync("tar", ["-cf", "-", ...extra, ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr?.toString());
  return run.stdout;
}

const answer = (token, tar) => Buffer.concat([Buffer.from(copyBackMarker(token)), tar]);

function tmpFilesIn(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.includes(".cody-")) found.push(`${current}/${entry.name}`);
      if (entry.isDirectory()) walk(`${current}/${entry.name}`);
    }
  };
  walk(dir);
  return found;
}

test("copyBack: the result paths come home with the same content and the report says how much", async () => {
  const shell = newShell();
  const jobDir = makeJobWithResults();
  const { root, tree } = makeHome();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: jobDir, token: newToken(), tree, paths: ["dist", "out.txt"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.report.files, 3);
  assert.equal(result.report.bytes, "built a\n".length + 6 + "output\n".length);
  assert.equal(result.report.complete, true);
  assert.ok(result.ms >= 0);
  assert.equal(readFileSync(`${root}/dist/a.txt`, "utf8"), "built a\n");
  assert.deepEqual(readFileSync(`${root}/dist/sub/b.bin`), Buffer.from([0, 1, 2, 3, 255, 254]));
  assert.equal(readFileSync(`${root}/out.txt`, "utf8"), "output\n");
});

test("copyBack: a path the worker does not have is listed as missing while the others still arrive", async () => {
  const shell = newShell();
  const jobDir = makeJobWithResults();
  const { root, tree } = makeHome();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: jobDir, token: newToken(), tree, paths: ["dist", "nope/not-here.txt", "out.txt"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, ["nope/not-here.txt"]);
  assert.equal(result.report.files, 3);
  assert.equal(existsSync(`${root}/dist/a.txt`), true);
  assert.equal(existsSync(`${root}/out.txt`), true);
  assert.equal(existsSync(`${root}/nope`), false);
});

test("copyBack: when every path is missing the call still succeeds, with nothing copied", async () => {
  const shell = newShell();
  const jobDir = makeJobWithResults();
  const { root, tree } = makeHome();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: jobDir, token: newToken(), tree, paths: ["x.txt", "y/z"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, ["x.txt", "y/z"]);
  assert.equal(result.report.files, 0);
  assert.deepEqual(readdirSync(root), []);
});

test("copyBack: a job directory that is already gone is reported as gone", async () => {
  const shell = newShell();
  const { tree } = makeHome();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"] });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /directory is already gone/);
});

test("copyBack: a failed connection says what ssh said and is not a cancel", async () => {
  const shell = newShell(() => ({ fail: { stderr: "ssh: connect to host w port 22: Connection refused\n" } }));
  const { root, tree } = makeHome();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"] });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /Connection refused/);
  assert.deepEqual(readdirSync(root), []);
});

test("copyBack: a job directory with unusual characters is refused and nothing is started", async () => {
  const shell = newShell();
  const { tree } = makeHome();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: "/tmp/has space/x", token: newToken(), tree, paths: ["out.txt"] });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /unusual characters/);
  assert.equal(shell.calls.length, 0);
});

test("copyBack: an answer without a results section is a failure with a message", async () => {
  const { tree } = makeHome();
  const garbled = newShell(() => ({ say: "this is not what we asked for\n", code: 255 }));
  const one = await copyBack({ shell: garbled.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"] });
  assert.equal(one.ok, false);
  assert.match(one.message, /no results section/);

  const odd = newShell(() => ({ say: "still not it\n", code: 0 }));
  const two = await copyBack({ shell: odd.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"] });
  assert.equal(two.ok, false);
  assert.ok(two.message.length > 0);
});

test("copyBack: tar saying a file changed while it was read (status 1) still counts as a whole answer; a real tar error does not", async () => {
  const jobDir = makeJobWithResults();
  const token = newToken();
  const tar = tarBuffer(jobDir, ["./out.txt"]);
  const { root, tree } = makeHome();
  const warned = newShell(() => ({ say: answer(token, tar), code: 1 }));
  const ok = await copyBack({ shell: warned.shell, destination: "w", directory: jobDir, token, tree, paths: ["out.txt"] });
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(`${root}/out.txt`, "utf8"), "output\n");

  const failed = newShell(() => ({ say: answer(token, tar), code: 2, stderr: "tar: ./out.txt: Cannot read: Input/output error\n" }));
  const bad = await copyBack({ shell: failed.shell, destination: "w", directory: jobDir, token, tree: makeHome().tree, paths: ["out.txt"] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Input\/output error/);
});

test("copyBack: a member named ../something never leaves the project", async () => {
  const token = newToken();
  const src = freshDir("src");
  mkdirSync(`${src}/inner`);
  writeFileSync(`${src}/escape.txt`, "gotcha\n");
  const tar = tarBuffer(`${src}/inner`, ["../escape.txt"], ["-P"]);
  const { sandbox, root, tree } = makeHome();
  const shell = newShell(() => ({ say: answer(token, tar) }));
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token, tree, paths: ["escape.txt"] });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /leaves the project/);
  assert.deepEqual(readdirSync(sandbox), ["root"]);
  assert.deepEqual(readdirSync(root), []);
});

test("copyBack: an absolute member name is refused and nothing is written there", async () => {
  const token = newToken();
  const victimDir = freshDir("victim");
  const victim = `${victimDir}/abs.txt`;
  writeFileSync(victim, "gotcha\n");
  const tar = tarBuffer("/", [victim], ["-P"]);
  rmSync(victim);
  const { root, tree } = makeHome();
  const shell = newShell(() => ({ say: answer(token, tar) }));
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token, tree, paths: ["abs.txt", "dist"] });
  assert.equal(result.ok, false);
  assert.match(result.message, /absolute name/);
  assert.equal(existsSync(victim), false);
  assert.deepEqual(readdirSync(victimDir), []);
  assert.deepEqual(readdirSync(root), []);
});

test("copyBack: a file the agent did not ask for is refused, but what arrived before it stays", async () => {
  const token = newToken();
  const src = freshDir("src");
  mkdirSync(`${src}/dist`);
  writeFileSync(`${src}/dist/a.txt`, "wanted\n");
  writeFileSync(`${src}/other.txt`, "unrequested\n");
  const tar = tarBuffer(src, ["./dist/a.txt", "./other.txt"]);
  const { root, tree } = makeHome();
  const shell = newShell(() => ({ say: answer(token, tar) }));
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token, tree, paths: ["dist"] });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /other\.txt, which was not asked for/);
  assert.equal(existsSync(`${root}/other.txt`), false);
  assert.equal(readFileSync(`${root}/dist/a.txt`, "utf8"), "wanted\n");
  assert.ok(result.report.files >= 1);
  assert.deepEqual(tmpFilesIn(root), []);
});

test("copyBack: a link in the project that leads outside it is never written through", async () => {
  const jobDir = makeJobWithResults();
  const { sandbox, root, tree } = makeHome();
  const outside = freshDir("outside");
  symlinkSync(outside, `${root}/dist`);
  const shell = newShell();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: jobDir, token: newToken(), tree, paths: ["dist"] });
  assert.equal(result.ok, false);
  assert.match(result.message, /leads outside it|leads outside the project/);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(readdirSync(sandbox), ["root"]);
});

test("copyBack: an archive cut off in the middle fails; what was complete stays and no half-written file is left", async () => {
  const token = newToken();
  const src = freshDir("src");
  mkdirSync(`${src}/dist`);
  writeFileSync(`${src}/dist/first.txt`, "complete\n");
  writeFileSync(`${src}/dist/second.txt`, "x".repeat(5000));
  const whole = tarBuffer(src, ["./dist/first.txt", "./dist/second.txt"]);
  const cut = whole.subarray(0, 512 * 3 + 1000);
  const { root, tree } = makeHome();
  const shell = newShell(() => ({ say: answer(token, cut) }));
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token, tree, paths: ["dist"] });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /cut short/);
  assert.ok(result.report.files >= 1);
  assert.equal(result.report.complete, false);
  assert.equal(readFileSync(`${root}/dist/first.txt`, "utf8"), "complete\n");
  assert.equal(existsSync(`${root}/dist/second.txt`), false);
  await delay(50);
  assert.deepEqual(tmpFilesIn(root), []);
});

test("copyBack: a stuck worker is given up on promptly, saying nothing was transferred", async () => {
  const shell = newShell(() => ({ hang: true }));
  const { tree } = makeHome();
  const startedAt = Date.now();
  const result = await copyBack({ shell: shell.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"], stallMs: 150 });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /nothing was transferred/);
  assert.ok(Date.now() - startedAt < 3000);
});

test("copyBack: cancelling gives cancelled, whether before the start or in the middle", async () => {
  const { tree } = makeHome();
  const idle = newShell();
  const early = new AbortController();
  early.abort();
  const one = await copyBack({ shell: idle.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"], signal: early.signal });
  assert.equal(one.ok, false);
  assert.equal(one.cancelled, true);
  assert.equal(idle.calls.length, 0);

  const stuck = newShell(() => ({ hang: true }));
  const late = new AbortController();
  setTimeout(() => late.abort(), 100);
  const two = await copyBack({ shell: stuck.shell, destination: "w", directory: newJob(), token: newToken(), tree, paths: ["out.txt"], signal: late.signal });
  assert.equal(two.ok, false);
  assert.equal(two.cancelled, true);
  assert.equal(stuck.calls.length, 1);
});
