import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * A run that stalls, dies or is cut off by a restart is carried on by the run
 * supervisor. While a disk is almost full it must not be: the restart would
 * start an engine and a turn into the disk the run most likely died of. What is
 * pinned here is what the owner would notice: nothing is closed or started,
 * no attempt is spent, the log says so once per wait, and the run carries on by
 * itself as soon as there is room. The clock, the sessions and the disk are the
 * test's own; nothing waits.
 */
const root = mkdtempSync(join(tmpdir(), "cody-run-supervisor-disk-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
after(() => rmSync(root, { recursive: true, force: true }));
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.CODY_RUN_RECOVERY;
delete process.env.OMP_WEB_RUN_RECOVERY;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createRunRecovery } = await jiti.import("./supervisor.ts");
const journal = await jiti.import("./journal.ts");

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-09T06:00:00Z");
const ZONE = "America/New_York";

const prompts = (session) => session.commands.filter((command) => command.type === "prompt");
const toolStart = (id, name, args = {}) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
const engineExit = [
  { type: "notice", level: "error", reason: "engine_exit", message: "The omp process for this session exited unexpectedly." },
  { type: "agent_end", isTerminal: true, messages: [] },
];

const REFUSAL = {
  code: "disk_full",
  area: { id: "tmp", path: "/tmp", totalBytes: 150, availableBytes: 4, usedBytes: 146, freeFraction: 0.03, level: "critical" },
  message: "The server's temporary disk space is almost full (3% free: 4.5 GB of 150 GB), so Cody is not starting new work right now.",
};

/** The surface of a live session the supervisor uses: the wrapper's, with a switch for what a test varies. */
class FakeSession {
  constructor(sessionId, { running = true } = {}) {
    this.sessionId = sessionId;
    this.sessionFile = `/sessions/${sessionId}.jsonl`;
    this.cwd = "/work/my-project";
    this.alive = true;
    this.running = running;
    this.observers = new Set();
    this.closeListeners = [];
    this.commands = [];
    this.destroyReasons = [];
  }

  isAlive() { return this.alive; }
  isRunning() { return this.alive && this.running; }
  hasPendingInput() { return false; }
  livePhase() { return { running: this.isRunning(), streaming: this.running, promptRunning: false, bashRunning: false, compacting: false }; }
  observeEvents(observer) {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  onClose(listener) {
    if (!this.alive) {
      listener();
      return () => {};
    }
    this.closeListeners.push(listener);
    return () => {};
  }
  async send(command) {
    this.commands.push(command);
    if (command.type === "prompt") this.running = true;
    return command.type === "get_state" ? {} : { delivery: "started" };
  }
  async destroyAndWait(reason) {
    this.destroyReasons.push(reason);
    if (!this.alive) return;
    this.alive = false;
    this.running = false;
    for (const listener of this.closeListeners.splice(0)) listener();
  }
  emit(...frames) {
    for (const frame of frames) for (const observer of [...this.observers]) observer(frame);
  }
}

/** One supervisor on a clock of the test's own, and a disk whose refusal (or none) the test sets with `w.disk`. */
function world() {
  rmSync(journal.runJournalPath(), { force: true });
  const clock = { now: T0 };
  const w = { clock, disk: null, notices: [], created: [], acquireLog: [] };
  w.rr = createRunRecovery({
    now: () => clock.now,
    bootAt: T0,
    zoneFor: () => ZONE,
    describeChat: async () => ({ title: "Fix login", project: "my-project" }),
    send: (draft) => { w.notices.push(draft); },
    isShuttingDown: () => false,
    enabled: () => true,
    schedule: () => () => {},
    sleep: async () => {},
    diskRefusal: () => w.disk,
    acquire: async (sessionId) => {
      w.acquireLog.push(sessionId);
      const session = new FakeSession(sessionId, { running: false });
      w.created.push(session);
      w.rr.supervise(session, { judgesTools: true });
      return session;
    },
  });
  w.advance = (ms) => { clock.now += ms; };
  /** A chat whose run has begun; the supervisor sees its agent_start. */
  w.run = (sessionId) => {
    const session = new FakeSession(sessionId);
    w.rr.supervise(session, { judgesTools: true });
    session.emit({ type: "agent_start" });
    return session;
  };
  return w;
}

/** The `[run-recovery]` lines the log gets while `work` runs. */
async function logged(work) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    await work();
  } finally {
    console.warn = original;
  }
  return lines;
}

const postponements = (lines, sessionId) => lines.filter((line) => line.includes("postponing") && line.includes(sessionId));

test("a stalled run waits while the disk is almost full: nothing is closed or started, no attempt is spent, and the log says so once", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "bash", { command: "sleep 100000", timeout: 600 }));
  w.advance(25 * MINUTE); // ten minutes of its own timeout and fifteen of grace
  w.disk = REFUSAL;

  const lines = await logged(async () => {
    for (let look = 0; look < 4; look += 1) {
      await w.rr.tick();
      w.advance(MINUTE);
    }
  });

  assert.equal(session.alive, true, "the stalled engine is left as it is: closing it is the first step of a restart that cannot go on");
  assert.deepEqual(session.destroyReasons, []);
  assert.deepEqual(w.acquireLog, [], "no engine is started into the disk");
  assert.deepEqual(w.created.flatMap(prompts), [], "and no turn");
  assert.deepEqual(journal.findRun("chat-1").recoveries, [], "the wait is not an attempt, so it can never use up the cap");
  assert.equal(w.notices.length, 0, "nothing is announced as done");
  const waiting = postponements(lines, "chat-1");
  assert.equal(waiting.length, 1, `four looks, one line: ${JSON.stringify(lines)}`);
  assert.match(waiting[0], /^\[run-recovery\] postponing the restart of chat chat-1 until there is room on the disk: The server's temporary disk space is almost full/);

  // Room is made: the very next look carries the run on, exactly as it would have.
  w.disk = null;
  const resumed = await logged(() => w.rr.tick());
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  assert.equal(session.alive, false, "the stalled engine is closed now");
  assert.match(session.destroyReasons[0], /^stalled: `bash` had not answered for 29 minutes/);
  const [prompt] = prompts(w.created[0]);
  assert.equal(prompt.clientMessageId, "recover-chat-1-1", "the wait did not count: this is the first attempt");
  assert.equal(journal.findRun("chat-1").recoveries.length, 1);
  assert.equal(w.notices.length, 1);
  assert.ok(resumed.some((line) => line.startsWith("[run-recovery] restarting chat chat-1 (attempt 1 of 3)")));
  assert.deepEqual(postponements(resumed, "chat-1"), []);

  // The next time the disk fills while that chat is stuck is a new wait, with its own line.
  const replacement = w.created[0];
  replacement.emit(toolStart("t2", "bash", { command: "sleep 100000", timeout: 600 }));
  w.advance(25 * MINUTE);
  w.disk = REFUSAL;
  const again = await logged(async () => {
    await w.rr.tick();
    w.advance(MINUTE);
    await w.rr.tick();
  });
  assert.equal(postponements(again, "chat-1").length, 1, "one line per wait, not one line ever");
  assert.equal(replacement.alive, true);
});

test("each waiting chat gets its own line, and none of them is counted as a restart", async () => {
  const w = world();
  const first = w.run("chat-a");
  const second = w.run("chat-b");
  for (const session of [first, second]) session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE); // an `edit` has no timeout: twenty quiet minutes is overdue
  w.disk = REFUSAL;

  const lines = await logged(async () => {
    await w.rr.tick();
    w.advance(MINUTE);
    await w.rr.tick();
  });
  assert.equal(postponements(lines, "chat-a").length, 1);
  assert.equal(postponements(lines, "chat-b").length, 1);
  assert.deepEqual(w.acquireLog, []);
  assert.equal(journal.findRun("chat-a").recoveries.length + journal.findRun("chat-b").recoveries.length, 0);
});

test("a crashed engine's restart waits for room too, and comes back by itself once there is some", async () => {
  const w = world();
  const session = w.run("chat-2");
  w.disk = REFUSAL;
  session.emit(...engineExit);
  await session.destroyAndWait("the engine exited");
  w.advance(31_000);

  const lines = await logged(async () => {
    await w.rr.tick();
    // Nothing else would bring it back: the dead engine has no watchdog left to look at it.
    assert.ok(w.rr.state.pending.has("chat-2"), "queued for the next look");
    for (let look = 0; look < 3; look += 1) {
      w.advance(MINUTE);
      await w.rr.tick();
    }
  });
  assert.deepEqual(w.acquireLog, []);
  assert.equal(postponements(lines, "chat-2").length, 1, "four looks, one line");
  assert.ok(journal.findRun("chat-2"), "the run's entry is kept: a restart of the server in the meantime still resumes it");
  assert.deepEqual(journal.findRun("chat-2").recoveries, []);

  w.disk = null;
  w.advance(MINUTE);
  await logged(() => w.rr.tick());
  assert.deepEqual(w.acquireLog, ["chat-2"]);
  const [prompt] = prompts(w.created[0]);
  assert.match(prompt.message, /The engine process exited unexpectedly at /);
  assert.equal(prompt.clientMessageId, "recover-chat-2-1");
  assert.equal(journal.findRun("chat-2").recoveries.length, 1);
  assert.equal(w.rr.state.pending.has("chat-2"), false, "and it is not queued twice");
});

test("at boot a run the restart cut off is not resumed into a full disk, and is picked up by the watchdog when there is room", async () => {
  const w = world();
  journal.beginRun("chat-boot", T0 - 20 * MINUTE);
  w.disk = REFUSAL;

  const lines = await logged(async () => {
    assert.equal(await w.rr.resume(), 0, "nothing was resumed");
    w.advance(MINUTE);
    await w.rr.tick();
  });
  assert.deepEqual(w.acquireLog, []);
  assert.equal(postponements(lines, "chat-boot").length, 1);
  assert.deepEqual(journal.findRun("chat-boot").recoveries, [], "no attempt spent");

  w.disk = null;
  w.advance(MINUTE);
  await logged(() => w.rr.tick());
  assert.deepEqual(w.acquireLog, ["chat-boot"]);
  const [prompt] = prompts(w.created[0]);
  assert.match(prompt.message, /^This is an automatic message from Cody, not from the user\. Cody's server restarted at /);
  assert.equal(journal.findRun("chat-boot").recoveries.length, 1);
});
