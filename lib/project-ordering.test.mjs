import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  groupSessionsByProject,
  projectActivityCounts,
  retainPendingSessions,
  sortManagedProjects,
} = await jiti.import("./project-ordering.ts");
const { comparableProjectPath } = await jiti.import("./comparable-path.ts");

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    ...overrides,
  };
}

test("sorts registered projects by most-recently-added, tie-broken by path", () => {
  const projects = [
    { path: "/proj/oldest", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/newest", addedAt: "2026-03-01T00:00:00.000Z" },
    { path: "/proj/middle", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/newest", "/proj/middle", "/proj/oldest"]);
});

test("project order is stable regardless of session activity", () => {
  const projects = [
    { path: "/proj/a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/b", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  // A session whose modified timestamp is newer than project B's must NOT
  // bump project A above it — rows must never reorder from activity.
  const sessions = [
    session("s-a", { modified: "2026-06-01T00:00:00.000Z", projectRoot: "/proj/a" }),
    session("s-b", { modified: "2026-03-01T00:00:00.000Z", projectRoot: "/proj/b" }),
  ];
  const sortedAfterActivity = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/b", "/proj/a"]);
  assert.deepEqual(sortedAfterActivity, sorted);
  assert.ok(sessions.length === 2); // sessions are irrelevant to ordering
});

test("session-discovered projects without addedAt sort below registered, by path", () => {
  const projects = [
    { path: "/proj/registered" }, // discovered, no addedAt
    { path: "/proj/active", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/inactive", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/proj/zzz" }, // discovered
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/inactive", "/proj/active", "/proj/registered", "/proj/zzz"]);
});

test("groups sessions under their project, including worktree sessions", () => {
  const projects = [
    { path: "/repo", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/empty", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/other" },
  ];
  const sessions = [
    // Worktree session: cwd differs, projectRoot is the main repo.
    session("wt", { cwd: "/repo-worktrees/feature", projectRoot: "/repo" }),
    // Forked session groups under its project like any other session.
    session("fork", { parentSessionId: "parent", projectRoot: "/other" }),
    session("parent", { projectRoot: "/other" }),
  ];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("/repo").map((s) => s.id), ["wt"]);
  // Empty managed project gets an (empty) bucket.
  assert.deepEqual(grouped.get("/empty"), []);
  assert.deepEqual(grouped.get("/other").map((s) => s.id).sort(), ["fork", "parent"]);
});

test("projectActivityCounts tallies running and unread per project", () => {
  const sessions = [
    session("running-main", { projectRoot: "/repo" }),
    session("unread-main", { projectRoot: "/repo" }),
    session("running-wt", { cwd: "/repo-worktrees/x", projectRoot: "/repo" }),
    session("idle-other", { projectRoot: "/other" }),
  ];
  const counts = projectActivityCounts(sessions, ["running-main", "running-wt"], ["unread-main"]);
  // Keys are the case-folded comparable form (see projectActivityCounts docs).
  assert.deepEqual(counts.get(comparableProjectPath("/repo")), { running: 2, unread: 1 });
  assert.deepEqual(counts.get(comparableProjectPath("/other")), { running: 0, unread: 0 });
});

test("casing-only projectRoot differences still group and tally on Windows", { skip: process.platform !== "win32" }, () => {
  // A session file whose cwd casing differs from the registered project path
  // must still land in that project's bucket and its activity row.
  const projects = [{ path: "D:\\OtherProjects\\Waku", addedAt: "2026-01-01T00:00:00.000Z" }];
  const sessions = [session("s1", { projectRoot: "d:\\otherprojects\\waku" })];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("D:\\OtherProjects\\Waku").map((s) => s.id), ["s1"]);
  const counts = projectActivityCounts(sessions, ["s1"], []);
  assert.deepEqual(counts.get(comparableProjectPath("d:\\otherprojects\\waku")), { running: 1, unread: 0 });
});

// --- retainPendingSessions: a new session must survive navigating away -------
// A brand-new session has no transcript file until its first message is
// persisted, so the server list cannot report it. The shell only ever hands
// over the SELECTED session, so retention is what keeps the row alive once the
// user switches to a different session mid-run.

test("a just-created session stays pending after it stops being the selected one", () => {
  const fresh = session("new-1", { path: "" });

  // Created and selected: nothing on disk yet, so the server list is empty.
  const afterCreate = retainPendingSessions([], fresh, []);
  assert.deepEqual(afterCreate.map((s) => s.id), ["new-1"]);

  // User switches to another session: `incoming` is now null (or another
  // session), and the list still cannot see the new one. It must persist.
  const afterSwitch = retainPendingSessions(afterCreate, null, [session("other")]);
  assert.deepEqual(afterSwitch.map((s) => s.id), ["new-1"]);
});

test("a pending session is dropped once the server list reports it", () => {
  const fresh = session("new-1", { path: "" });
  const pending = retainPendingSessions([], fresh, []);

  const settled = retainPendingSessions(pending, null, [session("new-1")]);
  assert.deepEqual(settled, []);
});

test("the same session is never retained twice", () => {
  const fresh = session("new-1", { path: "" });
  let pending = retainPendingSessions([], fresh, []);
  pending = retainPendingSessions(pending, fresh, []);
  pending = retainPendingSessions(pending, fresh, []);

  assert.deepEqual(pending.map((s) => s.id), ["new-1"]);
});

test("several concurrent new sessions are all retained", () => {
  const first = retainPendingSessions([], session("new-1", { path: "" }), []);
  const both = retainPendingSessions(first, session("new-2", { path: "" }), []);
  assert.deepEqual(both.map((s) => s.id), ["new-1", "new-2"]);

  // Only the one the list now knows about goes away.
  const settled = retainPendingSessions(both, null, [session("new-1")]);
  assert.deepEqual(settled.map((s) => s.id), ["new-2"]);
});

test("array identity is preserved when nothing moved, so state cannot loop", () => {
  const pending = retainPendingSessions([], session("new-1", { path: "" }), []);

  // The session list is replaced on every refresh, so this runs constantly
  // with no actual change; a fresh array each time would re-render forever.
  const again = retainPendingSessions(pending, null, [session("other")]);
  assert.equal(again, pending);

  // An already-pending incoming session must not allocate either.
  assert.equal(retainPendingSessions(pending, pending[0], []), pending);
});

test("an empty pending set with nothing incoming stays the same array", () => {
  const empty = [];
  assert.equal(retainPendingSessions(empty, null, [session("a")]), empty);
});
