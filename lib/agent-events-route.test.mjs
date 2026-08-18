import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The `connected` frame is the client's ground truth on every (re)connect.
 *
 * The wedge this pins: a container restart kills the engine mid-turn, the
 * browser's EventSource reconnects, and this route answers by RESUMING the
 * session — with a fresh engine that inherited no turn. If the frame did not
 * say so, the client would keep rendering "Waiting for model…" forever, because
 * no agent_end is ever coming for the dead turn.
 *
 * The agent dir is redirected before anything imports it, so this never touches
 * the developer's real ~/.omp. The claude engine is selected because its
 * sessions spawn no child process until the first prompt — a resumed session is
 * therefore real, live and idle, exactly the state under test.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-events-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const engineSessions = await jiti.import("./harness/engine-sessions.ts");
const eventsRoute = await jiti.import("../app/api/agent/[id]/events/route.ts");

fs.writeFileSync(
  path.join(agentDir, "cody-engine.json"),
  JSON.stringify({ version: 1, activeEngine: "claude", onboarded: true, updatedAt: new Date().toISOString() }),
);

/** Open the SSE stream and return its first frame, then hang up. */
async function firstFrame(id) {
  const controller = new AbortController();
  const res = await eventsRoute.GET(
    new Request(`http://cody.test/api/agent/${id}/events`, { signal: controller.signal }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(res.status, 200, "the stream must open");
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  // Hanging up releases the heartbeat interval and the engine listener.
  await reader.cancel();
  controller.abort();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  assert.ok(line, `expected an SSE data frame, got ${JSON.stringify(text)}`);
  return JSON.parse(line.slice("data: ".length));
}

/** Park a stand-in session in the registry the route reads. */
function registerSession(id, { alive, running }) {
  const session = {
    sessionId: id,
    sessionFile: "",
    cwd: agentDir,
    destroyPromise: null,
    isAlive: () => alive,
    isRunning: () => running,
    start() {},
    waitUntilReady: async () => {},
    onEvent: () => () => {},
    onDestroy() {},
    onIdentityChange() {},
    send: async () => null,
    destroy() {},
    destroyAndWait: async () => {},
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return session;
}

test("a resumed session announces itself as NOT running", async () => {
  const id = "resumed-session";
  engineSessions.upsertEngineSession(id, { engine: "claude", cwd: agentDir, title: "resumed" });
  globalThis.__ompSessions?.delete(id);

  const frame = await firstFrame(id);
  assert.equal(frame.type, "connected");
  assert.equal(frame.sessionId, id);
  // The whole point: a client that believes a turn is in flight learns here
  // that the turn it was waiting for is gone.
  assert.equal(frame.running, false);
});

test("a live session with a turn in flight announces itself as running", async () => {
  const id = "busy-session";
  engineSessions.upsertEngineSession(id, { engine: "claude", cwd: agentDir, title: "busy" });
  registerSession(id, { alive: true, running: true });

  const frame = await firstFrame(id);
  assert.equal(frame.running, true, "a real in-flight turn must not be cancelled by a reconnect");
});

test("a live but idle session announces itself as NOT running", async () => {
  const id = "idle-session";
  engineSessions.upsertEngineSession(id, { engine: "claude", cwd: agentDir, title: "idle" });
  registerSession(id, { alive: true, running: false });

  const frame = await firstFrame(id);
  assert.equal(frame.running, false);
});

test("a dead session in the registry is resumed, and the resumed engine is idle", async () => {
  const id = "dead-session";
  engineSessions.upsertEngineSession(id, { engine: "claude", cwd: agentDir, title: "dead" });
  // isAlive() false is exactly what a killed engine process leaves behind.
  registerSession(id, { alive: false, running: true });

  const frame = await firstFrame(id);
  assert.equal(frame.running, false, "a corpse's own isRunning() must never be believed");
});

test("the run state rides the FIRST frame, before any engine spawn", async () => {
  const source = await fs.promises.readFile(
    new URL("../app/api/agent/[id]/events/route.ts", import.meta.url),
    "utf8",
  );
  const connectedAt = source.indexOf('type: "connected"');
  const spawnAt = source.indexOf("startRpcSession(");
  assert.ok(connectedAt > 0 && spawnAt > 0);
  assert.ok(connectedAt < spawnAt, "the client must not wait on a cold spawn to learn the run state");
  assert.match(source, /running: alive \? alive\.isRunning\(\) : false/);
});
