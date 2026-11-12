// What executeOnWorker (lib/workers/execute.ts) tells the caller about a job.
// Part 1 is scripted: a tiny fake ssh whose output, exit and clock the test
// controls, to pin down every outcome (exited / no_start / dropped / timeout /
// cancelled), that the time limit counts from the start marker, that stopping
// a job means closing ssh's stdin (never writing to it, killing ssh only after
// a grace period) and that no timer outlives the call. Part 2 runs the REAL
// generated exec script through ./local-shell.mjs: merged output, exit codes,
// a time limit and a cancel really stop the job's processes, big output
// arrives whole, and a leftover background process dies with the command.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeOnWorker } = await jiti.import("./execute.ts");
const { buildExecCommand, newJobId, newToken, jobDirectory } = await jiti.import("./remote.ts");
const { localShell } = await import("./local-shell.mjs");

const TOKEN = "0123456789abcdef";
const STARTED = `@@cody-${TOKEN}-started\n`;
const exitText = (code) => `\n@@cody-${TOKEN}-exit:${code}\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const OK = { code: 0, stderr: "", noSsh: false };

async function until(condition, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(5);
  }
}

/** A fake ssh process the test drives by hand. */
function fakeProc() {
  const stdin = new PassThrough();
  const stdinLog = { ends: [], writes: 0, data: 0 };
  const realEnd = stdin.end.bind(stdin);
  stdin.end = (...args) => {
    if (args.length > 0 && typeof args[0] !== "function") stdinLog.writes += 1;
    stdinLog.ends.push(Date.now());
    return realEnd(...args);
  };
  const realWrite = stdin.write.bind(stdin);
  stdin.write = (...args) => {
    stdinLog.writes += 1;
    return realWrite(...args);
  };
  stdin.on("data", () => {
    stdinLog.data += 1;
  });
  const stdout = new PassThrough();
  const { promise: exited, resolve } = Promise.withResolvers();
  const proc = {
    stdinLog,
    kills: 0,
    starts: [],
    async say(chunk) {
      stdout.write(chunk);
      await tick();
    },
    finish(exit) {
      resolve(exit);
    },
  };
  const process = {
    stdin,
    stdout,
    exited,
    kill() {
      proc.kills += 1;
      resolve({ code: null, stderr: "", noSsh: false });
    },
  };
  proc.shell = {
    start(destination, command) {
      proc.starts.push({ destination, command });
      return process;
    },
  };
  return proc;
}

const SLOW = { startTimeoutMs: 5000, stopGraceMs: 5000, exitWaitMs: 5000 };

function run(proc, options = {}) {
  const events = [];
  const { timing, ...rest } = options;
  const promise = executeOnWorker({
    shell: proc.shell,
    destination: "w",
    command: "some command",
    token: TOKEN,
    timeoutMs: 60_000,
    timing: { ...SLOW, ...timing },
    onStarted: () => events.push({ started: true }),
    onOutput: (text) => events.push(text),
    ...rest,
  });
  return { promise, events };
}

const outputOf = (events) => events.filter((event) => typeof event === "string").join("");

// ── exited ───────────────────────────────────────────────────────────────────

test("the exit marker gives the command's exit status, with its output in order and onStarted first", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  await proc.say("login banner\n");
  await proc.say(STARTED);
  await proc.say("first\n");
  await proc.say("second\n");
  await proc.say(exitText(0));
  proc.finish(OK);
  assert.deepEqual(await promise, { kind: "exited", code: 0 });
  assert.deepEqual(events[0], { started: true });
  assert.equal(events.filter((event) => typeof event === "object").length, 1);
  assert.equal(outputOf(events), "first\nsecond\n");
  assert.deepEqual(proc.starts, [{ destination: "w", command: "some command" }]);
});

test("a non-zero exit status is reported as it is", async () => {
  const proc = fakeProc();
  const { promise } = run(proc);
  await proc.say(STARTED + "boom\n" + exitText(7));
  proc.finish({ code: 0, stderr: "", noSsh: false });
  assert.deepEqual(await promise, { kind: "exited", code: 7 });
});

test("the output is the same wherever the stream is cut, even inside a marker or a multi-byte character", async () => {
  const body = "héllo ✓ 😀\nline two\n";
  const stream = Buffer.from("banner\n" + STARTED + body + exitText(3), "utf8");
  const cuts = [];
  for (let at = 0; at <= stream.length; at += 1) cuts.push([stream.subarray(0, at), stream.subarray(at)]);
  cuts.push(Array.from({ length: stream.length }, (_, i) => stream.subarray(i, i + 1)));
  for (const pieces of cuts) {
    const proc = fakeProc();
    const { promise, events } = run(proc);
    for (const piece of pieces) {
      if (piece.length > 0) await proc.say(piece);
    }
    proc.finish(OK);
    assert.deepEqual(await promise, { kind: "exited", code: 3 });
    assert.equal(outputOf(events), body);
    assert.deepEqual(events[0], { started: true });
    assert.equal(events.filter((event) => typeof event === "object").length, 1);
  }
});

// ── never started ────────────────────────────────────────────────────────────

test("no start marker and ssh refused to log in: it never started, with the reason and ssh's line", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  proc.finish({ code: 255, stderr: "Permission denied (publickey).\n", noSsh: false });
  assert.deepEqual(await promise, { kind: "no_start", reason: "auth", detail: "Permission denied (publickey)." });
  assert.deepEqual(events, []);
});

test("the nodir marker means the working directory was missing and nothing ran", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  await proc.say(`@@cody-${TOKEN}-nodir\n`);
  proc.finish(OK);
  const outcome = await promise;
  assert.equal(outcome.kind, "no_start");
  assert.match(outcome.detail, /directory is missing/);
  assert.deepEqual(events, []);
});

test("ssh ending cleanly without any marker is still a job that never started", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  await proc.say("some unrelated banner\n");
  proc.finish(OK);
  const outcome = await promise;
  assert.equal(outcome.kind, "no_start");
  assert.deepEqual(events, []);
});

test("a worker that says nothing within the start time is cut off and counts as unreachable", async () => {
  const proc = fakeProc();
  const startedAt = Date.now();
  const { promise, events } = run(proc, { timing: { startTimeoutMs: 1000 } });
  const outcome = await promise;
  assert.deepEqual(outcome, { kind: "no_start", reason: "unreachable", detail: "the job did not start within 1 s" });
  assert.equal(proc.kills, 1);
  assert.deepEqual(events, []);
  assert.ok(Date.now() - startedAt >= 900);
});

test("the start time only applies until the job says it started", async () => {
  const proc = fakeProc();
  const { promise } = run(proc, { timing: { startTimeoutMs: 60 } });
  await delay(20);
  await proc.say(STARTED);
  await delay(150);
  assert.equal(proc.kills, 0);
  await proc.say("late output" + exitText(0));
  proc.finish(OK);
  assert.deepEqual(await promise, { kind: "exited", code: 0 });
  assert.equal(proc.kills, 0);
});

// ── dropped ──────────────────────────────────────────────────────────────────

test("started, then the connection ends without an exit marker: dropped, and what was printed was delivered", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  await proc.say(STARTED + "partial output");
  proc.finish({ code: 255, stderr: "Connection to x closed by remote host.\n", noSsh: false });
  assert.deepEqual(await promise, { kind: "dropped", reason: "dropped", detail: "Connection to x closed by remote host." });
  assert.equal(outputOf(events), "partial output");
});

test("output held back as a possible marker is delivered when the connection drops", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  await proc.say(STARTED + "work done\n@@cody-");
  proc.finish({ code: 255, stderr: "Connection to x closed by remote host.\n", noSsh: false });
  assert.equal((await promise).kind, "dropped");
  assert.equal(outputOf(events), "work done\n@@cody-");
});

test("ssh killed (no exit code) after the start is a drop too", async () => {
  const proc = fakeProc();
  const { promise, events } = run(proc);
  await proc.say(STARTED + "before\n");
  proc.finish({ code: null, stderr: "", noSsh: false });
  const outcome = await promise;
  assert.equal(outcome.kind, "dropped");
  assert.ok(outcome.detail.length > 0);
  assert.equal(outputOf(events), "before\n");
});

// ── time limit ───────────────────────────────────────────────────────────────

test("the time limit counts from the start marker, then ssh's stdin is closed (never written to)", async () => {
  const proc = fakeProc();
  const { promise } = run(proc, { timeoutMs: 100, timing: { startTimeoutMs: 1000, stopGraceMs: 1000, exitWaitMs: 1000 } });
  await delay(120);
  assert.equal(proc.stdinLog.ends.length, 0, "no stop before the job even started");
  await proc.say(STARTED);
  const markerAt = Date.now();
  await delay(40);
  assert.equal(proc.stdinLog.ends.length, 0, "the limit has not run out yet");
  await until(() => proc.stdinLog.ends.length > 0);
  assert.ok(proc.stdinLog.ends[0] - markerAt >= 80, "the limit is counted from the marker");
  assert.equal(proc.kills, 0, "ssh is not cut while the far side may still be stopping the job");
  await proc.say("terminated\n" + exitText(143));
  proc.finish(OK);
  assert.deepEqual(await promise, { kind: "timeout", code: 143 });
  assert.equal(proc.stdinLog.writes, 0);
  assert.equal(proc.stdinLog.data, 0);
  assert.equal(proc.kills, 0);
});

test("if the far side never confirms the stop, ssh is cut after the grace period", async () => {
  const proc = fakeProc();
  const { promise } = run(proc, { timeoutMs: 60, timing: { stopGraceMs: 120 } });
  await proc.say(STARTED + "still going\n");
  await until(() => proc.stdinLog.ends.length > 0);
  await delay(40);
  assert.equal(proc.kills, 0, "not before the grace period");
  await until(() => proc.kills > 0);
  assert.deepEqual(await promise, { kind: "timeout", code: null });
  assert.equal(proc.kills, 1);
  assert.equal(proc.stdinLog.writes, 0);
});

// ── cancel ───────────────────────────────────────────────────────────────────

test("cancelling before the start marker cuts ssh at once", async () => {
  const proc = fakeProc();
  const controller = new AbortController();
  const { promise } = run(proc, { signal: controller.signal });
  await delay(20);
  controller.abort();
  assert.deepEqual(await promise, { kind: "cancelled" });
  assert.equal(proc.kills, 1);
});

test("cancelling a started job closes stdin instead of killing ssh, and cancel wins over a later exit marker", async () => {
  const proc = fakeProc();
  const controller = new AbortController();
  const { promise } = run(proc, { signal: controller.signal });
  await proc.say(STARTED + "working\n");
  controller.abort();
  assert.equal(proc.stdinLog.ends.length, 1, "stdin was closed by the cancel");
  await delay(40);
  assert.equal(proc.kills, 0);
  await proc.say(exitText(143));
  proc.finish(OK);
  assert.deepEqual(await promise, { kind: "cancelled" });
  assert.equal(proc.kills, 0);
  assert.equal(proc.stdinLog.writes, 0);
});

test("a signal that is already aborted gives 'cancelled' without hanging", async () => {
  const proc = fakeProc();
  const controller = new AbortController();
  controller.abort();
  const { promise } = run(proc, { signal: controller.signal });
  const result = await Promise.race([promise, delay(1500).then(() => "hung")]);
  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(proc.kills, 1);
});

// ── ssh that does not end ────────────────────────────────────────────────────

test("after the exit marker ssh gets a moment to end by itself, then it is cut; the outcome stays 'exited'", async () => {
  const proc = fakeProc();
  const { promise } = run(proc, { timing: { exitWaitMs: 100 } });
  await proc.say(STARTED + "done\n" + exitText(5));
  await delay(30);
  assert.equal(proc.kills, 0);
  await until(() => proc.kills > 0);
  assert.deepEqual(await promise, { kind: "exited", code: 5 });
  assert.equal(proc.kills, 1);
});

// ── cleanliness ──────────────────────────────────────────────────────────────

const timerCount = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("every way out ends ssh's stdin and leaves no timer that could cut ssh later", async () => {
  const timing = { startTimeoutMs: 60, stopGraceMs: 60, exitWaitMs: 60 };
  const scenarios = {
    exited: async (proc) => {
      await proc.say(STARTED + "x" + exitText(0));
      proc.finish(OK);
    },
    dropped: async (proc) => {
      await proc.say(STARTED + "x");
      proc.finish({ code: 255, stderr: "Connection to w closed by remote host.\n", noSsh: false });
    },
    no_start: async (proc) => {
      proc.finish({ code: 255, stderr: "Permission denied (publickey).\n", noSsh: false });
    },
    cancelled: async (proc, controller) => {
      await proc.say(STARTED + "x");
      controller.abort();
      await proc.say(exitText(143));
      proc.finish(OK);
    },
    timeout: async (proc) => {
      await proc.say(STARTED + "x");
      await until(() => proc.stdinLog.ends.length > 0);
      await proc.say(exitText(143));
      proc.finish(OK);
    },
  };
  for (const [name, script] of Object.entries(scenarios)) {
    const proc = fakeProc();
    const controller = new AbortController();
    const timersBefore = timerCount();
    const { promise } = run(proc, { timeoutMs: 60, timing, signal: controller.signal });
    await script(proc, controller);
    const outcome = await promise;
    assert.equal(outcome.kind, name);
    assert.ok(proc.stdinLog.ends.length >= 1, `${name}: stdin ended`);
    assert.ok(timerCount() <= timersBefore, `${name}: no timer left`);
    const killsAtReturn = proc.kills;
    await delay(150);
    assert.equal(proc.kills, killsAtReturn, `${name}: nothing cut ssh after the call returned`);
  }
});

// ── Part 2: the real script ──────────────────────────────────────────────────

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-execute-")));
const workRoot = `${base}/work`;
mkdirSync(workRoot);
const sandbox = localShell({
  behave: (call) => (call.kind === "exec" && call.destination === "drop" ? { dropAfterStartedMs: 100 } : undefined),
});
after(() => {
  sandbox.stop();
  rmSync(base, { recursive: true, force: true });
});

function makeJob() {
  const directory = jobDirectory(workRoot, newJobId());
  mkdirSync(directory, { recursive: true });
  return directory;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // a process that ended but has not been collected yet is not running either
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

async function readPid(file) {
  await until(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "", 3000);
  return Number.parseInt(readFileSync(file, "utf8").trim(), 10);
}

async function assertGone(pid) {
  await until(() => !alive(pid), 7000);
}

function runReal({ directory, command, timeoutMs = 20_000, signal, destination = "w", onStarted, onOutput, cwdRel = "" }) {
  const token = newToken();
  const output = [];
  const promise = executeOnWorker({
    shell: sandbox.shell,
    destination,
    command: buildExecCommand({ directory, cwdRel, command, token }),
    token,
    timeoutMs,
    signal,
    onStarted,
    onOutput: onOutput ?? ((text) => output.push(text)),
  });
  return { promise, output };
}

test("real script: stdout and stderr arrive merged in order, and the exit status is the command's", async () => {
  const directory = makeJob();
  const { promise, output } = runReal({ directory, command: "echo hi; echo err 1>&2; exit 4" });
  assert.deepEqual(await promise, { kind: "exited", code: 4 });
  assert.equal(output.join(""), "hi\nerr\n");
});

test("real script: the command runs in the job's working directory", async () => {
  const directory = makeJob();
  mkdirSync(`${directory}/pkg/app`, { recursive: true });
  const { promise, output } = runReal({ directory, cwdRel: "pkg/app", command: "pwd" });
  assert.deepEqual(await promise, { kind: "exited", code: 0 });
  assert.equal(output.join(""), `${directory}/pkg/app\n`);
});

test("real script: a missing job directory means the job never started", async () => {
  const directory = jobDirectory(workRoot, newJobId());
  let started = false;
  const { promise, output } = runReal({ directory, command: "echo should not run", onStarted: () => (started = true) });
  const outcome = await promise;
  assert.equal(outcome.kind, "no_start");
  assert.match(outcome.detail, /directory is missing/);
  assert.equal(started, false);
  assert.deepEqual(output, []);
});

test("real script: a time limit stops the job's process", async () => {
  const directory = makeJob();
  const startedAt = Date.now();
  const { promise } = runReal({ directory, command: "echo $$ > pidfile; exec sleep 30", timeoutMs: 500 });
  const outcome = await promise;
  assert.equal(outcome.kind, "timeout");
  assert.ok(Date.now() - startedAt < 5000, "the stop did not wait for the five-second fallback");
  await assertGone(await readPid(`${directory}/pidfile`));
});

test("real script: cancelling a started job stops its process and reports 'cancelled'", async () => {
  const directory = makeJob();
  const controller = new AbortController();
  const startedAt = Date.now();
  const { promise } = runReal({ directory, command: "echo $$ > pidfile; exec sleep 30", signal: controller.signal });
  const pid = await readPid(`${directory}/pidfile`);
  assert.equal(alive(pid), true);
  controller.abort();
  assert.deepEqual(await promise, { kind: "cancelled" });
  assert.ok(Date.now() - startedAt < 5000);
  await assertGone(pid);
});

test("real script: when the connection vanishes mid-run the outcome is 'dropped' and the job is still stopped", async () => {
  const directory = makeJob();
  const { promise } = runReal({ directory, destination: "drop", command: "echo $$ > pidfile; exec sleep 30" });
  const outcome = await promise;
  assert.equal(outcome.kind, "dropped");
  assert.equal(outcome.reason, "dropped");
  await assertGone(await readPid(`${directory}/pidfile`));
});

test("real script: 5 MB of output arrives complete", async () => {
  const directory = makeJob();
  let bytes = 0;
  let wrong = 0;
  const { promise } = runReal({
    directory,
    command: "i=0; while [ $i -lt 5 ]; do head -c 1048576 /dev/zero | tr '\\000' a; i=$((i+1)); done",
    onOutput: (text) => {
      bytes += Buffer.byteLength(text);
      if (!/^a*$/.test(text)) wrong += 1;
    },
  });
  assert.deepEqual(await promise, { kind: "exited", code: 0 });
  assert.equal(bytes, 5 * 1024 * 1024);
  assert.equal(wrong, 0);
});

test("real script: a background process the command leaves behind is stopped when the command ends", async () => {
  const directory = makeJob();
  const { promise } = runReal({ directory, command: "sleep 30 & echo $! > bgpid; exit 0" });
  assert.deepEqual(await promise, { kind: "exited", code: 0 });
  await assertGone(await readPid(`${directory}/bgpid`));
});
