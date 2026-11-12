import { spawn } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runWorkerJob, DEFAULT_JOB_TIMING } = await jiti.import("./run.ts");
const { runLocalCommand } = await jiti.import("./local.ts");
const { sshShell } = await jiti.import("./shell.ts");

/**
 * A whole job through the REAL ssh seam (`sshShell`, the only place the
 * workers feature starts ssh) with a stand-in `ssh` first on PATH that records
 * how it was called and then runs the remote command on this machine, the way
 * sshd would. What matters: every call follows the machine rules (never `-n`
 * or a terminal, BatchMode, no connection sharing, the destination alone after
 * `--`); a destination outside the whitelist never reaches ssh; ssh's own
 * words decide why a worker is skipped; a server without ssh says so; and when
 * Cody itself is killed without a word, the job on the worker is stopped by
 * its dead-man's switch.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-ssh-")));
const bin = join(base, "bin");
const logFile = join(base, "ssh-calls.log");
mkdirSync(bin);

// Arguments are recorded NUL-separated (the remote command has newlines in it), one "@@end" per call.
writeFileSync(
  join(bin, "ssh"),
  `#!/bin/sh
{ for a in "$@"; do printf '%s\\0' "$a"; done; printf '@@end\\0'; } >> "$STANDIN_LOG"
while [ "$1" != "--" ]; do shift; done
shift
dest=$1
shift
case "$dest" in
  down@host) echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255 ;;
esac
exec sh -c "$1"
`,
);
chmodSync(join(bin, "ssh"), 0o755);

const savedPath = process.env.PATH;
process.env.PATH = `${bin}${delimiter}${savedPath}`;
process.env.STANDIN_LOG = logFile;
after(() => {
  process.env.PATH = savedPath;
  delete process.env.STANDIN_LOG;
  rmSync(base, { recursive: true, force: true });
});

/** The arguments of every ssh call so far, one array per call. */
function sshCalls() {
  if (!existsSync(logFile)) return [];
  const calls = [];
  let current = [];
  for (const item of readFileSync(logFile, "utf8").split("\0")) {
    if (item === "@@end") {
      calls.push(current);
      current = [];
    } else if (item !== "") {
      current.push(item);
    }
  }
  return calls;
}

const resetCalls = () => rmSync(logFile, { force: true });

function worker(id, destination, label) {
  return { id, label, destination, facts: { name: id, arch: "x86_64", cpus: 4, memMB: 8192, slots: 1, tools: [], onlyWhenIdle: false } };
}

let seq = 0;

function rig() {
  const dir = join(base, `case-${++seq}`);
  const project = join(dir, "project");
  const workRoot = join(dir, "work");
  mkdirSync(project, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  resetCalls();
  return { dir, project, workRoot };
}

/** The scheduler hands out `machines` in order, then refuses. */
function scheduler(machines) {
  let next = 0;
  return {
    async acquire() {
      const machine = machines[next++];
      if (!machine) return { kind: "refused", why: "no other worker is available", waitedMs: 0 };
      return { kind: "worker", lease: { machine, release() {} }, waitedMs: 0, freeCores: 2 };
    },
  };
}

function run(r, request, machines) {
  return runWorkerJob(
    { results: [], arch: null, tools: [], timeoutMs: 60_000, fallbackLocal: false, ...request },
    { cwd: r.project, sessionId: "s-ssh", scratchDir: join(r.dir, "scratch") },
    {
      scheduler: scheduler(machines),
      shell: sshShell,
      workRoot: r.workRoot,
      localFit: () => ({ ok: false, why: "not used" }),
      runLocal: runLocalCommand,
      timing: { ...DEFAULT_JOB_TIMING, startTimeoutMs: 5_000, stallMs: 2_000, cleanupTimeoutMs: 10_000 },
      now: () => Date.now(),
    },
  );
}

test("a job through ssh: results come home, and every ssh call follows the machine rules", async () => {
  const r = rig();
  const out = await run(r, { command: "echo via-ssh > out.txt; echo hi", results: ["out.txt"] }, [worker("w1", "root@pve", "Pve")]);

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith('Exit code 0: the command succeeded on worker "Pve" (x86_64, 4 cores)'), out.text);
  assert.equal(readFileSync(join(r.project, "out.txt"), "utf8"), "via-ssh\n");
  assert.deepEqual(readdirSync(r.workRoot), [], "the copy on the worker is deleted");

  const calls = sshCalls();
  assert.equal(calls.length, 4, "copy in, run, copy back, clean up: one ssh each");
  for (const args of calls) {
    assert.equal(args[0], "-T", "no terminal");
    for (const refused of ["-n", "-t", "-tt", "-f"]) assert.ok(!args.includes(refused), `no ${refused}: a job's stdin is the far side's dead-man's switch`);
    assert.ok(args.includes("BatchMode=yes"), "never asks anybody anything");
    assert.ok(args.some((arg) => arg.startsWith("ConnectTimeout=")), "a machine that stops answering is noticed");
    assert.ok(args.includes("ControlMaster=no") && args.includes("ControlPath=none"), "no connection sharing is started");
    const dashes = args.indexOf("--");
    assert.ok(dashes > 0);
    assert.deepEqual(args.slice(dashes + 1, dashes + 2), ["root@pve"], "the checked destination follows `--`");
    assert.equal(args.length, dashes + 3, "and then exactly one remote command");
    assert.ok(args[dashes + 2].startsWith("sh -c '"), "sent as sh -c, so the login shell never has to understand it");
  }
  assert.ok(calls[1][calls[1].length - 1].includes("-started"), "the second call runs the job");
});

test("a destination outside the whitelist never reaches ssh", async () => {
  const r = rig();
  const marker = join(r.dir, "pwned");
  const hostile = worker("w1", `-oProxyCommand=touch ${marker}`, "Hostile");
  const out = await run(r, { command: "echo never" }, [hostile]);

  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("No worker could take this job, and it was not run: no other worker is available."), out.text);
  assert.ok(out.text.includes("Refusing to run ssh against an invalid destination"), out.text);
  assert.equal(sshCalls().length, 0, "ssh was never started");
  assert.equal(existsSync(marker), false);
});

test("ssh's own words decide why a worker is skipped; the next worker runs the job", async () => {
  const r = rig();
  const out = await run(r, { command: "echo reached-pve" }, [worker("w1", "down@host", "Down"), worker("w2", "root@pve", "Pve")]);

  assert.equal(out.isError, false, out.text);
  assert.ok(out.text.startsWith('Exit code 0: the command succeeded on worker "Pve"'), out.text);
  assert.ok(
    out.text.includes('worker "Down" (x86_64, 4 cores) could not take the project: the machine refused the connection (ssh: connect to host down port 22: Connection refused).'),
    out.text,
  );
  const destinations = sshCalls().map((args) => args[args.indexOf("--") + 1]);
  assert.deepEqual(
    destinations,
    ["down@host", "down@host", "root@pve", "root@pve", "root@pve"],
    "the refused machine was asked for the copy and then (quietly) for the clean-up; the other one did the job",
  );
});

/** A directory holding only what a server without ssh would still have: tar and git. */
function pathWithoutSsh(dir) {
  const directory = join(dir, "no-ssh-path");
  mkdirSync(directory);
  for (const name of ["tar", "git"]) {
    const found = savedPath
      .split(delimiter)
      .map((part) => join(part, name))
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    assert.ok(found, `${name} is needed for this test`);
    symlinkSync(found, join(directory, name));
  }
  return directory;
}

test("a server without an ssh program says so instead of hanging", async () => {
  const r = rig();
  process.env.PATH = pathWithoutSsh(r.dir);
  let out;
  try {
    out = await run(r, { command: "echo never" }, [worker("w1", "root@pve", "Pve")]);
  } finally {
    process.env.PATH = `${bin}${delimiter}${savedPath}`;
  }
  assert.equal(out.isError, true);
  assert.ok(out.text.startsWith("No worker could take this job, and it was not run: no other worker is available."), out.text);
  assert.ok(out.text.includes('worker "Pve" (x86_64, 4 cores) could not take the project: this server has no ssh program.'), out.text);
  assert.equal(sshCalls().length, 0);
});

function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  // A process that ended but has not been reaped yet still answers; it is not running.
  try {
    return /^\d+ \([^)]*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

test("when Cody is killed without warning, the command on the worker is stopped by its dead-man's switch", async () => {
  const r = rig();
  const jobDirectory = join(r.workRoot, "j-test-0123abcd");
  mkdirSync(jobDirectory);
  const pidFile = join(r.dir, "pid");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
      const jiti = createJiti(${JSON.stringify(import.meta.url)});
      const { sshShell } = await jiti.import("./shell.ts");
      const { buildExecCommand } = await jiti.import("./remote.ts");
      const command = buildExecCommand({ directory: ${JSON.stringify(jobDirectory)}, cwdRel: "", command: ${JSON.stringify(`echo $$ > ${pidFile}; exec sleep 300`)}, token: "0123456789abcdef" });
      const proc = sshShell.start("root@pve", command);
      let text = "";
      proc.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("-started\\n")) console.log("ready");
      });
      setInterval(() => {}, 1000);
      `,
    ],
    { stdio: ["ignore", "pipe", "inherit"], env: process.env },
  );
  let jobPid = 0;
  try {
    const { promise: ready, resolve } = Promise.withResolvers();
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) resolve();
    });
    child.once("exit", resolve);
    await ready;
    const until = Date.now() + 5_000;
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") {
      assert.ok(Date.now() < until, "the command started on the worker");
      await sleep(20);
    }
    jobPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(jobPid > 1);
    assert.equal(isGone(jobPid), false, "it is running before Cody dies");

    child.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (!isGone(jobPid)) {
      assert.ok(Date.now() < deadline, "the job was stopped after its owner was killed");
      await sleep(50);
    }
  } finally {
    child.kill("SIGKILL");
    if (jobPid > 1) {
      try {
        process.kill(jobPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});
