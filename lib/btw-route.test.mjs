import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

/**
 * GET /api/sessions/[id]/btw — the side questions of one chat.
 *
 * Boundaries under test: another account's chat is indistinguishable from a
 * missing one; another engine never answers omp's data; a live engine answers
 * for itself but a slow one never holds the page hostage; a chat with no live
 * engine is read from disk and never starts one.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-btw-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-btw-route-accounts-"));
process.env.CODY_OMP_BIN = path.join(agentDir, "no-such-omp");
process.env.CODY_PI_BIN = path.join(agentDir, "no-such-pi");
process.env.CODY_CLAUDE_BIN = path.join(agentDir, "no-such-claude");
process.env.CODY_CODEX_BIN = path.join(agentDir, "no-such-codex");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/sessions/[id]/btw/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");
const { setSessionOwner } = await jiti.import("./auth/session-owners.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { getHarness } = await jiti.import("./harness/index.ts");

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}
selectEngine("omp");

const alice = createUser({
  username: "btwalice",
  fullName: "Btw Alice",
  passwordHash: await hashPassword("btw-password-1"),
  role: "member",
});
const bob = createUser({
  username: "btwbob",
  fullName: "Btw Bob",
  passwordHash: await hashPassword("btw-password-2"),
  role: "member",
});
const asUser = (user) => ({ cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` });

const sessionsDir = getHarness().getSessionsDir();
let counter = 0;

function turn(overrides = {}) {
  return { question: "q", answer: "a", status: "complete", createdAt: 1000, updatedAt: 2000, ...overrides };
}
function record(id, overrides = {}) {
  return { id, leafId: null, ...turn(), ...overrides };
}

/** A registered chat: a session file the path resolver finds, plus optional sidecar topics. */
function makeChat(topics = []) {
  const id = `btw-route-chat-${counter++}`;
  const dir = path.join(sessionsDir, "--btw-route--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
  cacheSessionPath(id, file);
  if (topics.length) {
    const sidecar = path.join(file.slice(0, -".jsonl".length), "btw-history");
    fs.mkdirSync(sidecar, { recursive: true });
    for (const topic of topics) fs.writeFileSync(path.join(sidecar, `entry-${topic.id}.json`), JSON.stringify(topic));
  }
  return { id, file };
}

function get(id, headers = {}) {
  return route.GET(new Request(`http://cody.test/api/sessions/${id}/btw`, { headers }), {
    params: Promise.resolve({ id }),
  });
}
const json = async (response) => ({ status: response.status, body: await response.json() });

function liveSession(id, { send, sessionFile = "" }) {
  const session = { cwd: "/tmp", sessionFile, isAlive: () => true, isRunning: () => false, send };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return session;
}

test.afterEach(() => {
  globalThis.__ompSessions?.clear();
  mock.timers.reset();
});

test.after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("another engine is refused with 400 unsupported before anything else is looked at", async () => {
  selectEngine("claude");
  try {
    const res = await json(await get("no-such-session"));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "unsupported");
  } finally {
    selectEngine("omp");
  }
});

test("another account's chat answers 404 exactly like a missing one", async () => {
  const { id } = makeChat([record("aaaa0001")]);
  setSessionOwner(id, alice.id);
  const stranger = await json(await get(id, asUser(bob)));
  const missing = await json(await get("btw-route-no-such-chat", asUser(bob)));
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger, missing);
  assert.equal(stranger.body.code, "session_not_found");
  // The owner still gets it.
  const owner = await json(await get(id, asUser(alice)));
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.records.map((r) => r.id), ["aaaa0001"]);
});

test("a missing chat with no live engine answers 404", async () => {
  const res = await json(await get("btw-route-no-such-chat"));
  assert.equal(res.status, 404);
});

test("no live engine: the sidecar is read, a running topic is reported interrupted, nothing is spawned", async () => {
  const { id } = makeChat([
    record("aaaa0001", { createdAt: 10 }),
    record("aaaa0002", { createdAt: 20, status: "running", answer: "partial" }),
  ]);
  const response = await get(id);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { status, body } = await json(response);
  assert.equal(status, 200);
  assert.equal(body.source, "disk");
  assert.equal(body.supported, null);
  assert.deepEqual(
    body.records.map((r) => [r.id, r.status, r.answer]),
    [["aaaa0002", "interrupted", "partial"], ["aaaa0001", "complete", "a"]],
  );
  assert.equal(globalThis.__ompSessions?.has(id) ?? false, false);
});

test("a dead session is treated as no session", async () => {
  const { id } = makeChat([record("aaaa0001", { status: "running" })]);
  (globalThis.__ompSessions ??= new Map()).set(id, {
    isAlive: () => false,
    send: async () => assert.fail("must not send to a dead session"),
  });
  const { body } = await json(await get(id));
  assert.equal(body.source, "disk");
  assert.equal(body.records[0].status, "interrupted");
});

test("a chat with no sidecar answers an empty list", async () => {
  const { id } = makeChat();
  const { status, body } = await json(await get(id));
  assert.equal(status, 200);
  assert.deepEqual(body, { records: [], source: "disk", supported: null });
});

test("a live engine answers for itself, parsed and newest first, without touching the disk", async () => {
  const sent = [];
  liveSession("btw-route-live", {
    // A session that has not written its file yet: only the engine knows.
    send: async (command) => {
      sent.push(command);
      return {
        records: [
          record("aaaa0001", { createdAt: 10 }),
          record("aaaa0002", { createdAt: 20, status: "running", answer: "so far" }),
          { id: "malformed" },
        ],
      };
    },
  });
  const { status, body } = await json(await get("btw-route-live"));
  assert.equal(status, 200);
  assert.deepEqual(sent, [{ type: "get_btw_history" }]);
  assert.equal(body.source, "live");
  assert.equal(body.supported, true);
  // A topic the engine says is running stays running: it is the writer.
  assert.deepEqual(body.records.map((r) => [r.id, r.status]), [["aaaa0002", "running"], ["aaaa0001", "complete"]]);
});

test("an omp that predates /btw answers supported:false with no topics", async () => {
  liveSession("btw-route-old", {
    send: async () => {
      throw new Error("Unknown command: get_btw_history");
    },
  });
  const res = await get("btw-route-old");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await json(res), { status: 200, body: { records: [], source: "live", supported: false } });
});

test("any other failure of the live engine is an error, not an empty list", async () => {
  liveSession("btw-route-broken", {
    send: async () => {
      throw new Error("disk on fire");
    },
  });
  const res = await json(await get("btw-route-broken"));
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  assert.match(res.body.error, /disk on fire/);
});

test("a live engine that never answers falls back to the disk within 3 s, topics left as written", async () => {
  const { id, file } = makeChat([record("aaaa0001", { status: "running", answer: "still writing" })]);
  let settleLate;
  liveSession(id, {
    sessionFile: file,
    send: () => new Promise((_, reject) => { settleLate = reject; }),
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = get(id);
  // Let the route reach its wait, then cross the bound.
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(2_999);
  await new Promise((resolve) => setImmediate(resolve));
  let early = false;
  pending.then(() => { early = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(early, false, "answered before the 3 s bound");
  mock.timers.tick(1);
  const { status, body } = await json(await pending);
  assert.equal(status, 200);
  assert.equal(body.source, "disk");
  assert.equal(body.supported, null);
  assert.deepEqual(body.records.map((r) => [r.id, r.status, r.answer]), [["aaaa0001", "running", "still writing"]]);
  // The engine finally failing must not become an unhandled rejection.
  settleLate(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("a slow live engine whose session file does not exist yet answers an empty list", async () => {
  liveSession("btw-route-slow-new", {
    sessionFile: path.join(agentDir, "not-created-yet.jsonl"),
    send: () => new Promise(() => {}),
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = get("btw-route-slow-new");
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(3_000);
  assert.deepEqual(await json(await pending), { status: 200, body: { records: [], source: "disk", supported: null } });
});
