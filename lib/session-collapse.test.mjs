import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A chat omp carried on in a newer file is ONE row in the list the sidebar shows.
 *
 * omp 18.13.2+ moves a chat to a sibling file when it cannot keep writing the
 * first (another process holds it): the new file holds the whole transcript
 * again and names the old session in its header (`continuationOf`). Listing both
 * would show one chat twice, the older row frozen at the move. These pin when a
 * row is hidden, where the tree hangs from afterwards, and that Delete and
 * Archive of the row take the earlier copies along. The files are written by
 * hand in the shape omp writes; no engine is involved.
 */

const root = mkdtempSync(path.join(os.tmpdir(), "cody-collapse-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CODY_SCRATCH_ROOT", "HOME", "PI_CONFIG_FILES", "OMP_PROFILE", "PI_PROFILE", "CODY_HARNESS"].map((key) => [key, process.env[key]]));
const agentDir = path.join(root, "agent");
const sessionsDir = path.join(agentDir, "sessions", "-collapse");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_SCRATCH_ROOT = path.join(root, "scratch");
process.env.HOME = root;
process.env.PI_CONFIG_FILES = "";
// A named omp profile outranks PI_CODING_AGENT_DIR: never let one point this test at a real agent dir.
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;
delete process.env.CODY_HARNESS;

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const reader = await jiti.import("./session-reader.ts");
const { getArchivedSessionsDir } = await jiti.import("./omp/paths.ts");
const sessionsRoute = await jiti.import("../app/api/sessions/route.ts");
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const archiveRoute = await jiti.import("../app/api/sessions/[id]/archive/route.ts");

const cwd = path.join(root, "work");
const minute = (n) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const turn = (id, parentId, minutes, role, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: minute(minutes),
  message: role === "user"
    ? { role, content: [{ type: "text", text }] }
    : { role, provider: "test", model: "m", content: [{ type: "text", text }] },
});
/** The first exchange both copies of a moved chat carry. */
const firstExchange = [turn("a1", null, 1, "user", "first question"), turn("a2", "a1", 2, "assistant", "first answer")];
const afterTheMove = [turn("b1", "a2", 11, "user", "after the move"), turn("b2", "b1", 12, "assistant", "answer after the move")];

function fresh() {
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  reader.invalidateSessionListCache();
}

function write(name, header, entries) {
  const file = path.join(sessionsDir, `${name}.jsonl`);
  writeFileSync(file, `${[{ type: "session", version: 3, cwd, ...header }, ...entries].map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

/** What omp writes when it moves a chat off a file it cannot keep: the whole transcript again under a new id. */
const continuation = (name, id, of, minutes, entries) =>
  write(name, { id, timestamp: minute(minutes), parentSession: of, continuationOf: of }, entries);

const ids = (sessions) => sessions.map((session) => session.id).sort();
const parentOf = (sessions, id) => sessions.find((session) => session.id === id)?.parentSessionId;
const call = (route, method, id, init) =>
  route[method](new Request(`http://cody.test/api/sessions/${id}`, init), { params: Promise.resolve({ id }) });
const header = (file) => reader.readSessionHeader(file);

test("a chat carried on in a newer file is one row: the frozen copy is hidden and the newer one takes its place", async () => {
  fresh();
  write("a", { id: "a", timestamp: minute(0) }, firstExchange);
  continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);

  const everything = await reader.listAllSessions();
  assert.deepEqual(ids(everything), ["a", "b"], "id lookups still see every copy");
  assert.equal(everything.find((session) => session.id === "b").continuationOf, "a");
  assert.equal(everything.find((session) => session.id === "a").continuationOf, undefined);
  assert.equal(parentOf(everything, "b"), "a");

  const rows = reader.collapseContinuedSessions(everything);
  assert.deepEqual(ids(rows), ["b"]);
  assert.equal(parentOf(rows, "b"), undefined, "it stands where the copy it continues stood, not under it");
  assert.deepEqual((await reader.listSupersededCopies("b")).map((session) => session.id), ["a"]);
  assert.deepEqual(await reader.listSupersededCopies("a"), []);
});

test("an earlier copy that went on after the move is a chat of its own", async () => {
  fresh();
  // Another process kept writing to the old file: it holds turns the new one lacks.
  write("a", { id: "a", timestamp: minute(0) }, [...firstExchange, turn("a3", "a2", 15, "user", "said in the old file after the move")]);
  continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);

  const everything = await reader.listAllSessions();
  const rows = reader.collapseContinuedSessions(everything);
  assert.deepEqual(ids(rows), ["a", "b"]);
  assert.equal(parentOf(rows, "b"), "a", "left as omp wrote it");
  assert.deepEqual(await reader.listSupersededCopies("b"), []);
});

test("a chat that moved twice is one row, and forks of any earlier copy hang from the copy shown", async () => {
  fresh();
  write("p", { id: "p", timestamp: minute(0) }, [turn("p1", null, 0, "user", "root chat")]);
  write("a", { id: "a", timestamp: minute(1), parentSession: "p" }, firstExchange);
  write("f1", { id: "f1", timestamp: minute(3), parentSession: "a" }, [...firstExchange, turn("f11", "a2", 4, "user", "fork of the first copy")]);
  continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);
  write("f2", { id: "f2", timestamp: minute(12), parentSession: "b" }, [...firstExchange, ...afterTheMove, turn("f21", "b2", 13, "user", "fork of the second copy")]);
  continuation("c", "c", "b", 20, [...firstExchange, ...afterTheMove, turn("c1", "b2", 21, "user", "after the second move")]);

  const rows = reader.collapseContinuedSessions(await reader.listAllSessions());
  assert.deepEqual(ids(rows), ["c", "f1", "f2", "p"]);
  assert.equal(parentOf(rows, "c"), "p", "the copy shown takes the first copy's place in the tree");
  assert.equal(parentOf(rows, "f1"), "c");
  assert.equal(parentOf(rows, "f2"), "c");
  assert.equal(parentOf(rows, "p"), undefined);
  assert.deepEqual((await reader.listSupersededCopies("c")).map((session) => session.id), ["b", "a"], "newest first");
});

test("when two copies took over from one chat, the one with the newest turn stands in for it", async () => {
  fresh();
  write("a", { id: "a", timestamp: minute(0) }, firstExchange);
  continuation("b1", "b1", "a", 10, [...firstExchange, turn("x1", "a2", 20, "user", "one process")]);
  continuation("b2", "b2", "a", 11, [...firstExchange, turn("y1", "a2", 30, "user", "the other process")]);

  const rows = reader.collapseContinuedSessions(await reader.listAllSessions());
  assert.deepEqual(ids(rows), ["b1", "b2"]);
  assert.equal(parentOf(rows, "b2"), undefined);
  assert.equal(parentOf(rows, "b1"), "b2", "no turn is lost: the other copy stays, under the row that took the chat's place");
  assert.deepEqual((await reader.listSupersededCopies("b2")).map((session) => session.id), ["a"]);
});

test("a continuation naming a chat that is not listed, itself, or a loop hides nothing", async () => {
  fresh();
  write("gone", { id: "gone-child", timestamp: minute(10), continuationOf: "gone" }, firstExchange);
  write("self", { id: "self", timestamp: minute(10), continuationOf: "self" }, firstExchange);
  // Never written by omp: each names the other and neither said anything after the other began.
  write("x", { id: "x", timestamp: minute(5), continuationOf: "y" }, [turn("x1", null, 4, "user", "x")]);
  write("y", { id: "y", timestamp: minute(5), continuationOf: "x" }, [turn("y1", null, 4, "user", "y")]);

  const rows = reader.collapseContinuedSessions(await reader.listAllSessions());
  assert.deepEqual(ids(rows), ["gone-child", "self", "x", "y"]);
});

test("the sidebar route lists one row for a continued chat, and that row opens", async () => {
  fresh();
  write("a", { id: "a", timestamp: minute(0) }, firstExchange);
  continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);

  const body = await (await sessionsRoute.GET(new Request("http://cody.test/api/sessions"))).json();
  assert.deepEqual(body.sessions.map((session) => session.id), ["b"]);
  assert.equal(body.sessions[0].continuationOf, "a");
  // The page opens the row it is shown, and that row's path stays resolvable.
  assert.equal((await call(sessionRoute, "GET", "b")).status, 200);
});

test("Delete of the row takes every earlier copy along and hands forks up the chain", async () => {
  fresh();
  const pFile = write("p", { id: "p", timestamp: minute(0) }, [turn("p1", null, 0, "user", "root chat")]);
  const aFile = write("a", { id: "a", timestamp: minute(1), parentSession: pFile }, firstExchange);
  const bFile = continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);
  // One fork names its parent by file path, the other by bare id (see resolveParentSessionId).
  const fFile = write("f", { id: "f", timestamp: minute(3), parentSession: aFile }, [...firstExchange, turn("f1", "a2", 4, "user", "fork of the first copy")]);
  const gFile = write("g", { id: "g", timestamp: minute(12), parentSession: "b" }, [...firstExchange, ...afterTheMove, turn("g1", "b2", 13, "user", "fork of the second copy")]);

  const response = await call(sessionRoute, "DELETE", "b", { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(existsSync(bFile), false);
  assert.equal(existsSync(aFile), false, "the frozen copy goes with the row, or the chat would reappear");
  assert.equal(existsSync(pFile), true);
  assert.equal(header(fFile).parentSession, pFile, "kept the path form");
  assert.equal(header(gFile).parentSession, "p", "kept the id form");

  reader.invalidateSessionListCache();
  const rows = await reader.listAllSessions();
  assert.deepEqual(ids(rows), ["f", "g", "p"]);
  assert.equal(parentOf(rows, "f"), "p");
  assert.equal(parentOf(rows, "g"), "p");
});

test("Delete of an earlier copy by its own id removes just that file", async () => {
  fresh();
  const aFile = write("a", { id: "a", timestamp: minute(0) }, firstExchange);
  const bFile = continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);

  assert.equal((await call(sessionRoute, "DELETE", "a", { method: "DELETE" })).status, 200);
  assert.equal(existsSync(aFile), false);
  assert.equal(existsSync(bFile), true);
  reader.invalidateSessionListCache();
  assert.deepEqual(ids(reader.collapseContinuedSessions(await reader.listAllSessions())), ["b"]);
});

test("Archive of the row takes every earlier copy along, and forks of an earlier copy hold it back", async () => {
  fresh();
  const aFile = write("a", { id: "a", timestamp: minute(0) }, firstExchange);
  const bFile = continuation("b", "b", "a", 10, [...firstExchange, ...afterTheMove]);
  // A fork of the FIRST copy: in the list it hangs from the row shown, so the row has a child.
  const fFile = write("f", { id: "f", timestamp: minute(3), parentSession: aFile }, [...firstExchange, turn("f1", "a2", 4, "user", "fork of the first copy")]);

  const blocked = await call(archiveRoute, "POST", "b", { method: "POST" });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "session_has_children");
  assert.equal(existsSync(aFile) && existsSync(bFile), true, "nothing moved");

  unlinkSync(fFile);
  reader.invalidateSessionListCache();
  const archived = await call(archiveRoute, "POST", "b", { method: "POST" });
  assert.equal(archived.status, 200);
  assert.equal(existsSync(bFile), false);
  assert.equal(existsSync(aFile), false);
  const archiveDir = path.join(getArchivedSessionsDir(), "-collapse");
  assert.equal(existsSync(path.join(archiveDir, "a.jsonl.gz")), true, "the earlier copy is archived beside the row's own");
  assert.equal(existsSync(path.join(archiveDir, "b.jsonl.gz")), true);
  reader.invalidateSessionListCache();
  assert.deepEqual(await reader.listAllSessions(), []);
});

test("a compaction's engine-only preserveData never reaches the page, and the chat's model_usage spend does", async () => {
  fresh();
  const frames = "A".repeat(300_000); // stands in for a snapcompact archive's base64 PNG frames
  write("c", { id: "c", timestamp: minute(0) }, [
    ...firstExchange,
    // The compaction ENDS the chat here, so the projected tree keeps it as a leaf.
    { type: "compaction", id: "k1", parentId: "a2", timestamp: minute(3), summary: "earlier work", firstKeptEntryId: "a1", tokensBefore: 1000, preserveData: { snapcompact: { frames: [frames] } } },
    // Billed calls that are not messages: one on the chain, one late and off the branch.
    { type: "model_usage", id: "mu1", parentId: "k1", timestamp: minute(4), purpose: "auto-thinking", provider: "acme", model: "tiny", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    { type: "model_usage", id: "mu2", parentId: "a2", timestamp: minute(5), purpose: "discarded-turn", provider: "acme", model: "tiny", activeLeafId: "mu1", usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
  ]);

  const response = await call(sessionRoute, "GET", "c");
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text.includes(frames), false, "the archive is not sent");
  assert.equal(text.includes("snapcompact"), false);
  const body = JSON.parse(text);
  assert.deepEqual(body.modelUsage && [body.modelUsage.input, body.modelUsage.output], [110, 5], "both entries count, whichever branch");
  assert.ok(Math.abs(body.modelUsage.cost - 0.11) < 1e-9);
  assert.equal(body.leafId, "mu1");

  // A chat with no such entries carries no rollup at all.
  fresh();
  write("plain", { id: "plain", timestamp: minute(0) }, firstExchange);
  assert.equal("modelUsage" in (await (await call(sessionRoute, "GET", "plain")).json()), false);
});
