import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { localFits, currentArch, runLocalCommand } = await jiti.import("./local.ts");

/**
 * Local fallback: the same job run on this server. localFits answers "could
 * this machine take it" from the architecture and the programs on PATH (with
 * the tool-name aliases such as rust = cargo or rustc). runLocalCommand runs a
 * real `sh` and must: merge stdout and stderr in order, report the exit code or
 * the signal, give the command no stdin, honour cwd, stop the WHOLE process
 * group on timeout or abort (no orphan left running), and report a cwd that
 * does not exist as a start error. Everything runs in a self-cleaning temp dir.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-local-")));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshDir(label) {
  counter += 1;
  const dir = join(root, `${label}-${counter}`);
  mkdirSync(dir);
  return dir;
}

/** A directory holding executable stubs with these names (plus, optionally, a file that is not executable). */
function stubBin(executables, notExecutable = []) {
  const dir = freshDir("bin");
  for (const name of executables) {
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, name), 0o755);
  }
  for (const name of notExecutable) {
    writeFileSync(join(dir, name), "not a program\n");
    chmodSync(join(dir, name), 0o644);
  }
  return dir;
}

/** Run a command and collect its merged output. */
async function run(command, options = {}) {
  const chunks = [];
  const result = await runLocalCommand({ command, cwd: options.cwd ?? freshDir("cwd"), onOutput: (text) => chunks.push(text), timeoutMs: 10_000, ...options });
  return { ...result, output: chunks.join("") };
}

/** Gone, or only a zombie nobody has collected yet (a container's init may not reap it). */
function processIsGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  try {
    return /^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function waitUntilGone(pid, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (processIsGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return processIsGone(pid);
}

// ---------- localFits ----------

test("currentArch names this machine the way workers do, and nothing for other CPUs", () => {
  const expected = { x64: "x86_64", arm64: "aarch64" }[process.arch] ?? null;
  assert.equal(currentArch(), expected);
});

test("a job that needs another architecture does not fit, and the message names both", () => {
  const fit = localFits({ arch: "x86_64", tools: [] }, { arch: "aarch64", path: "" });
  assert.deepEqual(fit, { ok: false, why: "this server is aarch64, the job needs x86_64" });
});

test("an architecture this server cannot name is reported by the CPU name node knows", () => {
  const fit = localFits({ arch: "aarch64", tools: [] }, { arch: null });
  assert.equal(fit.ok, false);
  assert.equal(fit.why, `this server is ${process.arch}, the job needs aarch64`);
});

test("the architecture is checked before the tools", () => {
  const fit = localFits({ arch: "x86_64", tools: ["nothing-like-this"] }, { arch: "aarch64", path: "" });
  assert.equal(fit.ok, false);
  assert.match(fit.why, /the job needs x86_64/);
});

test("a job with no architecture requirement fits on any architecture", () => {
  assert.deepEqual(localFits({ arch: null, tools: [] }, { arch: "aarch64" }), { ok: true });
  assert.deepEqual(localFits({ arch: null, tools: [] }, { arch: null }), { ok: true });
});

test("a matching architecture with no tools needed fits", () => {
  assert.deepEqual(localFits({ arch: "x86_64", tools: [] }, { arch: "x86_64", path: "" }), { ok: true });
});

test("without an override the real architecture and PATH are used", () => {
  const mine = currentArch();
  if (mine) assert.deepEqual(localFits({ arch: mine, tools: ["sh"] }), { ok: true });
  const other = mine === "x86_64" ? "aarch64" : "x86_64";
  assert.equal(localFits({ arch: other, tools: [] }).ok, false);
});

test("a tool that is on PATH fits and one that is not is named in the message", () => {
  const bin = stubBin(["mytool"]);
  assert.deepEqual(localFits({ arch: null, tools: ["mytool"] }, { path: bin }), { ok: true });
  const fit = localFits({ arch: null, tools: ["mytool", "absent-one", "absent-two"] }, { path: bin });
  assert.deepEqual(fit, { ok: false, why: "this server does not have absent-one, absent-two" });
});

test("a tool is searched across every directory of PATH", () => {
  const first = stubBin(["alpha"]);
  const second = stubBin(["beta"]);
  assert.deepEqual(localFits({ arch: null, tools: ["alpha", "beta"] }, { path: `${first}:${second}` }), { ok: true });
});

test("an empty PATH, an empty entry in it and a missing directory find nothing", () => {
  assert.equal(localFits({ arch: null, tools: ["sh"] }, { path: "" }).ok, false);
  assert.equal(localFits({ arch: null, tools: ["sh"] }, { path: `::${join(root, "no-such-dir")}` }).ok, false);
});

test("a file on PATH that is not executable does not count as the tool", () => {
  const bin = stubBin([], ["mytool"]);
  assert.equal(localFits({ arch: null, tools: ["mytool"] }, { path: bin }).ok, false);
});

test("a tool name an agent uses can stand for a different program: rust is cargo or rustc", () => {
  assert.deepEqual(localFits({ arch: null, tools: ["rust"] }, { path: stubBin(["cargo"]) }), { ok: true });
  assert.deepEqual(localFits({ arch: null, tools: ["rust"] }, { path: stubBin(["rustc"]) }), { ok: true });
  assert.equal(localFits({ arch: null, tools: ["rust"] }, { path: stubBin(["rust"]) }).ok, false, "a program literally called rust is not what rust means");
});

test("python is python3 or python, nodejs is node, golang is go", () => {
  assert.equal(localFits({ arch: null, tools: ["python"] }, { path: stubBin(["python3"]) }).ok, true);
  assert.equal(localFits({ arch: null, tools: ["python"] }, { path: stubBin(["python"]) }).ok, true);
  assert.equal(localFits({ arch: null, tools: ["python3"] }, { path: stubBin(["python"]) }).ok, false, "python3 means python3 only");
  assert.equal(localFits({ arch: null, tools: ["nodejs"] }, { path: stubBin(["node"]) }).ok, true);
  assert.equal(localFits({ arch: null, tools: ["golang"] }, { path: stubBin(["go"]) }).ok, true);
  assert.equal(localFits({ arch: null, tools: ["golang"] }, { path: stubBin(["golang"]) }).ok, false);
});

test("every tool in the list must be present, aliased or not", () => {
  const bin = stubBin(["cargo", "node"]);
  assert.equal(localFits({ arch: null, tools: ["rust", "node"] }, { path: bin }).ok, true);
  const fit = localFits({ arch: null, tools: ["rust", "node", "docker"] }, { path: bin });
  assert.deepEqual(fit, { ok: false, why: "this server does not have docker" });
});

// ---------- runLocalCommand ----------

test("stdout and stderr come back merged in the order they were written", async () => {
  const result = await run("echo a; echo b 1>&2; echo c");
  assert.equal(result.output, "a\nb\nc\n");
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.startError, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("the exit code is returned, zero or not", async () => {
  assert.equal((await run("exit 0")).code, 0);
  assert.equal((await run("exit 7")).code, 7);
  assert.equal((await run("echo before; exit 3")).code, 3);
  assert.equal((await run("no-such-command-anywhere-xyz")).code, 127);
});

test("a command killed by a signal has no exit code and names the signal", async () => {
  const result = await run("kill -9 $$");
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("the command has no stdin: cat ends at once instead of waiting", async () => {
  const startedAt = Date.now();
  const result = await run("cat; echo after-cat");
  assert.equal(result.code, 0);
  assert.equal(result.output, "after-cat\n");
  assert.ok(Date.now() - startedAt < 5000);
});

test("the command runs in the cwd it was given", async () => {
  const cwd = freshDir("here");
  const result = await run("pwd -P", { cwd });
  assert.equal(result.output.trim(), cwd);
});

test("the command runs at the lowest priority when nice exists", async (t) => {
  const hasNice = (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, "nice")));
  if (!hasNice) return t.skip("no nice program on this machine");
  const result = await run("nice");
  assert.equal(result.output.trim(), "19");
});

test("the scratch directory becomes TMPDIR for the command", async () => {
  const scratchDir = freshDir("scratch");
  const result = await run('printf "%s|%s" "$TMPDIR" "$CODY_SCRATCH"', { scratchDir });
  assert.equal(result.output, `${scratchDir}|${scratchDir}`);
});

test("the command's environment carries the disk areas as JSON", async () => {
  const result = await run('printf "%s" "$CODY_DISK_AREAS"');
  assert.doesNotThrow(() => JSON.parse(result.output));
});

test("a command with a shell syntax error reports through its exit code, not as a start error", async () => {
  const result = await run("if then fi");
  assert.equal(result.startError, null);
  assert.notEqual(result.code, 0);
  assert.notEqual(result.code, null);
});

test("a cwd that does not exist is a start error and nothing runs", async () => {
  const chunks = [];
  const result = await runLocalCommand({ command: "echo should-not-run", cwd: join(root, "missing-dir"), onOutput: (text) => chunks.push(text), timeoutMs: 10_000 });
  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.match(result.startError ?? "", /ENOENT/);
  assert.deepEqual(chunks, []);
});

test("a timeout stops the whole process group, so a background process does not survive", async () => {
  const cwd = freshDir("timeout");
  const startedAt = Date.now();
  const result = await run("sleep 30 & echo $! > child.pid; wait", { cwd, timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM");
  assert.ok(Date.now() - startedAt < 3000, "it did not wait for the 30 s sleep");
  const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.equal(await waitUntilGone(pid), true, "the background sleep is gone");
});

test("an abort signal stops the command and the whole group, and says it was aborted", async () => {
  const cwd = freshDir("abort");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const startedAt = Date.now();
  const result = await run("sleep 30 & echo $! > child.pid; wait", { cwd, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, null);
  assert.ok(Date.now() - startedAt < 3000);
  const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8").trim());
  assert.equal(await waitUntilGone(pid), true, "the background sleep is gone");
});

test("a signal that is already aborted stops the command straight away", async () => {
  const startedAt = Date.now();
  const result = await run("sleep 30", { signal: AbortSignal.abort() });
  assert.equal(result.aborted, true);
  assert.equal(result.code, null);
  assert.ok(Date.now() - startedAt < 3000);
});

test("an abort after the command has ended changes nothing", async () => {
  const controller = new AbortController();
  const result = await run("echo done", { signal: controller.signal });
  controller.abort();
  assert.equal(result.aborted, false);
  assert.equal(result.code, 0);
});

test("something the command leaves running does not hold the result back, and is killed with it", async () => {
  const cwd = freshDir("leftover");
  const startedAt = Date.now();
  const result = await run("sleep 30 & echo $! > child.pid; echo done", { cwd });
  assert.equal(result.output, "done\n");
  assert.equal(result.code, 0);
  assert.ok(Date.now() - startedAt < 4000, "it did not wait for the 30 s sleep");
  const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8").trim());
  assert.equal(await waitUntilGone(pid), true, "the leftover sleep is gone");
});

test("output that arrives in many pieces is all delivered before the result", async () => {
  const result = await run("i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done");
  const lines = result.output.trim().split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "line-0");
  assert.equal(lines[199], "line-199");
});
