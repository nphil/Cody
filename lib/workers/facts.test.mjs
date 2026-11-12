// What matters here (lib/workers/facts.ts): the one-line command Cody sends to
// read a worker must survive any login shell (no quote, backslash, `!`, backtick
// or newline inside) and refuse odd paths; the facts file is read through one
// strict gate whose complaints name the field; and the framed answer is parsed
// into "worker ok" or exactly one problem. The last group runs the REAL command
// with sh against temp directories, so the shell script itself is exercised.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const facts = await jiti.import("./facts.ts");

const base = mkdtempSync(join(tmpdir(), "cody-workers-facts-"));
after(() => rmSync(base, { recursive: true, force: true }));

const FILE = {
  name: "buildbox",
  arch: "x86_64",
  cpus: 8,
  memMB: 16384,
  slots: 2,
  tools: ["node", "rust"],
  limits: { onlyWhenIdle: true },
};
const FACTS = { name: "buildbox", arch: "x86_64", cpus: 8, memMB: 16384, slots: 2, tools: ["node", "rust"], onlyWhenIdle: true };

// ── buildWorkerCheckCommand ──────────────────────────────────────────────────

function scriptOf(command) {
  const match = /^sh -c '([^']*)'$/.exec(command);
  assert.ok(match, `not a single sh -c '…': ${command}`);
  return match[1];
}

test("the check is one line of sh -c with a script free of shell-hostile characters", () => {
  for (const command of [facts.buildWorkerCheckCommand(), facts.buildWorkerCheckCommand({ factsPath: "/tmp/a-b/f.json", workRoot: "/srv/x_y.z" })]) {
    assert.ok(!command.includes("\n"));
    const script = scriptOf(command); // also proves no single quote inside
    for (const bad of ["'", "\\", "!", "`", "\n"]) assert.ok(!script.includes(bad), `script contains ${JSON.stringify(bad)}`);
  }
});

test("the default command reads the contract paths", () => {
  const script = scriptOf(facts.buildWorkerCheckCommand());
  assert.match(script, /F=\/etc\/cody-worker\.json;/);
  assert.match(script, /R=\/srv\/cody-work;/);
});

test("a path with a space, quote, dollar, backtick, semicolon, newline, or no leading slash is refused", () => {
  for (const bad of ["/tmp/a b", "/tmp/a'b", "/tmp/$HOME", "/tmp/`x`", "/tmp/a;rm", "/tmp/a\nb", "relative/path", "", "/tmp/a\\b", "/tmp/a!b"]) {
    assert.throws(() => facts.buildWorkerCheckCommand({ factsPath: bad }), /unsafe path/, `factsPath ${JSON.stringify(bad)}`);
    assert.throws(() => facts.buildWorkerCheckCommand({ workRoot: bad }), /unsafe path/, `workRoot ${JSON.stringify(bad)}`);
  }
});

// ── parseWorkerFacts ─────────────────────────────────────────────────────────

test("the real file shape parses into facts", () => {
  assert.deepEqual(facts.parseWorkerFacts(JSON.stringify(FILE)), { ok: true, facts: FACTS });
});

test("amd64 and arm64 are read as the kernel's names", () => {
  assert.equal(facts.parseWorkerFacts(JSON.stringify({ ...FILE, arch: "amd64" })).facts.arch, "x86_64");
  assert.equal(facts.parseWorkerFacts(JSON.stringify({ ...FILE, arch: "arm64" })).facts.arch, "aarch64");
  assert.equal(facts.parseWorkerFacts(JSON.stringify({ ...FILE, arch: "AArch64" })).facts.arch, "aarch64");
});

test("a minimal file gets one slot, no tools and not-only-when-idle", () => {
  const out = facts.parseWorkerFacts(JSON.stringify({ name: "n", arch: "x86_64", cpus: 4, memMB: 4096 }));
  assert.deepEqual(out, { ok: true, facts: { name: "n", arch: "x86_64", cpus: 4, memMB: 4096, slots: 1, tools: [], onlyWhenIdle: false } });
});

test("tool names are lower-cased, trimmed and listed once", () => {
  const out = facts.parseWorkerFacts(JSON.stringify({ ...FILE, tools: ["Node", " node ", "RUST", "go", "Go"] }));
  assert.deepEqual(out.facts.tools, ["node", "rust", "go"]);
});

test("text that is not JSON is named as such", () => {
  const out = facts.parseWorkerFacts("{nope");
  assert.deepEqual(out, { ok: false, detail: "/etc/cody-worker.json is not valid JSON" });
});

test("each invalid field is named in the complaint", () => {
  const cases = [
    [{ ...FILE, cpus: 0 }, "cpus"],
    [{ ...FILE, memMB: "16384" }, "memMB"],
    [{ ...FILE, tools: ["node", "bad tool!"] }, "tools"],
    [{ ...FILE, tools: "node" }, "tools"],
    [{ ...FILE, arch: "riscv" }, "arch"],
    [{ ...FILE, limits: { onlyWhenIdle: "yes" } }, "limits.onlyWhenIdle"],
    [{ ...FILE, slots: 0 }, "slots"],
    [{ ...FILE, name: "" }, "name"],
  ];
  for (const [file, field] of cases) {
    assert.deepEqual(
      facts.parseWorkerFacts(JSON.stringify(file)),
      { ok: false, detail: `/etc/cody-worker.json: ${field} is missing or not valid` },
      field,
    );
  }
  for (const text of ["[]", "null", "5"]) {
    assert.equal(facts.parseWorkerFacts(text).ok, false);
    assert.match(facts.parseWorkerFacts(text).detail, /the file is missing or not valid/);
  }
});

// ── loadFromMetrics ──────────────────────────────────────────────────────────

test("a metrics reading becomes a worker load with memory available in MB", () => {
  const mb = 1024 * 1024;
  const load = facts.loadFromMetrics({
    cpuPercent: 37.5,
    cores: 8,
    load1: 1.25,
    memTotalBytes: 16000 * mb,
    memUsedBytes: 4000 * mb,
    memPercent: 25,
    at: 1234,
  });
  assert.deepEqual(load, { cpuPercent: 37.5, load1: 1.25, memAvailMB: 12000, at: 1234 });
  const unknown = facts.loadFromMetrics({ cpuPercent: null, cores: null, load1: null, memTotalBytes: 1000 * mb + 600000, memUsedBytes: 0, memPercent: 0, at: 1 });
  assert.equal(unknown.cpuPercent, null);
  assert.equal(unknown.load1, null);
  assert.equal(unknown.memAvailMB, Math.round((1000 * mb + 600000) / mb));
});

// ── parseWorkerProbe over crafted output ─────────────────────────────────────

const STAT_A = "cpu  1000 100 500 8000 400 0 50 0 0 0";
const STAT_B = "cpu  1330 100 600 8300 500 0 50 0 0 0"; // 830 ticks, 400 idle: 51.8% busy
const MEMINFO = [
  "MemTotal:       65667444 kB",
  "MemFree:         2111468 kB",
  "MemAvailable:   22034404 kB",
  "Buffers:          500000 kB",
  "Cached:         15000000 kB",
];
const frame = (cpu, load) => ["@S 8", cpu, ...MEMINFO, load, "@E"];

function probeText({ file = JSON.stringify(FILE, null, 2), root = "yes", jobs = "1", load = [...frame(STAT_A, "0.40 0.30 0.20 1/100 5"), ...frame(STAT_B, "0.50 0.40 0.30 2/200 6")] } = {}) {
  return ["@FACTS", file, "@ROOT", root, "@JOBS", jobs, "@LOAD", ...load, "@END", ""].join("\n");
}

test("a machine with no facts file is not a worker", () => {
  const out = facts.parseWorkerProbe("@NOFILE\n", 1);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not_a_worker");
  assert.match(out.detail, /There is no \/etc\/cody-worker\.json on that machine/);
});

test("an answer that stops early is a failed read, not a verdict", () => {
  const whole = probeText();
  for (const cut of [0, whole.indexOf("@ROOT"), whole.indexOf("@LOAD"), whole.indexOf("@END")]) {
    const out = facts.parseWorkerProbe(whole.slice(0, cut), 1);
    assert.equal(out.ok, false, `cut at ${cut}`);
    assert.equal(out.reason, "read_failed");
  }
  assert.equal(facts.parseWorkerProbe("", 1).reason, "read_failed");
});

test("facts that do not pass the gate come back as bad_facts with the reason", () => {
  const out = facts.parseWorkerProbe(probeText({ file: JSON.stringify({ ...FILE, cpus: 0 }) }), 1);
  assert.deepEqual(out, { ok: false, reason: "bad_facts", detail: "/etc/cody-worker.json: cpus is missing or not valid" });
  assert.equal(facts.parseWorkerProbe(probeText({ file: "garbage" }), 1).reason, "bad_facts");
});

test("a work root that is not writable is no_work_root", () => {
  const out = facts.parseWorkerProbe(probeText({ root: "no" }), 1);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no_work_root");
  assert.match(out.detail, /\/srv\/cody-work is missing or not writable/);
});

test("a good answer gives the facts, the live job count and the load from the two frames", () => {
  const out = facts.parseWorkerProbe(probeText({ jobs: "3" }).replaceAll("\n", "\r\n"), 999);
  assert.equal(out.ok, true);
  assert.deepEqual(out.facts, FACTS);
  assert.equal(out.liveJobs, 3);
  assert.deepEqual(out.load, {
    cpuPercent: 51.8,
    load1: 0.5, // from the second (latest) frame
    memAvailMB: Math.round((22034404 * 1024) / (1024 * 1024)),
    at: 999,
  });
});

test("one frame is enough for memory and load but gives no cpu percentage", () => {
  const out = facts.parseWorkerProbe(probeText({ load: frame(STAT_A, "0.90 0.5 0.5 1/1 1") }), 5);
  assert.equal(out.ok, true);
  assert.equal(out.load.cpuPercent, null);
  assert.equal(out.load.load1, 0.9);
});

test("garbage frames still pass, with no load reading", () => {
  const out = facts.parseWorkerProbe(probeText({ load: ["head: cannot open '/proc/stat'", "@S x", "nonsense"] }), 1);
  assert.equal(out.ok, true);
  assert.equal(out.load, null);
  assert.deepEqual(out.facts, FACTS);
});

test("a job count that is not a positive number reads as zero", () => {
  for (const jobs of ["", "x", "-2", "0"]) assert.equal(facts.parseWorkerProbe(probeText({ jobs }), 1).liveJobs, 0, JSON.stringify(jobs));
});

// ── the real command, run by sh ──────────────────────────────────────────────

let counter = 0;
function fixture({ facts: factsFile = true, root = true } = {}) {
  const dir = join(base, `fx${++counter}`);
  mkdirSync(dir);
  const factsPath = join(dir, "cody-worker.json");
  const workRoot = join(dir, "work");
  if (factsFile) writeFileSync(factsPath, JSON.stringify(FILE));
  if (root) mkdirSync(workRoot);
  return { dir, factsPath, workRoot };
}

async function runCheck({ factsPath, workRoot }) {
  const command = facts.buildWorkerCheckCommand({ factsPath, workRoot });
  const child = spawn("sh", ["-c", command]);
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.resume();
  const done = Promise.withResolvers();
  child.on("close", done.resolve);
  child.on("error", done.reject);
  await done.promise;
  return facts.parseWorkerProbe(stdout, Date.now());
}

test("a real check of a fresh work root finds the facts, no jobs, and a live reading", async () => {
  const fx = fixture();
  const out = await runCheck(fx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.facts, FACTS);
  assert.equal(out.liveJobs, 0);
  assert.ok(out.load, "this Linux box has /proc, so a reading is expected");
  assert.ok(out.load.memAvailMB > 0);
});

test("a job directory whose .pid is a live process counts as one running job", async () => {
  const fx = fixture();
  mkdirSync(join(fx.workRoot, "j-aaa-1"));
  writeFileSync(join(fx.workRoot, "j-aaa-1", ".pid"), `${process.pid}\n`);
  const out = await runCheck(fx);
  assert.equal(out.ok, true);
  assert.equal(out.liveJobs, 1);
  assert.ok(existsSync(join(fx.workRoot, "j-aaa-1")));
});

test("an old job directory with nothing running is cleaned up; a recent one is kept but not counted", async () => {
  const fx = fixture();
  const stale = join(fx.workRoot, "j-old-1");
  const recent = join(fx.workRoot, "j-new-1");
  const unrelated = join(fx.workRoot, "keep-me");
  for (const dir of [stale, recent, unrelated]) mkdirSync(dir);
  writeFileSync(join(stale, "out.txt"), "left behind");
  writeFileSync(join(stale, ".pid"), "999999999\n"); // not a live pid
  const old = new Date(Date.now() - 13 * 3600 * 1000);
  utimesSync(stale, old, old);
  utimesSync(unrelated, old, old);
  const out = await runCheck(fx);
  assert.equal(out.ok, true);
  assert.equal(out.liveJobs, 0);
  assert.ok(!existsSync(stale), "the stale job dir should be removed");
  assert.ok(existsSync(recent), "a recent job dir stays");
  assert.ok(existsSync(unrelated), "only j-* directories are ever touched");
});

test("an old job directory whose process is alive is not removed", async () => {
  const fx = fixture();
  const dir = join(fx.workRoot, "j-live-1");
  mkdirSync(dir);
  writeFileSync(join(dir, ".pid"), String(process.pid));
  const old = new Date(Date.now() - 20 * 3600 * 1000);
  utimesSync(dir, old, old);
  const out = await runCheck(fx);
  assert.equal(out.liveJobs, 1);
  assert.ok(existsSync(dir));
});

test("a real check on a machine with no facts file says not_a_worker", async () => {
  const fx = fixture({ facts: false });
  const out = await runCheck(fx);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not_a_worker");
});

test("a real check with a missing or non-directory work root says no_work_root", async () => {
  const missing = fixture({ root: false });
  assert.equal((await runCheck(missing)).reason, "no_work_root");
  const notDir = fixture({ root: false });
  writeFileSync(notDir.workRoot, "i am a file");
  assert.equal((await runCheck(notDir)).reason, "no_work_root");
});
