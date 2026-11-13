import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The burn guard, fed the frames a session really emits and transcripts
 * shaped like the 2026-11-12 loop. Nothing here waits and nothing touches a
 * disk or a network: the clock is the test's, a "session" is a small object
 * with the surface the wrapper offers, the transcripts are a map, and every
 * collaborator (the chat line, the pop-up, the push) is recorded. What is
 * pinned is what a person would notice: what gets stopped, what is left
 * alone, what the agent and the owner are told, and that it is said once.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createBurnGuard, burnNote } = await jiti.import("./burn-guard.ts");
const { BURN_LIMITS, describeBurn } = await jiti.import("./burn-detect.ts");
const { readEngineCrashNotice } = await jiti.import("../engine-crash.ts");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse("2026-11-12T17:05:00Z");
const SESSION_FILE = "/sessions/-Cody/chat-1.jsonl";
const HELPERS = "/sessions/-Cody/chat-1";

async function settle() {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The surface of a live session the guard uses: the wrapper's, with a switch for everything a test varies. */
class FakeSession {
  constructor({ running = true, cancellable = [], abortFails = false, sessionFile = SESSION_FILE } = {}) {
    this.sessionId = "chat-1";
    this.sessionFile = sessionFile;
    this.cwd = "/work/my-project";
    this.alive = true;
    this.running = running;
    this.cancellable = new Set(cancellable);
    this.abortFails = abortFails;
    this.observers = new Set();
    this.closeListeners = [];
    this.commands = [];
    this.announced = [];
  }
  isAlive() { return this.alive; }
  isRunning() { return this.running; }
  observeEvents(observer) {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  onClose(listener) {
    this.closeListeners.push(listener);
    return () => {};
  }
  announce(event) { this.announced.push(event); }
  async send(command) {
    this.commands.push(command);
    if (command.type === "abort") {
      if (this.abortFails) throw new Error("Session is no longer running");
      // The wrapper's Stop: observers hear it at once, and the run is over.
      this.running = false;
      this.emit({ type: "cody_run_stopped" });
      return null;
    }
    if (command.type === "cancel_subagent") return { cancelled: this.cancellable.delete(command.subagentId) };
    return { delivery: "queued" };
  }
  emit(event) {
    for (const observer of [...this.observers]) observer(event);
  }
  close() {
    this.alive = false;
    for (const listener of this.closeListeners) listener();
  }
}

/** A guard on a clock and a disk the test owns. */
function setup(overrides = {}) {
  const clock = { now: T0 };
  const disk = new Map();
  const seen = { reads: [], records: [], published: [], pushes: [], lists: 0 };
  let enabled = true;
  const raw = createBurnGuard({
    now: () => clock.now,
    enabled: () => enabled,
    stat: async (file) => disk.get(file)?.stamp ?? null,
    listHelpers: async (sessionFile) => {
      seen.lists += 1;
      const dir = `${sessionFile.slice(0, -".jsonl".length)}/`;
      return [...disk].filter(([file]) => file.startsWith(dir)).map(([file, entry]) => {
        const parts = file.slice(dir.length).split("/");
        const id = parts.at(-1).slice(0, -".jsonl".length);
        return { file, id, root: parts.length > 1 ? parts[0] : id, stamp: entry.stamp };
      });
    },
    readTrail: async (file) => {
      seen.reads.push(file);
      return disk.get(file)?.events ?? [];
    },
    record: (sessionId, notice) => { seen.records.push({ sessionId, notice }); },
    publish: (event) => { seen.published.push(event); },
    describeChat: async () => ({ title: "Fix the usage page", project: "my-project" }),
    notify: (draft) => { seen.pushes.push(draft); },
    zoneFor: () => "America/New_York",
    ...overrides,
  });
  /** Write (or rewrite) a transcript: a new stamp, as an append or omp's rewrite gives. */
  const write = (file, events) => {
    const version = (disk.get(file)?.stamp.ino ?? 0) + 1;
    disk.set(file, { events, stamp: { size: events.length, mtimeMs: clock.now, ino: version } });
  };
  /** One frame after the guard's own pause, and everything it sets off. */
  const look = async (session) => {
    clock.now += BURN_LIMITS.scanEveryMs;
    session.emit({ type: "message_update" });
    await settle();
  };
  /**
   * The chat was opened ten minutes before whatever a test writes next: only
   * what happens while a chat is watched is judged, and the transcripts the
   * tests build reach a few minutes back.
   */
  const guard = {
    watch: (session, options) => {
      raw.watch(session, options);
      clock.now += 10 * MINUTE;
    },
  };
  return { guard, raw, clock, disk, seen, write, look, disable: () => { enabled = false; } };
}

/** `count` ordinary steps ending at `end`. */
function work(end, count = 30) {
  return Array.from({ length: count }, (_, i) => ({ kind: "request", at: end - (count - i) * 7 * SECOND, fresh: 4_000, cached: true }));
}

/** The 2026-11-12 loop, `cycles` long, ending at `end`: a compaction that keeps 91% before every request, each re-sending ~166,000 tokens. */
function loop(end, cycles = 8) {
  const events = work(end - cycles * 8 * SECOND);
  for (let i = cycles; i > 0; i -= 1) {
    events.push({ kind: "compaction", at: end - i * 8 * SECOND, before: 208_780, after: 189_735, warned: true });
    events.push({ kind: "request", at: end - i * 8 * SECOND + 7 * SECOND, fresh: 166_271, cached: true });
  }
  return events;
}

/** A healthy helper: a compaction every 13 requests that frees most of the context. */
function healthy(end) {
  const events = [];
  let at = end - 40 * 7 * SECOND;
  for (let i = 0; i < 40; i += 1) {
    at += 7 * SECOND;
    if (i % 13 === 12) events.push({ kind: "compaction", at: at - SECOND, before: 200_357, after: 58_403, warned: false });
    events.push({ kind: "request", at, fresh: i % 13 === 12 ? 27_000 : 4_000, cached: true });
  }
  return events;
}

const types = (session) => session.commands.map((command) => command.type);

test("a helper that loops is cancelled, the agent is told not to wake it, and the owner hears once", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ cancellable: ["DbHealth"] });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  write(`${HELPERS}/DbHealth.jsonl`, loop(clock.now));
  write(`${HELPERS}/CatchupAuth.jsonl`, healthy(clock.now));
  await look(session);

  assert.deepEqual(types(session), ["cancel_subagent", "prompt"]);
  assert.deepEqual(session.commands[0], { type: "cancel_subagent", subagentId: "DbHealth" });
  const saw = "Helper DbHealth cleaned up its memory 5 times within 5 steps and freed almost nothing each time";
  assert.deepEqual(session.commands[1], {
    type: "prompt",
    message: burnNote("DbHealth", saw),
    streamingBehavior: "steer",
    clientMessageId: `burn-chat-1-${clock.now}`,
    timeZone: "America/New_York",
  });
  assert.match(session.commands[1].message, /^This is an automatic message from Cody, not from the user\. Cody stopped your helper `DbHealth`/);
  assert.match(session.commands[1].message, /Do not resume, steer or message that helper again/);

  // The line that stays in the chat, live and after a reload.
  const notice = { reason: "token_burn", detail: saw, disk: null, quota: false, code: null, signal: null, recovery: "automatic", at: clock.now };
  assert.deepEqual(seen.records, [{ sessionId: "chat-1", notice }]);
  const sentence = `Cody stopped a helper in this chat because it was using tokens far faster than normal. What Cody saw: ${saw}. The rest of the chat carries on without it.`;
  assert.deepEqual(session.announced, [{ type: "notice", level: "warning", reason: "token_burn", message: sentence, crash: notice }]);
  // No "this chat stopped" pop-up: it did not.
  assert.deepEqual(seen.published, []);
  assert.deepEqual(seen.pushes, [{ event: "error", sessionId: "chat-1", title: "Error · Fix the usage page", body: sentence, tags: ["my-project"] }]);

  // The loop's last lines are still in the file: they are not judged again.
  write(`${HELPERS}/DbHealth.jsonl`, [...loop(clock.now), { kind: "request", at: clock.now, fresh: 166_271, cached: true }]);
  await look(session);
  assert.equal(session.commands.length, 2);
  assert.equal(seen.pushes.length, 1);
});

test("a main agent that loops is stopped the way the person's Stop does it", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession();
  guard.watch(session);
  write(SESSION_FILE, loop(clock.now, 6));
  await look(session);

  assert.deepEqual(session.commands, [{ type: "abort" }]);
  assert.equal(session.isRunning(), false);
  const saw = "The main agent cleaned up its memory 5 times within 5 steps and freed almost nothing each time";
  const notice = { reason: "token_burn", detail: saw, disk: null, quota: false, code: null, signal: null, recovery: "manual", at: clock.now };
  assert.deepEqual(seen.records, [{ sessionId: "chat-1", notice }]);
  assert.deepEqual(seen.published, [{ sessionId: "chat-1", title: null, notice }]);
  assert.equal(seen.pushes[0].body, `Cody stopped this chat's run because it was using tokens far faster than normal. What Cody saw: ${saw}. Send a message to continue.`);
  assert.equal(session.announced[0].reason, "token_burn", "never engine_exit: the run supervisor would take that for a crash to recover from");

  // The person sends a message: the same lines are in the transcript, and the new run is not stopped for them.
  session.running = true;
  write(SESSION_FILE, [...loop(clock.now - 30 * SECOND, 6), { kind: "request", at: clock.now, fresh: 4_000, cached: true }]);
  await look(session);
  assert.deepEqual(session.commands, [{ type: "abort" }]);
});

test("ordinary work is never touched", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ cancellable: ["CatchupAuth"] });
  guard.watch(session);
  for (let round = 0; round < 6; round += 1) {
    write(SESSION_FILE, work(clock.now + BURN_LIMITS.scanEveryMs, 60));
    write(`${HELPERS}/CatchupAuth.jsonl`, healthy(clock.now + BURN_LIMITS.scanEveryMs));
    await look(session);
  }
  assert.deepEqual(session.commands, []);
  assert.deepEqual(session.announced, []);
  assert.deepEqual([seen.records, seen.published, seen.pushes], [[], [], []]);
});

test("frames are only the clock: one look per pause, and a file that has not changed is not read again", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession();
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  write(`${HELPERS}/CatchupAuth.jsonl`, healthy(clock.now));
  // A reply streaming: hundreds of frames inside one pause.
  clock.now += BURN_LIMITS.scanEveryMs;
  for (let i = 0; i < 300; i += 1) session.emit({ type: "message_update" });
  await settle();
  assert.equal(seen.lists, 1);
  assert.deepEqual(seen.reads, [SESSION_FILE, `${HELPERS}/CatchupAuth.jsonl`]);
  // Nothing was written since: looked at, not read.
  await look(session);
  assert.equal(seen.lists, 2);
  assert.equal(seen.reads.length, 2);
  // Only the helper wrote.
  write(`${HELPERS}/CatchupAuth.jsonl`, healthy(clock.now));
  await look(session);
  assert.deepEqual(seen.reads.slice(2), [`${HELPERS}/CatchupAuth.jsonl`]);
  // No frame, no look: an idle chat costs nothing.
  clock.now += 10 * MINUTE;
  await settle();
  assert.equal(seen.lists, 3);
});

test("a transcript nobody has written to for half an hour is never read", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ cancellable: ["Old"] });
  guard.watch(session);
  write(`${HELPERS}/Old.jsonl`, loop(clock.now));
  write(SESSION_FILE, work(clock.now));
  clock.now += BURN_LIMITS.windowMs + MINUTE;
  write(SESSION_FILE, work(clock.now));
  await look(session);
  assert.deepEqual(seen.reads, [SESSION_FILE]);
  assert.deepEqual(session.commands, []);
});

test("a helper of a helper is stopped through the top-level helper it runs under", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ cancellable: ["AgentsSlim"] });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  write(`${HELPERS}/AgentsSlim/AgentsSlim.CheckUi.jsonl`, loop(clock.now));
  await look(session);
  assert.deepEqual(session.commands.slice(0, 2), [
    { type: "cancel_subagent", subagentId: "AgentsSlim.CheckUi" },
    { type: "cancel_subagent", subagentId: "AgentsSlim" },
  ]);
  assert.equal(session.commands[2].type, "prompt");
  assert.match(session.commands[2].message, /your helper `AgentsSlim\.CheckUi`/);
  assert.equal(seen.records[0].notice.recovery, "automatic");
});

test("a helper is stopped while the main agent is idle, and a stopped chat is not started again to hear about it", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ running: false, cancellable: ["DbHealth"] });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now - 10 * MINUTE));
  write(`${HELPERS}/DbHealth.jsonl`, loop(clock.now));
  await look(session);
  assert.deepEqual(types(session), ["cancel_subagent"], "no prompt: that would start a run nobody asked for");
  assert.equal(seen.records[0].notice.recovery, "automatic");
  assert.equal(seen.pushes.length, 1);
});

test("the third helper stopped in one chat within the hour stops the chat's own run", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ cancellable: ["One", "Two", "Three"] });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  for (const name of ["One", "Two"]) {
    clock.now += 5 * MINUTE;
    write(`${HELPERS}/${name}.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
    await look(session);
  }
  assert.deepEqual(types(session), ["cancel_subagent", "prompt", "cancel_subagent", "prompt"]);
  clock.now += 5 * MINUTE;
  write(`${HELPERS}/Three.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
  await look(session);
  assert.deepEqual(types(session).slice(4), ["cancel_subagent", "abort"]);
  assert.deepEqual(seen.records.map((entry) => entry.notice.recovery), ["automatic", "automatic", "manual"]);
  assert.equal(seen.records[2].notice.detail, "3 helpers of this chat had to be stopped within the hour (the last one: Three)");
  assert.equal(seen.published.length, 1);
});

test("three helpers stopped over an afternoon are three helpers, not a chat to stop", async () => {
  const { guard, clock, write, look } = setup();
  const session = new FakeSession({ cancellable: ["One", "Two", "Three"] });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  for (const name of ["One", "Two", "Three"]) {
    clock.now += 40 * MINUTE;
    write(`${HELPERS}/${name}.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
    await look(session);
  }
  assert.deepEqual(types(session), ["cancel_subagent", "prompt", "cancel_subagent", "prompt", "cancel_subagent", "prompt"]);
});

test("a helper that could not be cancelled had probably ended: nothing is said unless it goes on burning", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession();
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  write(`${HELPERS}/Gone.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
  await look(session);
  assert.deepEqual(types(session), ["cancel_subagent"]);
  assert.deepEqual([seen.records, seen.pushes, session.announced], [[], [], []]);

  // It was not gone: a minute later the same loop has gone round again.
  clock.now += MINUTE;
  write(`${HELPERS}/Gone.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
  await look(session);
  assert.deepEqual(types(session), ["cancel_subagent", "cancel_subagent", "abort"]);
  assert.equal(seen.records[0].notice.recovery, "manual");
  assert.match(seen.records[0].notice.detail, /\(it could not be stopped on its own\)$/);
  assert.equal(seen.pushes.length, 1);
});

test("when nothing can be stopped the owner is told once, and asked to stop it", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ running: false });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now - 10 * MINUTE));
  for (let round = 0; round < 5; round += 1) {
    clock.now += MINUTE;
    write(`${HELPERS}/Gone.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
    await look(session);
  }
  assert.deepEqual(types(session), ["cancel_subagent", "cancel_subagent"], "after saying so it stops trying");
  assert.equal(seen.records.length, 1);
  assert.equal(seen.records[0].notice.recovery, "gave_up");
  assert.equal(
    seen.pushes[0].body,
    "A helper in this chat is using tokens far faster than normal, and Cody could not stop it. What Cody saw: Helper Gone cleaned up its memory 5 times within 5 steps and freed almost nothing each time. Open the chat and press Stop.",
  );
  assert.equal(seen.published.length, 1);
});

test("the person's own Stop clears the slate for their next message", async () => {
  const { guard, clock, write, look } = setup();
  const session = new FakeSession({ cancellable: ["DbHealth"] });
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  await look(session);
  // They saw the helper spinning and pressed Stop a moment before the guard's next look.
  write(`${HELPERS}/DbHealth.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
  clock.now += BURN_LIMITS.scanEveryMs;
  session.emit({ type: "cody_run_stopped" });
  session.emit({ type: "agent_end", isTerminal: true });
  await settle();
  await look(session);
  assert.deepEqual(session.commands, []);
});

test("a run that cannot be stopped is not announced as stopped", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ abortFails: true });
  guard.watch(session);
  write(SESSION_FILE, loop(clock.now + BURN_LIMITS.scanEveryMs, 6));
  await look(session);
  assert.deepEqual(session.commands, [{ type: "abort" }]);
  assert.deepEqual([seen.records, seen.pushes, session.announced], [[], [], []]);
});

test("fresh evidence in a chat that is no longer running is its last run's final minutes", async () => {
  const { guard, clock, seen, write, look } = setup();
  const session = new FakeSession({ running: false });
  guard.watch(session);
  write(SESSION_FILE, loop(clock.now + BURN_LIMITS.scanEveryMs, 6));
  await look(session);
  assert.deepEqual(session.commands, []);
  assert.deepEqual(seen.pushes, []);
});

test("what a transcript already held when the chat was opened is history, not a reason to stop it", async () => {
  const { raw, clock, seen, write, look } = setup();
  // Cody restarted a minute after a loop: the lines are fresh, the engine that wrote them is gone.
  write(SESSION_FILE, loop(clock.now, 6));
  write(`${HELPERS}/DbHealth.jsonl`, loop(clock.now));
  const session = new FakeSession({ cancellable: ["DbHealth"] });
  raw.watch(session);
  await look(session);
  assert.deepEqual(session.commands, []);
  assert.deepEqual(seen.pushes, []);

  // The same loop starting again under this engine is stopped like any other.
  clock.now += 2 * MINUTE;
  write(SESSION_FILE, loop(clock.now + BURN_LIMITS.scanEveryMs, 6));
  await look(session);
  assert.deepEqual(session.commands, [{ type: "abort" }]);
});

test("what the guard says fits the chat line: a reload brings it back whole, not cut short or scrubbed", () => {
  // The longest name omp gives a helper, and the longest thing each rule can say about it.
  const who = "Helper UsageAccuracyQuotaReadingRework2";
  assert.equal(who.length, "Helper ".length + 32);
  const sayings = [
    `${describeBurn({ rule: "stuck", compactions: 5, requests: 60 }, who)} (it could not be stopped on its own)`,
    describeBurn({ rule: "churn", compactions: 6, requests: 12 }, who),
    describeBurn({ rule: "rate", requests: 8, tokens: 12_500_000, minutes: 10 }, who),
    "3 helpers of this chat had to be stopped within the hour (the last one: UsageAccuracyQuotaReadingRework2)",
  ];
  for (const detail of sayings) {
    const read = readEngineCrashNotice({ reason: "token_burn", recovery: "manual", at: T0, detail });
    assert.equal(read?.detail, detail);
  }
});

test("sidebar chats, engines without a transcript and a switched-off guard are left alone", async () => {
  const { guard, clock, seen, write, look, disable } = setup();
  const sidebar = new FakeSession();
  guard.watch(sidebar, { kind: "sidebar" });
  assert.equal(sidebar.observers.size, 0);

  // An ACP engine: a session, frames, and no file omp wrote.
  const acp = new FakeSession({ sessionFile: "" });
  guard.watch(acp);
  write(SESSION_FILE, loop(clock.now + BURN_LIMITS.scanEveryMs, 6));
  await look(acp);
  assert.deepEqual([acp.commands, seen.reads], [[], []]);

  // An engine whose wrapper offers no observer at all.
  const bare = new FakeSession();
  bare.observeEvents = undefined;
  guard.watch(bare);
  assert.equal(bare.closeListeners.length, 0);

  const session = new FakeSession();
  guard.watch(session);
  guard.watch(session);
  assert.equal(session.observers.size, 1, "watched once however often it is asked");
  disable();
  await look(session);
  assert.deepEqual([session.commands, seen.reads], [[], []], "CODY_BURN_GUARD=0");
});

test("it never throws into the session it watches, one failed way of saying it does not cost the others, and a closed session is let go", async () => {
  const { guard, clock, seen, write, look } = setup({
    // A full disk: the line cannot be filed.
    record: () => { throw new Error("ENOSPC: no space left on device"); },
  });
  const session = new FakeSession({ cancellable: ["DbHealth"] });
  session.announce = () => { throw new Error("stream closed"); };
  guard.watch(session);
  write(SESSION_FILE, work(clock.now));
  write(`${HELPERS}/DbHealth.jsonl`, loop(clock.now + BURN_LIMITS.scanEveryMs));
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    await look(session);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(types(session), ["cancel_subagent", "prompt"], "the stop itself went through");
  assert.equal(seen.pushes.length, 1, "and the owner still hears");
  assert.deepEqual(warnings.filter((line) => line.includes("could not")).map((line) => line.split(":")[0]), [
    "[burn-guard] could not file the chat line",
    "[burn-guard] could not put the line in the open chat",
  ]);

  session.close();
  assert.equal(session.observers.size, 0);
  const reads = seen.reads.length;
  await look(session);
  assert.equal(seen.reads.length, reads);
});
