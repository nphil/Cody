import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Server history paging: GET /api/sessions/[id] and /context with `?page=1`.
 *
 * The contract under test: a window of the branch plus stable cursors, the
 * whole branch's totals alongside it, no message ever dropped for being large,
 * the legacy (no `page`) response untouched, ownership and non-omp engines
 * honoured.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-history-page-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-history-page-accounts-"));
process.env.CODY_ACCOUNTS_DIR = accountsDir;
process.on("exit", () => fs.rmSync(accountsDir, { recursive: true, force: true }));
process.env.CODY_OMP_BIN = path.join(agentDir, "no-such-omp");
process.env.CODY_PI_BIN = path.join(agentDir, "no-such-pi");
process.env.CODY_CLAUDE_BIN = path.join(agentDir, "no-such-claude");
process.env.CODY_CODEX_BIN = path.join(agentDir, "no-such-codex");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  chooseHistoryWindow,
  computeHistoryStats,
  engineCursorId,
  pageSessionContext,
  parseHistoryPage,
  slimTreeForPage,
  HISTORY_PAGE_DEFAULT_LIMIT,
  HISTORY_PAGE_MAX_LIMIT,
  HISTORY_PAGE_MIN_BYTES,
} = await jiti.import("./session-history-page.ts");
const mainRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const contextRoute = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");
const { setSessionOwner } = await jiti.import("./auth/session-owners.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { getHarness } = await jiti.import("./harness/index.ts");
const { upsertEngineSession } = await jiti.import("./harness/engine-sessions.ts");
const { recordEngineCrash } = await jiti.import("./engine-crash-log.ts");

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}
selectEngine("omp");

test.after(() => {
  globalThis.__ompSessions?.clear();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const user = (text) => ({ role: "user", content: text });
const usage = (input, output, cost = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
const assistant = (text, extra = {}) => ({
  role: "assistant",
  provider: "p",
  model: "m",
  content: [{ type: "text", text }],
  usage: usage(10, 5, 0.5),
  ...extra,
});

/** n small user messages `u0..u(n-1)` with ids `e0..e(n-1)`. */
function branch(n) {
  return {
    messages: Array.from({ length: n }, (_, i) => user(`u${i}`)),
    entryIds: Array.from({ length: n }, (_, i) => `e${i}`),
  };
}
const request = (anchor, limit = 80, bytes = 512 * 1024) => ({ anchor, limit, bytes });

test("page=1 opts in; everything else is the legacy full response", () => {
  assert.deepEqual(parseHistoryPage(new URLSearchParams("")), { page: null });
  assert.deepEqual(parseHistoryPage(new URLSearchParams("page=0&before=e1")), { page: null });
  assert.deepEqual(parseHistoryPage(new URLSearchParams("before=e1&limit=3")), { page: null });
});

test("page=1 defaults, clamps and conflicts", () => {
  const plain = parseHistoryPage(new URLSearchParams("page=1")).page;
  assert.deepEqual(plain.anchor, { kind: "tail" });
  assert.equal(plain.limit, HISTORY_PAGE_DEFAULT_LIMIT);
  assert.deepEqual(parseHistoryPage(new URLSearchParams("page=1&before=e5")).page.anchor, { kind: "before", id: "e5" });
  assert.deepEqual(parseHistoryPage(new URLSearchParams("page=1&after=e5")).page.anchor, { kind: "after", id: "e5" });
  const huge = parseHistoryPage(new URLSearchParams("page=1&limit=99999&bytes=1")).page;
  assert.equal(huge.limit, HISTORY_PAGE_MAX_LIMIT);
  assert.equal(huge.bytes, HISTORY_PAGE_MIN_BYTES);
  assert.equal(parseHistoryPage(new URLSearchParams("page=1&limit=abc")).page.limit, HISTORY_PAGE_DEFAULT_LIMIT);
  assert.equal(parseHistoryPage(new URLSearchParams("page=1&before=a&after=b")).error.code, "history_cursor_conflict");
});

test("the tail window is the newest messages, with the oldest loaded id as the cursor", () => {
  const { context } = pageSessionContext({ ...branch(10), thinkingLevel: "high", model: null, todoPhases: [] }, request({ kind: "tail" }, 4));
  assert.deepEqual(context.entryIds, ["e6", "e7", "e8", "e9"]);
  assert.deepEqual(context.messages.map((m) => m.content), ["u6", "u7", "u8", "u9"]);
  assert.equal(context.olderCursor, "e6");
  assert.equal(context.newerCursor, null);
  assert.equal(context.totalMessages, 10);
  assert.equal(context.olderCount, 6);
  assert.equal(context.newerCount, 0);
  // The branch's current state is not windowed.
  assert.equal(context.thinkingLevel, "high");
});

test("a branch that fits has no older cursor", () => {
  const { context } = pageSessionContext({ ...branch(3), thinkingLevel: "off", model: null, todoPhases: [] }, request({ kind: "tail" }, 10));
  assert.equal(context.messages.length, 3);
  assert.equal(context.olderCursor, null);
  assert.equal(context.newerCursor, null);
});

test("before is exclusive and walking it back visits every message once, in order", () => {
  const full = { ...branch(11), thinkingLevel: "off", model: null, todoPhases: [] };
  const seen = [];
  let { context } = pageSessionContext(full, request({ kind: "tail" }, 4));
  seen.unshift(...context.entryIds);
  while (context.olderCursor) {
    const next = pageSessionContext(full, request({ kind: "before", id: context.olderCursor }, 4));
    context = next.context;
    // Strictly older: the cursor itself is never repeated.
    assert.ok(!seen.includes(context.entryIds.at(-1)));
    // A page that is not the tail knows messages follow it.
    assert.equal(context.newerCursor, context.entryIds.at(-1));
    seen.unshift(...context.entryIds);
  }
  assert.deepEqual(seen, full.entryIds);
});

test("cursors stay valid when newer messages are appended", () => {
  const before = { ...branch(8), thinkingLevel: "off", model: null, todoPhases: [] };
  const cursor = pageSessionContext(before, request({ kind: "tail" }, 3)).context.olderCursor;
  const after = { ...branch(12), thinkingLevel: "off", model: null, todoPhases: [] };
  const page = pageSessionContext(after, request({ kind: "before", id: cursor }, 3)).context;
  assert.deepEqual(page.entryIds, ["e2", "e3", "e4"]);
});

test("after walks forward to the leaf and reports the newer cursor until it gets there", () => {
  const full = { ...branch(9), thinkingLevel: "off", model: null, todoPhases: [] };
  const first = pageSessionContext(full, request({ kind: "after", id: "e1" }, 3)).context;
  assert.deepEqual(first.entryIds, ["e2", "e3", "e4"]);
  assert.equal(first.olderCursor, "e2");
  assert.equal(first.newerCursor, "e4");
  const last = pageSessionContext(full, request({ kind: "after", id: "e5" }, 10)).context;
  assert.deepEqual(last.entryIds, ["e6", "e7", "e8"]);
  assert.equal(last.newerCursor, null);
  const nothing = pageSessionContext(full, request({ kind: "after", id: "e8" })).context;
  assert.deepEqual(nothing.messages, []);
  assert.equal(nothing.olderCursor, null);
  assert.equal(nothing.newerCursor, null);
});

test("a cursor that is not on the branch is reported, never guessed", () => {
  const full = { ...branch(4), thinkingLevel: "off", model: null, todoPhases: [] };
  assert.deepEqual(pageSessionContext(full, request({ kind: "before", id: "nope" })), { error: "history_cursor_not_found" });
  assert.deepEqual(pageSessionContext(full, request({ kind: "after", id: "nope" })), { error: "history_cursor_not_found" });
  assert.deepEqual(pageSessionContext(full, request({ kind: "before", id: "e0" })).context.messages, []);
});

test("the byte budget stops a page short and a single oversized message is returned whole, alone", () => {
  const big = "x".repeat(40_000);
  const messages = [user("a"), user(big), user("b"), user("c")];
  const entryIds = ["e0", "e1", "e2", "e3"];
  const budget = HISTORY_PAGE_MIN_BYTES;
  // Tail: c and b fit; the big one does not fit after them, so it waits behind the cursor.
  const tail = chooseHistoryWindow(messages, entryIds, request({ kind: "tail" }, 50, budget), false);
  assert.deepEqual([tail.start, tail.end], [2, 4]);
  // The next page IS the big message: over budget, but never dropped.
  const next = chooseHistoryWindow(messages, entryIds, request({ kind: "before", id: "e2" }, 50, budget), false);
  assert.deepEqual([next.start, next.end], [1, 2]);
  assert.ok(next.bytes > budget);
  const last = chooseHistoryWindow(messages, entryIds, request({ kind: "before", id: "e1" }, 50, budget), false);
  assert.deepEqual([last.start, last.end], [0, 1]);
  // Forward, the same rule.
  const fwd = chooseHistoryWindow(messages, entryIds, request({ kind: "after", id: "e0" }, 50, budget), false);
  assert.deepEqual([fwd.start, fwd.end], [1, 2]);
  const reassembled = [last, next, tail].flatMap((w) => messages.slice(w.start, w.end));
  assert.deepEqual(reassembled, messages);
});

test("an engine with no entry ids is cursored by message index", () => {
  const messages = Array.from({ length: 7 }, (_, i) => user(`t${i}`));
  const full = { messages, entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  const tail = pageSessionContext(full, request({ kind: "tail" }, 3), { engine: true }).context;
  assert.deepEqual(tail.messages.map((m) => m.content), ["t4", "t5", "t6"]);
  assert.deepEqual(tail.entryIds, []);
  assert.equal(tail.olderCursor, engineCursorId(4));
  const older = pageSessionContext(full, request({ kind: "before", id: tail.olderCursor }, 3), { engine: true }).context;
  assert.deepEqual(older.messages.map((m) => m.content), ["t1", "t2", "t3"]);
  assert.equal(older.newerCursor, "m:3");
  assert.deepEqual(pageSessionContext(full, request({ kind: "before", id: "m:99" }), { engine: true }), { error: "history_cursor_not_found" });
  assert.deepEqual(pageSessionContext(full, request({ kind: "before", id: "e3" }), { engine: true }), { error: "history_cursor_not_found" });
});

test("history stats cover the whole branch", () => {
  const messages = [
    user("hi"),
    assistant("a", { content: [{ type: "toolCall", toolCallId: "1", toolName: "edit", input: {} }, { type: "text", text: "x" }] }),
    { role: "toolResult", toolName: "edit", isError: true, details: { errorKind: "stale_tag" }, content: [] },
    assistant("b", { model: "other", usage: usage(1, 1, 0) }),
  ];
  const stats = computeHistoryStats(messages);
  assert.equal(stats.totalMessages, 4);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 2);
  assert.equal(stats.toolResults, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.usage.input, 11);
  assert.equal(stats.usage.cost, 0.5);
  assert.deepEqual(stats.usage.unpricedModels, ["p/other"]);
  assert.deepEqual(stats.editRejections, { stale_tag: 1 });
  assert.deepEqual(stats.modelTurns.map((r) => [r.modelId, r.turns, r.input]), [["m", 1, 10], ["other", 1, 1]]);
  assert.equal(stats.latestAssistant.model, "other");
  assert.equal(computeHistoryStats([]).latestAssistant, null);
});

test("an imported assistant reply without model identity stays in message counts but out of model rows", () => {
  const stats = computeHistoryStats([{ role: "assistant", content: [{ type: "text", text: "Imported reply" }] }]);
  assert.equal(stats.assistantMessages, 1);
  assert.deepEqual(stats.modelTurns, []);
});

test("slimTreeForPage keeps shape, identity and a label, and drops the bodies", () => {
  const huge = "z".repeat(5000);
  const leaf = { entry: { type: "message", id: "b", parentId: "a", timestamp: "t", message: { role: "assistant", content: [{ type: "thinking", thinking: huge }, { type: "text", text: huge }], usage: {} } }, children: [] };
  const root = { entry: { type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "user", content: huge } }, children: [leaf] };
  const compaction = { entry: { type: "compaction", id: "c", parentId: "b", timestamp: "t", summary: huge, preserveData: huge }, children: [] };
  leaf.children.push(compaction);
  slimTreeForPage([root], null);
  assert.equal(root.entry.message.content.length, 80);
  assert.equal(root.entry.id, "a");
  assert.deepEqual(leaf.entry.message.content, [{ type: "text", text: "z".repeat(80) }]);
  assert.equal(leaf.entry.message.role, "assistant");
  assert.equal("usage" in leaf.entry.message, false);
  assert.deepEqual(compaction.entry, { type: "compaction", id: "c", parentId: "b", timestamp: "t" });
  assert.equal(root.children[0], leaf);
});

test("slimTreeForPage turns chain ids into a count, keeping only a leaf that sits inside a chain", () => {
  const chain = Array.from({ length: 5000 }, (_, i) => `c${i}`);
  const entry = (id) => ({ type: "custom", id, parentId: null, timestamp: "t" });
  const make = () => ({ entry: entry("end"), children: [], label: "L".repeat(5000), compressedEntryIds: [...chain] });
  const tip = make();
  const root = { entry: entry("root"), children: [tip] };
  slimTreeForPage([root], "end");
  // The active leaf is a node of its own: no ids needed, the count carries the skipped-entries figure.
  assert.equal(tip.compressedCount, 5000);
  assert.equal("compressedEntryIds" in tip, false);
  assert.equal(tip.label.length, 200);
  assert.equal("compressedCount" in root, false);
  // A leaf inside the chain is the one membership the navigator asks about.
  const inner = make();
  slimTreeForPage([{ entry: entry("root"), children: [inner] }], "c42");
  assert.deepEqual(inner.compressedEntryIds, ["c42"]);
  assert.equal(inner.compressedCount, 5000);
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

const alice = createUser({
  username: "pagealice",
  fullName: "Page Alice",
  passwordHash: await hashPassword("page-password-1"),
  role: "member",
});
const bob = createUser({
  username: "pagebob",
  fullName: "Page Bob",
  passwordHash: await hashPassword("page-password-2"),
  role: "member",
});
const asUser = (account) => ({ cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(account)}` });

const sessionsDir = getHarness().getSessionsDir();
let counter = 0;

/**
 * A chat file of `pairs` user/assistant pairs on one branch (u0,a0,u1,a1,...),
 * plus, when `fork` is set, a second assistant reply to u0 (a sibling branch).
 */
function makeChat(pairs, { fork = false, bigAt = -1, bigChars = 60_000 } = {}) {
  const id = `history-page-chat-${counter++}`;
  const dir = path.join(sessionsDir, "--history-page--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [{ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/x", version: 3 }];
  let parent = null;
  const ids = [];
  for (let i = 0; i < pairs; i++) {
    const text = i === bigAt ? "B".repeat(bigChars) : `question ${i}`;
    lines.push({ type: "message", id: `u${i}`, parentId: parent, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } });
    lines.push({
      type: "message",
      id: `a${i}`,
      parentId: `u${i}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: `answer ${i}` }], usage: usage(100, 10, 0.25) },
    });
    ids.push(`u${i}`, `a${i}`);
    parent = `a${i}`;
  }
  if (fork) {
    lines.push({
      type: "message",
      id: "fork-a0",
      parentId: "u0",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "other answer" }], usage: usage(1, 1, 0) },
    });
  }
  // A billed call that is on no branch of the chat.
  lines.push({ type: "model_usage", id: "mu1", parentId: parent, timestamp: "2026-01-01T00:00:00.000Z", provider: "p", model: "m", usage: usage(7, 3, 0.1) });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  cacheSessionPath(id, file);
  return { id, file, ids };
}

const call = async (handler, id, query = "", headers = {}) => {
  const response = await handler.GET(
    new Request(`http://cody.test/api/sessions/${id}${handler === contextRoute ? "/context" : ""}?${query}`, { headers }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: await response.json() };
};

test("legacy (no page): the whole branch, the full tree and no paging fields", async () => {
  const { id, ids } = makeChat(30);
  const res = await call(mainRoute, id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.context.entryIds, ids);
  assert.equal(res.body.context.messages.length, 60);
  assert.equal("olderCursor" in res.body.context, false);
  assert.equal("historyStats" in res.body, false);
  assert.equal(res.body.tree[0].entry.message.content, "question 0");
  const ctx = await call(contextRoute, id);
  assert.deepEqual(ctx.body.context.entryIds, ids);
  assert.equal("olderCursor" in ctx.body.context, false);
});

test("page=1 returns a window, keeps full-history totals and current state, and slims the tree", async () => {
  const { id, ids } = makeChat(30, { fork: true });
  const legacy = await call(mainRoute, id);
  const res = await call(mainRoute, id, "page=1&limit=10");
  assert.equal(res.status, 200);
  const { context } = res.body;
  assert.deepEqual(context.entryIds, ids.slice(-10));
  assert.equal(context.olderCursor, ids.at(-10));
  assert.equal(context.newerCursor, null);
  assert.equal(context.totalMessages, 60);
  // Info, leaf and current state are the full branch's, not the window's.
  assert.equal(res.body.info.messageCount, 60);
  assert.equal(res.body.info.firstMessage, "question 0");
  assert.equal(res.body.leafId, legacy.body.leafId);
  assert.deepEqual(res.body.modelUsage, legacy.body.modelUsage);
  assert.equal(context.thinkingLevel, legacy.body.context.thinkingLevel);
  assert.deepEqual(context.model, legacy.body.context.model);
  // Totals come from the whole branch.
  assert.equal(res.body.historyStats.totalMessages, 60);
  assert.equal(res.body.historyStats.userMessages, 30);
  assert.equal(res.body.historyStats.assistantMessages, 30);
  assert.equal(res.body.historyStats.usage.input, 3000);
  assert.equal(res.body.historyStats.usage.cost, 7.5);
  assert.deepEqual(res.body.historyStats.modelTurns, [{ provider: "p", modelId: "m", turns: 30, input: 3000, output: 300, cacheRead: 0, cacheWrite: 0 }]);
  // The tree keeps its shape (the fork is still a branch point) but not the bodies.
  const root = res.body.tree[0];
  assert.equal(root.entry.id, "u0");
  assert.equal(root.children.length, 2);
  const forkNode = root.children.find((child) => child.entry.id === "fork-a0");
  assert.equal(forkNode.entry.message.role, "assistant");
  assert.equal("usage" in forkNode.entry.message, false);
  // The other branch's long chain is a count, not a list of ids.
  const chainTip = root.children.find((child) => child.entry.id !== "fork-a0");
  assert.equal("compressedEntryIds" in chainTip, false);
  assert.ok(chainTip.compressedCount > 50);
  assert.equal(root.entry.message.content, "question 0");
});

test("walking before-cursors from the page=1 tail rebuilds exactly the full branch", async () => {
  const { id, ids } = makeChat(25);
  const seen = [];
  let res = await call(mainRoute, id, "page=1&limit=7");
  seen.unshift(...res.body.context.entryIds);
  while (res.body.context.olderCursor) {
    res = await call(contextRoute, id, `page=1&limit=7&before=${encodeURIComponent(res.body.context.olderCursor)}`);
    assert.equal(res.status, 200);
    seen.unshift(...res.body.context.entryIds);
  }
  assert.deepEqual(seen, ids);
});

test("/context pages a chosen branch and after walks back toward its leaf", async () => {
  const { id } = makeChat(6, { fork: true });
  const branchRes = await call(contextRoute, id, "page=1&leafId=fork-a0");
  assert.deepEqual(branchRes.body.context.entryIds, ["u0", "fork-a0"]);
  assert.equal(branchRes.body.context.olderCursor, null);
  assert.equal(branchRes.body.historyStats.totalMessages, 2);
  const forward = await call(contextRoute, id, "page=1&limit=3&after=a1");
  assert.deepEqual(forward.body.context.entryIds, ["u2", "a2", "u3"]);
  assert.equal(forward.body.context.olderCursor, "u2");
  assert.equal(forward.body.context.newerCursor, "u3");
  assert.equal(forward.body.context.newerCount, 5);
});

test("a large message is never dropped: it comes back whole, alone, behind a cursor", async () => {
  const { id } = makeChat(5, { bigAt: 2 });
  const bytes = HISTORY_PAGE_MIN_BYTES;
  const tail = await call(contextRoute, id, `page=1&bytes=${bytes}`);
  assert.deepEqual(tail.body.context.entryIds, ["a2", "u3", "a3", "u4", "a4"]);
  const big = await call(contextRoute, id, `page=1&bytes=${bytes}&before=a2`);
  assert.deepEqual(big.body.context.entryIds, ["u2"]);
  assert.equal(big.body.context.messages[0].content.length, 60_000);
  assert.equal(big.body.context.olderCursor, "u2");
  assert.ok(big.body.context.windowBytes > bytes);
  const rest = await call(contextRoute, id, `page=1&bytes=${bytes}&before=u2`);
  assert.deepEqual(rest.body.context.entryIds, ["u0", "a0", "u1", "a1"]);
  assert.equal(rest.body.context.olderCursor, null);
});

test("engine crash lines are windowed with the messages and carry the same ids on both routes", async () => {
  const { id } = makeChat(3);
  recordEngineCrash(id, { reason: "crashed", recovery: "manual", at: 1, detail: null, disk: null, quota: false });
  const main = await call(mainRoute, id, "page=1");
  const ctx = await call(contextRoute, id, "page=1");
  assert.equal(main.body.context.messages.length, 7);
  assert.deepEqual(main.body.context.entryIds, ctx.body.context.entryIds);
  assert.equal(main.body.historyStats.totalMessages, 7);
  // messageCount stays the branch's own message count, as it was.
  assert.equal(main.body.info.messageCount, 6);
});

test("bad cursors: 410 for one that is not on the branch, 400 for before together with after", async () => {
  const { id } = makeChat(3);
  for (const handler of [mainRoute, contextRoute]) {
    const gone = await call(handler, id, "page=1&before=nope");
    assert.equal(gone.status, 410);
    assert.equal(gone.body.code, "history_cursor_not_found");
    const both = await call(handler, id, "page=1&before=u1&after=u0");
    assert.equal(both.status, 400);
    assert.equal(both.body.code, "history_cursor_conflict");
  }
});

test("another account's chat is a 404 for the windowed routes too", async () => {
  const { id } = makeChat(3);
  setSessionOwner(id, alice.id);
  for (const handler of [mainRoute, contextRoute]) {
    const stranger = await call(handler, id, "page=1", asUser(bob));
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.code, "session_not_found");
    const owner = await call(handler, id, "page=1", asUser(alice));
    assert.equal(owner.status, 200);
  }
});

test("a non-omp engine pages its live turn log by message index on both routes", async () => {
  selectEngine("claude");
  try {
    const id = "history-page-engine-1";
    upsertEngineSession(id, { engine: "claude", engineSessionId: "x", title: "t", cwd: "/tmp/e", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const messages = Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : assistant(`r${i}`)));
    (globalThis.__ompSessions ??= new Map()).set(id, {
      cwd: "/tmp/e",
      sessionFile: "",
      isAlive: () => true,
      isRunning: () => false,
      send: async (command) => (command.type === "get_messages" ? { messages } : null),
    });

    const legacy = await call(mainRoute, id);
    assert.equal(legacy.body.context.messages.length, 9);
    assert.equal("olderCursor" in legacy.body.context, false);

    const tail = await call(mainRoute, id, "page=1&limit=4");
    assert.equal(tail.status, 200);
    assert.equal(tail.body.context.messages.length, 4);
    assert.deepEqual(tail.body.context.entryIds, []);
    assert.equal(tail.body.context.olderCursor, "m:5");
    assert.equal(tail.body.info.messageCount, 9);
    assert.equal(tail.body.historyStats.totalMessages, 9);
    assert.equal(tail.body.historyStats.assistantMessages, 4);

    const older = await call(contextRoute, id, "page=1&limit=4&before=m:5");
    assert.equal(older.status, 200);
    assert.deepEqual(older.body.context.messages.map((m) => m.content), messages.slice(1, 5).map((m) => m.content));
    assert.equal(older.body.context.olderCursor, "m:1");
    const first = await call(contextRoute, id, "page=1&limit=4&before=m:1");
    assert.equal(first.body.context.messages.length, 1);
    assert.equal(first.body.context.olderCursor, null);
    assert.equal((await call(contextRoute, id, "page=1&before=m:50")).status, 410);

    // The legacy /context answers for an engine too (it used to 404).
    const legacyContext = await call(contextRoute, id);
    assert.equal(legacyContext.body.context.messages.length, 9);

    // Ownership holds for the fallback too.
    setSessionOwner(id, alice.id);
    assert.equal((await call(contextRoute, id, "page=1", asUser(bob))).status, 404);
    assert.equal((await call(mainRoute, id, "page=1", asUser(bob))).status, 404);
  } finally {
    globalThis.__ompSessions?.clear();
    selectEngine("omp");
  }
});

test("a multi-megabyte first prompt and a very long linear branch cannot bloat an unrelated tail response", async () => {
  // 3 MB first prompt, then 1500 ordinary pairs on one linear branch.
  const { id } = makeChat(1500, { bigAt: 0, bigChars: 3 * 1024 * 1024 });
  const legacy = await call(mainRoute, id);
  assert.ok(JSON.stringify(legacy.body).length > 3 * 1024 * 1024, "the legacy response carries it all");

  const res = await call(mainRoute, id, "page=1&limit=10");
  assert.equal(res.status, 200);
  const bytes = JSON.stringify(res.body).length;
  assert.ok(bytes < 64 * 1024, `paged response is ${bytes} bytes`);
  // The preview is capped; the totals still say how long the chat is.
  assert.ok(res.body.info.firstMessage.length <= 200);
  assert.ok(res.body.info.firstMessage.startsWith("BBBB"));
  assert.equal(res.body.info.messageCount, 3000);
  assert.equal(res.body.context.totalMessages, 3000);
  assert.equal(res.body.context.messages.length, 10);
  // The tree is one chain (u0 ... model_usage): its entries are counted, not listed.
  const treeJson = JSON.stringify(res.body.tree);
  assert.ok(treeJson.length < 4 * 1024, `tree is ${treeJson.length} bytes`);
  const tip = res.body.tree[0].children[0];
  assert.equal("compressedEntryIds" in tip, false);
  assert.equal(tip.compressedCount + 2, 3001, "root + tip + the chain between them = every entry");
  // The legacy tree still lists every id (consumers that read it are untouched).
  assert.ok(legacy.body.tree[0].children[0].compressedEntryIds.length > 2900);
});
