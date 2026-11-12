// The commands that run on a worker and the reader for what a job prints.
// Two halves. First the pure parts: ids, the refusals of unsafe values, and
// ExecStreamParser, which has to give the same answer however the bytes are
// cut up. Then the generated scripts are RUN for real with `sh -c` on this
// machine inside a temp work root (no ssh, no network): copy-in, exec (output
// merge, markers, niceness, no stdin, dead-man's switch, leftover cleanup),
// copy-back and cleanup. All files live in a self-cleaning temp dir; every
// process a test starts is killed again in its own cleanup.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const remote = await jiti.import("./remote.ts");
const { newJobId, newToken, jobDirectory, buildCopyInCommand, buildExecCommand, buildCopyBackCommand, buildCleanupCommand, copyBackMarker, ExecStreamParser } = remote;

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-remote-")));
const workRoot = `${base}/work`;
mkdirSync(workRoot);
after(() => rmSync(base, { recursive: true, force: true }));

const TOKEN = "0123456789abcdef";

// ── ids and directories ──────────────────────────────────────────────────────

test("a job id has the j-<time>-<random> shape and is different every time", () => {
  assert.match(newJobId(), /^j-[a-z0-9]+-[0-9a-f]{8}$/);
  assert.match(newJobId(35), /^j-z-[0-9a-f]{8}$/);
  assert.match(newJobId(0), /^j-0-[0-9a-f]{8}$/);
  assert.equal(new Set(Array.from({ length: 50 }, () => newJobId(1))).size, 50);
});

test("a token is 16 lowercase hex characters and is different every time", () => {
  assert.match(newToken(), /^[0-9a-f]{16}$/);
  assert.equal(new Set(Array.from({ length: 50 }, () => newToken())).size, 50);
});

test("the job directory is the work root plus the job id", () => {
  assert.equal(jobDirectory("/home/u/.cache/cody", "j-abc-0123abcd"), "/home/u/.cache/cody/j-abc-0123abcd");
  assert.equal(jobDirectory(workRoot, newJobId()).startsWith(`${workRoot}/j-`), true);
});

test("a work root with unusual characters is refused", () => {
  for (const bad of ["", "relative/root", "/has space/x", "/it's", "/a;b", "/a$b", "/a`b`", "/a\nb", "/trailing/", "/ünï", "/"]) {
    assert.throws(() => jobDirectory(bad, "j-abc-0123abcd"), /unusual characters/, JSON.stringify(bad));
  }
});

test("a malformed job id is refused", () => {
  for (const bad of ["", "j-", "abc", "j-abc", "j-ABC-0123", "j-abc-XYZ", "../j-abc-01", "j-abc-01/../x", "j-a b-01", "j-abc-01\n", "x-abc-01"]) {
    assert.throws(() => jobDirectory("/w", bad), /malformed job id/, JSON.stringify(bad));
  }
});

// ── ExecStreamParser ─────────────────────────────────────────────────────────

/** Feed chunks, then end(); fold the events into one summary. */
function readStream(chunks, token = TOKEN, { end = true } = {}) {
  const parser = new ExecStreamParser(token);
  const events = [];
  for (const chunk of chunks) events.push(...parser.feed(chunk));
  if (end) events.push(...parser.end());
  return {
    parser,
    events,
    started: events.filter((e) => e.kind === "started").length,
    nodir: events.filter((e) => e.kind === "nodir").length,
    output: events.filter((e) => e.kind === "output").map((e) => e.text).join(""),
    exits: events.filter((e) => e.kind === "exit").map((e) => e.code),
    preamble: parser.preamble,
    finished: parser.finished,
  };
}

const START = `@@cody-${TOKEN}-started\n`;
const EXIT = (code) => `\n@@cody-${TOKEN}-exit:${code}\n`;

test("the parser gives started, the output and the exit code", () => {
  const r = readStream([`${START}hello\nworld${EXIT(5)}`]);
  assert.deepEqual(r.events, [{ kind: "started" }, { kind: "output", text: "hello\nworld" }, { kind: "exit", code: 5 }]);
  assert.equal(r.finished, true);
});

test("a login banner before the start marker is the preamble, not output", () => {
  const r = readStream([`Welcome to worker\nLast login: never\n${START}job output${EXIT(0)}`]);
  assert.equal(r.preamble, "Welcome to worker\nLast login: never\n");
  assert.equal(r.output, "job output");
  assert.deepEqual(r.exits, [0]);
});

test("a job that prints nothing gives started and exit only", () => {
  const r = readStream([`${START}${EXIT(0)}`]);
  assert.deepEqual(r.events, [{ kind: "started" }, { kind: "exit", code: 0 }]);
});

// A stream full of things that look like the markers but are not.
const TRICKY_BANNER = `motd @@cody-${TOKEN}-star\n@@cody-${TOKEN}-start\n`;
const TRICKY_BODY = [
  "first line",
  `@@cody-ffffffffffffffff-exit:5`,
  `x@@cody-${TOKEN}-exit:6`,
  `@@cody-${TOKEN}-exit:abc`,
  `@@cody-${TOKEN}-exit:1234`,
  `@@cody-${TOKEN}-exit:`,
  `@@cody-${TOKEN}-started`,
  "",
  "@@cody-",
  "last line without newline ünï✓",
].join("\n");
const TRICKY_STREAM = `${TRICKY_BANNER}${START}${TRICKY_BODY}${EXIT(137)}TRAILING JUNK\n`;

function checkTricky(r, label) {
  assert.equal(r.output, TRICKY_BODY, `${label}: output`);
  assert.deepEqual(r.exits, [137], `${label}: exit`);
  assert.equal(r.started, 1, `${label}: started once`);
  assert.equal(r.preamble, TRICKY_BANNER, `${label}: preamble`);
  assert.equal(r.finished, true, `${label}: finished`);
}

test("text that looks like the exit marker is output, whole stream in one piece", () => {
  checkTricky(readStream([TRICKY_STREAM]), "single chunk");
});

test("cut at every possible boundary the parser gives the same output and exit code", () => {
  for (let i = 0; i <= TRICKY_STREAM.length; i += 1) {
    checkTricky(readStream([TRICKY_STREAM.slice(0, i), TRICKY_STREAM.slice(i)]), `cut at ${i}`);
  }
});

test("fed one character at a time the parser gives the same answer", () => {
  checkTricky(readStream([...TRICKY_STREAM]), "char by char");
});

test("fed in random pieces the parser gives the same answer", () => {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 200; round += 1) {
    const chunks = [];
    for (let at = 0; at < TRICKY_STREAM.length; ) {
      const size = 1 + (next() % 12);
      chunks.push(TRICKY_STREAM.slice(at, at + size));
      at += size;
    }
    checkTricky(readStream(chunks), `random round ${round}`);
  }
});

test("a marker that only has the same prefix but another token is output", () => {
  const r = readStream([`${START}a\n@@cody-ffffffffffffffff-exit:5\nb${EXIT(0)}`]);
  assert.equal(r.output, "a\n@@cody-ffffffffffffffff-exit:5\nb");
  assert.deepEqual(r.exits, [0]);
});

test("the right prefix with a non-numeric tail is output", () => {
  const r = readStream([`${START}a\n@@cody-${TOKEN}-exit:five\nb${EXIT(1)}`]);
  assert.equal(r.output, `a\n@@cody-${TOKEN}-exit:five\nb`);
  assert.deepEqual(r.exits, [1]);
});

test("a fake marker directly followed by the real one still finds the real one", () => {
  const r = readStream([`${START}${EXIT("")}`.slice(0, -1) + EXIT(3)]);
  assert.equal(r.output, `\n@@cody-${TOKEN}-exit:`);
  assert.deepEqual(r.exits, [3]);
});

test("the exit marker arriving in pieces is held back until it is complete", () => {
  const parser = new ExecStreamParser(TOKEN);
  assert.deepEqual(parser.feed(START), [{ kind: "started" }]);
  assert.deepEqual(parser.feed("abc"), [{ kind: "output", text: "abc" }]);
  assert.deepEqual(parser.feed("\n@@cody-0123"), []);
  assert.deepEqual(parser.feed("456789abcdef-exit:"), []);
  assert.deepEqual(parser.feed("1"), []);
  assert.deepEqual(parser.feed("3"), []);
  assert.equal(parser.finished, false);
  assert.deepEqual(parser.feed("7\n"), [{ kind: "exit", code: 137 }]);
  assert.equal(parser.finished, true);
});

test("a held-back piece that turns out not to be the marker is released as output", () => {
  const parser = new ExecStreamParser(TOKEN);
  parser.feed(START);
  assert.deepEqual(parser.feed("a\n@@cody"), [{ kind: "output", text: "a" }]);
  assert.deepEqual(parser.feed("x"), [{ kind: "output", text: "\n@@codyx" }]);
});

test("exit codes of one to three digits are read", () => {
  for (const code of [0, 1, 9, 10, 99, 100, 127, 137, 143, 255, 999]) {
    assert.deepEqual(readStream([`${START}${EXIT(code)}`]).exits, [code]);
  }
});

test("a four digit code is not an exit marker and the stream stays unfinished", () => {
  const r = readStream([`${START}out${EXIT(1000)}`]);
  assert.deepEqual(r.exits, []);
  assert.equal(r.output, `out\n@@cody-${TOKEN}-exit:1000\n`);
  assert.equal(r.finished, false);
});

test("a nodir marker gives the nodir event and nothing more", () => {
  const parser = new ExecStreamParser(TOKEN);
  assert.deepEqual(parser.feed(`Banner\n@@cody-${TOKEN}-nodir\nleftover ${START}more${EXIT(0)}`), [{ kind: "nodir" }]);
  assert.equal(parser.finished, true);
  assert.equal(parser.preamble, "Banner\n");
  assert.deepEqual(parser.feed("anything"), []);
  assert.deepEqual(parser.end(), []);
});

test("a nodir marker cut in pieces is still found", () => {
  const r = readStream([...`x\n@@cody-${TOKEN}-nodir\n`]);
  assert.equal(r.nodir, 1);
  assert.equal(r.started, 0);
  assert.equal(r.preamble, "x\n");
});

test("when the stream ends without an exit marker end() flushes the held-back text and the job is not finished", () => {
  const parser = new ExecStreamParser(TOKEN);
  assert.deepEqual(parser.feed(START), [{ kind: "started" }]);
  assert.deepEqual(parser.feed("abc\n@@cody-0123456789ab"), [{ kind: "output", text: "abc" }]);
  assert.equal(parser.finished, false);
  assert.deepEqual(parser.end(), [{ kind: "output", text: "\n@@cody-0123456789ab" }]);
  assert.equal(parser.finished, false, "no exit marker was read, so the job did not finish");
  assert.deepEqual(parser.feed("late"), []);
  assert.deepEqual(parser.end(), []);
});

test("a stream that ends before the start marker keeps what it saw as the preamble", () => {
  const r = readStream(["Permission denied (publickey).\n"]);
  assert.equal(r.started, 0);
  assert.equal(r.preamble, "Permission denied (publickey).\n");
  assert.equal(r.output, "");
  assert.equal(r.finished, false);
});

test("nothing after the exit marker is returned", () => {
  const parser = new ExecStreamParser(TOKEN);
  const events = parser.feed(`${START}x${EXIT(0)}GARBAGE`);
  assert.deepEqual(events, [{ kind: "started" }, { kind: "output", text: "x" }, { kind: "exit", code: 0 }]);
  assert.deepEqual(parser.feed("more"), []);
  assert.deepEqual(parser.end(), []);
  assert.equal(parser.finished, true);
});

test("an empty feed does nothing", () => {
  const parser = new ExecStreamParser(TOKEN);
  assert.deepEqual(parser.feed(""), []);
});

test("only the last 4096 characters before the start marker are kept as the preamble", () => {
  const banner = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 23))).join("");
  const r = readStream([banner, `${START}ok${EXIT(0)}`]);
  assert.equal(r.preamble.length, 4096);
  assert.equal(r.preamble, banner.slice(-4096));
  assert.equal(r.output, "ok");
  // fed in small pieces the cap holds as well
  const parser = new ExecStreamParser(TOKEN);
  for (let at = 0; at < banner.length; at += 777) parser.feed(banner.slice(at, at + 777));
  parser.feed(`${START}ok${EXIT(0)}`);
  assert.equal(parser.preamble, banner.slice(-4096));
});

test("the parser refuses a malformed token", () => {
  for (const bad of ["", "xyz", "ABCDEF0123456789", "123", "0".repeat(33), "0123456789abcdeg"]) {
    assert.throws(() => new ExecStreamParser(bad), /malformed job token/, JSON.stringify(bad));
  }
});

// ── command builders: shape and refusals ─────────────────────────────────────

const JOB = `${workRoot}/j-abc-0123abcd`;

test("every builder returns one sh -c '…' string", () => {
  const commands = [
    buildCopyInCommand(JOB, "sub", true),
    buildCopyInCommand(JOB, "", false),
    buildExecCommand({ directory: JOB, cwdRel: "sub", command: "make", token: TOKEN }),
    buildCopyBackCommand({ directory: JOB, paths: ["a"], token: TOKEN }),
    buildCleanupCommand(JOB, workRoot),
  ];
  for (const command of commands) {
    assert.ok(command.startsWith("sh -c '"), command);
    assert.ok(command.endsWith("'"), command);
  }
});

test("copy-in only unpacks when there are files", () => {
  assert.match(buildCopyInCommand(JOB, "sub", true), /tar -xof - -C /);
  assert.doesNotMatch(buildCopyInCommand(JOB, "sub", false), /tar/);
});

const unsafeDirectories = ["", "relative/dir", "/with space/j-a", "/it's/j-a", "/semi;colon", "/dollar$HOME", "/back`tick`", "/new\nline", "/trailing/", "/ends-with-dash-", "/ünï/x", "/a/../b", "/a/..", "/.."];

test("an unsafe job directory is refused by every builder", () => {
  for (const bad of unsafeDirectories) {
    const label = JSON.stringify(bad);
    assert.throws(() => buildCopyInCommand(bad, "", true), /Refusing/, `copy-in ${label}`);
    assert.throws(() => buildExecCommand({ directory: bad, cwdRel: "", command: "true", token: TOKEN }), /Refusing/, `exec ${label}`);
    assert.throws(() => buildCopyBackCommand({ directory: bad, paths: [], token: TOKEN }), /Refusing/, `copy-back ${label}`);
    assert.throws(() => buildCleanupCommand(bad, "/w"), /Refusing/, `cleanup dir ${label}`);
    assert.throws(() => buildCleanupCommand("/w/j-a", bad), /Refusing/, `cleanup root ${label}`);
  }
});

test("a malformed token is refused by exec, copy-back and the marker", () => {
  for (const bad of ["", "xyz", "ABCDEF0123456789", "123", "0".repeat(33), "0123456789abcde'"]) {
    const label = JSON.stringify(bad);
    assert.throws(() => buildExecCommand({ directory: JOB, cwdRel: "", command: "true", token: bad }), /malformed job token/, `exec ${label}`);
    assert.throws(() => buildCopyBackCommand({ directory: JOB, paths: [], token: bad }), /malformed job token/, `copy-back ${label}`);
    assert.throws(() => copyBackMarker(bad), /malformed job token/, `marker ${label}`);
  }
  assert.equal(copyBackMarker(TOKEN), `@@cody-${TOKEN}-data\n`);
});

test("cleanup refuses a directory that is not <root>/j-*", () => {
  const outside = mkdtempSync(join(base, "outside-"));
  writeFileSync(join(outside, "precious"), "keep");
  for (const dir of ["/tmp/other/j-abc-01", workRoot, `${workRoot}/not-a-job`, `${workRoot}j-abc-01`, `${workRoot}other/j-abc-01`, `${workRoot}/j-abc-01/../../etc`, outside]) {
    assert.throws(() => buildCleanupCommand(dir, workRoot), /Refusing/, dir);
  }
  assert.equal(readFileSync(join(outside, "precious"), "utf8"), "keep");
});

test("a command with a NUL byte cannot be turned into a script", () => {
  assert.throws(() => buildExecCommand({ directory: JOB, cwdRel: "", command: "echo a\0b", token: TOKEN }), /NUL/);
  assert.throws(() => buildCopyInCommand(JOB, "a\0b", false), /NUL/);
  assert.throws(() => buildCopyBackCommand({ directory: JOB, paths: ["a\0b"], token: TOKEN }), /NUL/);
});

// ── running the generated scripts for real ───────────────────────────────────

const started = new Set();
after(() => {
  for (const child of started) child.kill("SIGKILL");
});

/** Start a generated command the way ssh would hand it to the remote login shell. */
function start(commandString, { stdin } = {}) {
  const child = spawn("sh", ["-c", commandString], { stdio: ["pipe", "pipe", "pipe"], detached: false });
  started.add(child);
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.stdin.on("error", () => {});
  if (stdin !== undefined) child.stdin.end(stdin);
  const { promise, resolve } = Promise.withResolvers();
  child.on("close", (code, signal) => {
    started.delete(child);
    resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
  });
  return { child, done: promise, text: () => Buffer.concat(out).toString("utf8") };
}

/** Run a one-shot command (stdin given and closed) to its end. */
async function runOnce(commandString, stdin = "") {
  return start(commandString, { stdin }).done;
}

/** Run a job's exec command to its end, keeping stdin open like Cody's ssh does, then close it. */
async function runExec(options) {
  const job = start(buildExecCommand(options));
  const result = await job.done;
  job.child.stdin.destroy();
  return { ...result, text: result.stdout.toString("utf8") };
}

async function waitFor(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // a zombie nobody reaped is dead for our purposes
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

/** A fresh, empty job directory (with cwdRel in it) made by the real copy-in command. */
async function makeJob(cwdRel = "") {
  const directory = jobDirectory(workRoot, newJobId());
  const result = await runOnce(buildCopyInCommand(directory, cwdRel, false));
  assert.equal(result.code, 0, result.stderr);
  return directory;
}

function tarOf(sourceDirectory) {
  const result = spawnSync("tar", ["-cf", "-", "-C", sourceDirectory, "."]);
  assert.equal(result.status, 0);
  return result.stdout;
}

/** Fold a run's stdout through the parser, for exec output. */
function parse(text, token = TOKEN) {
  return readStream([text], token);
}

// (1) copy-in

test("copy-in unpacks the tar stream into the job directory and makes the working directory", async () => {
  const source = mkdtempSync(join(base, "src-"));
  mkdirSync(join(source, "a"));
  writeFileSync(join(source, "a", "b.txt"), "hi there\n", { mode: 0o666 });
  writeFileSync(join(source, "top.txt"), "top\n", { mode: 0o666 });
  const directory = jobDirectory(workRoot, newJobId());
  const result = await runOnce(buildCopyInCommand(directory, "a/not-in-the-archive", true), tarOf(source));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "a", "b.txt"), "utf8"), "hi there\n");
  assert.equal(readFileSync(join(directory, "top.txt"), "utf8"), "top\n");
  assert.ok(statSync(join(directory, "a", "not-in-the-archive")).isDirectory());
  // The directory the script made itself follows umask 077.
  assert.equal(statSync(join(directory, "a", "not-in-the-archive")).mode & 0o777, 0o700);
  if (process.getuid() !== 0) {
    // As an ordinary user tar applies the umask to what it unpacks; root's tar restores the archive's modes.
    assert.equal(statSync(join(directory, "top.txt")).mode & 0o077, 0, "unpacked files are not readable by others");
    assert.equal(statSync(join(directory, "a", "b.txt")).mode & 0o077, 0);
  }
});

test("copy-in without files makes only the directories", async () => {
  const directory = jobDirectory(workRoot, newJobId());
  const result = await runOnce(buildCopyInCommand(directory, "x/y", false));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(directory), ["x"]);
  assert.deepEqual(readdirSync(join(directory, "x")), ["y"]);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, "x", "y")).mode & 0o777, 0o700);
});

test("copy-in with an empty working directory path uses the job directory itself", async () => {
  const source = mkdtempSync(join(base, "src-"));
  writeFileSync(join(source, "f"), "1");
  const directory = jobDirectory(workRoot, newJobId());
  const result = await runOnce(buildCopyInCommand(directory, "", true), tarOf(source));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "f"), "utf8"), "1");
});

test("a working directory path with spaces, quotes and $() is made literally", async () => {
  const directory = jobDirectory(workRoot, newJobId());
  const nasty = "sp ace/it's $(touch pwned) `touch pwned2` ünï";
  const result = await runOnce(buildCopyInCommand(directory, nasty, false));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(statSync(join(directory, nasty)).isDirectory());
  assert.equal(existsSync(join(directory, "pwned")), false);
  assert.equal(existsSync(join(directory, "pwned2")), false);
  assert.equal(existsSync(join(base, "pwned")), false);
});

// (2) exec

test("exec prints started, the output with stderr merged, and the exit code", async () => {
  const directory = await makeJob("sub/dir");
  const result = await runExec({ directory, cwdRel: "sub/dir", command: "echo out; echo err >&2; pwd; exit 3", token: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(result.text, `@@cody-${TOKEN}-started\nout\nerr\n${directory}/sub/dir\n\n@@cody-${TOKEN}-exit:3\n`);
  const parsed = parse(result.text);
  assert.deepEqual(parsed.events, [{ kind: "started" }, { kind: "output", text: `out\nerr\n${directory}/sub/dir\n` }, { kind: "exit", code: 3 }]);
});

test("the exit code of the command comes through", async () => {
  const directory = await makeJob();
  for (const code of [0, 1, 255]) {
    const result = await runExec({ directory, cwdRel: "", command: `exit ${code}`, token: TOKEN });
    assert.deepEqual(parse(result.text).exits, [code]);
  }
});

test("a command whose output has no trailing newline still gets a clean exit marker", async () => {
  const directory = await makeJob();
  const result = await runExec({ directory, cwdRel: "", command: "printf abc", token: TOKEN });
  assert.equal(result.text, `@@cody-${TOKEN}-started\nabc\n@@cody-${TOKEN}-exit:0\n`);
  const parsed = parse(result.text);
  assert.equal(parsed.output, "abc");
  assert.deepEqual(parsed.exits, [0]);
});

test("a missing working directory gives the nodir marker and runs nothing", async () => {
  const directory = await makeJob("here");
  const result = await runExec({ directory, cwdRel: "gone", command: "touch ran", token: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(result.text, `@@cody-${TOKEN}-nodir\n`);
  assert.deepEqual(parse(result.text).events, [{ kind: "nodir" }]);
  assert.equal(existsSync(join(directory, "ran")), false);
  assert.equal(existsSync(join(directory, ".pid")), false);
});

test("a job directory that is gone altogether also gives nodir", async () => {
  const result = await runExec({ directory: jobDirectory(workRoot, newJobId()), cwdRel: "", command: "true", token: TOKEN });
  assert.equal(result.text, `@@cody-${TOKEN}-nodir\n`);
});

test("the command runs in the working directory, with .pid there while it runs and .done after", async () => {
  const directory = await makeJob("w");
  // cwdRel "" puts the command in the job directory where .pid and .done live
  const top = await makeJob();
  const during = await runExec({ directory: top, cwdRel: "", command: 'p=$(cat .pid); kill -0 "$p" && echo "pid-alive:$p"; [ -e .done ] && echo done-early || echo not-done', token: TOKEN });
  const lines = parse(during.text).output.split("\n");
  assert.match(lines[0], /^pid-alive:\d+$/);
  assert.equal(lines[1], "not-done");
  assert.equal(existsSync(join(top, ".done")), true, ".done exists once the job is over");
  assert.match(readFileSync(join(top, ".pid"), "utf8"), /^\d+\n$/);
  const where = await runExec({ directory, cwdRel: "w", command: "pwd; echo made > file-here", token: TOKEN });
  assert.equal(parse(where.text).output, `${directory}/w\n`);
  assert.equal(readFileSync(join(directory, "w", "file-here"), "utf8"), "made\n");
});

test("the job has umask 077", async () => {
  const directory = await makeJob();
  const result = await runExec({ directory, cwdRel: "", command: "umask; touch made; ls -l made", token: TOKEN });
  const lines = parse(result.text).output.split("\n");
  assert.match(lines[0], /^0*77$/);
  assert.match(lines[1], /^-rw-------/);
});

test("the job runs at the lowest priority when nice exists", async () => {
  const hasNice = spawnSync("sh", ["-c", "command -v nice"]).status === 0;
  assert.equal(hasNice, true, "this machine has nice");
  const directory = await makeJob();
  const result = await runExec({ directory, cwdRel: "", command: "nice", token: TOKEN });
  assert.equal(parse(result.text).output, "19\n");
});

test("the job has no stdin: it is not a terminal and cat returns at once", async () => {
  const directory = await makeJob();
  const result = await runExec({ directory, cwdRel: "", command: "if [ -t 0 ]; then echo tty; else echo not-a-tty; fi; cat; echo after-cat; read x || echo read-failed", token: TOKEN });
  assert.equal(parse(result.text).output, "not-a-tty\nafter-cat\nread-failed\n");
});

test("a command with quotes, $(), backticks, newlines and unicode runs exactly as written", async () => {
  const directory = await makeJob();
  const command = ["echo 'single quoted'", 'echo "double $((1+2))"', "echo $(echo sub)", "echo `echo tick`", "echo 'it'\\''s'", "echo ünï✓ 日本", "cat <<'EOF'", "heredoc $NOT_EXPANDED 'q'", "EOF", "echo end"].join("\n");
  const result = await runExec({ directory, cwdRel: "", command, token: TOKEN });
  assert.equal(parse(result.text).output, "single quoted\ndouble 3\nsub\ntick\nit's\nünï✓ 日本\nheredoc $NOT_EXPANDED 'q'\nend\n");
});

test("a command that tries to print a fake exit marker for another token stays output", async () => {
  const directory = await makeJob();
  const result = await runExec({ directory, cwdRel: "", command: `echo; echo '@@cody-ffffffffffffffff-exit:0'; exit 7`, token: TOKEN });
  const parsed = parse(result.text);
  assert.equal(parsed.output, "\n@@cody-ffffffffffffffff-exit:0\n");
  assert.deepEqual(parsed.exits, [7]);
});

// (3) the dead-man's switch

test("when Cody closes the session's stdin the job's process group is stopped", { timeout: 12_000 }, async () => {
  const directory = await makeJob();
  const job = start(buildExecCommand({ directory, cwdRel: "", command: "echo $$; sleep 60", token: TOKEN }));
  const jobPid = await waitFor(() => {
    const match = /@@cody-[0-9a-f]+-started\n(\d+)\n/.exec(job.text());
    return match ? Number(match[1]) : 0;
  }, "the job to print its pid");
  assert.equal(alive(jobPid), true, "the job runs while stdin is open");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alive(jobPid), true, "and keeps running while nobody touches stdin");
  const sleepers = spawnSync("sh", ["-c", `ps -o pid= -g ${jobPid}`]).stdout.toString().trim().split(/\s+/).map(Number).filter(Boolean);
  assert.ok(sleepers.length >= 2, `the job's group has the shell and its sleep: ${sleepers}`);

  const closedAt = Date.now();
  job.child.stdin.end();
  const result = await job.done;
  assert.ok(Date.now() - closedAt < 10_000);
  const parsed = parse(result.stdout.toString("utf8"));
  assert.deepEqual(parsed.exits.length, 1, "an exit marker is printed");
  assert.ok([143, 137].includes(parsed.exits[0]), `exit code ${parsed.exits[0]} is a signal code`);
  await waitFor(() => sleepers.every((pid) => !alive(pid)), "the whole process group to be gone", 3000);
  assert.equal(alive(jobPid), false);
  assert.equal(existsSync(join(directory, ".done")), true);
});

// (4) leftovers

test("a background process the command left behind is killed when the command ends", { timeout: 12_000 }, async () => {
  const directory = await makeJob();
  let leftover = 0;
  try {
    const result = await runExec({ directory, cwdRel: "", command: "sleep 60 & echo $!; exit 0", token: TOKEN });
    const parsed = parse(result.text);
    assert.deepEqual(parsed.exits, [0]);
    leftover = Number(parsed.output.trim());
    assert.ok(leftover > 1, `pid ${parsed.output}`);
    await waitFor(() => !alive(leftover), "the leftover to be killed", 3000);
  } finally {
    if (leftover > 1) {
      try {
        process.kill(leftover, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});

// (5) copy-back

function splitAnswer(buffer, token = TOKEN) {
  const marker = Buffer.from(copyBackMarker(token));
  const at = buffer.indexOf(marker);
  assert.ok(at >= 0, `the data marker is in the answer: ${JSON.stringify(buffer.toString("utf8").slice(0, 200))}`);
  return { text: buffer.subarray(0, at).toString("utf8"), data: buffer.subarray(at + marker.length) };
}

function listTar(data) {
  const result = spawnSync("tar", ["-tf", "-"], { input: data });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString("utf8").split("\n").filter(Boolean);
}

async function jobWithFiles() {
  const directory = await makeJob("proj");
  writeFileSync(join(directory, "out.txt"), "result\n");
  mkdirSync(join(directory, "build"));
  writeFileSync(join(directory, "build", "x.bin"), Buffer.from([0, 1, 2, 255]));
  return directory;
}

test("copy-back names the missing paths, then the data marker, then a tar of the others", async () => {
  const directory = await jobWithFiles();
  const result = await runOnce(buildCopyBackCommand({ directory, paths: ["out.txt", "nope", "build"], token: TOKEN }));
  assert.equal(result.code, 0);
  const { text, data } = splitAnswer(result.stdout);
  assert.equal(text, "missing:1\n");
  const names = listTar(data);
  assert.deepEqual(names.sort(), ["./build/", "./build/x.bin", "./out.txt"]);
  for (const name of names) assert.ok(name.startsWith("./"), name);
  const extracted = mkdtempSync(join(base, "back-"));
  assert.equal(spawnSync("tar", ["-xf", "-", "-C", extracted], { input: data }).status, 0);
  assert.equal(readFileSync(join(extracted, "out.txt"), "utf8"), "result\n");
  assert.deepEqual([...readFileSync(join(extracted, "build", "x.bin"))], [0, 1, 2, 255]);
});

test("copy-back reports every missing path by its position", async () => {
  const directory = await jobWithFiles();
  const result = await runOnce(buildCopyBackCommand({ directory, paths: ["a", "out.txt", "b", "c", "build"], token: TOKEN }));
  const { text, data } = splitAnswer(result.stdout);
  assert.equal(text, "missing:0\nmissing:2\nmissing:3\n");
  assert.equal(listTar(data).length, 3);
});

test("copy-back with everything missing sends the text section, the marker and no tar bytes", async () => {
  const directory = await jobWithFiles();
  const result = await runOnce(buildCopyBackCommand({ directory, paths: ["nope", "also/nope"], token: TOKEN }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString("utf8"), `missing:0\nmissing:1\n@@cody-${TOKEN}-data\n`);
});

test("copy-back with no paths sends only the marker", async () => {
  const directory = await jobWithFiles();
  const result = await runOnce(buildCopyBackCommand({ directory, paths: [], token: TOKEN }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.toString("utf8"), `@@cody-${TOKEN}-data\n`);
});

test("copy-back quotes paths: spaces, quotes and $() are literal, and a dangling link counts as present", async () => {
  const directory = await makeJob();
  const odd = "we ird 'file' $(touch pwned).txt";
  writeFileSync(join(directory, odd), "odd");
  symlinkSync("target-that-is-not-there", join(directory, "dangling"));
  const result = await runOnce(buildCopyBackCommand({ directory, paths: [odd, "dangling", "$(touch pwned)"], token: TOKEN }));
  const { text, data } = splitAnswer(result.stdout);
  assert.equal(text, "missing:2\n");
  assert.deepEqual(listTar(data).sort(), ["./dangling", `./${odd}`].sort());
  assert.equal(existsSync(join(directory, "pwned")), false);
});

test("copy-back of a job directory that is gone answers nodir", async () => {
  const result = await runOnce(buildCopyBackCommand({ directory: jobDirectory(workRoot, newJobId()), paths: ["a"], token: TOKEN }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString("utf8"), `@@cody-${TOKEN}-nodir\n`);
});

// (6) cleanup

test("cleanup removes the job directory", async () => {
  const directory = await jobWithFiles();
  const result = await runOnce(buildCleanupCommand(directory, workRoot));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(workRoot), true, "the work root stays");
});

test("cleanup of a directory that is already gone succeeds", async () => {
  const result = await runOnce(buildCleanupCommand(jobDirectory(workRoot, newJobId()), workRoot));
  assert.equal(result.code, 0, result.stderr);
});

test("cleanup leaves other job directories alone", async () => {
  const mine = await jobWithFiles();
  const other = await jobWithFiles();
  assert.equal((await runOnce(buildCleanupCommand(mine, workRoot))).code, 0);
  assert.equal(existsSync(mine), false);
  assert.equal(existsSync(join(other, "out.txt")), true);
});

test("cleanup waits for a live job to end before it deletes", { timeout: 12_000 }, async () => {
  const directory = await jobWithFiles();
  const sleeper = spawn("sleep", ["2"], { stdio: "ignore" });
  started.add(sleeper);
  sleeper.on("close", () => started.delete(sleeper));
  writeFileSync(join(directory, ".pid"), `${sleeper.pid}\n`);
  const began = Date.now();
  const cleanup = start(buildCleanupCommand(directory, workRoot), { stdin: "" });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(existsSync(directory), true, "the directory is still there while the job lives");
  const result = await cleanup.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(directory), false);
  assert.ok(Date.now() - began >= 1200, "it waited for the sleeper");
  assert.equal(alive(sleeper.pid), false);
});

test("cleanup of a job whose pid file names a dead process does not wait", async () => {
  const directory = await jobWithFiles();
  const gone = spawn("true", { stdio: "ignore" });
  await new Promise((resolve) => gone.on("close", resolve));
  writeFileSync(join(directory, ".pid"), `${gone.pid}\n`);
  const began = Date.now();
  const result = await runOnce(buildCleanupCommand(directory, workRoot));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(directory), false);
  assert.ok(Date.now() - began < 1500);
});
