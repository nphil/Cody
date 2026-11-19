import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/** `omp ps --all --json` parsing for Settings › System › Background services. */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseServiceReports, listServices, readServiceBoard, isLegacyBrokerCmdline, legacyBrokerPids, stopLegacyBrokers } = await jiti.import("./services.ts");

// omp ≤ 18: one entry per project service manager, machine-wide ones as `global` entries.
const SAMPLE = JSON.stringify([
  {
    kind: "project",
    projectDir: "/work/app",
    runtimeDir: "/run/x",
    brokerPid: 1,
    daemons: [
      { name: "web", id: "a", state: "ready", pid: 42, startedAt: 1000, command: "bun   run\n dev", cwd: "/work/app", supervised: true },
      { name: "old", id: "b", state: "exited", startedAt: 900, command: "x" },
      { name: "omp.browser.headless", id: "c", state: "running", pid: 43, command: "chromium" },
    ],
  },
  { kind: "global", service: "browser-relay", runtimeDir: "/run/g", daemons: [{ name: "relay", id: "d", state: "starting", command: "relay" }] },
  { kind: "project", daemons: [{ name: "no-dir", state: "ready" }] },
]);

const SHELL_HOST = "/usr/local/bin/bun /opt/omp/dist/cli.js __omp_worker_shell_process --source /home/u/.omp/run/daemon/services/9a60/web/shell.sh --";

function unit(over) {
  return {
    id: "u-1",
    kind: "proc",
    scope: { kind: "project", dir: "/work/app" },
    key: "web",
    label: "web",
    state: "running",
    pids: [4242],
    createdAt: 1000,
    startedAt: 1100,
    restartCount: 0,
    outputBytes: 0,
    leases: 0,
    policy: { hold: "persist", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
    command: `${SHELL_HOST} npm run dev -- --port 3000`,
    cwd: "/work/app",
    supervised: true,
    ...over,
  };
}

// omp 19: one per-user daemon; the board groups units of every kind by scope.
const DAEMON_SAMPLE = JSON.stringify({
  daemon: { pid: 9, build: "19.0.0+1", startedAt: 5 },
  reports: [
    { scope: { kind: "global" }, units: [unit({ id: "u-relay", key: "omp.browser.relay", label: "omp.browser.relay", scope: { kind: "global" }, command: "bun relay" })] },
    {
      scope: { kind: "project", dir: "/work/app" },
      units: [
        unit({}),
        unit({ id: "u-lsp", kind: "lsp", key: "typescript", label: "typescript", command: "typescript-language-server --stdio" }),
        unit({ id: "u-old", key: "old", label: "old", state: "exited", pids: [] }),
        unit({ id: "u-bad", key: "bad", label: "bad", state: "failed", pids: [] }),
        unit({ id: "u-pty", kind: "external", key: "pty-1", label: "terminal", supervised: false }),
        unit({ id: "u-nolabel", key: "watch", label: "", pids: [], state: "starting", startedAt: undefined, command: "tsc -w" }),
      ],
    },
    { scope: { kind: "session", id: "s-1" }, units: [unit({ id: "u-sess", key: "chat-proc", label: "chat-proc", scope: { kind: "session", id: "s-1" } })] },
  ],
});

test("only running services are listed, with their scope", () => {
  const rows = parseServiceReports(`warning line\n${SAMPLE}`);
  assert.deepEqual(rows.map((row) => row.name), ["web", "omp.browser.headless", "relay"]);
  assert.deepEqual(rows[0], { name: "web", id: null, state: "ready", pid: 42, startedAt: 1000, command: "bun run dev", projectDir: "/work/app", scope: null, internal: false });
  assert.equal(rows[1].internal, true);
  assert.equal(rows[2].scope, "browser-relay");
  assert.equal(rows[2].projectDir, null);
});

test("omp 19's daemon board lists only the services someone started, by unit id", () => {
  const rows = parseServiceReports(DAEMON_SAMPLE);
  assert.deepEqual(rows.map((row) => row.id), ["u-relay", "u-1", "u-nolabel"]);
  assert.deepEqual(rows[1], {
    name: "web",
    id: "u-1",
    state: "running",
    pid: 4242,
    startedAt: 1100,
    // The shell host omp wraps a service in is hidden; a `--` inside the user's own command stays.
    command: "npm run dev -- --port 3000",
    projectDir: "/work/app",
    scope: null,
    internal: false,
  });
  // A machine-wide unit, named by its key when it has no label; omp's own.
  assert.equal(rows[0].scope, "global");
  assert.equal(rows[0].projectDir, null);
  assert.equal(rows[0].internal, true);
  assert.deepEqual([rows[2].name, rows[2].state, rows[2].pid, rows[2].startedAt, rows[2].command], ["watch", "starting", null, null, "tsc -w"]);
});

test("unreadable output is null, not an empty list", () => {
  assert.equal(parseServiceReports("not json"), null);
  assert.equal(parseServiceReports("{}"), null);
  assert.equal(parseServiceReports('{"daemon":{"pid":1}}'), null);
  // A daemon board with nothing on it is an empty list, not an error.
  assert.deepEqual(parseServiceReports('{"reports":[]}'), []);
});

test("unknown fields and malformed units never break the list", () => {
  const rows = parseServiceReports(JSON.stringify({
    reports: [
      { scope: { kind: "project", dir: "/w" }, units: [null, 7, { kind: "proc" }, { ...unit({}), future: { nested: true }, pids: ["x"] }], more: 1 },
      { scope: null, units: [unit({})] },
      { units: [unit({})] },
    ],
    newTopLevel: true,
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, null);
});

test("only a whole `__omp_worker_daemon_broker` argument marks an omp 18 service manager", () => {
  assert.equal(isLegacyBrokerCmdline("/usr/local/bin/bun\0/opt/omp/dist/cli.js\0__omp_worker_daemon_broker\0"), true);
  assert.equal(isLegacyBrokerCmdline("/usr/local/bin/bun\0/opt/omp/dist/cli.js\0__omp_worker_daemon\0"), false);
  assert.equal(isLegacyBrokerCmdline("tail\0-f\0/x/__omp_worker_daemon_broker.log\0"), false);
  assert.equal(isLegacyBrokerCmdline(""), false);
});

test("old service managers are found and stopped by process id, nothing else is touched", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "__omp_worker_daemon_broker"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
  const proc = mkdtempSync(join(tmpdir(), "cody-fake-proc-"));
  try {
    // A fake /proc: only this child, an unrelated process, and a non-pid entry.
    mkdirSync(join(proc, String(child.pid)));
    writeFileSync(join(proc, String(child.pid), "cmdline"), `${process.execPath}\0-e\0setInterval\0__omp_worker_daemon_broker\0`);
    mkdirSync(join(proc, "1"));
    writeFileSync(join(proc, "1", "cmdline"), "/sbin/init\0");
    mkdirSync(join(proc, "self-ish"));
    assert.deepEqual(legacyBrokerPids(proc), [child.pid]);
    assert.deepEqual(legacyBrokerPids(join(proc, "missing")), []);
    assert.equal(await stopLegacyBrokers(proc, 200), 1);
    assert.equal(await exited, "SIGTERM");
  } finally {
    child.kill("SIGKILL");
    rmSync(proc, { recursive: true, force: true });
  }
});

test("the installed engine answers `omp ps --all --json`", async () => {
  const rows = await listServices();
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(row.projectDir !== null || row.scope !== null);
    assert.ok(row.id === null || typeof row.id === "string");
  }
  const board = await readServiceBoard();
  assert.ok(Number.isInteger(board.oldManagers) && board.oldManagers >= 0);
  assert.ok(Array.isArray(board.services));
});
