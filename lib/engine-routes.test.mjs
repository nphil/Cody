import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The session API when a NON-OMP engine is active. omp discovers sessions by
 * walking its transcript directory; a turn-based engine has none, so the same
 * routes must answer from Cody's engine session index instead — and the two
 * worlds must never mix.
 *
 * The agent dir is redirected before anything imports it, so this test never
 * touches the developer's real ~/.omp.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-engine-routes-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const engineSessions = await jiti.import("./harness/engine-sessions.ts");
const owners = await jiti.import("./auth/session-owners.ts");
const sessionsRoute = await jiti.import("../app/api/sessions/route.ts");
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const infoRoute = await jiti.import("../app/api/info/route.ts");

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}

const listSessions = async () =>
  (await (await sessionsRoute.GET(new Request("http://cody.test/api/sessions"))).json()).sessions;
const getSession = (id) =>
  sessionRoute.GET(new Request("http://cody.test/api/sessions/x"), { params: Promise.resolve({ id }) });

test("engine sessions and omp sessions never appear in each other's listing", async () => {
  engineSessions.clearEngineSessionsCache();
  engineSessions.upsertEngineSession("claude-session", { engine: "claude", cwd: agentDir, title: "claude one" });
  engineSessions.upsertEngineSession("codex-session", { engine: "codex", cwd: agentDir, title: "codex one" });

  selectEngine("omp");
  const ompListed = await listSessions();
  assert.ok(!ompListed.some((s) => s.id === "claude-session" || s.id === "codex-session"));
  assert.equal((await getSession("claude-session")).status, 404);

  selectEngine("claude");
  const claudeListed = await listSessions();
  assert.deepEqual(claudeListed.map((s) => s.id), ["claude-session"]);
  // Rows of another engine stay addressable to no one until it is selected
  // again — resuming a claude session with codex (or the reverse) is not a
  // thing Cody may do — but the row itself survives the switch.
  assert.equal((await getSession("codex-session")).status, 404);
  assert.ok(engineSessions.getEngineSession("codex-session"));
});

test("an engine session listing carries the fields the sidebar reads", async () => {
  selectEngine("claude");
  const [row] = await listSessions();
  assert.equal(row.id, "claude-session");
  assert.equal(row.path, "");
  assert.equal(row.cwd, agentDir);
  assert.equal(row.name, "claude one");
  assert.equal(row.firstMessage, "claude one");
  assert.equal(row.projectRoot, agentDir);
  assert.equal(typeof row.created, "string");
  assert.equal(typeof row.modified, "string");
  assert.equal(row.messageCount, 0);
});

test("an engine transcript mirrors the omp payload shape with an empty history", async () => {
  selectEngine("claude");
  const body = await (await getSession("claude-session")).json();
  assert.equal(body.sessionId, "claude-session");
  assert.equal(body.filePath, "");
  assert.equal(body.leafId, null);
  assert.deepEqual(body.tree, []);
  assert.deepEqual(body.context.messages, []);
  assert.deepEqual(body.context.entryIds, []);
  assert.deepEqual(body.context.todoPhases, []);
  assert.equal(body.context.model, null);
  assert.equal(body.context.thinkingLevel, "off");
  assert.equal(body.info.cwd, agentDir);
  assert.equal(body.info.name, "claude one");
});

test("session ownership filters engine sessions by id like omp sessions", async () => {
  owners.setSessionOwner("claude-session", "user-1");
  assert.equal(owners.filterSessionsForUser([{ id: "claude-session" }], { id: "user-1" }).length, 1);
  assert.equal(owners.filterSessionsForUser([{ id: "claude-session" }], { id: "user-2" }).length, 0);
  assert.equal(owners.canAccessSession("claude-session", { id: "user-2" }), false);
  selectEngine("claude");
  assert.equal((await getSession("claude-session")).status, 200, "auth off still sees it");
});

test("/api/info publishes the active engine's identity and capabilities", async () => {
  selectEngine("claude");
  const body = await (await infoRoute.GET()).json();
  assert.deepEqual(body.engine, {
    id: "claude",
    displayName: "Claude Code",
    shortName: "Claude",
    experimental: true,
  });
  assert.equal(body.capabilities.liveSessions, true);
  assert.equal(body.capabilities.chatExtras, false);
  assert.deepEqual(Object.keys(body.capabilities).sort(), [
    "advisor",
    "chatExtras",
    "configEditor",
    "fastMode",
    "liveSessions",
    "mcp",
    "memory",
    "models",
    "nativeSettings",
    "plugins",
    "skills",
    "subagents",
    "updates",
  ]);

  selectEngine("omp");
  const ompBody = await (await infoRoute.GET()).json();
  assert.equal(ompBody.engine.id, "omp");
  assert.equal(ompBody.engine.experimental, false);
  assert.equal(ompBody.capabilities.chatExtras, true);
  assert.equal(ompBody.capabilities.fastMode, true);

  // pi: the rpc-dialect chat surface without omp's protocol extras, plus an
  // honest skills tab — and nothing that would render an omp config editor.
  selectEngine("pi");
  const piBody = await (await infoRoute.GET()).json();
  assert.equal(piBody.capabilities.chatExtras, true);
  assert.equal(piBody.capabilities.skills, true);
  assert.equal(piBody.capabilities.fastMode, false);
  assert.equal(piBody.capabilities.advisor, false);
  assert.equal(piBody.capabilities.subagents, false);
  assert.equal(piBody.capabilities.mcp, false);
  assert.equal(piBody.capabilities.models, false);
  assert.equal(piBody.capabilities.nativeSettings, false);
});

test("/api/info reports platformInfo.desktop from CODY_DESKTOP, off by default", async () => {
  const previous = process.env.CODY_DESKTOP;
  try {
    delete process.env.CODY_DESKTOP;
    const webBody = await (await infoRoute.GET()).json();
    assert.equal(webBody.platformInfo.desktop, false);

    process.env.CODY_DESKTOP = "1";
    const desktopBody = await (await infoRoute.GET()).json();
    assert.equal(desktopBody.platformInfo.desktop, true);
  } finally {
    if (previous === undefined) delete process.env.CODY_DESKTOP;
    else process.env.CODY_DESKTOP = previous;
  }
});
