import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// The engine session index lives under the instance data dir — point it at a
// fresh temp dir BEFORE the modules load so tests never touch a real ~/.omp.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cody-engine-sessions-test-"));
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { TurnEngineSession } = await jiti.import("./turn-session.ts");
const { createClaudeTurnState, translateClaudeLine } = await jiti.import("./claude-stream.ts");
const { createCodexTurnState, translateCodexLine } = await jiti.import("./codex-stream.ts");
const index = await jiti.import("./engine-sessions.ts");

const CLAUDE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CODEX_THREAD_ID = "0199f0b1-thread";

const CLAUDE_TURN = [
  { type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID, model: "claude-sonnet-4-5", tools: ["Bash"] },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Listing files." } } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "Listing files." },
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "README.md", is_error: false }] },
  },
  { type: "result", subtype: "success", is_error: false, session_id: CLAUDE_SESSION_ID, total_cost_usd: 0.01 },
];

const CODEX_TURN = [
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", item_type: "agent_message", text: "Done." } },
  { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4 } },
];

/** A node one-liner standing in for the engine CLI: prints the recorded NDJSON
 * transcript, optionally writes to stderr, optionally fails. Exit happens
 * naturally so the piped stdout is fully flushed first. */
function engineScript(lines, { exitCode = 0, stderr = "" } = {}) {
  const payload = JSON.stringify(lines.map((line) => JSON.stringify(line)));
  return [
    `for (const line of ${payload}) console.log(line);`,
    stderr ? `console.error(${JSON.stringify(stderr)});` : "",
    exitCode ? `process.exitCode = ${exitCode};` : "",
  ].filter(Boolean).join("\n");
}

function makeSpec(options = {}) {
  const {
    id = "fake",
    name = "Fake Engine",
    provider = "anthropic",
    defaultModel = "fake-model",
    preassignsIdentity = true,
    lines = CLAUDE_TURN,
    exitCode = 0,
    stderr = "",
    script = engineScript(lines, { exitCode, stderr }),
    createState = createClaudeTurnState,
    translate = translateClaudeLine,
    resolveBin = () => process.execPath,
    argvCalls = [],
  } = options;
  return {
    spec: {
      id,
      name,
      provider,
      defaultModel,
      preassignsIdentity,
      resolveBin,
      buildArgv: (input) => {
        argvCalls.push(input);
        return ["-e", script];
      },
      createState,
      translate,
    },
    argvCalls,
  };
}

function collector(session) {
  const events = [];
  let waiters = [];
  session.onEvent((event) => {
    events.push(event);
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter();
  });
  return {
    events,
    types: () => events.map((event) => event.type),
    /** Resolve once `count` events of `type` have been seen. */
    waitFor(type, count = 1, timeoutMs = 20_000) {
      const satisfied = () => events.filter((event) => event.type === type).length >= count;
      if (satisfied()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count}x ${type}`)), timeoutMs);
        const check = () => {
          if (satisfied()) {
            clearTimeout(timer);
            resolve();
            return;
          }
          waiters.push(check);
        };
        waiters.push(check);
      });
    },
  };
}

test("a prompt runs one child turn and emits the full pi event sequence", async () => {
  const { spec, argvCalls } = makeSpec();
  const session = new TurnEngineSession(spec, { sessionId: CLAUDE_SESSION_ID, cwd: process.cwd() });
  session.start();
  const seen = collector(session);

  assert.equal(session.sessionId, CLAUDE_SESSION_ID);
  assert.equal(session.sessionFile, "");
  assert.equal(session.isAlive(), true);
  assert.equal(session.isRunning(), false);

  assert.equal(await session.send({ type: "prompt", message: "list the files" }), null);
  assert.equal(session.isRunning(), true);
  await seen.waitFor("agent_end");
  assert.equal(session.isRunning(), false);

  assert.deepEqual(seen.types(), [
    "agent_start",
    "message_end", // user echo
    "message_start",
    "message_end", // assistant text + toolCall
    "tool_execution_start",
    "message_end", // tool result
    "tool_execution_end",
    "agent_end",
  ]);
  assert.deepEqual(seen.events[1].message, {
    role: "user",
    content: [{ type: "text", text: "list the files" }],
    timestamp: seen.events[1].message.timestamp,
  });
  assert.equal(seen.events.at(-1).isTerminal, true);
  assert.equal(seen.events.some((event) => event.type === "notice"), false);

  // The first turn creates the engine-side session; later turns resume it.
  assert.equal(argvCalls.length, 1);
  assert.equal(argvCalls[0].resume, false);
  assert.equal(argvCalls[0].engineSessionId, CLAUDE_SESSION_ID);
  assert.equal(argvCalls[0].cwd, process.cwd());

  const { messages } = await session.send({ type: "get_messages" });
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(messages[1].content[1], {
    type: "toolCall",
    id: "toolu_01",
    name: "Bash",
    arguments: { command: "ls" },
  });

  const page = await session.send({ type: "get_messages_page", offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].role, "assistant");
  assert.equal(page.hasMore, true);

  const state = await session.send({ type: "get_state" });
  assert.equal(state.sessionId, CLAUDE_SESSION_ID);
  assert.equal(state.sessionFile, "");
  assert.equal(state.isStreaming, false);
  assert.equal(state.isPromptRunning, false);
  assert.equal(state.messageCount, 3);
  assert.deepEqual(state.model, { id: "claude-sonnet-4-5", provider: "anthropic" });
  assert.equal(state.contextUsage, null);
  assert.deepEqual(state.todoPhases, []);
  assert.equal(state.sessionName, "list the files");

  // The index row is the sidebar's only record of a non-omp session.
  const row = index.getEngineSession(CLAUDE_SESSION_ID);
  assert.equal(row.engine, "fake");
  assert.equal(row.engineSessionId, CLAUDE_SESSION_ID);
  assert.equal(row.title, "list the files");
  assert.equal(row.cwd, process.cwd());
  assert.ok(row.createdAt && row.updatedAt);
  assert.equal(statSync(index.getEngineSessionsPath()).mode & 0o777, 0o600);

  await session.destroyAndWait();
  assert.equal(session.isAlive(), false);
});

test("a second prompt resumes the engine session instead of creating one", async () => {
  const { spec, argvCalls } = makeSpec();
  const session = new TurnEngineSession(spec, { sessionId: "resume-me", cwd: process.cwd() });
  session.start();
  const seen = collector(session);

  await session.send({ type: "prompt", message: "first" });
  await seen.waitFor("agent_end", 1);
  await session.send({ type: "prompt", message: "second" });
  await seen.waitFor("agent_end", 2);

  assert.equal(argvCalls.length, 2);
  assert.equal(argvCalls[0].resume, false);
  assert.equal(argvCalls[1].resume, true);
  // The stream's own id wins over the pre-assigned one.
  assert.equal(argvCalls[1].engineSessionId, CLAUDE_SESSION_ID);
  // The title stays the FIRST prompt; updatedAt advances every turn.
  assert.equal(index.getEngineSession("resume-me").title, "first");
  await session.destroyAndWait();
});

test("only one turn runs at a time and abort ends it", async () => {
  const { spec } = makeSpec({ script: "setInterval(() => {}, 1000);" });
  const session = new TurnEngineSession(spec, { sessionId: "busy-session", cwd: process.cwd() });
  session.start();
  const seen = collector(session);

  await session.send({ type: "prompt", message: "long running" });
  await assert.rejects(
    () => session.send({ type: "prompt", message: "interrupting" }),
    (error) => {
      assert.equal(error.code, "session_busy");
      assert.equal(error.name, "EngineCommandError");
      return true;
    },
  );

  await session.send({ type: "abort" });
  await seen.waitFor("agent_end");
  // An abort is a clean ending: no failure notice for the signal that caused it.
  assert.equal(seen.events.some((event) => event.type === "notice"), false);
  assert.equal(session.isRunning(), false);
  await session.destroyAndWait();
});

test("a failing child produces an error notice and still ends the turn", async () => {
  const { spec, argvCalls } = makeSpec({ lines: [], exitCode: 3, stderr: "Error: not logged in" });
  const session = new TurnEngineSession(spec, { sessionId: "failing-session", cwd: process.cwd() });
  session.start();
  const seen = collector(session);

  await session.send({ type: "prompt", message: "hello" });
  await seen.waitFor("agent_end");

  const notice = seen.events.find((event) => event.type === "notice");
  assert.equal(notice.level, "error");
  assert.match(notice.message, /Fake Engine/);
  assert.match(notice.message, /exit code 3/);
  assert.match(notice.message, /not logged in/);
  assert.equal(seen.types().at(-1), "agent_end");

  // A turn that never reached the engine leaves nothing to resume: the retry
  // must still try to CREATE the session, not --resume one that never existed.
  await session.send({ type: "prompt", message: "try again" });
  await seen.waitFor("agent_end", 2);
  assert.equal(argvCalls[1].resume, false);
  await session.destroyAndWait();
});

test("unsupported commands, empty prompts and a missing binary fail with codes", async () => {
  const { spec } = makeSpec({ resolveBin: () => null });
  const session = new TurnEngineSession(spec, { sessionId: "unsupported-session", cwd: process.cwd() });
  session.start();

  for (const type of ["fork", "compact", "set_thinking_level", "bash", "steer"]) {
    await assert.rejects(
      () => session.send({ type }),
      (error) => {
        assert.equal(error.code, "unsupported");
        assert.match(error.message, /Fake Engine engine/);
        return true;
      },
    );
  }

  await assert.rejects(
    () => session.send({ type: "prompt", message: "   " }),
    (error) => error.code === "prompt_required",
  );
  await assert.rejects(
    () => session.send({ type: "prompt", message: "hello" }),
    (error) => error.code === "engine_not_installed",
  );

  await session.destroyAndWait();
  await assert.rejects(
    () => session.send({ type: "get_state" }),
    (error) => error.code === "session_dead",
  );
});

test("an engine that mints its own id re-keys the session and its index row", async () => {
  const { spec } = makeSpec({
    id: "fake-codex",
    name: "Fake Codex",
    provider: "openai",
    defaultModel: "codex",
    preassignsIdentity: false,
    lines: CODEX_TURN,
    createState: createCodexTurnState,
    translate: translateCodexLine,
  });
  const session = new TurnEngineSession(spec, { sessionId: "", cwd: process.cwd() });
  const localId = session.sessionId;
  assert.match(localId, /^fake-codex-/);

  const renames = [];
  session.onIdentityChange((oldId, newId) => renames.push([oldId, newId]));
  session.start();
  const seen = collector(session);

  await session.send({ type: "prompt", message: "say hello" });
  await seen.waitFor("agent_end");

  assert.deepEqual(renames, [[localId, CODEX_THREAD_ID]]);
  assert.equal(session.sessionId, CODEX_THREAD_ID);
  assert.equal(index.getEngineSession(localId), null);
  const row = index.getEngineSession(CODEX_THREAD_ID);
  assert.equal(row.engine, "fake-codex");
  assert.equal(row.engineSessionId, CODEX_THREAD_ID);
  assert.equal(row.title, "say hello");
  await session.destroyAndWait();
});

test("engine session index round-trips, renames, lists and removes rows", () => {
  index.clearEngineSessionsCache();
  const created = index.upsertEngineSession("sess-a", {
    engine: "claude",
    engineSessionId: "sess-a",
    title: "first prompt",
    cwd: "/workspace",
  });
  assert.equal(created.createdAt, created.updatedAt);

  const updated = index.upsertEngineSession("sess-a", { engine: "claude", updatedAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(updated.createdAt, created.createdAt); // createdAt is stamped once
  assert.equal(updated.title, "first prompt"); // untouched fields survive
  assert.equal(updated.updatedAt, "2030-01-01T00:00:00.000Z");

  index.upsertEngineSession("sess-b", { engine: "codex", engineSessionId: "thread-b", title: "b", cwd: "/w" });
  assert.deepEqual(index.listEngineSessions("claude").map((row) => row.sessionId), ["sess-a"]);
  const all = index.listEngineSessions().map((row) => row.sessionId);
  assert.equal(all[0], "sess-a"); // newest updatedAt first
  assert.ok(all.includes("sess-b"));

  assert.equal(index.renameEngineSession("sess-b", "thread-b").engineSessionId, "thread-b");
  assert.equal(index.getEngineSession("sess-b"), null);
  assert.equal(index.getEngineSession("thread-b").title, "b");
  assert.equal(index.renameEngineSession("missing", "whatever"), null);

  assert.equal(index.removeEngineSession("thread-b"), true);
  assert.equal(index.removeEngineSession("thread-b"), false);

  const onDisk = JSON.parse(readFileSync(index.getEngineSessionsPath(), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.ok(onDisk.sessions["sess-a"]);

  // A corrupt sidecar reads as empty instead of taking the server down.
  assert.deepEqual(index.readEngineSessions().version, 1);
});

test("session titles collapse whitespace and truncate", () => {
  assert.equal(index.engineSessionTitle("  hello   world \n again "), "hello world again");
  const long = index.engineSessionTitle("x".repeat(200));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});
