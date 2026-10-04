import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * The whole path with nothing in between faked but the network: a REAL session
 * (the real wrapper behind the real startRpcSession, talking to a scripted
 * stand-in for omp; and the real ACP session against its stub agent), the real
 * observer and dispatcher, the real settings, and the real answer route — with
 * ntfy's HTTP replaced by a recorder. What a phone would receive, and what its
 * button press does to the chat.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-e2e-"));
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession, getRpcSession } = await jiti.import("../rpc-manager.ts");
const { AcpEngineSession } = await jiti.import("../harness/acp-session.ts");
const { observeSessionForNotifications } = await jiti.import("./observer.ts");
const actionRoute = await jiti.import("../../app/api/notifications/action/route.ts");
const presenceRoute = await jiti.import("../../app/api/notifications/presence/route.ts");
const store = await jiti.import("./store.ts");
const compose = await jiti.import("./compose.ts");

const FAKE_OMP = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
let sessionId = process.env.FAKE_OMP_SESSION_ID;
let sessionFile = process.env.FAKE_OMP_SESSION_FILE;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (process.env.FAKE_OMP_LOG) fs.appendFileSync(process.env.FAKE_OMP_LOG, line + "\n");
  const reply = (fields) => send({ type: "response", id: command.id, command: command.type, ...fields });
  switch (command.type) {
    case "get_state":
      return reply({ success: true, data: { sessionId, sessionFile, isStreaming: false, isCompacting: false, messageCount: 0, queuedMessageCount: 0 } });
    case "set_ask_dialog":
      return reply({ success: true, data: { enabled: command.enabled === true } });
    case "fake_emit":
      send(command.frame);
      return reply({ success: true });
    default:
      // extension_ui_response is a frame, not a command: it has no id to answer.
      if (command.id === undefined || command.type === "extension_ui_response") return;
      return reply({ success: true });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function withEnv(overrides, run) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A real omp session (the wrapper, started by startRpcSession) against the scripted omp. */
async function withOmpSession(sessionId, run, { kind } = {}) {
  const { invalidateOmpCliCache } = await jiti.import("../omp/omp-cli.ts");
  const dir = mkdtempSync(join(tmpdir(), "cody-notify-e2e-omp-"));
  const bin = join(dir, "fake-omp");
  const log = join(dir, "commands.log");
  writeFileSync(bin, FAKE_OMP);
  chmodSync(bin, 0o755);
  mkdirSync(join(dir, "agent"), { recursive: true });
  const commandsSent = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  try {
    return await withEnv(
      { PI_CODING_AGENT_DIR: join(dir, "agent"), CODY_OMP_BIN: bin, FAKE_OMP_LOG: log, FAKE_OMP_SESSION_ID: sessionId, FAKE_OMP_SESSION_FILE: join(dir, "s.jsonl") },
      async () => {
        invalidateOmpCliCache();
        const { session } = await startRpcSession(sessionId, join(dir, "s.jsonl"), dir, undefined, false, undefined, undefined, kind, kind === "sidebar" ? { contextSessionId: null } : undefined);
        const emit = (frame) => session.proc.sendCommand({ type: "fake_emit", frame });
        try {
          return await run({ session, emit, commandsSent, dir });
        } finally {
          await session.destroyAndWait();
        }
      },
    );
  } finally {
    invalidateOmpCliCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Record what would go to ntfy. */
function stubNetwork() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await wait(10);
  }
}
const publishes = (net) => net.calls.filter((call) => call.method === "POST");
const clears = (net) => net.calls.filter((call) => call.method === "PUT");

const configure = (patch = {}) =>
  store.updateNotificationPrefs("__instance", { enabled: true, server: "https://ntfy.test", topic: "e2e", token: "tk_e2e", codyUrl: "https://cody.test", answerButtons: true, finishedMinSeconds: 0, skipWhenViewing: true, ...patch });

const tap = (button) =>
  actionRoute.POST(new Request("http://cody.test/api/notifications/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: button.body }));

const toolApproval = (id) => ({ type: "extension_ui_request", id, method: "confirm", title: "Allow tool: bash", message: "rm -rf build" });

test("omp: an approval reaches the phone with Allow and Deny; tapping Allow answers the real chat once and takes the notification down", async () => {
  configure();
  const net = stubNetwork();
  try {
    await withOmpSession("e2e-omp-1", async ({ session, emit, commandsSent }) => {
      await emit({ type: "agent_start" });
      await emit(toolApproval("dialog-1"));
      await until(() => publishes(net).length === 1, "the approval to be published");

      const [published] = publishes(net);
      assert.equal(published.url, "https://ntfy.test/");
      assert.equal(published.headers.Authorization, "Bearer tk_e2e");
      assert.equal(published.body.topic, "e2e");
      assert.match(published.body.title, /^Approval needed · /);
      assert.equal(published.body.message, "Tool: bash\nrm -rf build");
      assert.equal(published.body.priority, 4);
      assert.deepEqual(published.body.tags.slice(0, 1), ["lock"]);
      assert.equal(published.body.click, "https://cody.test/?session=e2e-omp-1");
      assert.equal(published.body.sequence_id, compose.sequenceIdFor("e2e-omp-1", "dialog-1"));
      const buttons = published.body.actions;
      assert.deepEqual(buttons.map((button) => button.label), ["Allow", "Deny"]);
      assert.equal(session.hasPendingInput(), true);

      // The phone taps Allow.
      const answered = await tap(buttons[0]);
      assert.equal(answered.status, 200);
      assert.deepEqual(await answered.json(), { ok: true });
      await until(() => commandsSent().some((command) => command.type === "extension_ui_response"), "omp to receive the answer");
      assert.deepEqual(commandsSent().filter((command) => command.type === "extension_ui_response"), [{ type: "extension_ui_response", id: "dialog-1", confirmed: true }]);
      assert.equal(session.hasPendingInput(), false, "the chat is no longer waiting");

      // The observer takes it down once, on the request's own sequence id.
      await until(() => clears(net).length >= 1, "the notification to be cleared");
      assert.equal(clears(net)[0].url, `https://ntfy.test/e2e/${compose.sequenceIdFor("e2e-omp-1", "dialog-1")}/clear`);

      // The other button, and a repeat of this one, do nothing.
      assert.equal((await tap(buttons[1])).status, 410);
      assert.equal((await tap(buttons[0])).status, 401);
      assert.equal(commandsSent().filter((command) => command.type === "extension_ui_response").length, 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(clears(net).length, 1, "cleared exactly once");
    });
  } finally {
    net.restore();
  }
});

test("omp: a dialog omp cancels, and one that is still open when the chat closes, both come down", async () => {
  configure();
  const net = stubNetwork();
  try {
    await withOmpSession("e2e-omp-2", async ({ session, emit }) => {
      await emit({ type: "extension_ui_request", id: "pick", method: "select", title: "Which?", options: ["a", "b", "c", "d"] });
      await emit(toolApproval("stays-open"));
      await until(() => publishes(net).length === 2, "both to be published");
      assert.equal("actions" in publishes(net)[0].body, false, "four options: a question with no buttons");
      assert.equal(publishes(net)[0].body.sequence_id, compose.sequenceIdFor("e2e-omp-2", "pick"));

      await emit({ type: "extension_ui_request", id: "cancel-1", method: "cancel", targetId: "pick" });
      await until(() => clears(net).length === 1, "omp's cancel to clear the first");
      assert.equal(clears(net)[0].url, `https://ntfy.test/e2e/${compose.sequenceIdFor("e2e-omp-2", "pick")}/clear`);

      await session.destroyAndWait();
      await until(() => clears(net).length === 2, "closing the chat to clear the one still open");
      assert.equal(clears(net)[1].url, `https://ntfy.test/e2e/${compose.sequenceIdFor("e2e-omp-2", "stays-open")}/clear`);
    });
  } finally {
    net.restore();
  }
});

test("omp: a chat too new to have a name is titled by the opening words of its first message", async () => {
  configure();
  const net = stubNetwork();
  try {
    await withOmpSession("e2e-omp-title", async ({ emit }) => {
      await emit({ type: "agent_start" });
      await emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "\nFix the login redirect loop on the settings page after a password change, then run the tests" }] } });
      await emit(toolApproval("title-1"));
      await until(() => publishes(net).length === 1, "the approval to be published");
      assert.equal(publishes(net)[0].body.title, "Approval needed · Fix the login redirect loop on the settings page after a pa…");
    });
  } finally {
    net.restore();
  }
});

test("omp: a finished run, a stopped run and a failed run say three different things — or nothing", async () => {
  configure();
  const net = stubNetwork();
  const reply = (text, stopReason = "stop", extra = {}) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra } });
  try {
    await withOmpSession("e2e-omp-3", async ({ emit }) => {
      await emit({ type: "agent_start" });
      await emit(reply("The refactor is done and the tests pass."));
      await emit({ type: "agent_end", messages: [] });
      await until(() => publishes(net).length === 1, "finished");
      assert.match(publishes(net)[0].body.title, /^Reply finished · /);
      assert.equal(publishes(net)[0].body.message, "The refactor is done and the tests pass.");
      assert.deepEqual(publishes(net)[0].body.tags.slice(0, 1), ["white_check_mark"]);

      await emit({ type: "agent_start" });
      await emit(reply("Working…", "aborted"));
      await emit({ type: "agent_end", messages: [] });
      await wait(80);
      assert.equal(publishes(net).length, 1, "a stopped run is not news");

      await emit({ type: "agent_start" });
      await emit(reply("", "error", { errorMessage: "You have hit your usage limit. Try again later." }));
      await emit({ type: "agent_end", messages: [] });
      await until(() => publishes(net).length === 2, "error");
      assert.match(publishes(net)[1].body.title, /^Error · /);
      assert.equal(publishes(net)[1].body.message, "You have hit your usage limit. Try again later.");
      assert.equal(publishes(net)[1].body.priority, 4);

      await emit({ type: "agent_start" });
      await emit(reply("I changed the config.\nWhich environment should I deploy to?"));
      await emit({ type: "agent_end", messages: [] });
      await until(() => publishes(net).length === 3, "waiting");
      assert.match(publishes(net)[2].body.title, /^Waiting for your reply · /);
      assert.equal(publishes(net)[2].body.message, "… Which environment should I deploy to?");
    });
  } finally {
    net.restore();
  }
});

test("omp: a question the chat's own plumbing asks (the time-zone dialog) is never a notification", async () => {
  configure();
  const net = stubNetwork();
  try {
    await withOmpSession("e2e-omp-4", async ({ session, emit, commandsSent }) => {
      await emit({ type: "extension_ui_request", id: "tz-1", method: "input", title: "CODY_TIME_ZONE", placeholder: "" });
      await until(() => commandsSent().some((command) => command.type === "extension_ui_response" && command.id === "tz-1"), "the wrapper to answer it itself");
      await wait(80);
      assert.equal(net.calls.length, 0);
      assert.equal(session.hasPendingInput(), false);
    });
  } finally {
    net.restore();
  }
});

test("omp: someone looking at the chat is not notified about it; looking away, they are", async () => {
  configure();
  const net = stubNetwork();
  const report = (sessionId) => presenceRoute.POST(new Request("http://cody.test/api/notifications/presence", { method: "POST", body: JSON.stringify({ sessionId }) }));
  try {
    await withOmpSession("e2e-omp-5", async ({ emit }) => {
      assert.equal((await report("e2e-omp-5")).status, 200);
      await emit(toolApproval("while-viewing"));
      await wait(100);
      assert.equal(net.calls.length, 0, "they are looking right at it");

      assert.equal((await report(null)).status, 200);
      await emit(toolApproval("after-looking-away"));
      await until(() => publishes(net).length === 1, "the notification once they looked away");
      assert.equal(publishes(net)[0].body.sequence_id, compose.sequenceIdFor("e2e-omp-5", "after-looking-away"));
    });
  } finally {
    await report("none");
    await report(null);
    net.restore();
  }
});

test("a sidebar chat is never observed (the same frames in an ordinary chat are)", async () => {
  configure();
  const net = stubNetwork();
  const frames = async (emit) => {
    await emit({ type: "agent_start" });
    await emit(toolApproval("approval-1"));
    await emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
    await emit({ type: "agent_end", messages: [] });
  };
  try {
    await withOmpSession("e2e-sidebar-1", async ({ emit }) => {
      await frames(emit);
      await wait(120);
      assert.equal(net.calls.length, 0);
    }, { kind: "sidebar" });

    await withOmpSession("e2e-sidebar-control", async ({ emit }) => {
      await frames(emit);
      await until(() => publishes(net).length === 2, "an ordinary chat's approval and finished notifications");
    });
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------------------
// ACP
// ---------------------------------------------------------------------------

const STUB = fileURLToPath(new URL("../harness/acp-agent-stub.mjs", import.meta.url));

test("ACP: an approval offers the agent's one-shot options (never 'always'); tapping Deny refuses the real turn", async () => {
  configure();
  const net = stubNetwork();
  const dir = mkdtempSync(join(tmpdir(), "cody-notify-e2e-acp-"));
  const previous = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = dir;
  const sessionId = `acp-e2e-${randomUUID()}`;
  const session = new AcpEngineSession(
    { id: "stubengine", name: "StubEngine", binaryPath: process.execPath, args: [STUB], env: { ACP_STUB_ASK_PERMISSION: "1" }, setupHint: "" },
    { cwd: dir, sessionId },
  );
  try {
    await session.waitUntilReady();
    observeSessionForNotifications(session);
    (globalThis.__ompSessions ??= new Map()).set(sessionId, session);
    const events = [];
    session.onEvent((event) => events.push(event));

    await session.send({ type: "prompt", message: "edit a file" });
    await until(() => publishes(net).length === 1, "the approval to be published");
    const [published] = publishes(net);
    assert.match(published.body.title, /^Approval needed · /);
    assert.equal(published.body.message, "Write src/index.ts");
    assert.deepEqual(published.body.actions.map((action) => action.label), ["Allow once", "Deny"], "the agent's own names; no 'Always allow'");
    assert.ok(session.hasPendingInput());

    assert.equal((await tap(published.body.actions[1])).status, 200);
    await until(() => events.some((event) => event.type === "agent_end"), "the turn to end");
    const reply = events.find((event) => event.type === "message_end");
    assert.match(reply.content[0].text, /"outcome":"selected"/);
    assert.match(reply.content[0].text, /"optionId":"no"/, "Deny reached the agent");
    assert.equal(session.hasPendingInput(), false);
    await until(() => clears(net).length >= 1, "the notification to be cleared");
    assert.equal(clears(net)[0].url, `https://ntfy.test/e2e/${compose.sequenceIdFor(sessionId, "perm-1")}/clear`);
    // The turn then ended normally: a finished notification follows.
    await until(() => publishes(net).length === 2, "the finished notification");
    assert.match(publishes(net)[1].body.title, /^Reply finished · /);
  } finally {
    globalThis.__ompSessions?.delete(sessionId);
    await session.destroyAndWait();
    net.restore();
    if (previous === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real registry finds the session an answer is for, by the id the notification was sent under", async () => {
  configure();
  await withOmpSession("e2e-registry", async ({ session }) => {
    assert.equal(getRpcSession("e2e-registry"), session);
  });
});
