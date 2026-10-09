import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The run supervisor against the real session manager: `startRpcSession`
 * spawns a child, registers it with the supervisor, and a recovery goes back
 * through the real `acquireSession` to start the chat again. Only the engine
 * binary is a stand-in (the minimal protocol a wrapper needs, plus a command
 * that makes it emit any frame a test wants), and the thresholds are made
 * small enough to wait for. The unit tests in supervisor.test.mjs pin the
 * rules; this proves the pieces are wired together.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession, getRpcSession } = await jiti.import("../rpc-manager.ts");
const { invalidateOmpCliCache } = await jiti.import("../omp/omp-cli.ts");
const recovery = await jiti.import("./supervisor.ts");
const journal = await jiti.import("./journal.ts");
const shutdown = await jiti.import("./shutdown.ts");

/** Set environment variables for one run and put every one of them back. */
async function withEnv(overrides, run) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A scripted stand-in for `omp --mode rpc-ui`: enough protocol for the wrapper
 * to start, report an identity and run a command. Every command is logged with
 * the pid of the child that received it, and every child records when it
 * started and exited, so a test can say WHICH child got a message and prove two
 * children for one chat never overlapped. `fake_emit` makes it send any frame.
 */
const FAKE_OMP = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const sessionId = process.env.FAKE_OMP_SESSION_ID;
const sessionFile = process.env.FAKE_OMP_SESSION_FILE;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const lifecycle = (event) => fs.appendFileSync(process.env.FAKE_OMP_LIFECYCLE, JSON.stringify({ event, pid: process.pid, at: Date.now() }) + "\n");
lifecycle("start");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  fs.appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ ...command, pid: process.pid }) + "\n");
  const reply = (fields) => send({ type: "response", id: command.id, command: command.type, ...fields });
  switch (command.type) {
    case "get_state":
      return reply({ success: true, data: { sessionId, sessionFile, isStreaming: false, isCompacting: false, messageCount: 0, queuedMessageCount: 0 } });
    case "set_ask_dialog":
      return reply({ success: true, data: { enabled: command.enabled === true } });
    case "fake_emit":
      send(command.frame);
      return reply({ success: true });
    default:
      return reply({ success: true });
  }
});
// A real omp takes a moment to flush and release the session file after stdin closes.
process.stdin.on("end", () => {
  setTimeout(() => {
    lifecycle("exit");
    process.exit(0);
  }, Number(process.env.FAKE_OMP_EXIT_DELAY_MS || 0));
});
`;

const fakeEmit = (session, frame) => session.proc.sendCommand({ type: "fake_emit", frame });
const readLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

/**
 * Run `run` with a chat on disk, a fake engine and the supervisor started on
 * small thresholds. `notices` collects what would have been pushed.
 */
async function withChat(sessionId, extraEnv, limits, run) {
  const root = mkdtempSync(join(tmpdir(), "cody-run-recovery-e2e-"));
  const bin = join(root, "fake-omp");
  writeFileSync(bin, FAKE_OMP);
  chmodSync(bin, 0o755);
  const sessionsDir = join(root, "agent", "sessions", "-project");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root, title: "Fix login" })}\n`);
  const log = join(root, "commands.log");
  const lifecycle = join(root, "lifecycle.log");
  const notices = [];
  invalidateOmpCliCache();
  try {
    return await withEnv({
      PI_CODING_AGENT_DIR: join(root, "agent"),
      CODY_ACCOUNTS_DIR: join(root, "accounts"),
      CODY_OMP_BIN: bin,
      FAKE_OMP_SESSION_ID: sessionId,
      FAKE_OMP_SESSION_FILE: file,
      FAKE_OMP_LOG: log,
      FAKE_OMP_LIFECYCLE: lifecycle,
      ...extraEnv,
    }, async () => {
      delete process.env.CODY_RUN_RECOVERY;
      // The boot resume is exercised on its own below; here it must not wake in the middle of a stall.
      recovery.startRunRecovery({ send: (draft) => { notices.push(draft); }, limits: { bootDelayMs: 600_000, ...limits } });
      try {
        return await run({
          root,
          file,
          notices,
          commands: () => readLines(log),
          lifecycle: () => readLines(lifecycle),
        });
      } finally {
        recovery.stopRunRecovery();
      }
    });
  } finally {
    invalidateOmpCliCache();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a main-agent edit that never answers: the child is recycled, a new one starts only after the old one exited, and it is asked to carry on", async () => {
  await withChat("stalled-chat", { FAKE_OMP_EXIT_DELAY_MS: "600" }, { tickMs: 50, quickToolMs: 400 }, async ({ file, root, notices, commands, lifecycle }) => {
    const { session } = await startRpcSession("stalled-chat", file, root);
    try {
      await fakeEmit(session, { type: "agent_start" });
      await fakeEmit(session, { type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "src/login.ts" } });
      assert.ok(journal.findRun("stalled-chat"), "the run is on the journal while it is in flight");

      await waitFor(() => commands().some((command) => command.type === "prompt"), "the recovery prompt");

      assert.equal(session.isAlive(), false, "the stalled child was closed");
      const replacement = getRpcSession("stalled-chat");
      assert.ok(replacement && replacement !== session && replacement.isAlive(), "and the chat has a new one");

      const events = lifecycle();
      const starts = events.filter((event) => event.event === "start");
      assert.equal(starts.length, 2, "one new child, not two");
      const firstExit = events.find((event) => event.event === "exit" && event.pid === starts[0].pid);
      assert.ok(firstExit, "the first child exited");
      assert.ok(starts[1].at >= firstExit.at, "the second child started only after the first had exited");

      const prompt = commands().find((command) => command.type === "prompt");
      assert.equal(prompt.pid, starts[1].pid, "the message went to the NEW child");
      assert.equal(prompt.streamingBehavior, "steer");
      assert.match(prompt.message, /^This is an automatic message from Cody, not from the user\. `edit` had not answered for \d+ minutes? \(it started at \d{4}-\d\d-\d\d \d\d:\d\d [A-Z+\d:]+\)\. Cody restarted the engine at /);
      assert.match(prompt.message, /Check what actually finished \(files, git, job output\), then carry on with the task you were working on\.$/);
      assert.equal(commands().filter((command) => command.type === "prompt").length, 1, "once");

      const entry = journal.findRun("stalled-chat");
      assert.equal(entry.recoveries.length, 1, "the journal records the recovery");
      assert.match(entry.recoveries[0].reason, /^`edit` had not answered for /);

      await waitFor(() => notices.length === 1, "the push");
      assert.equal(notices[0].event, "error");
      assert.equal(notices[0].sessionId, "stalled-chat");
      assert.equal(notices[0].title, "Error · Fix login", "the chat's own name, read from its file");
      assert.match(notices[0].body, /^Stuck since .*: `edit` never answered\. Cody restarted the engine at .* and asked the agent to carry on\.$/);
    } finally {
      await getRpcSession("stalled-chat")?.destroyAndWait();
      await session.destroyAndWait();
    }
  });
});

test("a run that ends leaves no entry, one the person stops leaves none, and one cut off by a server shutdown keeps it", async () => {
  await withChat("lifecycle-chat", {}, { tickMs: 60_000 }, async ({ file, root }) => {
    const { session } = await startRpcSession("lifecycle-chat", file, root);
    try {
      assert.equal(journal.findRun("lifecycle-chat"), null, "an idle chat has no entry");

      await fakeEmit(session, { type: "agent_start" });
      assert.ok(journal.findRun("lifecycle-chat"));
      await fakeEmit(session, { type: "agent_end", isTerminal: true, messages: [] });
      assert.equal(journal.findRun("lifecycle-chat"), null, "a run that ends normally");

      await fakeEmit(session, { type: "agent_start" });
      assert.ok(journal.findRun("lifecycle-chat"));
      await session.send({ type: "abort" });
      assert.equal(journal.findRun("lifecycle-chat"), null, "a run the person stopped");

      await fakeEmit(session, { type: "agent_start" });
      assert.ok(journal.findRun("lifecycle-chat"));
      shutdown.markServerShuttingDown();
      await session.destroyAndWait("the server is stopping");
      assert.ok(journal.findRun("lifecycle-chat"), "a run cut off by the server going down");
    } finally {
      delete globalThis.__codyServerShuttingDown;
      await session.destroyAndWait();
    }
  });

  await withChat("closed-chat", {}, { tickMs: 60_000 }, async ({ file, root }) => {
    const { session } = await startRpcSession("closed-chat", file, root);
    await fakeEmit(session, { type: "agent_start" });
    assert.ok(journal.findRun("closed-chat"));
    await session.destroyAndWait("the chat was deleted");
    assert.equal(journal.findRun("closed-chat"), null, "closed for any other reason, a run in flight is abandoned, not interrupted");
  });
});

test("an engine that is killed mid-run is restarted after its wait, from the real exit sequence", async () => {
  await withChat("crashed-chat", {}, { tickMs: 50, crashDelayMs: 200 }, async ({ file, root, notices, commands, lifecycle }) => {
    const { session } = await startRpcSession("crashed-chat", file, root);
    try {
      await fakeEmit(session, { type: "agent_start" });
      const [first] = lifecycle();
      process.kill(first.pid, "SIGKILL");

      await waitFor(() => !session.isAlive(), "the wrapper to notice the child died");
      assert.ok(journal.findRun("crashed-chat"), "the engine's own exit (and the terminal agent_end it makes) is not the run finishing");

      await waitFor(() => commands().some((command) => command.type === "prompt"), "the recovery prompt");
      const starts = lifecycle().filter((event) => event.event === "start");
      assert.equal(starts.length, 2);
      const prompt = commands().find((command) => command.type === "prompt");
      assert.equal(prompt.pid, starts[1].pid);
      assert.equal(prompt.streamingBehavior, "steer");
      assert.match(prompt.message, /^This is an automatic message from Cody, not from the user\. The engine process exited unexpectedly at /);
      await waitFor(() => notices.some((notice) => /exited unexpectedly/.test(notice.body)), "the push");
    } finally {
      await getRpcSession("crashed-chat")?.destroyAndWait();
    }
  });
});

test("at boot the journal's cut-off run is resumed through the real session manager", async () => {
  await withChat("resumed-chat", {}, { tickMs: 60_000 }, async ({ file, notices, commands }) => {
    journal.beginRun("resumed-chat", Date.now() - 60_000);
    assert.equal(await recovery.createRunRecovery({ send: (draft) => { notices.push(draft); } }).resume(), 1);

    const replacement = getRpcSession("resumed-chat");
    try {
      assert.ok(replacement?.isAlive(), "the chat was started again from its own file");
      assert.equal(replacement.sessionFile, file);
      const prompt = commands().find((command) => command.type === "prompt");
      assert.equal(prompt.streamingBehavior, "steer");
      assert.match(prompt.message, /Cody's server restarted at .* while this chat was working \(last activity /);
      assert.equal(notices.length, 1);
      assert.match(notices[0].body, /^Cody restarted at .* while this chat was working; it asked the agent to carry on\.$/);
    } finally {
      await replacement?.destroyAndWait();
    }
  });
});
