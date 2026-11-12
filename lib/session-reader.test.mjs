import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sessionPathKey } = await jiti.import("./session-path.ts");
const {
  buildSessionContext,
  cacheSessionPath,
  getSessionEntries,
  getTodoPhasesFromEntries,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  isSidebarSessionPath,
  listAllSessions,
  loadSessionFileCached,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
} = await jiti.import("./session-reader.ts");
const { buildSessionTree, resolveSessionLeafId } = await jiti.import("./omp/session-files.ts");

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

test("renders the SDK compaction-aware context with aligned entry IDs", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "kept user request"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("uses only the latest compaction on the active path", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp2", "a2", "u3", "a3"]);
  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].content, "latest summary");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

// omp 18.12.4+ writes an entry that lands off the active branch (a late
// `model_usage`, a background bash result) with `activeLeafId` = the leaf the
// session was on, and replays THAT instead of treating the last line as the
// end of the chat. Cody used to take the last entry, so after such a tail the
// transcript, todo list and model came from the abandoned branch.
function lateTail(id, parentId, activeLeafId) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:09.000Z",
    activeLeafId,
    message: { role: "bashExecution", command: "sleep 1", output: "", exitCode: 0 },
  };
}

test("a late tail entry does not move the chat off the branch the session is on", () => {
  const entries = [
    userEntry("u1", null, "first"),
    assistantEntry("a1", "u1", "one"),
    userEntry("u2", "a1", "second"),
    { type: "model_change", id: "mc2", parentId: "u2", timestamp: "2026-01-01T00:00:02.000Z", model: "other/model-two", role: "default" },
    {
      type: "message",
      id: "t2",
      parentId: "mc2",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "toolResult", toolName: "todo", content: [], details: { phases: [{ name: "Real", tasks: [{ content: "Keep", status: "in_progress" }] }] } },
    },
    assistantEntry("a2", "t2", "two"),
    lateTail("b1", "a1", "a2"),
  ];

  assert.equal(resolveSessionLeafId(entries), "a2", "the tail names the leaf it interrupted");
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["u1", "a1", "u2", "t2", "a2"], "the second question and answer stay");
  assert.deepEqual(context.todoPhases, [{ name: "Real", tasks: [{ content: "Keep", status: "in_progress" }] }]);
  assert.deepEqual(context.model, { provider: "other", modelId: "model-two" });
  assert.deepEqual(getTodoPhasesFromEntries(entries), context.todoPhases, "the todo scan resolves the same leaf");
  // An explicitly chosen leaf is still honored, and an unknown one falls back to the replayed leaf.
  assert.deepEqual(buildSessionContext(entries, "b1").entryIds, ["u1", "a1", "b1"]);
  assert.deepEqual(buildSessionContext(entries, "no-such-entry").entryIds, ["u1", "a1", "u2", "t2", "a2"]);
});

test("a tail without activeLeafId keeps the last-entry rule older engines wrote", () => {
  const entries = [
    userEntry("u1", null, "first"),
    assistantEntry("a1", "u1", "one"),
    lateTail("b1", "a1", undefined),
  ];
  assert.equal(resolveSessionLeafId(entries), "b1");
  assert.deepEqual(buildSessionContext(entries).entryIds, ["u1", "a1", "b1"]);
  assert.equal(resolveSessionLeafId([]), null);
});

test("a cleared leaf selects no branch, and a vanished named leaf falls back to the newest self-selecting entry", () => {
  const base = [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")];

  const cleared = [...base, lateTail("b1", "a1", null)];
  assert.equal(resolveSessionLeafId(cleared), null);
  assert.deepEqual(buildSessionContext(cleared).entryIds, []);

  const vanished = [...base, lateTail("b1", "a1", "rolled-back"), lateTail("b2", "a1", "also-gone")];
  assert.equal(resolveSessionLeafId(vanished), "a1", "skips the markers and lands on the newest entry that selects itself");
  assert.deepEqual(buildSessionContext(vanished).entryIds, ["u1", "a1"]);
});

test("a late model_usage is billing, not a branch: the tree leaves a dead-end one out", () => {
  const usage = (id, parentId, activeLeafId) => ({
    type: "model_usage",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:09.000Z",
    purpose: "late",
    provider: "test",
    model: "test-model",
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
    ...(activeLeafId === undefined ? {} : { activeLeafId }),
  });
  const entries = [
    userEntry("u1", null, "first"),
    usage("mu0", "u1", undefined),
    assistantEntry("a1", "mu0", "one"),
    userEntry("u2", "a1", "second"),
    assistantEntry("a2", "u2", "two"),
    usage("mu1", "a1", "a2"),
  ];

  assert.equal(resolveSessionLeafId(entries), "a2");
  const [root] = buildSessionTree(entries);
  const ids = [];
  for (let node = root; node; node = node.children[0]) {
    ids.push(node.entry.id);
    assert.ok(node.children.length <= 1, `${node.entry.id} has no phantom branch`);
  }
  assert.deepEqual(ids, ["u1", "mu0", "a1", "u2", "a2"], "an ordinary model_usage on the chain stays; the late one is gone");
});

test("reads the latest valid persisted todo snapshot from the selected branch", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "message",
      id: "todo-main",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolName: "todo",
        content: [],
        details: { phases: [{ name: "Main", tasks: [{ content: "Keep", status: "in_progress" }] }] },
      },
    },
    {
      type: "custom",
      id: "todo-alt",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "user_todo_edit",
      data: { phases: [{ name: "Alternate", tasks: [{ content: "Use this", status: "pending" }] }] },
    },
  ];

  assert.deepEqual(getTodoPhasesFromEntries(entries, "todo-main"), [
    { name: "Main", tasks: [{ content: "Keep", status: "in_progress" }] },
  ]);
  assert.deepEqual(buildSessionContext(entries, "todo-alt").todoPhases, [
    { name: "Alternate", tasks: [{ content: "Use this", status: "pending" }] },
  ]);
});

test("a later todo snapshot on the same branch replaces an earlier one", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "message",
      id: "todo-old",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolName: "todo",
        content: [],
        details: { phases: [{ name: "Old", tasks: [{ content: "Stale", status: "pending" }] }] },
      },
    },
    assistantEntry("a1", "todo-old", "worked"),
    {
      type: "custom",
      id: "todo-new",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "user_todo_edit",
      data: { phases: [{ name: "New", tasks: [{ content: "Stale", status: "completed" }] }] },
    },
    assistantEntry("a2", "todo-new", "done"),
  ];

  assert.deepEqual(getTodoPhasesFromEntries(entries, "a2"), [
    { name: "New", tasks: [{ content: "Stale", status: "completed" }] },
  ]);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");
});

test("does not defer narration thinking blocks (they are answer text)", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "thinking", thinking: "Checking the logs now.", narration: true },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.equal(context.messages[1].content[0].deferred, true);
  assert.deepEqual(context.messages[1].content[1], { type: "thinking", thinking: "Checking the logs now.", narration: true });
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("deferThinking tolerates string-content assistant entries without crashing", () => {
  // normalizeToolCalls passes non-array content through unchanged; the
  // defer-thinking branch must not 500 the context route for legacy entries.
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", content: "legacy plain-text answer" },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.equal(context.messages[1].role, "assistant");
  assert.equal(context.messages[1].content, "legacy plain-text answer");
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);

  // With a URL factory, deferred images stay addressable in place: each
  // becomes a url-source block (media route), indexed per image within the
  // entry, and no "omitted" placeholder is appended.
  const addressable = buildSessionContext(entries, undefined, {
    deferToolResultImages: true,
    toolResultImageUrl: (entryId, index) => `/media/${entryId}/${index}`,
  });
  const content = addressable.messages[2].content;
  assert.deepEqual(content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(content[1], { type: "image", source: { type: "url", url: "/media/tr1/0" } });
  assert.deepEqual(content[2], { type: "image", source: { type: "url", url: "/media/tr1/1" } });
  assert.deepEqual(content[3], toolUrlImage);
  assert.equal(content.length, 4);
});

test("preserves hidden custom messages so the UI can render them collapsed", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("the hidden per-prompt local-time line leaves no trace in the transcript", () => {
  const localTime = (id, parentId) => ({
    type: "custom_message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "cody-local-time",
    content: "Current local time: 2026-01-01 09:00 EST",
    display: false,
  });
  const withLine = buildSessionContext([
    userEntry("u1", null, "first"),
    localTime("t1", "u1"),
    assistantEntry("a1", "t1", "reply one"),
    userEntry("u2", "a1", "second"),
    localTime("t2", "u2"),
    assistantEntry("a2", "t2", "reply two"),
  ]);
  const without = buildSessionContext([
    userEntry("u1", null, "first"),
    assistantEntry("a1", "u1", "reply one"),
    userEntry("u2", "a1", "second"),
    assistantEntry("a2", "u2", "reply two"),
  ]);

  assert.deepEqual(withLine.entryIds, ["u1", "a1", "u2", "a2"]);
  assert.equal(withLine.messages.length, without.messages.length);
  assert.deepEqual(withLine.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(withLine.messages.some((m) => m.role === "custom"), false);
  assert.equal(JSON.stringify(withLine.messages).includes("Current local time"), false);
});

test("a goal's steering messages leave no row, and the file's last goal change is the goal an idle chat shows", () => {
  const goal = { id: "g1", objective: "ship it", status: "active", tokenBudget: 5000, tokensUsed: 750, timeUsedSeconds: 9, createdAt: 1000, updatedAt: 2000 };
  const modeChange = (id, parentId, mode, data) => ({
    type: "mode_change", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", mode, ...(data ? { data } : {}),
  });
  const steer = (id, parentId, customType) => ({
    type: "custom_message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", customType, content: `<${customType}>`, display: false,
  });
  const entries = [
    modeChange("m1", null, "goal", { goal: { ...goal, tokensUsed: 0 } }),
    steer("c1", "m1", "goal-mode-context"),
    userEntry("u1", "c1", "go"),
    assistantEntry("a1", "u1", "working"),
    modeChange("m2", "a1", "goal", { goal }),
    steer("c2", "m2", "goal-mode-context"),
    steer("c3", "c2", "goal-continuation"),
    steer("c4", "c3", "goal-budget-limit"),
    assistantEntry("a2", "c4", "still working"),
  ];

  const running = buildSessionContext(entries);
  assert.deepEqual(running.messages.map((message) => message.role), ["user", "assistant", "assistant"], "the three steering types draw no row");
  assert.deepEqual(running.entryIds, ["u1", "a1", "a2"]);
  // omp pauses an active goal when it reopens the file, so an idle chat shows it paused, with what it had spent.
  assert.deepEqual([running.goal.enabled, running.goal.goal.status, running.goal.goal.tokensUsed], [false, "paused", 750]);

  // Finishing records `none`; a branch that ends before that still has its goal.
  const finished = [...entries, modeChange("m3", "a2", "none"), { type: "custom", id: "x1", parentId: "m3", timestamp: "2026-01-01T00:00:02.000Z", customType: "goal-completed", data: { objective: "ship it" } }];
  assert.equal(buildSessionContext(finished).goal, null);
  assert.equal(buildSessionContext(finished, "a1").goal.goal.tokensUsed, 0, "the goal as it stood at that point of the branch");
  assert.equal(buildSessionContext([userEntry("u1", null, "no goals here")]).goal, null);
});

test("omp 18.19's hidden model-only notes and silent bookkeeping entries leave no row, while a session-transfer marker stays visible", () => {
  const note = (id, parentId, customType, display = false) => ({
    type: "custom_message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", customType, content: `<${customType}>`, display,
  });
  const silent = (id, parentId, customType) => ({
    type: "custom", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", customType, data: { anything: true },
  });
  const entries = [
    silent("s1", null, "source_session_init"),
    silent("s2", "s1", "system-prompt-digest"),
    silent("s3", "s2", "date-cwd-reminder"),
    silent("s4", "s3", "memory_recall"),
    userEntry("u1", "s4", "go"),
    note("n1", "u1", "auto-parallel-plan"),
    note("n2", "n1", "skill-notice"),
    note("n3", "n2", "memory-recall-changes"),
    note("n4", "n3", "streaming-edit-recovery"),
    assistantEntry("a1", "n4", "done"),
    { ...note("t1", "a1", "session-transfer", true), details: { kind: "arrived", fromCwd: "/a", cwd: "/b" } },
  ];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.messages.map((message) => message.role), ["user", "assistant", "custom"]);
  assert.equal(context.messages[2].customType, "session-transfer");
  assert.deepEqual(context.entryIds, ["u1", "a1", "t1"]);
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].customType, "compaction");
  assert.equal(context.messages[0].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a throwaway agent dir with one project directory of session files. */
function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "cody-agent-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  return Promise.resolve(run(projectDir)).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
}

function writeSessionFile(dir, name, header, entries = []) {
  const filePath = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

// omp writes header.parentSession as a file path (RPC branch) OR as a bare
// session id (TUI /fork, `omp --fork`, /tan). Both must link to the parent.
test("links forked children whose parentSession is a bare session id", async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "cody-missing-project");
    const parentPath = writeSessionFile(dir, "2026-01-01_parent.jsonl", {
      id: "parent-id",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "root")]);
    writeSessionFile(dir, "2026-01-02_by-path.jsonl", {
      id: "child-by-path",
      cwd,
      timestamp: "2026-01-02T00:00:00.000Z",
      parentSession: parentPath,
    }, [userEntry("u1", null, "branched")]);
    writeSessionFile(dir, "2026-01-03_by-id.jsonl", {
      id: "child-by-id",
      cwd,
      timestamp: "2026-01-03T00:00:00.000Z",
      parentSession: "parent-id",
    }, [userEntry("u1", null, "forked")]);
    writeSessionFile(dir, "2026-01-04_orphan.jsonl", {
      id: "orphan",
      cwd,
      timestamp: "2026-01-04T00:00:00.000Z",
      parentSession: "gone-id",
    }, [userEntry("u1", null, "orphan")]);

    const byId = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(byId.get("child-by-path")?.parentSessionId, "parent-id");
    assert.equal(byId.get("child-by-id")?.parentSessionId, "parent-id");
    assert.equal(byId.get("orphan")?.parentSessionId, undefined);
  });
});

test("stops resolving a session path once the file is deleted", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_doomed.jsonl", {
      id: "doomed",
      cwd: join(tmpdir(), "cody-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "hello")]);

    assert.equal(await resolveSessionPath("doomed"), filePath);
    unlinkSync(filePath);
    // A stale cache hit here would make the agent routes spawn omp with
    // --resume against a missing file, silently creating a new session.
    assert.equal(await resolveSessionPath("doomed"), null);
    assert.equal(globalThis.__piSessionPathCache?.has("doomed"), false);
  });
});

test("a transcript minted under one engine stops resolving after switching to another", async () => {
  // The path cache is keyed by session id alone and outlives an engine
  // switch. Nothing downstream re-checked it: the file-based send path hands
  // the resolved path straight to the engine's --session flag, so pi would
  // open and APPEND to omp's transcript — a turn written into a file pi's own
  // sidebar never lists.
  //
  // omp and pi share a sessions root in the shipped container
  // (PI_CODING_AGENT_DIR is set for both), which is why this needs
  // PI_CODING_AGENT_SESSION_DIR to reproduce what a from-source install has
  // by default: two engines, two roots.
  const previousHarness = process.env.CODY_HARNESS;
  const previousPiSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
  const piSessions = mkdtempSync(join(tmpdir(), "cody-pi-sessions-"));
  try {
    await withAgentDir(async (dir) => {
      process.env.CODY_HARNESS = "omp";
      const filePath = writeSessionFile(dir, "2026-01-01_switcher.jsonl", {
        id: "switcher",
        cwd: join(tmpdir(), "cody-switch-project"),
        timestamp: "2026-01-01T00:00:00.000Z",
      }, [userEntry("u1", null, "hello")]);

      // Under omp it resolves, and the cache is now warm — which is the whole
      // setup for the bug.
      assert.equal(await resolveSessionPath("switcher"), filePath);
      assert.equal(globalThis.__piSessionPathCache?.get("switcher"), filePath);

      process.env.CODY_HARNESS = "pi";
      process.env.PI_CODING_AGENT_SESSION_DIR = piSessions;
      // The file still EXISTS, so the existing deleted-file guard does not
      // fire. Only an active-engine check can refuse it.
      assert.equal(await resolveSessionPath("switcher"), null);
    });
  } finally {
    if (previousHarness === undefined) delete process.env.CODY_HARNESS;
    else process.env.CODY_HARNESS = previousHarness;
    if (previousPiSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousPiSessions;
    rmSync(piSessions, { recursive: true, force: true });
  }
});

test("switching back makes the engine's own transcripts resolve again", async () => {
  // The guard must REFUSE the other engine's file, not poison the id: a user
  // who switches away and back finds their conversation where they left it.
  const previousHarness = process.env.CODY_HARNESS;
  try {
    await withAgentDir(async (dir) => {
      process.env.CODY_HARNESS = "omp";
      const filePath = writeSessionFile(dir, "2026-01-01_roundtrip.jsonl", {
        id: "roundtrip",
        cwd: join(tmpdir(), "cody-switch-project"),
        timestamp: "2026-01-01T00:00:00.000Z",
      }, [userEntry("u1", null, "hello")]);

      assert.equal(await resolveSessionPath("roundtrip"), filePath);
      process.env.CODY_HARNESS = "pi";
      process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpdir(), "cody-pi-elsewhere");
      assert.equal(await resolveSessionPath("roundtrip"), null);

      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      process.env.CODY_HARNESS = "omp";
      assert.equal(await resolveSessionPath("roundtrip"), filePath);
    });
  } finally {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    if (previousHarness === undefined) delete process.env.CODY_HARNESS;
    else process.env.CODY_HARNESS = previousHarness;
  }
});

test("the session list never answers one engine with another engine's snapshot", async () => {
  // The sidebar reads this. A 30-second snapshot with no engine identity would
  // show omp's conversations to a pi user for up to half a minute after a
  // switch — and the only thing preventing it was the switch route
  // remembering to call invalidateSessionListCache(). That is one missed
  // invalidation away from the bug, so the cache refuses across roots itself.
  const previousHarness = process.env.CODY_HARNESS;
  const piSessions = mkdtempSync(join(tmpdir(), "cody-pi-list-"));
  try {
    await withAgentDir(async (dir) => {
      process.env.CODY_HARNESS = "omp";
      writeSessionFile(dir, "2026-01-01_ompchat.jsonl", {
        id: "ompchat",
        cwd: join(tmpdir(), "cody-list-project"),
        timestamp: "2026-01-01T00:00:00.000Z",
      }, [userEntry("u1", null, "hello")]);

      const underOmp = await listAllSessions();
      assert.ok(underOmp.some((session) => session.id === "ompchat"));

      // Deliberately NO invalidation here — that is the point. The snapshot is
      // still well inside its 30s TTL.
      process.env.CODY_HARNESS = "pi";
      process.env.PI_CODING_AGENT_SESSION_DIR = piSessions;
      const underPi = await listAllSessions();
      assert.deepEqual(underPi.map((session) => session.id), [], "pi must see its own (empty) root, not omp's snapshot");

      // And switching back does not strand the user on pi's empty answer.
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      process.env.CODY_HARNESS = "omp";
      assert.ok((await listAllSessions()).some((session) => session.id === "ompchat"));
    });
  } finally {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    if (previousHarness === undefined) delete process.env.CODY_HARNESS;
    else process.env.CODY_HARNESS = previousHarness;
    rmSync(piSessions, { recursive: true, force: true });
  }
});

test("loads sessions larger than the line-reader chunk without corrupting text", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-large-"));
  const filePath = join(dir, "large.jsonl");
  // Multi-byte content and >1 MiB of it, so lines and characters both straddle
  // the reader's chunk boundaries.
  const count = 900;
  const lines = [JSON.stringify({
    type: "session",
    version: 3,
    id: "large",
    cwd: dir,
    timestamp: "2026-01-01T00:00:00.000Z",
  })];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify(userEntry(`u${i}`, i === 0 ? null : `u${i - 1}`, `${"あ".repeat(500)}${i}`)));
  }
  writeFileSync(filePath, `${lines.join("\n")}\n`);

  try {
    const entries = getSessionEntries(filePath);
    assert.equal(entries.length, count);
    assert.equal(entries[450].message.content, `${"あ".repeat(500)}450`);
    assert.equal(entries[count - 1].message.content, `${"あ".repeat(500)}${count - 1}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async () => {
  const sessionId = "cache-test-session";
  const filePath = join(tmpdir(), "pi-web-cache-test", "..", "cache-test", "session.jsonl");

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(sessionPathKey(filePath)), false);
});

// The session-file walk cache keys on the sessions-root mtime, which does not
// change when a file is added inside an existing project subdirectory on some
// filesystems (Windows/NTFS). invalidateSessionListCache() must clear it so a
// brand-new session appears in the sidebar without a full app reload.
test("invalidateSessionListCache clears the session-file walk cache", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-01-01_first.jsonl", {
      id: "first",
      cwd: join(tmpdir(), "cody-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "first")]);

    const before = await listAllSessions();
    assert.equal(before.some((s) => s.id === "first"), true);

    // Simulate the walk cache being populated; the root mtime does not change
    // when the new file lands inside the project subdirectory.
    writeSessionFile(dir, "2026-01-02_second.jsonl", {
      id: "second",
      cwd: join(tmpdir(), "cody-missing-project"),
      timestamp: "2026-01-02T00:00:00.000Z",
    }, [userEntry("u1", null, "second")]);

    // Without invalidation the stale walk cache would hide the new session.
    invalidateSessionListCache();
    const after = await listAllSessions();
    assert.equal(after.some((s) => s.id === "second"), true);
  });
});


test("task toolResults keep size-bounded details; other toolResults stay stripped", () => {
  const entries = [
    {
      type: "message",
      id: "t1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "task",
        content: [],
        details: {
          projectAgentsDir: "C:\work\agents",
          totalDurationMs: 360000,
          progress: [{ id: "Scout", agent: "scout", status: "running", task: "Map", tokens: 100, cost: 0.001 }],
          results: [{
            id: "Scout", agent: "scout", task: "Map", exitCode: 0, tokens: 999000, cost: 1.25,
            output: "x".repeat(5000),
            stderr: "err",
            aborted: false,
            resolvedModel: "m".repeat(5000),
            outputPath: "p".repeat(5000),
          }],
          async: { state: "completed", jobId: "Scout", type: "task", message: "x".repeat(10000) },
          agent: "a".repeat(5000),
        },
      },
    },
    {
      type: "message",
      id: "t2",
      parentId: "t1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "edit",
        content: [],
        details: { huge: "x".repeat(10000), patch: "the patch" },
      },
    },
  ];
  const context = buildSessionContext(entries);
  const taskMessage = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "tc1");
  const editMessage = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "tc2");
  assert.ok(taskMessage);
  const taskDetails = taskMessage.details ?? {};
  assert.ok(Array.isArray(taskDetails.results));
  assert.equal(taskDetails.results[0].tokens, 999000);
  // bulky output is not shipped to the client
  assert.equal("output" in taskDetails.results[0], false);
  assert.equal("stderr" in taskDetails.results[0], false);
  assert.equal(taskDetails.progress[0].id, "Scout");
  assert.equal(taskDetails.async.jobId, "Scout");
  // async is projected: extra payload fields never ride the response
  assert.equal("message" in taskDetails.async, false);
  // long scalar strings are truncated to the 240-char bound
  assert.equal(taskDetails.results[0].resolvedModel.length <= 241, true);
  assert.equal(taskDetails.results[0].outputPath.length <= 241, true);
  // agent is an allowlisted (truncated) field — present but bounded
  assert.equal(taskDetails.results[0].agent.length <= 241, true);
  // non-task details keep only the allowlisted patch/diff keys
  assert.deepEqual(editMessage.details, { patch: "the patch" });
});

test("ask toolResults keep the bounded answers/notes/timedOut and the 18.8 shapes; everything else is dropped", () => {
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message });
  const entries = [
    entry("a1", null, {
      role: "toolResult",
      toolCallId: "ask-new",
      toolName: "ask",
      content: [],
      details: {
        answers: [
          { name: "plan", question: "Which plan?", answer: "Pro", extra: "dropped" },
          { name: "essay", question: "Why?", answer: "x".repeat(10000) },
          { name: "bad", question: "No answer string" },
        ],
        notes: [{ name: "plan", question: "Which plan?", option: "Pro", value: "pro", text: "annual", blob: "dropped" }],
        timedOut: true,
        html: "<form>dropped</form>",
        huge: "x".repeat(10000),
      },
    }),
    entry("a2", "a1", {
      role: "toolResult",
      toolCallId: "ask-old-one",
      toolName: "ask",
      content: [],
      details: { question: "Pick", options: [{ label: "A" }], multi: false, selectedOptions: ["A"], customInput: "mine", note: "n", timedOut: true },
    }),
    entry("a3", "a2", {
      role: "toolResult",
      toolCallId: "ask-old-many",
      toolName: "ask",
      content: [],
      details: {
        results: [
          { id: "q1", question: "One?", options: [{ label: "A" }], multi: true, selectedOptions: ["A", "B"], note: "why" },
          { id: "q2", question: "Two?", options: [], multi: false, selectedOptions: [], customInput: "typed" },
        ],
      },
    }),
    entry("a4", "a3", { role: "toolResult", toolCallId: "ask-cancel", toolName: "ask", content: [], details: { cancelled: true, big: "x".repeat(10000) } }),
  ];
  const context = buildSessionContext(entries);
  const byId = (id) => context.messages.find((m) => m.role === "toolResult" && m.toolCallId === id);

  const fresh = byId("ask-new").details;
  assert.deepEqual(Object.keys(fresh).sort(), ["answers", "notes", "timedOut"]);
  assert.equal(fresh.timedOut, true);
  assert.equal(fresh.answers.length, 2, "an entry without a string answer is skipped");
  assert.deepEqual(fresh.answers[0], { name: "plan", question: "Which plan?", answer: "Pro" });
  assert.equal(fresh.answers[1].answer.length <= 4001, true, "long answers are clipped");
  assert.deepEqual(fresh.notes, [{ name: "plan", question: "Which plan?", option: "Pro", value: "pro", text: "annual" }]);

  const one = byId("ask-old-one").details;
  assert.deepEqual(one, { question: "Pick", selectedOptions: ["A"], customInput: "mine", note: "n", timedOut: true });

  const many = byId("ask-old-many").details;
  assert.equal(many.results.length, 2);
  assert.deepEqual(many.results[0], { id: "q1", question: "One?", selectedOptions: ["A", "B"], note: "why" });
  assert.equal(many.results[1].customInput, "typed");
  assert.equal("options" in many.results[0], false);

  assert.equal(byId("ask-cancel").details, undefined, "a cancelled ask keeps nothing");
});

test("a failed edit keeps its short reason (details.errorKind); other results and successful edits do not", () => {
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message });
  const entries = [
    entry("e1", null, { role: "toolResult", toolCallId: "tc1", toolName: "edit", isError: true, content: [], details: { errorKind: "stale_tag", huge: "x".repeat(10000) } }),
    entry("e2", "e1", { role: "toolResult", toolCallId: "tc2", toolName: "edit", isError: false, content: [], details: { errorKind: "stale_tag", patch: "the patch" } }),
    entry("e3", "e2", { role: "toolResult", toolCallId: "tc3", toolName: "bash", isError: true, content: [], details: { errorKind: "stale_tag" } }),
    entry("e4", "e3", { role: "toolResult", toolCallId: "tc4", toolName: "edit", isError: true, content: [], details: { errorKind: "k".repeat(65) } }),
    entry("e5", "e4", { role: "toolResult", toolCallId: "tc5", toolName: "edit", isError: true, content: [], details: { errorKind: { nested: true } } }),
  ];
  const byCall = new Map(buildSessionContext(entries).messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  assert.deepEqual(byCall.get("tc1").details, { errorKind: "stale_tag" });
  assert.deepEqual(byCall.get("tc2").details, { patch: "the patch" }, "a successful edit has no reason to keep");
  assert.equal(byCall.get("tc3").details, undefined, "the reason is an edit-only field");
  assert.equal(byCall.get("tc4").details, undefined, "an over-long value is not shipped");
  assert.equal(byCall.get("tc5").details, undefined, "a non-string value is not shipped");
});

test("a fork's unknown-outcome tool result stays an error with its text, and the per-entry runtime stamp is ignored", () => {
  // omp 18.8.9 pairs a call the parent left unresolved with an isError result
  // ("outcome is unknown"), and 18.11 stamps every entry with the build that wrote it.
  const runtime = { version: "18.19.0", commit: "abc1234", branch: "main", label: "18.19.0 (abc1234)" };
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", runtime, message });
  const entries = [
    entry("u1", null, { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 }),
    entry("a1", "u1", { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "sleep 99" } }], stopReason: "toolUse", timestamp: 2 }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: true, content: [{ type: "text", text: "The parent session may still be running this tool; its outcome is unknown." }], timestamp: 3 }),
  ];
  const messages = buildSessionContext(entries).messages;
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "toolResult"], "the stamp neither hides nor reshapes an entry");
  const result = messages.find((m) => m.role === "toolResult");
  assert.equal(result.isError, true, "an unknown outcome is never presented as a success");
  assert.match(result.content[0].text, /outcome is unknown/);
});

test("an ask result keeps a bounded whitelist of its answers; unknown keys and other tools' answers are dropped", () => {
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message });
  const big = "é😀".repeat(5000);
  const entries = [
    entry("a1", null, { role: "toolResult", toolCallId: "n1", toolName: "ask", isError: false, content: [], details: {
      answers: [{ name: "q", question: "Which?", answer: "A", extra: "x".repeat(9000) }, { question: 5, answer: "bad" }, "junk"],
      notes: [{ name: "q", question: "Which?", option: "A", value: "a", text: "because", extra: 1 }, { question: "no option" }],
      timedOut: true,
      huge: "x".repeat(100000),
    } }),
    entry("a2", "a1", { role: "toolResult", toolCallId: "n2", toolName: "ask", isError: false, content: [], details: {
      question: "Pick", options: ["A", "B"], multi: true, selectedOptions: ["A", "B", 7], customInput: "typed", note: "n", timedOut: false, secret: "s",
    } }),
    entry("a3", "a2", { role: "toolResult", toolCallId: "n3", toolName: "ask", isError: false, content: [], details: {
      results: [{ id: "x", question: "One", options: ["A"], selectedOptions: ["A"], timedOut: true, junk: 1 }, { id: "y" }, null],
    } }),
    entry("a4", "a3", { role: "toolResult", toolCallId: "n4", toolName: "ask", isError: false, content: [], details: {
      answers: Array.from({ length: 80 }, (_, i) => ({ name: `f${i}`, question: big, answer: big })),
    } }),
    entry("a5", "a4", { role: "toolResult", toolCallId: "n5", toolName: "bash", isError: false, content: [], details: { answers: [{ question: "q", answer: "a" }], timedOut: true } }),
    entry("a6", "a5", { role: "toolResult", toolCallId: "n6", toolName: "ask", isError: false, content: [], details: { unrelated: "x".repeat(1000) } }),
  ];
  const byCall = new Map(buildSessionContext(entries).messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  assert.deepEqual(byCall.get("n1").details, {
    answers: [{ name: "q", question: "Which?", answer: "A" }],
    notes: [{ name: "q", question: "Which?", option: "A", value: "a", text: "because" }],
    timedOut: true,
  });
  assert.deepEqual(byCall.get("n2").details, { question: "Pick", selectedOptions: ["A", "B"], customInput: "typed", note: "n" });
  assert.deepEqual(byCall.get("n3").details, { results: [{ id: "x", question: "One", selectedOptions: ["A"], timedOut: true }] });
  const bounded = byCall.get("n4").details.answers;
  assert.equal(bounded.length, 50);
  assert.equal([...bounded[0].answer].length, 4001, "4000 code points plus the ellipsis, never a split surrogate");
  assert.ok(bounded[0].answer.isWellFormed());
  assert.equal(byCall.get("n5").details, undefined, "only ask keeps answers");
  assert.equal(byCall.get("n6").details, undefined, "nothing whitelisted, nothing shipped");
});

test("message entries without a message object are skipped, not fatal", () => {
  // Imports and hand-edited files can contain type:"message" entries whose
  // `message` object is missing entirely. Every reader (context build, todo
  // phases, model inference) must skip them instead of throwing.
  const entries = [
    {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: "bad1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    userEntry("u1", "bad1", "still readable"),
    {
      type: "message",
      id: "bad2",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: null,
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.deepEqual(context.entryIds, ["u1"]);

  assert.doesNotThrow(() => getTodoPhasesFromEntries(entries, "u1"));
});


test("sidebar session paths are correctly distinguished from main session paths", async () => {
  // Set up temp agent directories for testing path detection
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "cody-sidebar-test-"));
  
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    
    // Import fresh to pick up the new env var
    const jiti = createJiti(import.meta.url);
    const { getSidebarChatsDir, getSessionsDir } = await jiti.import("./omp/paths.ts");
    const { isSidebarSessionPath: isSidebarPath } = await jiti.import("./session-reader.ts");
    
    // Create test paths
    const sidebarRoot = getSidebarChatsDir();
    const sessionsRoot = getSessionsDir();
    const sidebarSessionPath = join(sidebarRoot, "test-workspace", "session-abc.jsonl");
    const mainSessionPath = join(sessionsRoot, "session-def.jsonl");
    
    // Verify sidebar path is recognized as sidebar
    assert.ok(isSidebarPath(sidebarSessionPath), "sidebar session path is recognized");
    
    // Verify main session path is not recognized as sidebar
    assert.ok(!isSidebarPath(mainSessionPath), "main session path is not a sidebar path");
    
    // Verify the roots themselves work correctly
    assert.ok(isSidebarPath(join(sidebarRoot, "test")), "sidebar root dir is recognized");
    assert.ok(!isSidebarPath(sessionsRoot), "main sessions root is not a sidebar path");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("loadSessionFileCached reuses a parse for an unchanged file, and re-parses after a real edit", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "s1.jsonl", { id: "s1" }, [
      userEntry("u1", null, "hello"),
    ]);
    const first = loadSessionFileCached(filePath, { resolveBlobs: true });
    const second = loadSessionFileCached(filePath, { resolveBlobs: true });
    assert.equal(second.entries, first.entries, "an unchanged file returns the SAME cached array, not a re-parse");

    // Appending an entry changes the file's size (and almost certainly its
    // mtime), which must invalidate the cache for this path.
    writeSessionFile(dir, "s1.jsonl", { id: "s1" }, [
      userEntry("u1", null, "hello"),
      assistantEntry("a1", "u1", "hi there"),
    ]);
    const third = loadSessionFileCached(filePath, { resolveBlobs: true });
    assert.notEqual(third.entries, first.entries, "a real edit must produce a fresh parse, not the stale cached one");
    assert.equal(third.entries.length, 2, "the fresh parse reflects the appended entry");
  });
});

test("loadSessionFileCached keys on options: resolveBlobs and skipToolResultImages do not share a cache slot", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "s1.jsonl", { id: "s1" }, [
      userEntry("u1", null, "hello"),
    ]);
    const withBlobs = loadSessionFileCached(filePath, { resolveBlobs: true, skipToolResultImages: false });
    const withoutBlobs = loadSessionFileCached(filePath, { resolveBlobs: false });
    assert.notEqual(withoutBlobs.entries, withBlobs.entries, "different options must not reuse each other's cached parse");
    // Re-requesting the FIRST option set again must still hit its own slot.
    const withBlobsAgain = loadSessionFileCached(filePath, { resolveBlobs: true, skipToolResultImages: false });
    assert.equal(withBlobsAgain.entries, withBlobs.entries);
  });
});
test("history retains background origin, payload and source entries", () => {
  const entries = [
    { type: "custom_message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "irc:incoming", content: "Can you check?", display: false, attribution: "agent" },
    { type: "custom_message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:01.000Z", customType: "irc:incoming", content: "User question?", display: true, attribution: "user" },
    { type: "message", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "custom", customType: "async-result", content: "literal async-result text", display: false, attribution: "agent" } },
  ];
  const before = structuredClone(entries);
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["a", "b", "c"]);
  assert.deepEqual(context.messages.map(message => message.attribution), ["agent", "user", "agent"]);
  assert.deepEqual(context.messages.map(message => message.content), entries.map(entry => entry.message?.content ?? entry.content));
  assert.deepEqual(entries, before);
});
