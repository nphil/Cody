import { execFileSync } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { localShell } from "./local-shell.mjs";

const jiti = createJiti(import.meta.url);
const { runWorkerJob, DEFAULT_JOB_TIMING } = await jiti.import("./run.ts");
const { runLocalCommand } = await jiti.import("./local.ts");

/**
 * One `run_on_worker` call from start to result. The "worker" is this machine:
 * the REAL generated scripts (copy in with tar, the wrapper that runs the
 * command with its markers and dead-man's switch, copy back, cleanup) run for
 * real through lib/workers/local-shell.mjs, which can also make a worker
 * refuse, go silent or vanish mid-run; only the scheduler is a script. What
 * matters: the command runs in a COPY and its results come home; whatever
 * goes wrong, the agent is told exactly what happened and nothing that is not
 * the command's own finished answer is ever reported as success (a lost run is
 * run once more elsewhere, a second loss is an error, a result file that was
 * not produced makes exit 0 incomplete); every slot is given back and no copy
 * is left behind; cancel and the time limit really stop the process.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-run-")));
const cleanups = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(base, { recursive: true, force: true });
});

/** Short waits so a test about a silent worker does not take a minute. */
const FAST = { ...DEFAULT_JOB_TIMING, startTimeoutMs: 5_000, stopGraceMs: 2_000, exitWaitMs: 1_000, stallMs: 1_000, cleanupTimeoutMs: 20_000 };

function worker(id, label) {
  return { id, label, destination: `root@${id}`, facts: { name: id, arch: "x86_64", cpus: 8, memMB: 16384, slots: 2, tools: ["node"], onlyWhenIdle: false } };
}

const ALPHA = worker("w1", "Alpha");
const BETA = worker("w2", "Beta");
const ALPHA_NAME = 'worker "Alpha" (x86_64, 8 cores)';
const BETA_NAME = 'worker "Beta" (x86_64, 8 cores)';

/**
 * A scripted scheduler. `answer(n, request, options)` says what the n-th ask
 * gets: `{ worker }`, `{ local: why }`, `{ refused: why }` or `{ aborted: true }`
 * (or a promise of one). Every ask and every lease is recorded.
 */
function scheduler(answer) {
  const asked = [];
  const leases = [];
  return {
    asked,
    leases,
    async acquire(request, options) {
      asked.push({ arch: request.arch, tools: [...request.tools], excluded: [...request.excluded].sort(), local: request.local });
      const given = await answer(asked.length - 1, request, options);
      if (given.worker) {
        const lease = {
          machine: given.worker,
          released: 0,
          release() {
            lease.released += 1;
          },
        };
        leases.push(lease);
        return { kind: "worker", lease, waitedMs: given.waitedMs ?? 0, freeCores: 4 };
      }
      if (given.local) return { kind: "local", why: given.local, waitedMs: given.waitedMs ?? 0 };
      if (given.refused) return { kind: "refused", why: given.refused, waitedMs: 0 };
      return { kind: "aborted" };
    },
  };
}

const always = (machine) => scheduler(() => ({ worker: machine }));

let seq = 0;

/**
 * A project (with a heavy directory that must stay home), a worker disk, a scratch folder, a scripted worker.
 * `git`: the project is a git repository whose .gitignore leaves the heavy directory out (a job's copy is then
 * the whole repository, whichever directory the command runs in); otherwise the working directory is the whole project.
 */
function rig({ behave, git = false } = {}) {
  const dir = join(base, `case-${++seq}`);
  const project = join(dir, "project");
  const workRoot = join(dir, "work");
  const scratch = join(dir, "scratch");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "node_modules", "dep"), { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(project, "src", "input.txt"), "hello\n");
  writeFileSync(join(project, "node_modules", "dep", "index.js"), "// heavy\n");
  if (git) {
    writeFileSync(join(project, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
  }
  const remote = localShell({ behave });
  cleanups.push(() => remote.stop());
  return { dir, project, workRoot, scratch, remote };
}

async function run(r, request, { sched, signal, onProgress, deps } = {}) {
  return runWorkerJob(
    { results: [], arch: null, tools: [], timeoutMs: 60_000, fallbackLocal: true, ...request },
    { cwd: r.project, sessionId: "s-test", scratchDir: r.scratch, signal, onProgress },
    {
      scheduler: sched,
      shell: r.remote.shell,
      workRoot: r.workRoot,
      localFit: () => ({ ok: true }),
      runLocal: runLocalCommand,
      timing: FAST,
      now: () => Date.now(),
      ...deps,
    },
  );
}

async function waitFor(condition, ms = 5_000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) assert.fail("timed out waiting for the test condition");
    await sleep(20);
  }
}

/** The process has ended (the stopped job must not run on). */
async function assertGone(pidFile) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 1, "the command wrote its pid");
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }, 8_000);
}

/** Every slot was given back and no copy of the project is left on the worker. */
function assertTidy(r, sched) {
  assert.deepEqual(readdirSync(r.workRoot), [], "no job directory is left on the worker");
  assert.ok(sched.leases.length > 0, "a worker was used");
  for (const lease of sched.leases) assert.ok(lease.released >= 1, `the slot of ${lease.machine.id} was given back`);
}

/** The path the result names for the whole output, and what is in it. */
function loggedOutput(out) {
  const match = /Whole output: (\S+\.log)/.exec(out.text);
  assert.ok(match, `the result names the output file:\n${out.text}`);
  return { path: match[1], content: readFileSync(match[1], "utf8") };
}

// ── A job that works ─────────────────────────────────────────────────────────

test("a job that works: the command runs in a copy, its results come home, the copy is deleted", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(
    r,
    {
      command: "pwd; ls; cat src/input.txt > out.txt; mkdir -p dist && echo built > dist/app.js; echo junk > junk.txt; echo done",
      results: ["out.txt", "dist"],
    },
    { sched },
  );

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith(`Exit code 0: the command succeeded on ${ALPHA_NAME} in `), out.text);
  assert.match(out.text, /Results: 2 files \(\d+ B\) copied back into the workspace\./);
  assert.match(out.text, /Timing: copied 2 files \(.+\) to the worker in .+, ran .+, copied the results back in .+; .+ in all\./);

  // It ran in the copy on the worker, which holds the project but not the heavy directory.
  assert.ok(out.text.includes(`${r.workRoot}/j-`), "pwd shows the job directory on the worker");
  assert.ok(out.text.includes("package.json"));
  assert.ok(!out.text.includes("node_modules"), "the heavy directory stayed home");

  // Only what was asked for came back.
  assert.equal(readFileSync(join(r.project, "out.txt"), "utf8"), "hello\n");
  assert.equal(readFileSync(join(r.project, "dist", "app.js"), "utf8"), "built\n");
  assert.equal(existsSync(join(r.project, "junk.txt")), false);

  // The whole output is in a file under the chat's scratch folder.
  const log = loggedOutput(out);
  assert.ok(log.path.startsWith(join(r.scratch, "workers")), log.path);
  assert.ok(log.content.endsWith("done\n"));
  assert.match(log.content, /package\.json\nsrc\n/);

  assert.deepEqual(r.remote.calls.map((call) => call.kind), ["in", "exec", "back", "cleanup"]);
  assert.ok(r.remote.calls.every((call) => call.destination === "root@w1"));
  assertTidy(r, sched);
});

test("in a git repository the whole repository is copied and cwd picks where the command runs; results are relative to cwd", async () => {
  const r = rig({ git: true });
  const sched = always(ALPHA);
  const out = await run(r, { command: "pwd; ls ..; cat input.txt > copy.txt", cwd: "src", results: ["copy.txt"] }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes(`${r.workRoot}/j-`) && /\/src\n/.test(out.text), "ran in the src directory of the copy");
  assert.ok(out.text.includes("package.json"), "the whole repository was copied, not only src");
  assert.ok(!out.text.includes("node_modules"), "what .gitignore leaves out stays home");
  assert.equal(readFileSync(join(r.project, "src", "copy.txt"), "utf8"), "hello\n");
  assert.equal(existsSync(join(r.project, "copy.txt")), false);
  assertTidy(r, sched);
});

test("outside git the working directory is the whole project", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "pwd; ls; cat input.txt > copy.txt", cwd: "src", results: ["copy.txt"] }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /Output \(2 lines\):\n\S+\/j-[a-z0-9]+-[0-9a-f]+\ninput\.txt/);
  assert.ok(!out.text.includes("package.json"), "only src was copied");
  assert.equal(readFileSync(join(r.project, "src", "copy.txt"), "utf8"), "hello\n");
  assertTidy(r, sched);
});

test("a failing command still brings its results home, but the result is an error with its exit code", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo partial > out.txt; echo oops 1>&2; exit 3", results: ["out.txt"] }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith(`Exit code 3: the command failed on ${ALPHA_NAME} after `), out.text);
  assert.ok(out.text.includes("oops"), "stderr is part of the output");
  assert.equal(readFileSync(join(r.project, "out.txt"), "utf8"), "partial\n");
  assertTidy(r, sched);
});

test("the result shows the last 200 lines; the output file has all of them", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "seq 1 1000" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes("Last 200 lines (of 1,000):"), out.text);
  assert.ok(out.text.includes("\n801\n") && out.text.endsWith("\n1000"));
  assert.ok(!out.text.includes("\n800\n"));
  const log = loggedOutput(out);
  assert.equal(log.content.split("\n").length, 1001, "the file holds every line");
  assert.ok(log.content.startsWith("1\n2\n3\n"));
  assertTidy(r, sched);
});

test("a command that reads its input gets the end of the input at once instead of hanging", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "cat; echo after-cat" }, { sched });
  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes("after-cat"));
});

// ── Stopping a command ───────────────────────────────────────────────────────

test("the time limit stops the command and its process, and no results are copied back", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const pidFile = join(r.dir, "pid");
  const out = await run(
    r,
    { command: `echo before > out.txt; echo started; echo $$ > ${pidFile}; exec sleep 30`, results: ["out.txt"], timeoutMs: 1_000 },
    { sched },
  );

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("Stopped after "), out.text);
  assert.ok(out.text.includes(`the command was still running when its time limit (1 s) ran out, so Cody ended it on ${ALPHA_NAME}.`), out.text);
  assert.ok(out.text.includes("No result files were copied back."));
  assert.ok(out.text.includes("started"), "what it printed before is still shown");
  assert.equal(existsSync(join(r.project, "out.txt")), false);
  assert.equal(r.remote.of("back").length, 0);
  await assertGone(pidFile);
  assertTidy(r, sched);
});

test("cancelling while the command runs stops it on the worker and cleans up", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const pidFile = join(r.dir, "pid");
  const ready = join(r.dir, "ready");
  const controller = new AbortController();
  const pending = run(r, { command: `echo $$ > ${pidFile}; touch ${ready}; exec sleep 30`, results: ["out.txt"] }, { sched, signal: controller.signal });
  await waitFor(() => existsSync(ready));
  controller.abort();
  const out = await pending;

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith(`Cancelled on ${ALPHA_NAME}: the command was stopped`), out.text);
  assert.equal(r.remote.of("back").length, 0, "nothing is brought back from a cancelled job");
  await assertGone(pidFile);
  assertTidy(r, sched);
});

test("cancelling while waiting for a worker never touches a machine", async () => {
  const r = rig();
  const controller = new AbortController();
  const sched = scheduler(async (n, request, options) => {
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    return { aborted: true };
  });
  const pending = run(r, { command: "echo never" }, { sched, signal: controller.signal });
  await sleep(50);
  controller.abort();
  const out = await pending;

  assert.equal(out.isError, true);
  assert.equal(out.text, "Cancelled while waiting for a worker: the command was never started.");
  assert.equal(r.remote.calls.length, 0);
});

test("cancelling while the project is being copied says the command never started", async () => {
  const r = rig({ behave: (call) => (call.kind === "in" ? { hang: true } : undefined) });
  const sched = always(ALPHA);
  const controller = new AbortController();
  const pending = run(r, { command: "echo never" }, { sched, signal: controller.signal });
  await waitFor(() => r.remote.of("in").length === 1);
  controller.abort();
  const out = await pending;

  assert.equal(out.isError, true);
  assert.equal(out.text, `Cancelled while the project was being copied to ${ALPHA_NAME}: the command was never started.`);
  assert.equal(r.remote.of("exec").length, 0);
  assert.equal(r.remote.of("cleanup").length, 1, "a half-made copy is still cleaned up");
  assert.ok(sched.leases.every((lease) => lease.released >= 1));
});

test("a call that was already cancelled starts nothing", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const controller = new AbortController();
  controller.abort();
  const out = await run(r, { command: "echo never" }, { sched, signal: controller.signal });
  assert.equal(out.isError, true);
  assert.match(out.text, /Cancelled/);
  assert.equal(sched.asked.length, 0);
  assert.equal(r.remote.calls.length, 0);
});

// ── A worker that fails before the command starts ────────────────────────────

test("a worker that refuses the copy is skipped: the next worker runs the job and the agent is told", async () => {
  const r = rig({
    behave: (call) => (call.destination === "root@w1" && call.kind === "in" ? { fail: { stderr: "ssh: connect to host w1 port 22: Connection refused" } } : undefined),
  });
  const sched = scheduler((n) => ({ worker: n === 0 ? ALPHA : BETA }));
  const out = await run(r, { command: "echo ran-here" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith(`Exit code 0: the command succeeded on ${BETA_NAME} in `), out.text);
  assert.ok(out.text.includes(`${ALPHA_NAME} could not take the project: the machine refused the connection`), out.text);
  assert.deepEqual(sched.asked.map((ask) => ask.excluded), [[], ["w1"]], "the failed machine is not asked for again");
  assert.deepEqual(r.remote.of("exec").map((call) => call.destination), ["root@w2"]);
  assertTidy(r, sched);
});

test("a worker that does not start the command (login refused) is skipped too", async () => {
  const r = rig({
    behave: (call) => (call.destination === "root@w1" && call.kind === "exec" ? { fail: { stderr: "root@w1: Permission denied (publickey)." } } : undefined),
  });
  const sched = scheduler((n) => ({ worker: n === 0 ? ALPHA : BETA }));
  const out = await run(r, { command: "echo ran-here" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes(`${ALPHA_NAME} did not start the command: ssh login was refused`), out.text);
  assert.ok(out.text.includes(`on ${BETA_NAME}`));
  assertTidy(r, sched);
});

test("a worker that never says the command started is given up on after the start timeout", async () => {
  const r = rig({ behave: (call) => (call.destination === "root@w1" && call.kind === "exec" ? { hang: true } : undefined) });
  const sched = scheduler((n) => ({ worker: n === 0 ? ALPHA : BETA }));
  const out = await run(r, { command: "echo ran-here" }, { sched, deps: { timing: { ...FAST, startTimeoutMs: 300 } } });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes(`${ALPHA_NAME} did not start the command: the machine did not answer`), out.text);
  assert.ok(out.text.includes(`on ${BETA_NAME}`));
  assertTidy(r, sched);
});

test("when the only worker fails before the command started and nothing is left, the job is not run and says why", async () => {
  const r = rig({ behave: (call) => (call.kind === "in" ? { fail: { stderr: "ssh: connect to host w1 port 22: Connection refused" } } : undefined) });
  const sched = scheduler((n) => (n === 0 ? { worker: ALPHA } : { refused: "no other worker is available" }));
  const out = await run(r, { command: "echo never", fallbackLocal: false }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("No worker could take this job, and it was not run: no other worker is available."), out.text);
  assert.ok(out.text.includes(`${ALPHA_NAME} could not take the project`));
  assert.ok(out.text.includes("fallbackLocal is false, so it was not run on this server either."));
  assert.equal(r.remote.of("exec").length, 0);
});

// ── A worker that goes away while the command runs ───────────────────────────

const dropAlpha = (call) => (call.destination === "root@w1" && call.kind === "exec" ? { dropAfterStartedMs: 200 } : undefined);

test("a worker that vanishes mid-run: the command runs once more on another worker, and the lost run is reported", async () => {
  const r = rig({ behave: dropAlpha });
  const sched = scheduler((n) => ({ worker: n === 0 ? ALPHA : BETA }));
  const out = await run(r, { command: "echo begin; sleep 1; echo end" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith(`Exit code 0: the command succeeded on ${BETA_NAME} in `), out.text);
  const note = /Alpha" \(x86_64, 8 cores\) went away while the command was running, after .+ \(the connection dropped \(Connection to root@w1 closed by remote host\.\)\), so that run was lost and no result files were copied\. Its output until then \(1 line\) is in (\S+\.log)\. Cody ran the command again from the start\./.exec(out.text);
  assert.ok(note, out.text);

  // The lost run's output was kept in its own file; the final output is the second run's.
  assert.equal(readFileSync(note[1], "utf8"), "begin\n");
  const final = loggedOutput(out);
  assert.notEqual(final.path, note[1]);
  assert.equal(final.content, "begin\nend\n");
  assert.ok(out.text.includes("Output (2 lines):\nbegin\nend"));
  assert.ok(!out.text.includes("lost run"), "the output shown belongs to the run that finished");

  assert.deepEqual(sched.asked.map((ask) => ask.excluded), [[], ["w1"]]);
  assertTidy(r, sched);
});

test("a lost run can be repeated on this server when no other worker is there; the files stay in the workspace", async () => {
  const r = rig({ behave: dropAlpha });
  const sched = scheduler((n) => (n === 0 ? { worker: ALPHA } : { local: "no other worker has what the job needs" }));
  const out = await run(r, { command: "echo begin; sleep 1; echo end > made.txt; echo end" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith("Exit code 0: the command succeeded on this server instead of a worker (no other worker has what the job needs)."), out.text);
  assert.ok(out.text.includes("went away while the command was running"));
  assert.equal(readFileSync(join(r.project, "made.txt"), "utf8"), "end\n");
  assert.equal(sched.asked[1].local, true);
  assertTidy(r, sched);
});

test("losing the command twice is an error: it is not run a third time and nothing is reported as its result", async () => {
  const r = rig({ behave: (call) => (call.kind === "exec" ? { dropAfterStartedMs: 150 } : undefined) });
  const sched = scheduler((n) => ({ worker: n === 0 ? ALPHA : BETA }));
  const out = await run(r, { command: "echo begin; sleep 1; echo end", results: ["out.txt"] }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("Failed: the command was cut off before it finished twice (see below), so Cody did not run it a third time. Nothing here is a result of the command."), out.text);
  assert.ok(out.text.includes(`${ALPHA_NAME} went away`) && out.text.includes(`${BETA_NAME} went away`), "both losses are told");
  assert.ok(out.text.includes("lost run"), "the output shown is labelled as a lost run's");
  assert.equal(sched.asked.length, 2);
  assert.equal(r.remote.of("back").length, 0);
  assertTidy(r, sched);
});

test("after a loss with no worker left, the refusal says the first run was lost", async () => {
  const r = rig({ behave: dropAlpha });
  const sched = scheduler((n) => (n === 0 ? { worker: ALPHA } : { refused: "every other worker is down" }));
  const out = await run(r, { command: "echo begin; sleep 1; echo end", fallbackLocal: false }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("Failed: the first run was lost (see below) and no worker could take the job again: every other worker is down."), out.text);
  assert.ok(out.text.includes("fallbackLocal is false, so it was not run on this server either."));
  assert.ok(out.text.includes("went away while the command was running"));
  assertTidy(r, sched);
});

// ── Bringing the results home ────────────────────────────────────────────────

test("copying the results back is retried once, and the agent is told", async () => {
  const r = rig({ behave: (call) => (call.kind === "back" && call.index === 0 ? { fail: { stderr: "Connection to root@w1 closed by remote host." } } : undefined) });
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo made > out.txt", results: ["out.txt"] }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes("Copying the results back failed once ("), out.text);
  assert.ok(out.text.includes("Cody tried again."));
  assert.equal(r.remote.of("back").length, 2);
  assert.equal(readFileSync(join(r.project, "out.txt"), "utf8"), "made\n");
  assertTidy(r, sched);
});

test("results that cannot be brought back make a successful command an incomplete job", async () => {
  const r = rig({ behave: (call) => (call.kind === "back" ? { fail: { stderr: "Connection to root@w1 closed by remote host." } } : undefined) });
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo made > out.txt", results: ["out.txt"] }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith(`Exit code 0, but the job is NOT complete: the result files could not be copied back. The command succeeded on ${ALPHA_NAME} in `), out.text);
  assert.ok(out.text.includes("Results: copying them back FAILED:"));
  assert.equal(r.remote.of("back").length, 2, "tried twice, not more");
  assert.equal(existsSync(join(r.project, "out.txt")), false);
  assertTidy(r, sched);
});

test("a result path the command did not produce makes exit 0 incomplete, and the others still arrive", async () => {
  const r = rig({ git: true });
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo made > out.txt", cwd: "src", results: ["out.txt", "dist"] }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith(`Exit code 0, but the job is NOT complete: these requested result paths were not produced: dist. The command succeeded on ${ALPHA_NAME} in `), out.text);
  assert.ok(out.text.includes("Not found on the worker: dist."), "paths are shown as the agent wrote them (relative to cwd)");
  assert.equal(readFileSync(join(r.project, "src", "out.txt"), "utf8"), "made\n");
  assertTidy(r, sched);
});

test("when none of the requested results exist the agent is told so", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "true", results: ["dist", "build/app"] }, { sched });

  assert.equal(out.isError, true);
  assert.ok(out.text.includes("Results: none of the requested paths exist on the worker (build/app, dist); nothing was copied back."), "listed in sorted order, as the agent wrote them");
  assertTidy(r, sched);
});

// ── On this server instead ───────────────────────────────────────────────────

test("when every worker is busy the command runs in the workspace and the result says so", async () => {
  const r = rig();
  const sched = scheduler(() => ({ local: "every worker is busy", waitedMs: 2_500 }));
  const out = await run(r, { command: "echo here > made.txt; pwd", results: ["made.txt"], arch: "x86_64", tools: ["node"] }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith("Exit code 0: the command succeeded on this server instead of a worker (every worker is busy)."), out.text);
  assert.ok(out.text.includes(`Nothing was copied: the command ran in ${r.project}, so its files are already in the workspace.`));
  assert.ok(out.text.includes("The `results` paths were not copied: the command ran in place"));
  assert.match(out.text, /Timing: waited 2\.5 s, ran .+; .+ in all\./);
  assert.ok(out.text.includes(r.project), "pwd shows the workspace itself");
  assert.equal(readFileSync(join(r.project, "made.txt"), "utf8"), "here\n");
  assert.equal(r.remote.calls.length, 0, "no machine was touched");
  assert.deepEqual(sched.asked, [{ arch: "x86_64", tools: ["node"], excluded: [], local: true }]);
});

test("a command that fails on this server is an error with its exit code", async () => {
  const r = rig();
  const sched = scheduler(() => ({ local: "every worker is busy" }));
  const out = await run(r, { command: "echo bad; exit 2" }, { sched });
  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("Exit code 2: the command failed on this server instead of a worker (every worker is busy)."), out.text);
  assert.ok(out.text.includes("bad"));
});

test("the time limit and cancel work on this server too", async () => {
  const r = rig();
  const sched = scheduler(() => ({ local: "every worker is busy" }));

  const slow = await run(r, { command: "echo started; sleep 30", timeoutMs: 1_000 }, { sched });
  assert.equal(slow.isError, true);
  assert.ok(slow.text.startsWith("Stopped after "), slow.text);
  assert.ok(slow.text.includes("time limit (1 s) ran out, so Cody ended it on this server instead of a worker (every worker is busy)."));
  assert.ok(slow.text.includes("started"));

  const ready = join(r.dir, "ready");
  const controller = new AbortController();
  const pending = run(r, { command: `touch ${ready}; sleep 30` }, { sched, signal: controller.signal });
  await waitFor(() => existsSync(ready));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.text.split("\n")[0], "Cancelled on this server: the command was stopped. Files it had already written stay in the workspace.");
});

test("a command that could not be started here, or was killed by a signal, is an error", async () => {
  const r = rig();
  const sched = scheduler(() => ({ local: "every worker is busy" }));
  const result = (over) => ({ code: 0, signal: null, timedOut: false, aborted: false, startError: null, ...over });

  const noStart = await run(r, { command: "x" }, { sched, deps: { runLocal: async () => result({ code: null, startError: "spawn sh ENOENT" }) } });
  assert.deepEqual(noStart, { text: "The command could not be started on this server: spawn sh ENOENT", isError: true });

  const killed = await run(r, { command: "x" }, { sched, deps: { runLocal: async () => result({ code: null, signal: "SIGKILL" }) } });
  assert.equal(killed.isError, true);
  assert.ok(killed.text.startsWith("The command was stopped by signal SIGKILL on this server instead of a worker (every worker is busy)."), killed.text);
});

// ── Nobody can take it ───────────────────────────────────────────────────────

test("no worker and nowhere to run it here: the job is not run, and the result says what was tried", async () => {
  const r = rig();
  const checked = [];
  const sched = scheduler(() => ({ refused: "no worker has rust" }));
  const out = await run(r, { command: "cargo build", tools: ["rust"], arch: "aarch64" }, {
    sched,
    deps: {
      localFit: (request) => {
        checked.push(request);
        return { ok: false, why: "this server does not have rust" };
      },
    },
  });

  assert.equal(out.isError, true);
  assert.equal(out.text, "No worker could take this job, and it was not run: no worker has rust.\nIt could not run on this server instead: this server does not have rust.");
  assert.deepEqual(checked.map((request) => ({ arch: request.arch, tools: [...request.tools] })), [{ arch: "aarch64", tools: ["rust"] }]);
  assert.deepEqual(sched.asked, [{ arch: "aarch64", tools: ["rust"], excluded: [], local: false }], "the scheduler is told this server cannot run it");
  assert.equal(r.remote.calls.length, 0);
});

test("fallbackLocal off: this server is never considered", async () => {
  const r = rig();
  let consulted = 0;
  const sched = scheduler(() => ({ refused: "every worker is busy" }));
  const out = await run(r, { command: "make", fallbackLocal: false }, {
    sched,
    deps: {
      localFit: () => {
        consulted += 1;
        return { ok: true };
      },
    },
  });

  assert.equal(out.isError, true);
  assert.equal(out.text, "No worker could take this job, and it was not run: every worker is busy.\nfallbackLocal is false, so it was not run on this server either.");
  assert.equal(consulted, 0);
  assert.equal(sched.asked[0].local, false);
});

test("arguments that cannot be run start nothing: no scheduler ask, no machine touched", async () => {
  const r = rig();
  const sched = always(ALPHA);

  const outside = await run(r, { command: "echo x", cwd: "../elsewhere" }, { sched });
  assert.equal(outside.isError, true);

  const escape = await run(r, { command: "echo x", results: ["../outside.txt"] }, { sched });
  assert.equal(escape.isError, true);
  assert.ok(escape.text.includes("../outside.txt"), escape.text);

  const emptyInclude = await run(r, { command: "echo x", include: [""] }, { sched });
  assert.equal(emptyInclude.isError, true);

  assert.equal(sched.asked.length, 0);
  assert.equal(r.remote.calls.length, 0);
});

// ── What goes wrong around the job ───────────────────────────────────────────

test("a copy that could not be deleted is reported with its place, but the result stands", async () => {
  const r = rig({ behave: (call) => (call.kind === "cleanup" ? { fail: { stderr: "Connection to root@w1 closed by remote host." } } : undefined) });
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo ok" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith(`Exit code 0: the command succeeded on ${ALPHA_NAME}`));
  assert.ok(out.text.includes(`The copy of the project on ${ALPHA_NAME} could not be deleted (the connection dropped`), out.text);
  assert.ok(out.text.includes(`it stays in ${r.workRoot}/j-`), "the agent is told where it is");
});

test("a cleanup that hangs gives up after its time limit", async () => {
  const r = rig({ behave: (call) => (call.kind === "cleanup" ? { hang: true } : undefined) });
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo ok" }, { sched, deps: { timing: { ...FAST, cleanupTimeoutMs: 200 } } });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes("could not be deleted (the cleanup did not finish in time)"), out.text);
});

test("a worker that never took the project is not blamed for a copy it never had", async () => {
  const r = rig({
    behave: (call) => (call.destination === "root@w1" && (call.kind === "in" || call.kind === "cleanup") ? { fail: { stderr: "ssh: connect to host w1 port 22: Connection refused" } } : undefined),
  });
  const sched = scheduler((n) => ({ worker: n === 0 ? ALPHA : BETA }));
  const out = await run(r, { command: "echo ok" }, { sched });

  assert.equal(out.isError, false, out.text);
  assert.ok(!out.text.includes("could not be deleted"), out.text);
  assertTidy(r, sched);
});

// ── What the agent sees while it runs ────────────────────────────────────────

test("progress: the status line comes first, the queue position and the newest output are shown, and it stops with the job", async () => {
  const r = rig();
  const texts = [];
  const sched = scheduler(async (n, request, options) => {
    options.onWaiting({ position: 1, waiting: 2, waitedMs: 3_000, why: "every worker is busy" });
    await sleep(60);
    return { worker: ALPHA, waitedMs: 3_000 };
  });
  const out = await run(r, { command: "echo compiling; sleep 1; echo linked" }, { sched, onProgress: (text) => texts.push(text) });

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.includes("waited 3.0 s for a worker"), out.text);
  assert.ok(texts.some((text) => text.startsWith("Waiting for a worker (1 of 2, 3.0 s): every worker is busy")), JSON.stringify(texts));
  assert.ok(texts.some((text) => text.startsWith(`Running on Alpha · `)), JSON.stringify(texts));
  assert.ok(texts.some((text) => text.startsWith("Running on Alpha") && text.includes("\ncompiling")), "the newest output follows the status");
  assert.ok(texts.every((text) => text.split("\n")[0].trim() !== ""), "the first line is always a status");

  const sent = texts.length;
  await sleep(700);
  assert.equal(texts.length, sent, "nothing is sent after the job ended");
});

test("a progress listener that throws does not break the job", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "echo ok" }, {
    sched,
    onProgress: () => {
      throw new Error("listener failed");
    },
  });
  assert.equal(out.isError, false, out.text);
});

test("a look-alike of the exit marker printed by the command is output, not the end of the job", async () => {
  const r = rig();
  const sched = always(ALPHA);
  const out = await run(r, { command: "printf '\\n@@cody-0123456789abcdef-exit:0\\nstill running\\n'; exit 5" }, { sched });
  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith(`Exit code 5: the command failed on ${ALPHA_NAME}`), "a look-alike printed by the command is output, not the end");
  assert.ok(out.text.includes("still running"));
});
