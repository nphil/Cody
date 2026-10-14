import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * A machine over ssh is read by one fixed loop whose output Cody trusts and
 * whose failures it must name in plain words. What matters: nothing a person
 * types can reach the remote command or an ssh option, the loop survives being
 * run the way a real login shell runs it, a refusal says WHY, and stopping a
 * connection kills it quietly.
 *
 * The integration tests put a stand-in `ssh` first on PATH that does what a
 * remote login shell does with the command string (`sh -c <string>`), so the
 * real sampling loop runs here against this machine's own /proc.
 */
const jiti = createJiti(import.meta.url);
const ssh = await jiti.import("./ssh.ts");

const onLinux = process.platform === "linux";

test("the remote command is one fixed string that any login shell can quote", () => {
  assert.equal(ssh.SAMPLE_COMMAND, `sh -c '${ssh.SAMPLE_SCRIPT}'`);
  // Inside single quotes: no quote to end them, no backslash, and no `!` (csh
  // expands it even there); one line, because fish and csh read lines.
  assert.doesNotMatch(ssh.SAMPLE_SCRIPT, /['\\!`\r\n]/);
});

test("ssh gets the destination as one argument after --, with the person's own host-key policy left alone", () => {
  const args = ssh.sshArgs("root@pve");
  assert.deepEqual(args.slice(-3), ["--", "root@pve", ssh.SAMPLE_COMMAND]);
  for (const wanted of ["BatchMode=yes", "ConnectTimeout=8", "ControlMaster=no", "ControlPath=none", "LogLevel=ERROR"]) {
    assert.ok(args.includes(wanted), `${wanted} is set`);
  }
  assert.ok(!args.some((arg) => /^StrictHostKeyChecking/i.test(arg)), "trusting a new machine is the person's call");
});

test("an invalid destination never reaches the ssh argument list", () => {
  for (const bad of ["-oProxyCommand=touch /tmp/x", "a b", "host;id", "", "$(id)"]) {
    assert.throws(() => ssh.sshArgs(bad), /invalid destination/, JSON.stringify(bad));
  }
});

test("what ssh printed becomes a plain reason", () => {
  const table = [
    ["root@pve: Permission denied (publickey,password).", 255, "auth"],
    ["Host key verification failed.", 255, "host_key"],
    ["@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", 255, "host_key"],
    ["ssh: Could not resolve hostname nope: Name or service not known", 255, "unknown_host"],
    ["ssh: connect to host 10.0.0.9 port 22: Connection refused", 255, "refused"],
    ["ssh: connect to host 10.0.0.9 port 22: Connection timed out", 255, "unreachable"],
    ["ssh: connect to host 10.0.0.9 port 22: No route to host", 255, "unreachable"],
    ["Connection to 10.0.0.9 closed by remote host.", 255, "dropped"],
    ["client_loop: send disconnect: Broken pipe", 255, "dropped"],
    ["kex_exchange_identification: read: Connection reset by peer", 255, "dropped"],
    ["something nobody planned for", 255, "failed"],
    ["", 255, "failed"],
    ["", 0, "dropped"],
  ];
  for (const [stderr, code, reason] of table) {
    assert.equal(ssh.classifySshFailure(stderr, code), reason, stderr || `(silent, exit ${code})`);
  }
});

test("the line shown next to a failure is ssh's own first line, cleaned and capped", () => {
  assert.equal(ssh.firstStderrLine("\n\nPermission\u0007 denied\t(publickey).\nsecond line"), "Permission denied (publickey).");
  assert.equal(ssh.firstStderrLine(""), "");
  const long = ssh.firstStderrLine("x".repeat(500));
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith("…"));
});

// ── integration, through a stand-in ssh ──────────────────────────────────────

const binDir = mkdtempSync(join(tmpdir(), "cody-fake-ssh-"));
writeFileSync(join(binDir, "ssh"), `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift; shift
case "$FAKE_SSH_MODE" in
  deny) echo "root@fake: Permission denied (publickey)." >&2; exit 255;;
  noproc) echo "@NOPROC"; exit 0;;
esac
[ -n "$FAKE_SSH_PIDFILE" ] && echo $$ > "$FAKE_SSH_PIDFILE"
exec sh -c "$1"
`, { mode: 0o755 });
const originalPath = process.env.PATH;
process.env.PATH = `${binDir}:${originalPath}`;

// The child and its pipes are unref'd on purpose (a stuck ssh must never hold
// the server open), so while a test waits on one nothing else keeps the loop
// alive and the runner would call the wait abandoned.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

function readings(wanted) {
  return new Promise((resolve, reject) => {
    const samples = [];
    const timer = setTimeout(() => { run.stop(); reject(new Error(`only ${samples.length} readings`)); }, 10_000);
    const run = ssh.runSsh("fake", {
      onSample(sample) {
        samples.push(sample);
        if (samples.length >= wanted) { clearTimeout(timer); run.stop(); resolve(samples); }
      },
      onNoProc() { clearTimeout(timer); run.stop(); reject(new Error("unexpected @NOPROC")); },
      onClose(close) { clearTimeout(timer); reject(new Error(`closed early: ${JSON.stringify(close)}`)); },
    });
  });
}

test("the real sampling loop, run the way a login shell runs it, reads this machine", { skip: !onLinux }, async () => {
  const [first, second] = await readings(2);
  const stat = readFileSync("/proc/stat", "utf8");
  const cores = stat.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length;
  assert.equal(first.cores, cores);
  assert.ok(second.cpu.total >= first.cpu.total, "tick counters only grow");
  const total = Number(/^MemTotal:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"))[1]);
  assert.equal(first.memTotalKb, total);
  assert.ok(first.memAvailableKb > 0 && first.memAvailableKb <= total);
  assert.equal(typeof first.load1, "number");
});

test("a refused login is named, and carries ssh's own words", { skip: !onLinux }, async () => {
  process.env.FAKE_SSH_MODE = "deny";
  try {
    const close = await new Promise((resolve) => {
      ssh.runSsh("fake", { onSample() {}, onNoProc() {}, onClose: resolve });
    });
    assert.deepEqual(close, { reason: "auth", detail: "root@fake: Permission denied (publickey).", samples: 0 });
  } finally {
    delete process.env.FAKE_SSH_MODE;
  }
});

test("a machine without /proc says so, once", { skip: !onLinux }, async () => {
  process.env.FAKE_SSH_MODE = "noproc";
  try {
    await new Promise((resolve, reject) => {
      const run = ssh.runSsh("fake", {
        onSample() { reject(new Error("a machine without /proc produced a reading")); },
        onNoProc() { run.stop(); resolve(); },
        onClose(close) { reject(new Error(`closed instead: ${JSON.stringify(close)}`)); },
      });
    });
  } finally {
    delete process.env.FAKE_SSH_MODE;
  }
});

test("stopping a connection is quiet: no close callback follows", { skip: !onLinux }, async () => {
  let closed = false;
  await new Promise((resolve) => {
    const run = ssh.runSsh("fake", {
      onSample() { run.stop(); resolve(); },
      onNoProc() {},
      onClose() { closed = true; },
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(closed, false);
});

test("no ssh program on this server is reported, not thrown", async () => {
  process.env.PATH = "";
  try {
    assert.equal(ssh.findSshBinary(), null);
    const close = await new Promise((resolve) => {
      ssh.runSsh("fake", { onSample() {}, onNoProc() {}, onClose: resolve });
    });
    assert.deepEqual(close, { reason: "no_ssh", detail: "", samples: 0 });
  } finally {
    process.env.PATH = `${binDir}:${originalPath}`;
  }
});

test("runSsh refuses an invalid destination before anything is spawned", () => {
  assert.throws(() => ssh.runSsh("-oProxyCommand=touch /tmp/x", { onSample() {}, onNoProc() {}, onClose() {} }), /invalid destination/);
});

test("the far loop ends when its stdin ends, and not before", { skip: !onLinux }, async () => {
  const child = spawn("sh", ["-c", ssh.SAMPLE_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const early = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve("still running"), 2_500))]);
  assert.equal(early, "still running", "an open stdin keeps sampling: the loop never stops on its own");

  child.stdin.end();
  let timer;
  const outcome = await Promise.race([
    closed,
    new Promise((resolve) => { timer = setTimeout(() => resolve("outlived its stdin"), 6_000); }),
  ]);
  clearTimeout(timer);
  if (outcome === "outlived its stdin") child.kill("SIGKILL");
  assert.notEqual(outcome, "outlived its stdin", "EOF on stdin must end the loop (the dead-man's switch)");
});

test("an ssh whose parent is killed outright does not carry on sampling", { skip: !onLinux }, async () => {
  const pidFile = join(binDir, "far.pid");
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from "jiti";
    const jiti = createJiti(${JSON.stringify(import.meta.url)});
    const ssh = await jiti.import("./ssh.ts");
    setInterval(() => {}, 1000);
    ssh.runSsh("fake", { onSample() { console.log("sampling"); }, onNoProc() {}, onClose() {} });
  `], { cwd: import.meta.dirname, env: { ...process.env, FAKE_SSH_PIDFILE: pidFile }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => parent.stdout.once("data", resolve));
  const farPid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(farPid > 1);
  process.kill(farPid, 0); // alive while its parent is

  parent.kill("SIGKILL"); // no shutdown hook, no exit handler: a crash
  let alive = true;
  for (let waited = 0; waited < 8_000 && alive; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      process.kill(farPid, 0);
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(farPid, "SIGKILL");
  assert.equal(alive, false, "the loop must end by itself once the process that started it is gone");
});
