import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Which directory is "the project", which files of it go to a worker, and which
 * paths may come home. What matters: the project is the whole git repository
 * around the working directory (or the directory itself outside git), a
 * working directory can never leave it (not by `..`, not by a symlink), the
 * default copy follows .gitignore and never follows symlinks, `include` globs
 * are relative to the working directory and cannot escape it, and result paths
 * that could write outside the project, or into .git, are refused.
 */
const jiti = createJiti(import.meta.url);
const files = await jiti.import("./files.ts");

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-files-")));
after(() => rmSync(base, { recursive: true, force: true }));

// The user's own git setup must never matter, and git must not look above our temp dir.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

let counter = 0;
function fresh(name) {
  counter += 1;
  const dir = join(base, `${counter}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
}
function initRepo(dir) {
  git(dir, "init", "-q");
}
function put(dir, relative, content = "x") {
  const full = join(dir, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function commitAll(dir) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c");
}
async function tree(workspace, cwd) {
  const result = await files.resolveTree(workspace, cwd);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.value;
}

// ── resolveTree ──────────────────────────────────────────────────────────────

test("a workspace that is the repository root is the project", async () => {
  const repo = fresh("root");
  initRepo(repo);
  assert.deepEqual(await tree(repo, undefined), { root: repo, cwd: repo, cwdRel: "", isGit: true });
});

test("a workspace inside a repository makes the whole repository the project and the subdirectory the cwd", async () => {
  const repo = fresh("sub");
  initRepo(repo);
  mkdirSync(join(repo, "packages/app"), { recursive: true });
  assert.deepEqual(await tree(join(repo, "packages/app"), undefined), {
    root: repo,
    cwd: join(repo, "packages/app"),
    cwdRel: "packages/app",
    isGit: true,
  });
});

test("a requested cwd works relative to the workspace and as an absolute path", async () => {
  const repo = fresh("req");
  initRepo(repo);
  mkdirSync(join(repo, "a/b"), { recursive: true });
  const relative = await tree(repo, "a/b");
  assert.equal(relative.cwdRel, "a/b");
  assert.equal(relative.root, repo);
  const absolute = await tree(repo, join(repo, "a"));
  assert.equal(absolute.cwdRel, "a");
  // From a subdirectory workspace, `..` may climb to the repo top (still inside the repository).
  const climbed = await tree(join(repo, "a/b"), "../..");
  assert.equal(climbed.cwdRel, "");
  assert.equal(climbed.cwd, repo);
});

test("a cwd outside the workspace's repository is refused", async () => {
  const repo = fresh("outside");
  const other = fresh("outside-other");
  initRepo(repo);
  const viaDots = await files.resolveTree(repo, "..");
  assert.equal(viaDots.ok, false);
  assert.equal(viaDots.message, "cwd .. is outside the workspace; the job's directory must be inside it");
  const absolute = await files.resolveTree(repo, other);
  assert.equal(absolute.ok, false);
  assert.match(absolute.message, /outside the workspace/);
  // From inside a repository the message names the repository.
  mkdirSync(join(repo, "sub"));
  const fromSub = await files.resolveTree(join(repo, "sub"), other);
  assert.match(fromSub.message, /outside the workspace's repository/);
});

test("a symlink inside the workspace that points outside is refused", async () => {
  const repo = fresh("symlink");
  const secret = fresh("symlink-secret");
  initRepo(repo);
  symlinkSync(secret, join(repo, "escape"));
  const result = await files.resolveTree(repo, "escape");
  assert.equal(result.ok, false);
  assert.match(result.message, /outside the workspace/);
});

test("a symlink that stays inside the project resolves to its real directory", async () => {
  const repo = fresh("symlink-in");
  initRepo(repo);
  mkdirSync(join(repo, "real"));
  symlinkSync(join(repo, "real"), join(repo, "alias"));
  assert.equal((await tree(repo, "alias")).cwdRel, "real");
});

test("a cwd that does not exist, is a file, or has a NUL is refused with a clear message", async () => {
  const repo = fresh("bad");
  initRepo(repo);
  put(repo, "file.txt");
  assert.deepEqual(await files.resolveTree(repo, "nope"), { ok: false, message: "cwd nope does not exist in the workspace" });
  assert.deepEqual(await files.resolveTree(repo, "file.txt"), { ok: false, message: "cwd file.txt is not a directory" });
  assert.deepEqual(await files.resolveTree(repo, "a\0b"), { ok: false, message: "cwd contains a NUL character" });
  const missing = await files.resolveTree(join(base, "no-such-workspace"), undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /workspace .* does not exist/);
});

test("a blank cwd means the workspace itself", async () => {
  const repo = fresh("blank");
  initRepo(repo);
  assert.equal((await tree(repo, "   ")).cwd, repo);
});

test("a workspace that is not in a git repository is its own project", async () => {
  const plain = fresh("plain");
  mkdirSync(join(plain, "sub"));
  assert.deepEqual(await tree(plain, undefined), { root: plain, cwd: plain, cwdRel: "", isGit: false });
  // Without git, a subdirectory cwd becomes the root: the project is the cwd.
  assert.deepEqual(await tree(plain, "sub"), { root: join(plain, "sub"), cwd: join(plain, "sub"), cwdRel: "", isGit: false });
});

// ── listTreeFiles without include ────────────────────────────────────────────

test("in a repository the copy is tracked plus untracked-not-ignored files, sorted, without ignored ones", async () => {
  const repo = fresh("list");
  initRepo(repo);
  put(repo, ".gitignore", "node_modules/\ndist/\n");
  put(repo, "src/a.ts", "12345");
  put(repo, "src/deep/b.rs", "123");
  put(repo, "package.json", "{}");
  put(repo, "gone.txt", "tracked then deleted");
  commitAll(repo);
  rmSync(join(repo, "gone.txt"));
  put(repo, "untracked.md", "1234567");
  put(repo, "node_modules/pkg/index.js", "ignored");
  put(repo, "dist/out.js", "ignored");
  const result = await files.listTreeFiles(await tree(repo), undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.files, [".gitignore", "package.json", "src/a.ts", "src/deep/b.rs", "untracked.md"]);
  // .gitignore is 23 bytes: "node_modules/\ndist/\n"
  assert.equal(result.value.bytes, 20 + 2 + 5 + 3 + 7);
  assert.equal(result.value.skipped, 0);
});

test("symlinks are listed, not followed, and count no bytes", async () => {
  const repo = fresh("links");
  initRepo(repo);
  put(repo, "real.txt", "1234567890");
  symlinkSync("real.txt", join(repo, "link"));
  symlinkSync("/etc", join(repo, "dirlink"));
  commitAll(repo);
  const result = await files.listTreeFiles(await tree(repo), undefined);
  assert.deepEqual(result.value.files, ["dirlink", "link", "real.txt"]);
  assert.equal(result.value.bytes, 10);
});

test("a name that is not valid UTF-8 is skipped and counted; a name with a newline is listed intact", async () => {
  const repo = fresh("names");
  initRepo(repo);
  put(repo, "ok.txt", "1");
  put(repo, "weird\nname.txt", "22");
  let made = true;
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), Buffer.from([0x62, 0xff, 0xfe])]), "x");
  } catch (error) {
    if (error?.code !== "EILSEQ") throw error;
    made = false; // this filesystem refuses such names, so there is nothing to skip
  }
  const result = await files.listTreeFiles(await tree(repo), undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.files, ["ok.txt", "weird\nname.txt"]);
  assert.equal(result.value.skipped, made ? 1 : 0);
});

test("a tracked file inside a subdirectory cwd is still listed from the repository top", async () => {
  const repo = fresh("top");
  initRepo(repo);
  put(repo, "Cargo.lock", "l");
  put(repo, "crate/src/main.rs", "m");
  const result = await files.listTreeFiles(await tree(repo, "crate"), undefined);
  assert.deepEqual(result.value.files, ["Cargo.lock", "crate/src/main.rs"]);
});

test("a nested repository's own files are listed under its directory (one clean path each)", async () => {
  const repo = fresh("nested");
  initRepo(repo);
  put(repo, "top.txt", "t");
  const inner = join(repo, "inner");
  mkdirSync(inner);
  initRepo(inner);
  put(inner, "in.txt", "i");
  put(inner, "ignored.log", "x");
  put(inner, ".gitignore", "*.log\n");
  const result = await files.listTreeFiles(await tree(repo), undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.files, ["inner/.gitignore", "inner/in.txt", "top.txt"]);
});

test("a damaged repository gives a failure, not a crash", async () => {
  const repo = fresh("damaged");
  initRepo(repo);
  put(repo, "a.txt");
  commitAll(repo);
  const t = await tree(repo);
  rmSync(join(repo, ".git/HEAD"));
  rmSync(join(repo, ".git/objects"), { recursive: true });
  const result = await files.listTreeFiles(t, undefined);
  assert.equal(result.ok, false);
  assert.match(result.message, /git could not list/);
});

test("outside git the copy is everything except .git and node_modules", async () => {
  const plain = fresh("nogit");
  put(plain, "a.txt", "1");
  put(plain, "sub/b.txt", "22");
  put(plain, "node_modules/x/index.js", "no");
  put(plain, ".git/config", "no");
  put(plain, "sub/node_modules/y.js", "no");
  put(plain, ".env", "333");
  symlinkSync("a.txt", join(plain, "link"));
  const result = await files.listTreeFiles(await tree(plain), undefined);
  assert.deepEqual(result.value.files, [".env", "a.txt", "link", "sub/b.txt"]);
  assert.equal(result.value.bytes, 1 + 2 + 3);
});

test("an empty include list is the same as no include", async () => {
  const plain = fresh("emptyinc");
  put(plain, "a.txt");
  const result = await files.listTreeFiles(await tree(plain), []);
  assert.deepEqual(result.value.files, ["a.txt"]);
});

test("an aborted listing returns instead of hanging", async () => {
  const repo = fresh("abort");
  initRepo(repo);
  put(repo, "a.txt");
  const t = await tree(repo);
  const controller = new AbortController();
  controller.abort();
  const result = await Promise.race([
    files.listTreeFiles(t, undefined, controller.signal),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 5000).unref()),
  ]);
  assert.notEqual(result, "hung");
  assert.equal(result.ok, false); // git is killed before it answers
  const walkAbort = await files.listTreeFiles(await tree(fresh("abort2")), ["**"], controller.signal);
  assert.equal(walkAbort.ok, true);
  assert.deepEqual(walkAbort.value.files, []);
});

// ── listTreeFiles with include ───────────────────────────────────────────────

async function layout() {
  const repo = fresh("glob");
  initRepo(repo);
  put(repo, "package.json", "{}");
  put(repo, "top.json", "{}");
  put(repo, "src/a.ts");
  put(repo, "src/deep/b.rs");
  put(repo, "src/deep/c.json");
  put(repo, "lib/x.rs");
  put(repo, "docs/readme.md");
  put(repo, "a/one.txt");
  put(repo, "b/two.txt");
  put(repo, "c/three.txt");
  put(repo, "node_modules/pkg/index.js");
  put(repo, "src/node_modules/inner.js");
  put(repo, ".git-not/x", "");
  return repo;
}
async function list(repo, cwd, include) {
  const result = await files.listTreeFiles(await tree(repo, cwd), include);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.value.files;
}

test("include globs pick files relative to the cwd, results are relative to the root and sorted", async () => {
  const repo = await layout();
  assert.deepEqual(await list(repo, "src", ["**/*.rs"]), ["src/deep/b.rs"]);
  assert.deepEqual(await list(repo, "src", ["*.ts"]), ["src/a.ts"]);
  assert.deepEqual(await list(repo, "src", ["deep/*.json", "*.ts"]), ["src/a.ts", "src/deep/c.json"]);
});

test("include at the root: ** forms, extensions, braces and directory names", async () => {
  const repo = await layout();
  assert.deepEqual(await list(repo, undefined, ["src/**"]), ["src/a.ts", "src/deep/b.rs", "src/deep/c.json"]);
  assert.deepEqual(await list(repo, undefined, ["*.json"]), ["package.json", "top.json"]);
  assert.deepEqual(await list(repo, undefined, ["**/*.rs"]), ["lib/x.rs", "src/deep/b.rs"]);
  assert.deepEqual(await list(repo, undefined, ["{a,b}/**"]), ["a/one.txt", "b/two.txt"]);
  assert.deepEqual(await list(repo, undefined, ["{a,c}"]), ["a/one.txt", "c/three.txt"]);
  // A directory name takes everything below, with or without a trailing slash or ./
  assert.deepEqual(await list(repo, undefined, ["lib"]), ["lib/x.rs"]);
  assert.deepEqual(await list(repo, undefined, ["./lib/"]), ["lib/x.rs"]);
  assert.deepEqual(await list(repo, undefined, ["docs/readme.m?"]), ["docs/readme.md"]);
  assert.deepEqual(await list(repo, undefined, ["[ab]/*.txt"]), ["a/one.txt", "b/two.txt"]);
  assert.deepEqual(await list(repo, undefined, ["[!ab]/*.txt"]), ["c/three.txt"]);
});

test("overlapping patterns list a file once", async () => {
  const repo = await layout();
  assert.deepEqual(await list(repo, undefined, ["src", "src/**", "**/a.ts"]), ["src/a.ts", "src/deep/b.rs", "src/deep/c.json"]);
});

test("globs skip node_modules and .git unless a pattern names them", async () => {
  const repo = await layout();
  assert.deepEqual(await list(repo, undefined, ["**/*.js"]), []);
  assert.deepEqual(await list(repo, undefined, ["node_modules/**"]), ["node_modules/pkg/index.js"]);
  assert.deepEqual(await list(repo, undefined, ["**/node_modules/**"]), ["node_modules/pkg/index.js", "src/node_modules/inner.js"]);
  assert.ok(!(await list(repo, undefined, ["**"])).some((f) => f.startsWith(".git/") || f.includes("node_modules")));
  assert.deepEqual(await list(repo, undefined, [".git/HEAD"]), [".git/HEAD"]);
});

test("include walks ignored files too (a glob is an explicit request)", async () => {
  const repo = await layout();
  put(repo, ".gitignore", "dist/\n");
  put(repo, "dist/out.js", "o");
  assert.deepEqual(await list(repo, undefined, ["dist/**"]), ["dist/out.js"]);
});

test("include never follows a directory symlink and lists a file symlink", async () => {
  const repo = await layout();
  symlinkSync(join(repo, "src"), join(repo, "srclink"));
  symlinkSync("package.json", join(repo, "pkglink"));
  assert.deepEqual(await list(repo, undefined, ["srclink/**"]), []);
  assert.deepEqual(await list(repo, undefined, ["pkglink"]), ["pkglink"]);
});

test("include patterns that escape the cwd or are absolute are refused with the module's message", async () => {
  const repo = await layout();
  const t = await tree(repo, "src");
  assert.deepEqual(await files.listTreeFiles(t, ["../x"]), { ok: false, message: "include pattern ../x leaves cwd (it contains ..)" });
  assert.deepEqual(await files.listTreeFiles(t, ["a/../../x"]), { ok: false, message: "include pattern a/../../x leaves cwd (it contains ..)" });
  assert.deepEqual(await files.listTreeFiles(t, ["/etc/passwd"]), { ok: false, message: "include pattern /etc/passwd is absolute: patterns are relative to cwd" });
  assert.match((await files.listTreeFiles(t, ["C:\\x"])).message, /is absolute/);
  assert.match((await files.listTreeFiles(t, ["C:/x"])).message, /is absolute/);
});

test("include patterns that are empty, the whole directory, odd or too many are refused", async () => {
  const repo = await layout();
  const t = await tree(repo);
  assert.deepEqual(await files.listTreeFiles(t, ["  "]), { ok: false, message: "include has an empty pattern" });
  assert.deepEqual(await files.listTreeFiles(t, [""]), { ok: false, message: "include has an empty pattern" });
  assert.match((await files.listTreeFiles(t, ["."])).message, /names the whole working directory/);
  assert.match((await files.listTreeFiles(t, ["./"])).message, /names the whole working directory/);
  assert.match((await files.listTreeFiles(t, ["a\0b"])).message, /too long or has control characters/);
  assert.match((await files.listTreeFiles(t, ["a\nb"])).message, /too long or has control characters/);
  assert.match((await files.listTreeFiles(t, ["x".repeat(513)])).message, /too long or has control characters/);
  assert.equal((await files.listTreeFiles(t, ["x".repeat(512)])).ok, true);
  assert.deepEqual(await files.listTreeFiles(t, Array.from({ length: 65 }, (_, i) => `p${i}`)), { ok: false, message: "include has more than 64 patterns" });
  assert.equal((await files.listTreeFiles(t, Array.from({ length: 64 }, (_, i) => `p${i}`))).ok, true);
  assert.match((await files.listTreeFiles(t, ["{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}"])).message, /too many \{a,b\} alternatives/);
});

test("a file in the working tree that is not a file or link is skipped and counted", async () => {
  const plain = fresh("fifo");
  put(plain, "a.txt");
  execFileSync("mkfifo", [join(plain, "pipe")]);
  const result = await files.listTreeFiles(await tree(plain), undefined);
  assert.deepEqual(result.value.files, ["a.txt"]);
  assert.equal(result.value.skipped, 1);
});

// ── checkResultPaths / relativeToCwd ─────────────────────────────────────────

const ok = (raw, cwdRel = "") => {
  const result = files.checkResultPaths(raw, cwdRel);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.value;
};
const bad = (raw, cwdRel = "") => {
  const result = files.checkResultPaths(raw, cwdRel);
  assert.equal(result.ok, false, `expected refusal of ${JSON.stringify(raw)}`);
  return result.message;
};

test("result paths are relative to the cwd and come back relative to the root", () => {
  assert.deepEqual(ok(["out/bin"], ""), ["out/bin"]);
  assert.deepEqual(ok(["out/bin"], "crate"), ["crate/out/bin"]);
  assert.deepEqual(ok(["../shared/x"], "crate"), ["shared/x"]);
  assert.deepEqual(ok(["./dist"], ""), ["dist"]);
  assert.deepEqual(ok(["a/./b//c"], "x/y"), ["x/y/a/b/c"]);
});

test("result paths that leave the project are refused", () => {
  assert.equal(bad(["../x"], ""), "results path ../x leaves the project");
  assert.match(bad(["../../x"], "crate"), /leaves the project/);
  assert.match(bad(["a/../../x"], ""), /leaves the project/);
  assert.match(bad([".."], "crate"), /leaves the project|whole project/);
});

test("absolute result paths are refused (posix, backslash, drive letter)", () => {
  assert.equal(bad(["/etc/passwd"]), "results path /etc/passwd is absolute: paths are relative to cwd");
  assert.match(bad(["\\windows"]), /absolute/);
  assert.match(bad(["C:\\x"]), /absolute/);
  assert.match(bad(["c:/x"]), /absolute/);
});

test("anything pointing into .git is refused, however it is reached", () => {
  assert.match(bad([".git"]), /points into \.git/);
  assert.match(bad([".git/config"]), /points into \.git/);
  assert.match(bad(["sub/.git/hooks/pre-commit"]), /points into \.git/);
  assert.match(bad(["a/../.git/config"]), /points into \.git/);
  assert.match(bad(["../.git/config"], "crate"), /points into \.git/);
  assert.deepEqual(ok([".github/x", ".gitignore", "a.git"]), [".github/x", ".gitignore", "a.git"]);
});

test("control characters and empty paths are refused", () => {
  assert.match(bad(["a\nb"]), /has control characters/);
  assert.match(bad(["a\0b"]), /has control characters/);
  assert.match(bad(["a\x7fb"]), /has control characters/);
  assert.match(bad(["a\tb"]), /has control characters/);
  assert.equal(bad([""]), "results has an empty path");
  assert.equal(bad(["   "]), "results has an empty path");
  assert.equal(bad(["x".repeat(1025)]), "results has a path that is too long");
});

test("the whole project is refused", () => {
  assert.match(bad(["."]), /is the whole project/);
  assert.match(bad(["./"]), /is the whole project/);
  assert.match(bad(["a/.."]), /is the whole project/);
  assert.match(bad([".."], "crate"), /is the whole project/);
});

test("more than 64 paths are refused, exactly 64 are fine", () => {
  assert.equal(bad(Array.from({ length: 65 }, (_, i) => `f${i}`)), "results has more than 64 paths");
  assert.equal(ok(Array.from({ length: 64 }, (_, i) => `f${i}`)).length, 64);
});

test("nested paths fold into the directory that covers them; duplicates and trailing slashes collapse", () => {
  assert.deepEqual(ok(["dist/a.js", "dist", "dist/sub/b.js"]), ["dist"]);
  assert.deepEqual(ok(["dist/", "dist"]), ["dist"]);
  assert.deepEqual(ok(["b", "a", "b/"]), ["a", "b"]);
  // A name that merely starts the same is not covered.
  assert.deepEqual(ok(["dist", "dist2/x", "distance"]), ["dist", "dist2/x", "distance"]);
  assert.deepEqual(ok(["out", "../out/x"], "crate"), ["crate/out", "out/x"]);
  assert.deepEqual(ok([]), []);
});

test("relativeToCwd turns a root-relative path back into what the agent wrote", () => {
  assert.equal(files.relativeToCwd("crate/out/bin", "crate"), "out/bin");
  assert.equal(files.relativeToCwd("shared/x", "crate"), "../shared/x");
  assert.equal(files.relativeToCwd("crate", "crate"), ".");
  assert.equal(files.relativeToCwd("a/b", ""), "a/b");
});

test("checkResultPaths and relativeToCwd round trip", () => {
  for (const [written, cwdRel] of [["out/bin", "crate"], ["../shared/x", "crate/deep"], ["dist", ""], ["a/b/c", "x"]]) {
    const [rootRelative] = ok([written], cwdRel);
    assert.equal(files.relativeToCwd(rootRelative, cwdRel), written);
  }
});

test("isInside accepts the directory itself and its children only", () => {
  assert.equal(files.isInside("/a/b", "/a/b"), true);
  assert.equal(files.isInside("/a/b", "/a/b/c/d"), true);
  assert.equal(files.isInside("/a/b", "/a/bc"), false);
  assert.equal(files.isInside("/a/b", "/a"), false);
  assert.equal(files.isInside("/a/b", "/x"), false);
});
