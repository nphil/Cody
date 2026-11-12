import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const crash = await jiti.import("./engine-crash.ts");
const { describeDiskError } = await jiti.import("./disk-space.ts");

const areas = [
  { id: "tmp", path: "/tmp", freeFraction: 0.4 },
  { id: "data", path: "/data/agent-home/.omp", freeFraction: 0.02 },
];

test("SIGKILL while the container's oom_kill counter moved is out of memory, whatever the engine last said", () => {
  const verdict = crash.classifyEngineExit({ code: null, signal: "SIGKILL", stderrTail: "[tool] bash finished\n", cgroup: { oomKill: 1, pidsMax: 0 } });
  assert.equal(verdict.reason, "out_of_memory");
  assert.equal(verdict.detail, null);
  assert.equal(crash.classifyEngineExit({ code: 137, signal: null, stderrTail: "", cgroup: { oomKill: 2 } }).reason, "out_of_memory");
});

test("a SIGKILL with no oom_kill movement is not blamed on memory", () => {
  const verdict = crash.classifyEngineExit({ code: null, signal: "SIGKILL", stderrTail: "", cgroup: { oomKill: 0, pidsMax: 0 } });
  assert.equal(verdict.reason, "crashed");
  assert.equal(verdict.signal, "SIGKILL");
  assert.equal(crash.describeEngineCrash({ ...verdict, recovery: "manual" }).headline, "The engine crashed on its own (stopped by SIGKILL).");
  // The counter moved but the engine exited by itself: some other process in the container was the victim.
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: "boom", cgroup: { oomKill: 1 } }).reason, "crashed");
});

test("an engine that says it is out of memory is out of memory", () => {
  const tail = "<--- Last few GCs --->\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
  assert.equal(crash.classifyEngineExit({ code: 134, signal: null, stderrTail: tail }).reason, "out_of_memory");
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: "fatal: out of memory" }).reason, "out_of_memory");
});

test("ENOSPC names the disk the failing path lives on", () => {
  const tmp = "Error: ENOSPC: no space left on device, write '/tmp/cody-scratch/abc/out.log'";
  assert.deepEqual(
    (({ reason, disk, quota }) => ({ reason, disk, quota }))(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: `${tmp}\n`, diskAreas: areas })),
    { reason: "disk_full", disk: "tmp", quota: false },
  );
  const data = "error: ENOSPC: no space left on device, open '/data/agent-home/.omp/agent/sessions/x.jsonl'";
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: data, diskAreas: areas }).disk, "data");
});

test("a disk error with no path names the fullest disk, and with no disks names none", () => {
  const tail = "ENOSPC: no space left on device";
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: tail, diskAreas: areas }).disk, "data");
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: tail }).disk, null);
});

test("EDQUOT, including the unnamed errno npm and libuv print, is a quota", () => {
  const verdict = crash.classifyEngineExit({
    code: 1,
    signal: null,
    stderrTail: "Unknown system error -122: Unknown system error -122, open '/data/home/.npm/_cacache/tmp/ce185227'\n",
    diskAreas: areas,
  });
  assert.equal(verdict.reason, "disk_full");
  assert.equal(verdict.quota, true);
  assert.equal(crash.describeEngineCrash({ ...verdict, recovery: "manual" }).headline, "The server's disk quota is used up, so this chat's engine stopped.");
});

test("the disk patterns answer like describeDiskError, the one place that knows the errno shapes", () => {
  const inputs = [
    "EDQUOT: disk quota exceeded, write",
    "Unknown system error -122",
    "Unknown system error -69",
    "ENOSPC: no space left on device, write",
    "write failed: No space left on device",
    "installed pi-coding-agent@1.122.0",
    "exited with code 1",
    "TypeError: x is not a function",
  ];
  for (const text of inputs) {
    const verdict = crash.classifyEngineExit({ code: 1, signal: null, stderrTail: text });
    const shared = describeDiskError(text);
    assert.equal(verdict.reason === "disk_full", shared !== null, text);
    if (shared) assert.equal(verdict.quota, shared === "quota", text);
  }
});

test("the thread pool refusing to start is the pids limit", () => {
  const tail = [
    "thread '<unnamed>' panicked at crates/natives/src/pool.rs:42:10:",
    "Failed to build the thread pool: ThreadPoolBuildError { kind: IOError(Os { code: 11, kind: WouldBlock, message: \"Resource temporarily unavailable\" }) }",
    "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
  ].join("\n");
  assert.equal(crash.classifyEngineExit({ code: 101, signal: null, stderrTail: tail }).reason, "too_many_processes");
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: "pthread_create failed: Resource temporarily unavailable" }).reason, "too_many_processes");
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: "Error: spawn EAGAIN: cannot fork a new thread" }).reason, "too_many_processes");
});

test("a moving pids.events counter counts only when the engine has nothing else to blame", () => {
  assert.equal(crash.classifyEngineExit({ code: null, signal: "SIGABRT", stderrTail: "", cgroup: { pidsMax: 12 } }).reason, "too_many_processes");
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: "", cgroup: { pidsMax: 3 } }).reason, "too_many_processes");
  assert.equal(crash.classifyEngineExit({ code: 1, signal: null, stderrTail: "TypeError: undefined is not an object", cgroup: { pidsMax: 3 } }).reason, "crashed");
});

test("a generic panic shows the last error line, not the stack under it", () => {
  const tail = [
    "error: Unhandled error. TypeError: undefined is not an object (evaluating 'session.state.model')",
    "    at handlePrompt (/opt/omp/dist/agent.js:1204:31)",
    "    at async run (/opt/omp/dist/agent.js:88:9)",
    "",
    "Bun v1.3.2 (Linux x64)",
  ].join("\n");
  const verdict = crash.classifyEngineExit({ code: 1, signal: null, stderrTail: tail });
  assert.equal(verdict.reason, "crashed");
  assert.equal(verdict.detail, "error: Unhandled error. TypeError: undefined is not an object (evaluating 'session.state.model')");
});

test("a clean exit in the middle of a run is still a crash, and says how it stopped", () => {
  const verdict = crash.classifyEngineExit({ code: 0, signal: null, stderrTail: "" });
  assert.equal(verdict.reason, "crashed");
  assert.equal(verdict.detail, null);
  assert.equal(crash.describeEngineCrash({ ...verdict, recovery: "manual" }).headline, "The engine crashed on its own (exit code 0).");
});

test("the line shown is one line, capped, with no colour codes and no credentials", () => {
  const noisy = "\u001b[31merror\u001b[0m: request failed with Authorization: Bearer sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 api_key=abcd1234efgh5678 \u0007\t  twice";
  const line = crash.lastErrorLine(`${noisy}\n`);
  assert.doesNotMatch(line, /\u001b|\u0007|\t|sk-ant|abcd1234/);
  assert.match(line, /^error: request failed with Authorization: …/);
  assert.equal(line.includes("\n"), false);
  const capped = crash.lastErrorLine(`${"x ".repeat(400)}\n`);
  assert.ok(capped.length <= crash.ENGINE_CRASH_DETAIL_MAX);
  assert.match(capped, /…$/);
  assert.equal(crash.lastErrorLine(""), null);
  assert.equal(crash.lastErrorLine("  \n\n"), null);
});

test("cgroup counters: files parse, deltas never go negative and an unknown end reads as no movement", () => {
  assert.deepEqual(crash.parseCgroupEvents("low 0\nhigh 0\nmax 0\noom 1\noom_kill 3\noom_group_kill 0\n"), { low: 0, high: 0, max: 0, oom: 1, oom_kill: 3, oom_group_kill: 0 });
  assert.deepEqual(crash.parseCgroupEvents("garbage\n"), {});
  assert.deepEqual(crash.cgroupDeltas({ oomKill: 3, pidsMax: 0 }, { oomKill: 4, pidsMax: 0 }), { oomKill: 1, pidsMax: 0 });
  assert.deepEqual(crash.cgroupDeltas({ oomKill: 5, pidsMax: 5 }, { oomKill: 2, pidsMax: 5 }), { oomKill: 0, pidsMax: 0 });
  assert.deepEqual(crash.cgroupDeltas(null, { oomKill: 4, pidsMax: 9 }), { oomKill: 0, pidsMax: 0 });
  assert.deepEqual(crash.cgroupDeltas({ oomKill: null, pidsMax: 1 }, { oomKill: 1, pidsMax: 2 }), { oomKill: 0, pidsMax: 1 });
});

test("what happens next is part of the sentence", () => {
  const base = { reason: "out_of_memory", detail: null, disk: null, quota: false, code: null, signal: "SIGKILL" };
  assert.equal(
    crash.engineCrashSentence({ ...base, recovery: "automatic" }),
    "The server ran out of memory and stopped this chat's engine. Cody is restarting this chat automatically.",
  );
  assert.equal(
    crash.engineCrashSentence({ ...base, recovery: "manual" }),
    "The server ran out of memory and stopped this chat's engine. Send a message to continue.",
  );
  assert.match(crash.engineCrashSentence({ ...base, recovery: "gave_up" }), /stopped trying\. Send a message to continue\.$/);
  assert.match(crash.engineCrashSentence({ ...base, reason: "disk_full", disk: "data", recovery: "automatic" }), /data disk space is full.*once there is room on the disk\.$/);
  assert.equal(
    crash.engineCrashSentence({ ...base, reason: "crashed", detail: "panic: boom", recovery: "manual" }),
    "The engine crashed on its own. Last error: panic: boom Send a message to continue.",
  );
  assert.equal(
    crash.engineCrashSentence({ ...base, reason: "server_restarted", recovery: "automatic" }),
    "Cody's server restarted, which stopped this chat's engine. Cody is picking this chat back up.",
  );
});

test("a notice read back from JSON keeps only what it knows", () => {
  const stored = { reason: "crashed", recovery: "manual", at: 1_700_000_000_000, detail: "boom \u001b[31m", disk: "elsewhere", quota: "yes", code: 1, signal: "rm -rf", extra: { huge: true } };
  assert.deepEqual(crash.readEngineCrashNotice(stored), { reason: "crashed", recovery: "manual", at: 1_700_000_000_000, detail: "boom", disk: null, quota: false, code: 1, signal: null });
  assert.equal(crash.readEngineCrashNotice({ ...stored, reason: "meteor" }), null);
  assert.equal(crash.readEngineCrashNotice({ ...stored, at: "yesterday" }), null);
  assert.equal(crash.readEngineCrashNotice("nope"), null);
  const row = crash.engineCrashRow(crash.readEngineCrashNotice(stored));
  assert.equal(row.customType, crash.ENGINE_CRASH_CUSTOM_TYPE);
  assert.equal(row.display, true);
  assert.equal(row.timestamp, 1_700_000_000_000);
});

test("every locale carries these words, English matching the server's", () => {
  const dir = path.join(import.meta.dirname, "i18n", "locales");
  const locales = Object.fromEntries(["en", "ja", "zh-CN"].map((name) => [name, JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"))]));
  for (const [key, english] of Object.entries(crash.ENGINE_CRASH_TEXT)) {
    assert.equal(locales.en[key], english, `en.json "${key}" must equal the server's English`);
    for (const name of ["ja", "zh-CN"]) assert.ok(locales[name][key] && locales[name][key] !== english, `${name}.json "${key}" is translated`);
  }
});
