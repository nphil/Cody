import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The two routes that start a turn answer 507 `disk_full` while a disk is
 * almost full, before anything is checkpointed, started or sent, and let a
 * person still talk to an agent that is already working (a steer, an
 * interrupt, Stop, a shell command) so a runaway build can be told to clean up.
 * The routes run for real; the chats are stand-ins in the session registry and
 * the disk is made up, so no engine is ever started and no real disk is asked.
 */
const root = mkdtempSync(join(tmpdir(), "cody-agent-disk-gate-route-"));
after(() => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
// The "with room" case below must stop at a preset that does not exist, which only the omp engine checks.
process.env.CODY_HARNESS = "omp";
delete process.env.OMP_WEB_HARNESS;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const commandRoute = await jiti.import("../app/api/agent/[id]/route.ts");
const newRoute = await jiti.import("../app/api/agent/new/route.ts");
const gate = await jiti.import("./disk/gate.ts");

after(() => gate.configureDiskGateForTests(null));

const GiB = 1024 ** 3;

/** The disk: nearly full (3% free) or roomy (half free). Setting it drops the gate's cached reading. */
function disk(state) {
  const availableBytes = state === "full" ? 6 * GiB : 100 * GiB;
  gate.configureDiskGateForTests({ probe: () => ({ totalBytes: 200 * GiB, availableBytes }) });
}

/** A live chat in the session registry; it records what it is sent. */
function liveChat(id, { running }) {
  const sent = [];
  (globalThis.__ompSessions ??= new Map()).set(id, {
    sessionId: id,
    cwd: workspace,
    isAlive: () => true,
    isRunning: () => running,
    send: async (command) => {
      sent.push(command);
      return { delivery: "started" };
    },
  });
  return sent;
}

async function postCommand(id, body) {
  const response = await commandRoute.POST(
    new Request(`http://cody.test/api/agent/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: await response.json() };
}

async function postNew(body) {
  const response = await newRoute.POST(new Request("http://cody.test/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

const checkpointsWritten = () => existsSync(join(agentDir, "cody-checkpoints"));

test("a prompt to an idle chat is refused with 507 disk_full, in plain words, and nothing is sent", async () => {
  const sent = liveChat("chat-idle", { running: false });
  disk("full");

  for (const command of [
    { type: "prompt", message: "build it", streamingBehavior: "steer" },
    { type: "prompt", message: "build it", streamingBehavior: "followUp" },
    { type: "prompt", message: "build it" },
    { type: "follow_up", message: "build it" },
    { type: "steer", message: "build it" },
    { type: "abort_and_prompt", message: "build it" },
  ]) {
    const { status, body } = await postCommand("chat-idle", command);
    assert.equal(status, 507, JSON.stringify(command));
    assert.equal(body.code, "disk_full");
    assert.match(body.error, /^The server's temporary disk space is almost full \(3% free: 6\.0 GB of 200 GB\)/);
    assert.match(body.error, /Clean idle scratch now/);
  }
  assert.deepEqual(sent, [], "the chat never heard of any of them");
  assert.equal(checkpointsWritten(), false, "no snapshot of the workspace was taken for a turn that did not start");
});

test("a chat that has no engine running is refused before one is started for it", async () => {
  disk("full");
  const { status, body } = await postCommand("chat-not-running-at-all", { type: "prompt", message: "hello", streamingBehavior: "steer" });
  assert.equal(status, 507);
  assert.equal(body.code, "disk_full");
  assert.equal(globalThis.__ompSessions.has("chat-not-running-at-all"), false, "no session was registered, so no engine was spawned");
  assert.equal(checkpointsWritten(), false);
});

test("an agent that is already working can still be told to stop and clean up", async () => {
  const sent = liveChat("chat-busy", { running: true });
  disk("full");

  const passes = [
    { type: "prompt", message: "stop the build and delete target/", streamingBehavior: "steer" },
    { type: "steer", message: "delete your scratch files" },
    { type: "abort_and_prompt", message: "stop, then clean up" },
    { type: "abort" },
    { type: "bash", command: "du -sh $CODY_SCRATCH" },
    { type: "get_state" },
  ];
  for (const command of passes) {
    const { status, body } = await postCommand("chat-busy", command);
    assert.equal(status, 200, JSON.stringify(command));
    assert.equal(body.success, true);
  }
  assert.deepEqual(sent.map((command) => command.type), passes.map((command) => command.type), "each one reached the agent");

  // But whatever would begin ANOTHER turn once this one ends is refused, however it asks.
  for (const command of [
    { type: "follow_up", message: "then run the whole suite again" },
    { type: "prompt", message: "then run the whole suite again", streamingBehavior: "followUp" },
  ]) {
    const { status, body } = await postCommand("chat-busy", command);
    assert.equal(status, 507, JSON.stringify(command));
    assert.equal(body.code, "disk_full");
  }
  assert.equal(sent.length, passes.length, "and none of those reached the agent");
});

test("when there is room again everything goes through as it always did", async () => {
  const sent = liveChat("chat-room", { running: false });
  disk("full");
  assert.equal((await postCommand("chat-room", { type: "follow_up", message: "go" })).status, 507);

  disk("roomy");
  const { status, body } = await postCommand("chat-room", { type: "follow_up", message: "go" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(sent.map((command) => command.message), ["go"]);
});

test("a new chat is refused before anything is created, and a malformed request is still a malformed request", async () => {
  const sessionsBefore = globalThis.__ompSessions?.size ?? 0;
  disk("full");

  for (const body of [
    { cwd: workspace, type: "ensure_session" },
    { cwd: workspace, type: "prompt", message: "hello" },
    { cwd: workspace, type: "ensure_session", kind: "sidebar" },
  ]) {
    const refused = await postNew(body);
    assert.equal(refused.status, 507, JSON.stringify(body));
    assert.equal(refused.body.code, "disk_full");
    assert.match(refused.body.error, /almost full/);
  }
  assert.equal(globalThis.__ompSessions?.size ?? 0, sessionsBefore, "no session, so no engine");
  assert.equal(checkpointsWritten(), false, "not even the snapshot a first prompt takes");

  // What was wrong with the request is said first: that does not depend on the disk.
  assert.equal((await postNew({ type: "ensure_session" })).body.code, "cwd_required");
  assert.equal((await postNew({ cwd: workspace })).body.code, "command_type_required");
  assert.equal((await postNew({ cwd: workspace, type: "ensure_session", localOnly: "yes" })).body.code, "invalid_local_routing");
});

test("with room, a new chat gets past the gate (and is stopped here by a preset that does not exist, before any engine could start)", async () => {
  disk("full");
  assert.equal((await postNew({ cwd: workspace, type: "ensure_session", presetId: "no-such-preset" })).status, 507, "the gate comes first");
  disk("roomy");
  const past = await postNew({ cwd: workspace, type: "ensure_session", presetId: "no-such-preset" });
  assert.equal(past.status, 404);
  assert.equal(past.body.code, "not_found");
  assert.equal(checkpointsWritten(), false);
});
