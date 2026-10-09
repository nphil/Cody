import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The run supervisor, fed the frames a session really emits and the clock it
 * really runs on. Nothing here waits: the clock is the test's, a "session" is
 * a small object with the surface the wrapper offers, and the supervisor's
 * collaborators (starting a chat again, sending a push) are recorded. What is
 * pinned is what a person would notice: which stalls are recovered, with which
 * words, how many times, and what the journal says afterwards.
 */
const root = mkdtempSync(join(tmpdir(), "cody-run-supervisor-"));
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
const shutdown = await jiti.import("./shutdown.ts");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2026-10-09 is daylight time in New York: 06:00 UTC is 02:00 EDT.
const T0 = Date.parse("2026-10-09T06:00:00Z");
const ZONE = "America/New_York";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const asked = (session) => session.commands.filter((command) => command.type === "get_state").length;
const prompts = (session) => session.commands.filter((command) => command.type === "prompt");
const toolStart = (id, name, args = {}) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
const toolUpdate = (id, name) => ({ type: "tool_execution_update", toolCallId: id, toolName: name, partialResult: {} });
const engineExit = [
  { type: "notice", level: "error", reason: "engine_exit", message: "The omp process for this session exited unexpectedly." },
  { type: "agent_end", isTerminal: true, messages: [] },
];

/** The surface of a live session the supervisor uses: the wrapper's, with a switch for everything a test varies. */
class FakeSession {
  constructor(sessionId, { running = true, stateReply = "answer" } = {}) {
    this.sessionId = sessionId;
    this.sessionFile = `/sessions/${sessionId}.jsonl`;
    this.cwd = "/work/my-project";
    this.alive = true;
    this.running = running;
    this.pendingInput = false;
    this.compacting = false;
    this.stateReply = stateReply;
    this.observers = new Set();
    this.closeListeners = [];
    this.commands = [];
    this.destroyReasons = [];
    this.destroyGate = null;
  }

  isAlive() { return this.alive; }
  isRunning() { return this.alive && this.running; }
  hasPendingInput() { return this.pendingInput; }
  livePhase() { return { running: this.isRunning(), streaming: this.running, promptRunning: false, bashRunning: false, compacting: this.compacting }; }
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
    if (command.type !== "get_state") return { delivery: "started" };
    if (this.stateReply === "never") return new Promise(() => {});
    return {};
  }
  async destroyAndWait(reason) {
    this.destroyReasons.push(reason);
    if (!this.alive) return;
    this.alive = false;
    this.running = false;
    // The wrapper tells every close listener before its child has exited.
    for (const listener of this.closeListeners.splice(0)) listener();
    if (this.destroyGate) await this.destroyGate;
  }
  emit(...frames) {
    for (const frame of frames) for (const observer of [...this.observers]) observer(frame);
  }
}

/**
 * One supervisor on a clock of the test's own. `acquire` starts a chat again
 * the way the session manager does: a new idle session, supervised on arrival.
 */
function world(overrides = {}, { failAcquire = 0, chatGone = false, omit = [] } = {}) {
  rmSync(journal.runJournalPath(), { force: true });
  const clock = { now: T0 };
  const notices = [];
  const scheduled = [];
  const slept = [];
  const created = [];
  const acquireLog = [];
  let failures = failAcquire;
  const w = { clock, notices, scheduled, slept, created, acquireLog };
  const deps = {
    now: () => clock.now,
    bootAt: T0,
    zoneFor: () => ZONE,
    describeChat: async () => ({ title: "Fix login", project: "my-project" }),
    send: (draft) => { notices.push(draft); },
    isShuttingDown: () => false,
    enabled: () => true,
    schedule: (run, delayMs) => {
      const entry = { run, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
    sleep: async (ms) => { slept.push(ms); },
    acquire: async (sessionId) => {
      acquireLog.push(sessionId);
      if (chatGone) return null;
      if (failures > 0) {
        failures -= 1;
        throw new Error("the engine would not start");
      }
      const session = new FakeSession(sessionId, { running: false });
      created.push(session);
      w.rr.supervise(session, { judgesTools: true });
      return session;
    },
    ...overrides,
  };
  for (const key of omit) delete deps[key];
  w.rr = createRunRecovery(deps);
  w.advance = (ms) => { clock.now += ms; };
  /** A chat whose run has begun; the supervisor sees its agent_start. */
  w.run = (sessionId, options = {}) => {
    const session = new FakeSession(sessionId);
    w.rr.supervise(session, { judgesTools: options.judgesTools ?? true });
    session.emit({ type: "agent_start" });
    return session;
  };
  return w;
}

// ---------------------------------------------------------------------------
// The watchdog: tools
// ---------------------------------------------------------------------------

test("a tool call that outlives its own timeout restarts the chat once, and the agent is told what happened", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "bash", { command: "sleep 100000", timeout: 600 }));

  w.advance(24 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0, "inside its ten minutes and the fifteen of grace");

  w.advance(MINUTE);
  await w.rr.tick();
  assert.equal(session.alive, false, "the stalled engine was closed");
  assert.match(session.destroyReasons[0], /^stalled: `bash` had not answered for 25 minutes/, "and the close says why");
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  const [replacement] = w.created;
  const [prompt, ...more] = prompts(replacement);
  assert.equal(more.length, 0);
  assert.equal(prompt.streamingBehavior, "steer", "it interrupts rather than queues");
  assert.equal(prompt.clientMessageId, "recover-chat-1-1");
  assert.equal(prompt.timeZone, ZONE);
  assert.equal(
    prompt.message,
    "This is an automatic message from Cody, not from the user. `bash` had not answered for 25 minutes (it started at 2026-10-09 02:00 EDT). "
      + "Cody restarted the engine at 2026-10-09 02:25 EDT. "
      + "Tool calls that were still running have unknown results, and any subagents or background jobs were stopped. "
      + "Check what actually finished (files, git, job output), then carry on with the task you were working on.",
  );

  const entry = journal.findRun("chat-1");
  assert.deepEqual(entry.recoveries, [{ at: T0 + 25 * MINUTE, reason: "`bash` had not answered for 25 minutes (it started at 2026-10-09 02:00 EDT)" }]);

  assert.equal(w.notices.length, 1);
  assert.deepEqual(
    { event: w.notices[0].event, sessionId: w.notices[0].sessionId, title: w.notices[0].title, tags: w.notices[0].tags },
    { event: "error", sessionId: "chat-1", title: "Error · Fix login", tags: ["my-project"] },
  );
  assert.equal(w.notices[0].body, "Stuck since 2026-10-09 02:00 EDT: `bash` never answered. Cody restarted the engine at 2026-10-09 02:25 EDT and asked the agent to carry on.");

  // The replacement is a fresh chat with nothing in flight: later looks leave it alone.
  w.advance(10 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 1, "exactly one recovery");
  assert.equal(w.notices.length, 1);
});

test("an edit that keeps reporting progress is never overdue, and one that goes quiet is after twenty minutes", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit", { path: "a.ts" }));
  for (let step = 0; step < 8; step += 1) {
    w.advance(10 * MINUTE);
    session.emit(toolUpdate("t1", "edit"));
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 0, "eighty minutes, never quiet for twenty");

  w.advance(19 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0);
  w.advance(MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  assert.equal(journal.findRun("chat-1").recoveries[0].reason, "`edit` had not answered for 20 minutes (it started at 2026-10-09 02:00 EDT)");
});

test("a command run with no deadline is never overdue and may be silent for hours", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "bash", { command: "make all", timeout: 0 }));
  for (let step = 0; step < 18; step += 1) {
    w.advance(10 * MINUTE);
    await w.rr.tick();
  }
  await settle();
  assert.equal(w.acquireLog.length, 0, "three hours of silence from a command that was told it has all the time it needs");
  assert.equal(session.alive, true);
  assert.ok(asked(session) > 0, "the engine was still asked whether it was there, and answered");

  const control = world();
  const plain = control.run("chat-2");
  plain.emit(toolStart("t1", "bash", { command: "make all" }));
  control.advance(20 * MINUTE);
  await control.rr.tick();
  assert.deepEqual(control.acquireLog, ["chat-2"], "the same command with the default timeout is overdue at twenty minutes");
});

test("tools that wait on others never go overdue: wait, ask, task, yield and goal", async () => {
  for (const name of ["wait", "ask", "task", "yield", "goal"]) {
    const w = world();
    const session = w.run(`chat-${name}`);
    session.emit(toolStart("t1", name));
    for (let step = 0; step < 18; step += 1) {
      w.advance(10 * MINUTE);
      // The engine keeps talking while the work it waits on goes on.
      session.emit({ type: "subagent_progress" });
      await w.rr.tick();
    }
    assert.equal(w.acquireLog.length, 0, `${name} for three hours`);
  }

  const control = world();
  const session = control.run("chat-edit");
  session.emit(toolStart("t1", "edit"));
  for (let step = 0; step < 3; step += 1) {
    control.advance(10 * MINUTE);
    session.emit({ type: "subagent_progress" });
    await control.rr.tick();
  }
  assert.deepEqual(control.acquireLog, ["chat-edit"], "an edit in the same chatter IS overdue, so the quiet above was the tools' doing");
});

test("an engine whose tools are not omp's is never judged call by call", async () => {
  const w = world();
  const session = w.run("chat-1", { judgesTools: false });
  session.emit(toolStart("t1", "bash", { command: "make" }));
  for (let step = 0; step < 10; step += 1) {
    w.advance(5 * MINUTE);
    session.emit({ type: "message_update" });
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 0, "fifty minutes inside a tool call another engine may time out in its own way");

  w.advance(60 * MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"], "an hour of silence is still a stall, whatever the engine");
});

// ---------------------------------------------------------------------------
// The watchdog: when it must not judge
// ---------------------------------------------------------------------------

test("a chat waiting on the person is never judged, and the clocks start again when the wait ends", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  session.pendingInput = true;
  for (let step = 0; step < 5; step += 1) {
    w.advance(HOUR);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 0, "five hours at an approval dialog");

  session.pendingInput = false;
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0, "the minute after the answer is not judged against the hours before it");
  w.advance(19 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0);
  w.advance(MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"], "twenty quiet minutes after the answer is a stall");
  assert.equal(
    journal.findRun("chat-1").recoveries[0].reason,
    "`edit` had not answered for 20 minutes (it started at 2026-10-09 02:00 EDT)",
    "the hours at the dialog are not the call's time, but the call still says when it really began",
  );
  assert.match(w.notices[0].body, /^Stuck since 2026-10-09 07:00 EDT: `edit` never answered\./, "and it has been stuck since the answer");
});

test("a chat that is compacting is never judged", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  session.compacting = true;
  for (let step = 0; step < 4; step += 1) {
    w.advance(HOUR);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 0);
  session.compacting = false;
  w.advance(5 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0, "and the clocks start from the end of the compaction");
});

test("a session the wrapper says is not running is not judged, and a run whose end was missed is forgotten", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  session.running = false;
  for (let look = 1; look <= 2; look += 1) {
    w.advance(HOUR);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 0);
  assert.ok(journal.findRun("chat-1"), "two looks are not enough to be sure it is over");

  w.advance(HOUR);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0);
  assert.equal(journal.findRun("chat-1"), null, "a leftover entry would make the next boot resume a run that finished");
});

test("frames that are not the run moving do not keep a silent chat alive", async () => {
  const w = world();
  const session = w.run("chat-1");
  for (let step = 0; step < 11; step += 1) {
    w.advance(5 * MINUTE);
    session.emit({ type: "btw_delta" }, { type: "cache_warming_start" }, { type: "cache_warming_end" }, { type: "cody_ui_requests_cleared" });
    await w.rr.tick();
  }
  await settle();
  assert.equal(w.acquireLog.length, 0);
  assert.equal(asked(session), 0, "a side answer is a sign of life: nobody needs asking whether the engine is there");

  w.advance(5 * MINUTE);
  session.emit({ type: "btw_record" });
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"], "an hour in which only side answers, cache warming and Cody's own signals arrived");
  assert.equal(journal.findRun("chat-1").recoveries[0].reason, "nothing had happened for 60 minutes");
});

// ---------------------------------------------------------------------------
// The watchdog: the engine itself
// ---------------------------------------------------------------------------

test("an engine that cannot answer a question within ten minutes is restarted", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.stateReply = "never";

  w.advance(9 * MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(asked(session), 0, "nine quiet minutes are not worth a question");
  w.advance(MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(asked(session), 1, "ten are");
  assert.deepEqual(session.commands.at(-1), { type: "get_state" });

  w.advance(9 * MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(w.acquireLog.length, 0, "the engine has had nine minutes to answer");
  assert.equal(asked(session), 1, "one question at a time");

  w.advance(MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  assert.equal(journal.findRun("chat-1").recoveries[0].reason, "the engine had stopped answering for 20 minutes");
  assert.equal(w.notices[0].body, "Stuck since 2026-10-09 02:00 EDT: the engine stopped answering. Cody restarted the engine at 2026-10-09 02:20 EDT and asked the agent to carry on.");
});

test("an engine that answers is left alone, and is not asked again for ten minutes", async () => {
  const w = world();
  const session = w.run("chat-1");
  w.advance(10 * MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(asked(session), 1);

  w.advance(9 * MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(asked(session), 1, "an answer is good for another ten minutes");
  w.advance(MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(asked(session), 2);
  assert.equal(w.acquireLog.length, 0);
});

test("a frame that arrives while a question is open withdraws the suspicion; going quiet again restarts the count", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.stateReply = "never";
  w.advance(10 * MINUTE);
  await w.rr.tick();
  await settle();
  assert.equal(asked(session), 1);

  w.advance(5 * MINUTE);
  session.emit({ type: "message_update" });
  w.advance(5 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0, "the engine spoke five minutes ago: it is there");

  w.advance(5 * MINUTE);
  await w.rr.tick();
  w.advance(9 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0, "ten quiet minutes later the old question counts afresh, and has had nine");
  assert.equal(asked(session), 1, "without being asked a second time");
  w.advance(MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"]);
});

test("an hour of total silence is a stall, unless a tool is still inside the deadline it declared", async () => {
  const w = world();
  w.run("chat-1");
  for (let step = 0; step < 5; step += 1) {
    w.advance(10 * MINUTE);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 0, "fifty minutes of quiet from an engine that still answers");
  w.advance(10 * MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  assert.equal(journal.findRun("chat-1").recoveries[0].reason, "nothing had happened for 60 minutes");

  const declared = world();
  const session = declared.run("chat-2");
  session.emit(toolStart("t1", "bash", { command: "npm run e2e", timeout: 3600 }));
  declared.advance(74 * MINUTE);
  await declared.rr.tick();
  assert.equal(declared.acquireLog.length, 0, "an hour-long command may be quiet for its hour and the grace after it");
  declared.advance(MINUTE);
  await declared.rr.tick();
  assert.deepEqual(declared.acquireLog, ["chat-2"]);
  assert.equal(journal.findRun("chat-2").recoveries[0].reason, "`bash` had not answered for 75 minutes (it started at 2026-10-09 02:00 EDT)");
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

test("a chat that stalls a fourth time within twelve hours is given up on: one notice, no prompt, no entry", async () => {
  const w = world();
  let session = w.run("chat-1");
  for (let round = 1; round <= 3; round += 1) {
    session.emit(toolStart(`t${round}`, "edit"));
    w.advance(20 * MINUTE);
    await w.rr.tick();
    assert.equal(w.acquireLog.length, round, `recovery ${round}`);
    session = w.created.at(-1);
    // The recovered run begins, and stalls in its turn an hour later.
    session.running = true;
    session.emit({ type: "agent_start" });
    w.advance(HOUR);
  }
  const promptsBefore = prompts(session).length;
  session.emit(toolStart("t4", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();

  assert.equal(w.acquireLog.length, 3, "no fourth restart");
  assert.equal(session.alive, true, "the stuck engine is left as it is for the person to look at");
  assert.equal(prompts(session).length, promptsBefore, "and nothing more is sent to it");
  const gaveUp = w.notices.filter((notice) => /stopped trying/.test(notice.body));
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].body, "Cody restarted this chat's engine 3 times in 12 hours and stopped trying. Open the chat to continue.");
  assert.equal(gaveUp[0].event, "error");
  assert.equal(journal.findRun("chat-1"), null, "the entry is deleted: nothing will resume it at boot either");
  w.advance(5 * MINUTE);
  session.emit({ type: "message_update" });
  assert.equal(journal.findRun("chat-1"), null, "and a late frame from the stuck run does not write one back");

  const before = w.notices.length;
  for (let look = 0; look < 3; look += 1) {
    w.advance(HOUR);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 3);
  assert.equal(w.notices.length, before, "told once, not once a minute");
});

test("recoveries older than twelve hours no longer count toward the cap", async () => {
  const w = world();
  for (const hoursAgo of [30, 13, 12.5]) {
    const at = T0 - hoursAgo * HOUR;
    journal.addRecovery("chat-1", { at, reason: "long ago" }, at);
  }
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"], "restarted as usual");
  assert.equal(prompts(w.created[0])[0].clientMessageId, "recover-chat-1-1", "and counted as the first of its window");
});

test("a restart that fails counts as an attempt, is tried again at the next look, and stops at the cap", async () => {
  const w = world({}, { failAcquire: 2 });
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 1);
  assert.equal(journal.findRun("chat-1").recoveries.length, 1, "a failed start counts");
  assert.equal(w.notices.length, 0, "nothing is announced until the agent has actually been asked to carry on");

  w.advance(59_000);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 1, "not before the next look");
  w.advance(1_000);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 2);
  assert.equal(journal.findRun("chat-1").recoveries.length, 2);

  w.advance(MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 3, "the third try starts the chat");
  assert.equal(prompts(w.created[0]).length, 1);
  assert.equal(journal.findRun("chat-1").recoveries.length, 3);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].body, /asked the agent to carry on\.$/);

  const stuck = world({}, { failAcquire: 99 });
  const dead = stuck.run("chat-2");
  dead.emit(toolStart("t1", "edit"));
  stuck.advance(20 * MINUTE);
  for (let look = 0; look < 8; look += 1) {
    await stuck.rr.tick();
    stuck.advance(MINUTE);
  }
  assert.equal(stuck.acquireLog.length, 3, "three attempts, then it stops trying");
  assert.equal(stuck.notices.length, 1);
  assert.match(stuck.notices[0].body, /^Cody restarted this chat's engine 3 times in 12 hours and stopped trying\./);
  assert.equal(journal.findRun("chat-2"), null);
});

test("the run Cody restarts is watched from the moment its prompt is sent, even when the engine never says it began", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 1);
  const replacement = w.created[0];
  assert.equal(replacement.isRunning(), true, "the prompt was accepted; no agent_start follows");

  for (let step = 0; step < 5; step += 1) {
    w.advance(10 * MINUTE);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 1, "fifty minutes without a word is not yet a stall");
  w.advance(10 * MINUTE);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1", "chat-1"], "an hour is: the original incident again, caught the second time");
  assert.equal(journal.findRun("chat-1").recoveries.length, 2);
  assert.equal(journal.findRun("chat-1").recoveries[1].reason, "nothing had happened for 60 minutes");
  assert.equal(prompts(w.created[1])[0].clientMessageId, "recover-chat-1-2");
});

test("a recovery whose prompt was never run is forgotten, not judged, once the session is plainly idle", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  w.created[0].running = false;
  for (let look = 0; look < 3; look += 1) {
    w.advance(HOUR);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 1, "nothing is running, so nothing is stalled");
  assert.equal(journal.findRun("chat-1"), null, "and no entry is left to resume a run that never was");
});

test("an engine that dies before it says a recovered run began is restarted again, within the cap", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  const replacement = w.created[0];
  replacement.emit(...engineExit);
  await replacement.destroyAndWait();
  w.advance(31_000);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 2);
  assert.match(prompts(w.created[1])[0].message, /The engine process exited unexpectedly at /);
  assert.equal(journal.findRun("chat-1").recoveries.length, 2);
});

test("a chat that no longer exists is not restarted, not retried and not announced", async () => {
  const w = world({}, { chatGone: true });
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  for (let look = 0; look < 3; look += 1) {
    w.advance(MINUTE);
    await w.rr.tick();
  }
  assert.equal(w.acquireLog.length, 1);
  assert.equal(w.notices.length, 0);
  assert.equal(journal.findRun("chat-1"), null, "nothing is left to resume");
});

test("a chat that is already working again when the restart finishes is left alone", async () => {
  const busy = new FakeSession("chat-1", { running: true });
  const w = world({ acquire: async () => busy });
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(20 * MINUTE);
  await w.rr.tick();
  assert.deepEqual(prompts(busy), [], "somebody got there first; the agent is not interrupted with a message about a stall");
  assert.equal(w.notices.length, 0);
});

test("nothing is started once the server is going down, and the cut-off run is left for the next boot", async () => {
  let down = false;
  const w = world({ isShuttingDown: () => down });
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  let release;
  session.destroyGate = new Promise((resolve) => { release = resolve; });
  w.advance(20 * MINUTE);
  const looking = w.rr.tick();
  await settle();
  down = true; // the stop signal arrives while the stalled engine is still closing
  release();
  await looking;
  assert.equal(w.acquireLog.length, 0, "no engine is started only to be killed with the server");
  assert.equal(journal.findRun("chat-1").recoveries.length, 0, "and the attempt is not counted against the chat");
  assert.equal(w.notices.length, 0);

  // A recovery that came due during the shutdown is not started either.
  down = false;
  const crashed = world({ isShuttingDown: () => down });
  const dying = crashed.run("chat-2");
  dying.emit(...engineExit);
  await dying.destroyAndWait();
  crashed.advance(31_000);
  down = true;
  await crashed.rr.tick();
  assert.equal(crashed.acquireLog.length, 0);
  assert.ok(journal.findRun("chat-2"), "the entry waits for the next boot");
});

test("two looks at once start one recovery, not two", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  let release;
  session.destroyGate = new Promise((resolve) => { release = resolve; });
  w.advance(20 * MINUTE);
  const first = w.rr.tick();
  const second = w.rr.tick();
  await settle();
  release();
  await Promise.all([first, second]);
  assert.equal(w.acquireLog.length, 1);
  assert.equal(prompts(w.created[0]).length, 1);
});

// ---------------------------------------------------------------------------
// The journal, as the supervisor keeps it
// ---------------------------------------------------------------------------

test("a run that ends normally leaves no entry: the journal holds an entry only while a run is in flight", () => {
  const w = world();
  const session = w.run("chat-1");
  assert.deepEqual(journal.findRun("chat-1"), { sessionId: "chat-1", startedAt: T0, updatedAt: T0, recoveries: [] });

  w.advance(30_000);
  session.emit({ type: "message_update" });
  assert.equal(journal.findRun("chat-1").updatedAt, T0, "a frame half a minute later is not worth a write");
  w.advance(31_000);
  session.emit({ type: "message_update" });
  assert.equal(journal.findRun("chat-1").updatedAt, T0 + 61_000, "once a minute the entry says the run is alive");

  session.emit({ type: "agent_end", isTerminal: false, messages: [] });
  assert.ok(journal.findRun("chat-1"), "a pause inside a run (Steer now) is not its end");
  session.emit({ type: "agent_end", messages: [] });
  assert.equal(journal.findRun("chat-1"), null);
  assert.deepEqual(journal.listRuns(), []);

  session.emit({ type: "agent_start" });
  assert.ok(journal.findRun("chat-1"), "and the next run starts a fresh entry");
  session.emit({ type: "agent_end", isTerminal: true, messages: [] });
  assert.deepEqual(journal.listRuns(), []);
});

test("a run the person stops leaves no entry, is not judged, and the winding down does not bring it back", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  session.emit({ type: "cody_run_stopped" });
  assert.equal(journal.findRun("chat-1"), null);

  session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "edit" }, { type: "message_end" }, { type: "agent_end", isTerminal: true, messages: [] });
  assert.equal(journal.findRun("chat-1"), null);

  const stopped = world();
  const hung = stopped.run("chat-2");
  hung.emit(toolStart("t1", "edit"));
  hung.emit({ type: "cody_run_stopped" });
  stopped.advance(3 * HOUR);
  await stopped.rr.tick();
  assert.equal(stopped.acquireLog.length, 0, "the person stopped it: Cody must not carry on what they stopped");

  hung.emit({ type: "agent_start" });
  assert.ok(journal.findRun("chat-2"), "a new run is a new run");
});

test("a chat whose session id changes under a run keeps its entry, under the new id", async () => {
  const w = world();
  const session = w.run("old-id");
  session.sessionId = "new-id";
  w.advance(5_000);
  session.emit({ type: "message_update" });
  assert.equal(journal.findRun("old-id"), null);
  assert.equal(journal.findRun("new-id").startedAt, T0);

  // The engine says nothing after the move: the watchdog's own look finds it.
  session.sessionId = "newer-id";
  w.advance(MINUTE);
  await w.rr.tick();
  assert.equal(journal.findRun("new-id"), null);
  assert.equal(journal.findRun("newer-id").startedAt, T0);

  session.emit({ type: "agent_end", messages: [] });
  assert.deepEqual(journal.listRuns(), [], "the end removes it under the id it moved to");
});

test("a chat closed mid-run keeps its entry only when the server is shutting down, the engine died, or Cody is restarting it", async () => {
  // Deleted, archived, the engine switched or updated: somebody decided.
  const abandoned = world();
  await abandoned.run("chat-a").destroyAndWait();
  assert.equal(journal.findRun("chat-a"), null);

  // The server is going down: the run was cut off.
  const going = world({ isShuttingDown: () => true });
  const dying = going.run("chat-b");
  await dying.destroyAndWait();
  assert.ok(journal.findRun("chat-b"), "kept for the next boot");
  assert.deepEqual(going.scheduled, [], "and nothing is restarted while the server is stopping");

  // The engine died on its own: its terminal agent_end is not the run finishing.
  const crashed = world();
  const gone = crashed.run("chat-c");
  gone.emit(...engineExit);
  assert.ok(journal.findRun("chat-c"), "the run did not end, its engine did");
  await gone.destroyAndWait();
  assert.ok(journal.findRun("chat-c"));
  assert.deepEqual(crashed.scheduled.map((entry) => entry.delayMs), [30_000]);

  // A run that ended before the close has nothing left to keep.
  const finished = world();
  const done = finished.run("chat-d");
  done.emit({ type: "agent_end", messages: [] });
  await done.destroyAndWait();
  assert.equal(journal.findRun("chat-d"), null);
});

test("the server's own shutdown flag is what the supervisor reads by default", async () => {
  const w = world({}, { omit: ["isShuttingDown"] });
  const session = w.run("chat-1");
  assert.equal(shutdown.isServerShuttingDown(), false);
  shutdown.markServerShuttingDown();
  try {
    assert.equal(shutdown.isServerShuttingDown(), true);
    await session.destroyAndWait();
    assert.ok(journal.findRun("chat-1"), "closed while the server was shutting down");
  } finally {
    delete globalThis.__codyServerShuttingDown;
  }
  const after = world({}, { omit: ["isShuttingDown"] });
  await after.run("chat-2").destroyAndWait();
  assert.equal(journal.findRun("chat-2"), null, "and an ordinary close once it is not");
});

test("a sidebar chat is never supervised, nor an engine with no observer channel; a session is attached once", async () => {
  const w = world();
  const sidebar = new FakeSession("side-1");
  w.rr.supervise(sidebar, { kind: "sidebar" });
  assert.equal(sidebar.observers.size, 0);

  const bare = new FakeSession("bare");
  bare.observeEvents = undefined;
  w.rr.supervise(bare);
  assert.equal(w.rr.state.trackers.size, 0);

  const main = new FakeSession("main-1");
  w.rr.supervise(main);
  w.rr.supervise(main);
  assert.equal(main.observers.size, 1, "one observer, not two");
  assert.equal(w.rr.state.trackers.size, 1);

  await main.destroyAndWait();
  assert.equal(main.observers.size, 0, "the observer goes with the session");
  assert.equal(w.rr.state.trackers.size, 0);
});

// ---------------------------------------------------------------------------
// An engine that dies, and a server that restarts
// ---------------------------------------------------------------------------

test("an engine that dies mid-run is restarted after thirty seconds, with nothing left to close", async () => {
  const w = world();
  const session = w.run("chat-1");
  w.advance(5 * MINUTE);
  session.emit(...engineExit);
  await session.destroyAndWait("the engine exited");
  assert.deepEqual(w.scheduled.map((entry) => entry.delayMs), [30_000], "the wait is armed, so it is not a minute late");

  w.advance(29_000);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0, "the page gets a moment to reconnect on its own");
  w.advance(2_000);
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  const [replacement] = w.created;
  assert.deepEqual(replacement.destroyReasons, [], "nothing to close: the engine was already gone");
  const [prompt] = prompts(replacement);
  assert.equal(prompt.streamingBehavior, "steer");
  assert.match(prompt.message, /^This is an automatic message from Cody, not from the user\. The engine process exited unexpectedly at 2026-10-09 02:05 EDT\. Cody restarted the engine at 2026-10-09 02:05 EDT\. /);
  assert.equal(w.notices[0].body, "The engine exited unexpectedly at 2026-10-09 02:05 EDT. Cody restarted the engine at 2026-10-09 02:05 EDT and asked the agent to carry on.");
  assert.equal(journal.findRun("chat-1").recoveries.length, 1);
});

test("the timer armed for a crash starts the recovery by itself", async () => {
  const w = world();
  const session = w.run("chat-1");
  session.emit(...engineExit);
  await session.destroyAndWait();
  w.advance(30_000);
  w.scheduled[0].run();
  await settle();
  await settle();
  assert.deepEqual(w.acquireLog, ["chat-1"]);
});

test("a crashed chat the person already reopened and set working is left alone", async () => {
  const busy = new FakeSession("chat-1", { running: true });
  const w = world({ acquire: async () => busy });
  const session = w.run("chat-1");
  session.emit(...engineExit);
  await session.destroyAndWait();
  w.advance(31_000);
  await w.rr.tick();
  assert.deepEqual(prompts(busy), []);
});

test("with run recovery switched off nothing is restarted, but the journal is still written", async () => {
  const w = world({ enabled: () => false });
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  assert.ok(journal.findRun("chat-1"), "the journal does not depend on the switch");
  w.advance(3 * HOUR);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0);

  session.emit(...engineExit);
  await session.destroyAndWait();
  assert.deepEqual(w.scheduled, [], "no crash recovery");
  w.advance(HOUR);
  await w.rr.tick();
  assert.equal(w.acquireLog.length, 0);
  assert.equal(await w.rr.resume(), 0, "no boot resume");
  assert.equal(w.notices.length, 0);
  assert.ok(journal.findRun("chat-1"), "and the entry is left as it was");
});

test("CODY_RUN_RECOVERY=0 is what switches it off", async () => {
  const w = world({}, { omit: ["enabled"] });
  const session = w.run("chat-1");
  session.emit(toolStart("t1", "edit"));
  w.advance(HOUR);
  process.env.CODY_RUN_RECOVERY = "0";
  try {
    await w.rr.tick();
    assert.equal(w.acquireLog.length, 0);
  } finally {
    delete process.env.CODY_RUN_RECOVERY;
  }
  await w.rr.tick();
  assert.deepEqual(w.acquireLog, ["chat-1"], "and on again without it");
});

test("at boot a run the restart cut off is resumed, with the restart in the words", async () => {
  const restarted = T0 + 161 * MINUTE; // 04:41 EDT
  const w = world({ bootAt: restarted });
  journal.beginRun("chat-1", T0 + 160 * MINUTE); // last activity 04:40
  w.clock.now = restarted;

  assert.equal(await w.rr.resume(), 1);
  assert.deepEqual(w.acquireLog, ["chat-1"]);
  const [replacement] = w.created;
  assert.deepEqual(replacement.destroyReasons, [], "no engine to close: the server's restart already did");
  const [prompt] = prompts(replacement);
  assert.equal(prompt.streamingBehavior, "steer");
  assert.equal(prompt.clientMessageId, "recover-chat-1-1");
  assert.equal(
    prompt.message,
    "This is an automatic message from Cody, not from the user. Cody's server restarted at 2026-10-09 04:41 EDT while this chat was working (last activity 2026-10-09 04:40 EDT). "
      + "Cody restarted the engine at 2026-10-09 04:41 EDT. "
      + "Tool calls that were still running have unknown results, and any subagents or background jobs were stopped. "
      + "Check what actually finished (files, git, job output), then carry on with the task you were working on.",
  );
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].body, "Cody restarted at 2026-10-09 04:41 EDT while this chat was working; it asked the agent to carry on.");
  assert.equal(journal.findRun("chat-1").recoveries.length, 1);
});

test("at boot a run that was last alive more than six hours ago is dropped, and the owner is told it was not resumed", async () => {
  const w = world();
  journal.beginRun("chat-old", T0 - 7 * HOUR);
  journal.beginRun("chat-edge", T0 - 6 * HOUR);

  assert.equal(await w.rr.resume(), 1, "exactly six hours is still recent enough");
  assert.deepEqual(w.acquireLog, ["chat-edge"]);
  assert.equal(journal.findRun("chat-old"), null);
  const dropped = w.notices.find((notice) => notice.sessionId === "chat-old");
  assert.equal(dropped.body, "Not resumed: Cody restarted 7 hours after this chat last did anything (2026-10-08 19:00 EDT).");
  assert.equal(dropped.event, "error");
});

test("at boot a chat already working is skipped, a chat out of restarts is given up on, and chats are taken one at a time", async () => {
  const w = world();
  const live = w.run("chat-live");
  journal.beginRun("chat-a", T0 - 20 * MINUTE);
  journal.beginRun("chat-b", T0 - 10 * MINUTE);
  for (const hoursAgo of [3, 2, 1]) journal.addRecovery("chat-spent", { at: T0 - hoursAgo * HOUR, reason: "stuck" }, T0 - 30 * MINUTE);

  assert.equal(await w.rr.resume(), 2);
  assert.deepEqual(w.acquireLog, ["chat-b", "chat-a"], "the most recently alive first");
  assert.deepEqual(prompts(live), [], "a chat already working is not interrupted");
  assert.ok(journal.findRun("chat-live"), "and its entry is its own run's");
  assert.equal(journal.findRun("chat-spent"), null);
  assert.ok(w.notices.some((notice) => notice.sessionId === "chat-spent" && /stopped trying/.test(notice.body)));
  assert.equal(prompts(w.created[0]).length + prompts(w.created[1]).length, 2);
  assert.ok(w.slept.length >= 1 && w.slept.every((ms) => ms === 3_000), "three seconds apart");
});

test("a boot resume that is stopped half way does not carry on", async () => {
  const w = world();
  journal.beginRun("chat-a", T0 - 20 * MINUTE);
  journal.beginRun("chat-b", T0 - 10 * MINUTE);
  const deps = w.rr.state.deps;
  deps.sleep = async () => { w.rr.state.generation += 1; };
  assert.equal(await w.rr.resume(), 1, "the first chat was resumed before the stop");
  assert.deepEqual(w.acquireLog, ["chat-b"]);
});
