import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";
import { createJiti } from "jiti";
import { fakeProcess } from "./fake-proc.test-helper.mjs";

/**
 * The janitor end to end, on a fake machine: a private temp dir, home dir,
 * data dir and process table per test, so nothing here reads the real /tmp or
 * /proc. Ages are made by passing a later `now`, not by back-dating files:
 * a file's status-change time cannot be back-dated, and the janitor counts it.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cody-janitor-test-"));
const originalEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  HOME: process.env.HOME,
  CODY_SCRATCH_ROOT: process.env.CODY_SCRATCH_ROOT,
};
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
process.env.HOME = path.join(base, "home");
process.env.CODY_SCRATCH_ROOT = path.join(base, "tmp", "cs");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runDiskJanitor, readLastJanitorReport, isDiskJanitorRunning } = await jiti.import("./janitor.ts");
const scratch = await jiti.import("./scratch.ts");
const { checkpointGitDir } = await jiti.import("../checkpoints.ts");

after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  delete globalThis.__ompSessions;
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let counter = 0;
/** A fresh fake machine; the environment variables the janitor's helpers read point into it. */
function machine() {
  const root = path.join(base, `case-${counter++}`);
  const m = {
    root,
    tmp: path.join(root, "tmp"),
    home: path.join(root, "home"),
    homeTmp: path.join(root, "home", "tmp"),
    agent: path.join(root, "agent"),
    proc: path.join(root, "proc"),
  };
  for (const dir of [m.tmp, m.homeTmp, m.agent, m.proc]) fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = m.agent;
  process.env.HOME = m.home;
  process.env.CODY_SCRATCH_ROOT = path.join(m.tmp, "cs");
  fakeProcess(m.proc, process.pid, { cwd: m.root }); // our own process, so the table counts as readable
  return m;
}

function put(file, bytes = 10, modifiedMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  if (modifiedMs !== undefined) fs.utimesSync(file, new Date(modifiedMs), new Date(modifiedMs));
}

/** A chat's transcript, last written at `modifiedMs`. */
function transcript(m, chatId, text, modifiedMs) {
  const file = path.join(m.agent, "sessions", "-proj", `2026-11-04T00-00-00-000Z_${chatId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(modifiedMs), new Date(modifiedMs));
}

/** Run the janitor against the machine. `live` says which chats are running. */
function run(m, options = {}, live = { ids: [], cwds: [], dirs: [] }) {
  const { environment, ...rest } = options;
  return runDiskJanitor({
    trigger: "manual",
    ...rest,
    environment: {
      tmpRoot: m.tmp,
      homeTmpRoot: m.homeTmp,
      procRoot: m.proc,
      liveSessions: () => ({ ids: new Set(live.ids), cwds: new Set(live.cwds), dirs: new Set(live.dirs) }),
      readAreas: () => [],
      ...environment,
    },
  });
}

/** What the flat sweep must remove and must keep, built under the machine's temp and home-temp dirs. */
function sweepFixture(m, now) {
  put(path.join(m.tmp, "old-build", "artifact.bin"), 5000);
  put(path.join(m.tmp, "old-file.log"), 1234);
  put(path.join(m.homeTmp, "old-dir", "a.txt"), 700);

  put(path.join(m.tmp, "recent-inside", "deep", "new.txt"), 10, now - HOUR);
  put(path.join(m.tmp, "cwd-held", "sub", "x"));
  put(path.join(m.tmp, "env-held", "bin", "python"));
  put(path.join(m.tmp, "mentioned", "bin", "python"));
  put(path.join(m.tmp, ".hidden-old", "x"));
  put(path.join(m.tmp, "jiti", "module.cjs"));
  put(path.join(m.homeTmp, "token.sh"), 20);
  put(path.join(m.homeTmp, ".dot-dir", "x"));
  put(path.join(m.homeTmp, "mentioned-home", "x"));
  fs.symlinkSync(m.root, path.join(m.tmp, "old-link"));
  execFileSync("mkfifo", [path.join(m.tmp, "old-pipe")]);

  fakeProcess(m.proc, 4300, { cwd: path.join(m.tmp, "cwd-held", "sub") });
  fakeProcess(m.proc, 4301, { environ: [`VIRTUAL_ENV=${path.join(m.tmp, "env-held")}`] });
  transcript(m, "chat-x", `{"cmd":"${path.join(m.tmp, "mentioned", "bin", "python")} run.py ~/tmp/mentioned-home/x"}\n`, now - HOUR);

  return {
    removed: {
      [path.join(m.tmp, "old-build")]: ["tmp-idle", 5000],
      [path.join(m.tmp, "old-file.log")]: ["tmp-idle", 1234],
      [path.join(m.homeTmp, "old-dir")]: ["home-tmp-idle", 700],
    },
    kept: {
      "modified inside, though the folder itself looks old": path.join(m.tmp, "recent-inside"),
      "a process works in it": path.join(m.tmp, "cwd-held"),
      "a process names it in its environment": path.join(m.tmp, "env-held"),
      "a recent chat names it": path.join(m.tmp, "mentioned"),
      "a dot-entry": path.join(m.tmp, ".hidden-old"),
      "the server's own transpile cache": path.join(m.tmp, "jiti"),
      "a link": path.join(m.tmp, "old-link"),
      "a pipe": path.join(m.tmp, "old-pipe"),
      "a file in the home temp dir": path.join(m.homeTmp, "token.sh"),
      "a dot-entry in the home temp dir": path.join(m.homeTmp, ".dot-dir"),
      "a recent chat names it as ~/tmp/…": path.join(m.homeTmp, "mentioned-home"),
    },
  };
}

test("the flat sweep removes only what nothing uses, names, or changed lately", async () => {
  const m = machine();
  const now = Date.now() + 10 * DAY;
  const fixture = sweepFixture(m, now);

  const report = await run(m, { now });

  assert.deepEqual(report.errors, []);
  const removed = Object.fromEntries(report.removed.map((entry) => [entry.path, [entry.reason, entry.bytes]]));
  assert.deepEqual(removed, fixture.removed);
  assert.equal(report.freedBytes, 5000 + 1234 + 700);
  assert.deepEqual(report.removed.map((entry) => entry.bytes), [5000, 1234, 700], "biggest first");
  for (const removedPath of Object.keys(fixture.removed)) assert.equal(fs.existsSync(removedPath), false, removedPath);
  for (const [why, keptPath] of Object.entries(fixture.kept)) {
    assert.ok(fs.lstatSync(keptPath, { throwIfNoEntry: false }), `kept: ${why}`);
  }

  // The control: each of those entries goes the moment nothing protects it, so each was kept for its stated reason.
  fs.rmSync(path.join(m.proc, "4300"), { recursive: true });
  fs.rmSync(path.join(m.proc, "4301"), { recursive: true });
  fs.rmSync(path.join(m.agent, "sessions"), { recursive: true });
  const longAgo = new Date(now - 3 * DAY);
  fs.utimesSync(path.join(m.tmp, "recent-inside", "deep", "new.txt"), longAgo, longAgo);
  const second = await run(m, { now });
  assert.deepEqual(
    second.removed.map((entry) => path.basename(entry.path)).sort(),
    ["cwd-held", "env-held", "mentioned", "mentioned-home", "recent-inside"],
  );
  for (const [why, keptPath] of Object.entries(fixture.kept)) {
    const goes = ["modified inside", "a process works", "a process names", "a recent chat"].some((start) => why.startsWith(start));
    assert.equal(fs.lstatSync(keptPath, { throwIfNoEntry: false }) === undefined, goes, why);
  }
});

test("a dry run reports exactly what a real run would remove, and deletes and saves nothing", async () => {
  const m = machine();
  const now = Date.now() + 10 * DAY;
  const fixture = sweepFixture(m, now);

  const report = await run(m, { now, dryRun: true });

  assert.deepEqual(Object.fromEntries(report.removed.map((entry) => [entry.path, [entry.reason, entry.bytes]])), fixture.removed);
  for (const removedPath of Object.keys(fixture.removed)) assert.equal(fs.existsSync(removedPath), true, `still there: ${removedPath}`);
  assert.equal(readLastJanitorReport(), null, "a dry run is not the last run");
});

test("with no readable process list nothing in the temp dir is swept, and the report says why", async () => {
  const m = machine();
  const now = Date.now() + 10 * DAY;
  const fixture = sweepFixture(m, now);

  const report = await run(m, { now, environment: { procRoot: path.join(m.root, "no-process-table") } });

  assert.deepEqual(report.removed, []);
  for (const removedPath of Object.keys(fixture.removed)) assert.equal(fs.existsSync(removedPath), true);
  assert.match(report.errors.join("\n"), /running programs/);
});

test("scratch: a running chat's is never removed, an idle chat's is, a chat's own transcripts and processes keep it", async () => {
  const m = machine();
  const now = Date.now() + 5 * DAY;
  const dirOf = (chat) => {
    const dir = scratch.ensureSessionScratch(chat);
    assert.ok(dir, chat);
    put(path.join(dir, "data"), 10);
    return dir;
  };
  const idle = dirOf("idle-chat");
  const running = dirOf("running-chat");
  const moved = dirOf("moved-chat");
  const active = dirOf("active-chat");
  const held = dirOf("held-chat");

  const orphanOld = path.join(process.env.CODY_SCRATCH_ROOT, "aaaaaaaaaaaa");
  const orphanYoung = path.join(process.env.CODY_SCRATCH_ROOT, "bbbbbbbbbbbb");
  const orphanHeld = path.join(process.env.CODY_SCRATCH_ROOT, "cccccccccccc");
  const longAgo = Date.now() - 30 * DAY;
  for (const [dir, when] of [[orphanOld, longAgo], [orphanYoung, now - HOUR], [orphanHeld, longAgo]]) {
    put(path.join(dir, "leftover"), 10, when);
    fs.utimesSync(dir, new Date(when), new Date(when));
  }
  transcript(m, "active-chat", "{}\n", now - HOUR);
  fakeProcess(m.proc, 4400, { environ: [`TMPDIR=${held}`], cwd: orphanHeld });

  const report = await run(m, { now }, { ids: ["running-chat"], cwds: [], dirs: [moved] });

  assert.deepEqual(report.errors, []);
  const removed = Object.fromEntries(report.removed.map((entry) => [entry.path, entry.reason]));
  assert.deepEqual(removed, { [idle]: "scratch-idle", [orphanOld]: "scratch-orphan" });
  for (const dir of [running, moved, active, held, orphanYoung, orphanHeld]) assert.equal(fs.existsSync(dir), true, dir);
  assert.equal(fs.existsSync(idle), false);
  assert.equal(fs.existsSync(orphanOld), false);

  const remaining = Object.fromEntries(report.scratch.map((folder) => [folder.dir, folder]));
  assert.deepEqual(Object.keys(remaining).sort(), [running, moved, active, held, orphanYoung, orphanHeld].sort(), "the report lists what is left");
  assert.equal(remaining[running].live, true);
  assert.equal(remaining[moved].live, true, "found by the folder its engine runs in");
  assert.equal(remaining[active].live, false);
  assert.equal(remaining[running].bytes, 10);
  assert.ok(!scratch.listSessionScratch().some((entry) => entry.dir === idle), "its index entry went with it");
});

test("scratch: when the running chats cannot be read, every chat counts as running", async () => {
  const m = machine();
  const now = Date.now() + 5 * DAY;
  const dir = scratch.ensureSessionScratch("any-chat");
  put(path.join(dir, "data"));

  const report = await runDiskJanitor({
    now,
    environment: { tmpRoot: m.tmp, homeTmpRoot: null, procRoot: m.proc, liveSessions: () => { throw new Error("registry is broken"); }, readAreas: () => [] },
  });

  assert.equal(fs.existsSync(dir), true);
  assert.deepEqual(report.removed, []);
  assert.match(report.errors.join("\n"), /registry is broken/);
});

test("the live-chat registry the server keeps is what decides, and an unreadable one keeps everything", async () => {
  const m = machine();
  const now = Date.now() + 5 * DAY;
  const running = scratch.ensureSessionScratch("registered-chat");
  const idle = scratch.ensureSessionScratch("unregistered-chat");
  put(path.join(running, "data"));
  put(path.join(idle, "data"));
  const environment = { tmpRoot: m.tmp, homeTmpRoot: null, procRoot: m.proc, readAreas: () => [] };

  globalThis.__ompSessions = {};
  const unknown = await runDiskJanitor({ now, dryRun: true, environment });
  assert.deepEqual(unknown.removed, [], "not a registry at all: nothing is known to be idle");

  globalThis.__ompSessions = new Map([["registered-chat", { sessionId: "registered-chat", cwd: m.root, scratchDir: running, isAlive: () => true }]]);
  const report = await runDiskJanitor({ now, environment });
  assert.deepEqual(report.removed.map((entry) => entry.path), [idle]);
  assert.equal(fs.existsSync(running), true);
});

test("a disk over budget loses the scratch of the longest-idle chats first, and stops once it is under", async () => {
  const m = machine();
  const cs = process.env.CODY_SCRATCH_ROOT;
  const now = Date.now();
  const ages = { dddddddddddd: 50, eeeeeeeeeeee: 40, ffffffffffff: 30, "111111111111": 10, "222222222222": 2 };
  for (const [name, hours] of Object.entries(ages)) {
    const when = now - hours * HOUR;
    put(path.join(cs, name, "blob"), 100_000, when);
    fs.utimesSync(path.join(cs, name), new Date(when), new Date(when));
  }
  const total = 1_000_000;
  const scratchBytes = () => fs.readdirSync(cs).reduce((sum, name) => sum + fs.statSync(path.join(cs, name, "blob")).size, 0);
  const reading = (used) => [{ id: "tmp", path: m.tmp, totalBytes: total, availableBytes: total - used, usedBytes: used, freeFraction: (total - used) / total, level: "ok" }];
  const settings = { scratchIdleDays: 90, budgetPercent: 60 };

  // 300 KB of other things + 500 KB of scratch = 80%; two removals bring it to exactly 60%.
  const report = await run(m, { now, settings, environment: { readAreas: () => reading(300_000 + scratchBytes()) } });
  assert.deepEqual(report.removed.map((entry) => path.basename(entry.path)).sort(), ["dddddddddddd", "eeeeeeeeeeee"]);
  assert.ok(report.removed.every((entry) => entry.reason === "scratch-budget"));
  assert.deepEqual(fs.readdirSync(cs).sort(), ["111111111111", "222222222222", "ffffffffffff"]);
  assert.equal(report.areasAfter[0].usedBytes, 600_000);
});

test("a disk that reports freed space late does not make the janitor remove more than it must", async () => {
  const m = machine();
  const cs = process.env.CODY_SCRATCH_ROOT;
  const now = Date.now();
  for (const [name, hours] of Object.entries({ dddddddddddd: 50, eeeeeeeeeeee: 40, ffffffffffff: 30 })) {
    const when = now - hours * HOUR;
    put(path.join(cs, name, "blob"), 100_000, when);
    fs.utimesSync(path.join(cs, name), new Date(when), new Date(when));
  }
  const stale = [{ id: "tmp", path: m.tmp, totalBytes: 1_000_000, availableBytes: 400_000, usedBytes: 600_000, freeFraction: 0.4, level: "ok" }];

  // 60% used against a 45% budget, and the reading never changes (ZFS frees space seconds late):
  // removing two folders takes it to 40% by the janitor's own count, which is enough.
  const report = await run(m, { now, settings: { scratchIdleDays: 90, budgetPercent: 45 }, environment: { readAreas: () => stale } });
  assert.deepEqual(report.removed.map((entry) => path.basename(entry.path)).sort(), ["dddddddddddd", "eeeeeeeeeeee"]);
  assert.deepEqual(fs.readdirSync(cs), ["ffffffffffff"]);
});

test("budget pressure never takes a chat idle under six hours, or a running one, however far over budget", async () => {
  const m = machine();
  const cs = process.env.CODY_SCRATCH_ROOT;
  const now = Date.now();
  const ages = { dddddddddddd: 50, eeeeeeeeeeee: 40, ffffffffffff: 30, "111111111111": 10, "222222222222": 2 };
  for (const [name, hours] of Object.entries(ages)) {
    const when = now - hours * HOUR;
    put(path.join(cs, name, "blob"), 100_000, when);
    fs.utimesSync(path.join(cs, name), new Date(when), new Date(when));
  }
  const full = [{ id: "tmp", path: m.tmp, totalBytes: 1_000_000, availableBytes: 10_000, usedBytes: 990_000, freeFraction: 0.01, level: "critical" }];

  const report = await run(
    m,
    { now, settings: { scratchIdleDays: 90, budgetPercent: 40 }, environment: { readAreas: () => full } },
    { ids: [], cwds: [], dirs: [path.join(cs, "111111111111")] },
  );
  assert.deepEqual(report.removed.map((entry) => path.basename(entry.path)).sort(), ["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"]);
  assert.deepEqual(fs.readdirSync(cs).sort(), ["111111111111", "222222222222"], "the running one and the one used two hours ago");
});

test("undo snapshots past their age are dropped, except a live workspace's, and the total is reported", async () => {
  const m = machine();
  const now = Date.now();
  const repo = (workspace, ageMs) => {
    const dir = checkpointGitDir(workspace);
    put(path.join(dir, "objects", "pack", "blob"), 2000, now - ageMs);
    put(path.join(dir, "HEAD"), 20, now - ageMs);
    fs.utimesSync(dir, new Date(now - ageMs), new Date(now - ageMs));
    return dir;
  };
  const old = repo("/work/old-one", 3 * DAY);
  const live = repo("/work/live-one", 30 * DAY);
  const recent = repo("/work/recent-one", HOUR);

  const report = await run(m, { now, settings: { checkpointMaxAgeDays: 1 } }, { ids: [], cwds: ["/work/live-one"], dirs: [] });

  assert.deepEqual(report.removed.map((entry) => [entry.path, entry.reason]), [[old, "checkpoint"]]);
  assert.equal(report.removed[0].bytes, 2020);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(live), true, "a live chat's workspace");
  assert.equal(fs.existsSync(recent), true);
  assert.equal(report.checkpointBytes, 2 * 2020);
});

test("two runs at once share one pass, and the saved report reads back", async () => {
  const m = machine();
  const first = run(m, { trigger: "hourly" });
  const second = run(m, { trigger: "boot" });
  assert.equal(first, second, "the second call joins the run in progress");
  assert.equal(isDiskJanitorRunning(), true);

  const report = await first;
  assert.equal(isDiskJanitorRunning(), false);
  assert.equal(report.trigger, "hourly");

  const file = path.join(m.agent, "cody-janitor-report.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = readLastJanitorReport();
  assert.deepEqual([saved.trigger, saved.startedAt, saved.finishedAt, saved.freedBytes], [report.trigger, report.startedAt, report.finishedAt, report.freedBytes]);

  fs.writeFileSync(file, "{ not json");
  assert.equal(readLastJanitorReport(), null, "a damaged report reads as no report");
  fs.writeFileSync(file, JSON.stringify({ trigger: "whenever", startedAt: 1, finishedAt: 2 }));
  assert.equal(readLastJanitorReport(), null, "and so does a report of an unknown kind");
});

test("a step that fails is reported and the rest still run", async () => {
  const m = machine();
  const now = Date.now() + 10 * DAY;
  put(path.join(m.tmp, "old-build", "artifact.bin"), 500);

  const report = await run(m, { now, environment: { readAreas: () => { throw new Error("statfs exploded"); } } });

  assert.match(report.errors.join("\n"), /statfs exploded/);
  assert.deepEqual(report.removed.map((entry) => path.basename(entry.path)), ["old-build"]);
});
