import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { SESSION_AWARENESS_TOOLS, SESSION_NOT_FOUND } = await jiti.import("./session-tools.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { setSessionOwner } = await jiti.import("./auth/session-owners.ts");

function tool(name) {
  const found = SESSION_AWARENESS_TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `${name} is not in the registry`);
  return found;
}

async function withSessions(sessions, run) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-session-tools-"));
  const sessionsDir = path.join(agentDir, "sessions", "-project");
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const session of sessions) {
    const lines = [JSON.stringify({
      type: "session",
      version: 3,
      id: session.id,
      cwd: session.cwd ?? "/proj",
      title: session.title,
      created: new Date("2026-01-01"),
      modified: new Date(session.modified ?? "2026-01-01"),
    })];
    // Entries form a TREE: buildSessionContext walks leaf -> root, so a file
    // whose messages all carry parentId null contains exactly one message on
    // its active branch. Chain them.
    let parentId = null;
    for (const [index, message] of (session.messages ?? []).entries()) {
      const id = `${session.id}-${index}`;
      lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }));
      parentId = id;
    }
    const file = path.join(sessionsDir, `${session.id}.jsonl`);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    // `modified` in a listing is the file's own mtime, not the header field.
    if (session.modified) {
      const when = new Date(session.modified);
      fs.utimesSync(file, when, when);
    }
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

const phase = (over) => ({ running: true, streaming: false, promptRunning: false, bashRunning: false, compacting: false, ...over });

function fakeUser(id) {
  return { id, username: id, fullName: id, role: "member", tokenVersion: 0, createdAt: "2026-01-01T00:00:00.000Z" };
}

test("session_status names what a running session is actually doing", async () => {
  await withSessions([
    { id: "s1", title: "Streaming one", messages: [{ role: "user", content: "go" }, { role: "assistant", provider: "p", modelId: "m", content: [{ type: "text", text: "on it" }] }] },
    { id: "s2", title: "Shelling out" },
    { id: "s3", title: "Idle one" },
  ], async () => {
    const ctx = {
      user: null,
      defaultSessionId: null,
      runningSessionIds: new Set(["s1", "s2"]),
      livePhases: new Map([["s1", phase({ streaming: true })], ["s2", phase({ bashRunning: true })]]),
    };
    const status = tool("session_status");

    const one = await status.handler({ session: "Streaming" }, ctx);
    assert.match(one, /state: running/);
    assert.match(one, /streaming a reply/);
    // A status is about content too, not only flags: the newest message rides along.
    assert.match(one, /latest: Assistant: on it/);

    const shell = await status.handler({ session: "s2" }, ctx);
    assert.match(shell, /running a shell command/);

    // No argument reports every running session and leaves the idle one out.
    const all = await status.handler({}, ctx);
    assert.match(all, /Streaming one/);
    assert.match(all, /Shelling out/);
    assert.doesNotMatch(all, /Idle one/);
  });
});

test("session_status reports no live process rather than guessing idle", async () => {
  await withSessions([{ id: "s1", title: "Quiet" }], async () => {
    const answer = await tool("session_status").handler({ session: "s1" }, {
      user: null,
      defaultSessionId: null,
      runningSessionIds: new Set(),
      livePhases: new Map(),
    });
    assert.match(answer, /state: idle/);
    assert.match(answer, /no live process/);
  });
});

test("list_sessions can be narrowed to what is running", async () => {
  await withSessions([
    { id: "s1", title: "Busy", modified: "2026-01-02" },
    { id: "s2", title: "Quiet", modified: "2026-01-03" },
  ], async () => {
    const ctx = { user: null, defaultSessionId: null, runningSessionIds: new Set(["s1"]) };
    const running = await tool("list_sessions").handler({ running: true }, ctx);
    assert.match(running, /Busy/);
    assert.doesNotMatch(running, /Quiet/);
    // Newest first when unfiltered, so "what moved last" reads off the top.
    const all = await tool("list_sessions").handler({}, ctx);
    assert.ok(all.indexOf("Quiet") < all.indexOf("Busy"));
  });
});

const INSTANT = "2026-10-01T23:31:39.753Z";

test("list_sessions and session_status write last activity in the session's zone, never as a UTC string", async () => {
  await withSessions([{ id: "s1", title: "Clocked", modified: INSTANT }], async () => {
    const base = { user: null, defaultSessionId: null, runningSessionIds: new Set(["s1"]), livePhases: new Map([["s1", phase()]]) };
    const status = tool("session_status");
    const list = tool("list_sessions");

    const newYork = { ...base, timeZone: "America/New_York" };
    assert.match(await list.handler({}, newYork), /\| 2026-10-01 19:31 EDT$/);
    assert.match(await status.handler({ session: "s1" }, newYork), /last activity: 2026-10-01 19:31 EDT/);

    // The same instant in a zone with no abbreviation: the offset is spelled out and the date has rolled over.
    const tokyo = { ...base, timeZone: "Asia/Tokyo" };
    assert.match(await list.handler({}, tokyo), /\| 2026-10-02 08:31 UTC\+09:00$/);
    assert.match(await status.handler({ session: "s1" }, tokyo), /last activity: 2026-10-02 08:31 UTC\+09:00/);

    for (const text of [await list.handler({}, newYork), await status.handler({ session: "s1" }, newYork)]) {
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });
});

test("a missing or invalid zone falls back to the server's zone, not to UTC", async () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    await withSessions([{ id: "s1", title: "Clocked", modified: INSTANT }], async () => {
      const base = { user: null, defaultSessionId: null };
      for (const timeZone of [undefined, "Not/AZone", "$(touch x)"]) {
        const text = await tool("list_sessions").handler({}, { ...base, timeZone });
        assert.match(text, /\| 2026-10-02 08:31 UTC\+09:00$/, `timeZone=${String(timeZone)}`);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("an unowned caller sees only unowned sessions, never an account's", async () => {
  await withSessions([
    { id: "mine", title: "Owned by someone" },
    { id: "loose", title: "Nobody's" },
  ], async () => {
    setSessionOwner("mine", "someone");
    // `user: null` alone means "auth is off, see everything"; the flag is what
    // keeps a terminal-created session from reading an account's conversations.
    const ctx = { user: null, defaultSessionId: null, restrictToUnowned: true, runningSessionIds: new Set() };

    const listed = await tool("list_sessions").handler({}, ctx);
    assert.match(listed, /Nobody's/);
    assert.doesNotMatch(listed, /Owned by someone/, "an owned session must not even be enumerated");

    // Naming it directly is the same answer as a session that does not exist.
    assert.equal(await tool("read_session").handler({ session: "mine" }, ctx), SESSION_NOT_FOUND);
    assert.equal(await tool("session_status").handler({ session: "mine" }, ctx), SESSION_NOT_FOUND);
    assert.equal(await tool("read_session").handler({ session: "no-such-id" }, ctx), SESSION_NOT_FOUND);
  });
});

test("an owning account reads its own session and not another's", async () => {
  await withSessions([
    { id: "a", title: "Account A", messages: [{ role: "user", content: "hello from A" }] },
    { id: "b", title: "Account B", messages: [{ role: "user", content: "hello from B" }] },
  ], async () => {
    setSessionOwner("a", "user-a");
    setSessionOwner("b", "user-b");
    const ctx = { user: fakeUser("user-a"), defaultSessionId: "a", runningSessionIds: new Set() };

    assert.match(await tool("read_session").handler({}, ctx), /hello from A/);
    assert.equal(await tool("read_session").handler({ session: "Account B" }, ctx), SESSION_NOT_FOUND);
  });
});

test("the main chat's larger budget pages fewer times than the sidebar's", async () => {
  const long = Array.from({ length: 400 }, (_, index) => ({
    role: "user",
    content: `message ${index} ${"x".repeat(120)}`,
  }));
  await withSessions([{ id: "s1", title: "Long", messages: long }], async () => {
    const base = { user: null, defaultSessionId: "s1", runningSessionIds: new Set() };
    const sidebarPage = await tool("read_session").handler({}, base);
    const mainPage = await tool("read_session").handler({}, { ...base, charBudget: 24_000 });
    assert.ok(mainPage.length > sidebarPage.length, "a larger budget returns a larger page");
    // Both still report where to continue rather than truncating silently.
    assert.match(sidebarPage, /call again with offset=/);
    assert.match(mainPage, /call again with offset=/);
  });
});
