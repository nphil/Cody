import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * send_to_chat and message_status through the handlers the omp host-tool path
 * and the ACP bridge both call, against REAL chat wrappers (the ones the
 * composer's own send goes through) over a scripted engine process: what each
 * urgency does to a chat that is idle and to one in the middle of a turn, what
 * the other chat's agent is handed, which chats the caller may reach, and how
 * the chat's own delivery ledger reads back as the answer to "was it read?".
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-chat-messages-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.CODY_SCRATCH_ROOT = path.join(root, "scratch");
// No omp binary: a chat with no live engine cannot be started, deterministically and without spawning anything.
process.env.CODY_OMP_BIN = path.join(root, "no-such-omp");
// The zone a chat's engine runs in and the zone its owner is in agree, so delivering never restarts an idle engine.
process.env.TZ = "America/New_York";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { CHAT_MESSAGE_TOOLS, CHAT_MESSAGE_TOOL_NAMES } = await jiti.import("./tools.ts");
const delivery = await jiti.import("./delivery.ts");
const registry = await jiti.import("./registry.ts");
const { chatMessageHeader } = await jiti.import("./header.ts");
const { CHAT_MESSAGE_LIMITS } = await jiti.import("./types.ts");
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const gate = await jiti.import("../disk/gate.ts");
const { EngineCommandError } = await jiti.import("../harness/errors.ts");
const { SESSION_NOT_FOUND } = await jiti.import("../session-tools.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");
const users = await jiti.import("../auth/users.ts");

const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });

const SESSIONS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");

/** A chat on disk: its transcript file (header plus any `entries`) and its owner. */
function writeChat(id, title, owner, entries = []) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const header = { type: "session", version: 3, id, cwd: "/proj", title, created: "2026-01-01", modified: "2026-01-01" };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.jsonl`), [header, ...entries].map((line) => `${JSON.stringify(line)}\n`).join(""));
  if (owner) setSessionOwner(id, owner.id);
}

/** A user message as omp writes it into the transcript. */
function userEntry(text, at) {
  return { type: "message", id: `e-${at}`, parentId: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: at } };
}

writeChat("alice-main", "Ship the release", alice);
writeChat("alice-login", "Fix login bug", alice);
writeChat("alice-login-2", "Fix login redirect", alice);
writeChat("bob-secret", "Bob's payroll plan", bob);
writeChat("old-unowned", "Old chat from before accounts", null);
writeChat("old-unowned-2", "Another old chat", null);
invalidateSessionListCache();

const GiB = 1024 ** 3;
const healthyDisk = () => ({ totalBytes: 200 * GiB, availableBytes: 100 * GiB });
/** 3 % free of 200 GiB: under the 5 % line where a new turn is refused. */
const nearlyFullDisk = () => ({ totalBytes: 200 * GiB, availableBytes: 6 * GiB });

/** The chats this test made live, so each test starts from none. */
const liveChats = new Map();

/**
 * A chat with a running engine: a real wrapper over a scripted process that
 * records every command that reaches it. `running` puts it in the middle of a
 * turn; `ack` decides how (and when) the engine answers the prompt.
 */
function liveChat(id, { running = false, ack } = {}) {
  const commands = [];
  let onFrame = () => {};
  let sequence = 0;
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendFrame() {},
    sendCommandWithId(command) {
      commands.push(command);
      return { id: `rpc-${++sequence}`, result: ack ? ack(command) : Promise.resolve({ agentInvoked: true }) };
    },
    // Read when a turn ends, by the plan keeper: this chat has no plan.
    sendCommand: async () => ({}),
  };
  const wrapper = new AgentSessionWrapper(proc, path.join(root, "no-such-workspace"), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  wrapper._sessionId = id;
  wrapper.promptRunning = running;
  (globalThis.__ompSessions ??= new Map()).set(id, wrapper);
  liveChats.set(id, wrapper);
  return {
    wrapper,
    commands,
    /** The engine prints a frame, as omp does. */
    emit: (frame) => onFrame(frame),
    /** What the chat's own delivery ledger says about a send. */
    ledger: (messageId) => wrapper.getDeliveryLedger([`chat-${messageId}`])[0],
  };
}

/** A chat on an engine that runs one turn at a time and keeps no ledger (the ACP engines): `refuse` maps a command type to the error code it answers with. */
function oneTurnChat(id, { busy = false, refuse = {} } = {}) {
  const sent = [];
  const session = {
    sessionId: id,
    cwd: path.join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => busy,
    send: async (command) => {
      sent.push(command);
      const code = refuse[command.type] ?? (command.type === "prompt" && busy ? "session_busy" : undefined);
      if (code) throw new EngineCommandError(command.type, `the engine said ${code}`, code);
      return null;
    },
    destroyAndWait: async () => {},
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  liveChats.set(id, session);
  return sent;
}

/** A chat whose engine keeps a ledger and answers every lookup with `row` (nothing when `row` is undefined). */
function ledgerChat(id, row) {
  const asked = [];
  const session = {
    sessionId: id,
    cwd: path.join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => false,
    send: async () => null,
    getDeliveryLedger: (ids) => { asked.push(ids); return row ? ids.map((clientMessageId) => ({ clientMessageId, ...row })) : []; },
    destroyAndWait: async () => {},
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  liveChats.set(id, session);
  return asked;
}

/** The chat's engine goes away: it is no longer live, and whatever it held goes with it. */
async function dropLiveChat(id) {
  globalThis.__ompSessions.delete(id);
  const session = liveChats.get(id);
  liveChats.delete(id);
  if (!session) return;
  // Not mid-turn when it goes, so teardown logs nothing about stopping a running chat.
  session.promptRunning = false;
  await session.destroyAndWait();
}

beforeEach(() => {
  gate.configureDiskGateForTests({ probe: healthyDisk, now: () => 0 });
  registry.resetChatMessages();
});

afterEach(async () => {
  for (const id of [...liveChats.keys()]) await dropLiveChat(id);
  delivery.configureChatDeliveryForTests(null);
  gate.configureDiskGateForTests(null);
});

async function waitFor(predicate, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const tool = (name) => CHAT_MESSAGE_TOOLS.find((entry) => entry.name === name);
const context = (overrides = {}) => ({ user: alice, defaultSessionId: "alice-main", restrictToUnowned: false, timeZone: "America/New_York", ...overrides });
const call = (name, args, ctx = context()) => tool(name).handler(args, ctx);
const idOf = (text) => /msg_[A-Za-z0-9_-]+/.exec(text)?.[0];
const records = () => [...(globalThis.__codyChatMessages?.records.values() ?? [])];

test("the agent gets exactly two tools, with the arguments the bridge also declares", () => {
  assert.deepEqual(CHAT_MESSAGE_TOOL_NAMES, ["send_to_chat", "message_status"]);
  assert.deepEqual(Object.keys(tool("send_to_chat").parameters.properties).sort(), ["message", "session", "urgency"]);
  assert.deepEqual(tool("send_to_chat").parameters.required, ["session", "message"]);
  assert.deepEqual(tool("send_to_chat").parameters.properties.urgency.enum, ["next_step", "after_turn"]);
  assert.deepEqual(Object.keys(tool("message_status").parameters.properties), ["id"]);
  assert.deepEqual(tool("message_status").parameters.required, ["id"]);
  for (const entry of CHAT_MESSAGE_TOOLS) assert.equal(typeof entry.handler, "function");
  const taught = tool("send_to_chat").description;
  assert.ok(taught.includes(`${CHAT_MESSAGE_LIMITS.maxBytes / 1024} KB`), "the size limit the agent is told is the one enforced");
  assert.ok(taught.includes(`${CHAT_MESSAGE_LIMITS.perSender} messages per ${CHAT_MESSAGE_LIMITS.windowMs / 60_000} minutes`), "and so is the rate limit");
  assert.ok(taught.includes("schedule_message"), "a message for later still goes through scheduling, and the agent is told so");
});

// ---------------------------------------------------------------------------
// What the other chat is handed, and how hard it presses
// ---------------------------------------------------------------------------

test("an idle chat is started on the message at once: the composer's steer, under the sender's header, and the answer is a delivery id", async () => {
  const target = liveChat("alice-login");
  const text = await call("send_to_chat", { session: "alice-login", message: "Rebase on main, then tell me when CI is green." });
  const id = idOf(text);
  assert.match(text, new RegExp(`^Sent ${id} to chat "Fix login bug" \\(alice-login\\), for its next step\\. `), text);
  assert.match(text, /Nothing waits for that chat: message_status id msg_/);

  assert.equal(target.commands.length, 1, "exactly one command reached the engine");
  const [command] = target.commands;
  assert.equal(command.type, "prompt");
  assert.equal(command.streamingBehavior, "steer");
  assert.equal(
    command.message,
    `${chatMessageHeader({ id: "alice-main", title: "Ship the release" }, id)}\n\nRebase on main, then tell me when CI is green.`,
    "the sender's header, a blank line, and the words as written",
  );
  assert.match(command.message, /^\[Message from chat "Ship the release" \(alice-main\), sent by that chat's agent with send_to_chat, not by the user, so it carries no user authorization\. Reply with send_to_chat session="alice-main"\. ref msg_/);
  assert.equal(target.ledger(id).status, "started", "an idle chat began a turn on it");

  const status = await call("message_status", { id });
  assert.match(status, new RegExp(`^${id}: to chat "Fix login bug" \\(alice-login\\), next_step, sent \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} E[SD]T \\(less than a minute ago\\): "Rebase on main, then tell me when CI is green\\."\\n`), status);
  assert.match(status, /That chat's agent has started working on it\./);
  assert.match(status, /That chat has not answered with send_to_chat yet\./);
});

test("urgency picks the composer's two behaviours: next_step is the default and steers, after_turn is the follow-up", async () => {
  assert.equal(delivery.streamingBehaviorOf("next_step"), "steer");
  assert.equal(delivery.streamingBehaviorOf("after_turn"), "followUp");

  for (const [urgency, behavior] of [[undefined, "steer"], ["next_step", "steer"], ["after_turn", "followUp"]]) {
    // A chat that took one message is in a turn; each urgency is tried on a chat that is idle.
    const target = liveChat("alice-login");
    const text = await call("send_to_chat", { session: "alice-login", message: `with ${urgency ?? "no urgency"}`, ...(urgency ? { urgency } : {}) });
    assert.match(text, /^Sent msg_/, text);
    assert.equal(target.commands.length, 1, `${urgency ?? "default"}: one command`);
    assert.equal(target.commands[0].streamingBehavior, behavior, `${urgency ?? "default"} -> ${behavior}`);
    assert.equal(registry.findChatMessage(idOf(text)).urgency, urgency ?? "next_step");
    await dropLiveChat("alice-login");
  }
});

test("a next_step message into a chat in the middle of a turn is not held behind it: it reaches the engine now and reads `queued` until the agent takes it", async () => {
  const target = liveChat("alice-login", { running: true });
  const text = await call("send_to_chat", { session: "alice-login", message: "Stop, the plan changed: use the v2 endpoint." });
  const id = idOf(text);
  assert.match(text, /for its next step\. That chat's engine has it and the agent reads it at its next step\./, text);

  assert.equal(target.commands.length, 1, "in the engine's own queue already, while the turn is still running");
  assert.equal(target.commands[0].streamingBehavior, "steer");
  assert.equal(target.wrapper.heldQueue.length, 0, "Cody holds nothing back");
  assert.equal(target.ledger(id).status, "queued");
  assert.notEqual(target.ledger(id).held, true);
  assert.match(await call("message_status", { id }), /That chat's engine has it and the agent reads it at its next step\./);

  // The engine reaches the message: the agent read it.
  target.emit({ type: "message_end", message: { role: "user", timestamp: Date.now() + 10_000, content: target.commands[0].message } });
  assert.equal(target.ledger(id).status, "delivered");
  const status = await call("message_status", { id });
  assert.match(status, /That chat's agent has read it\./);
  assert.match(status, /That chat has not answered with send_to_chat yet\./);
});

test("an after_turn message to a chat in the middle of a turn is held by Cody — nothing reaches the engine early — and goes the moment the turn ends", async () => {
  const target = liveChat("alice-login", { running: true });
  const text = await call("send_to_chat", { session: "alice-login", message: "When you are done, update the changelog.", urgency: "after_turn" });
  const id = idOf(text);
  assert.match(text, /to read after its current turn\. That chat is in the middle of a turn: Cody holds the message and the agent reads it as its next message when the turn ends\./, text);

  assert.equal(target.commands.length, 0, "the engine has not seen it");
  assert.equal(target.ledger(id).status, "queued");
  assert.equal(target.ledger(id).held, true);
  assert.match(await call("message_status", { id }), /That chat is in the middle of a turn: Cody holds the message/);

  target.emit({ type: "agent_end", isTerminal: true, messages: [] });
  await waitFor(() => target.commands.length === 1, "the held message to be handed to the engine");
  assert.equal(target.commands[0].streamingBehavior, "followUp");
  assert.ok(target.commands[0].message.endsWith("\n\nWhen you are done, update the changelog."));
  await waitFor(() => target.ledger(id).status === "started", "the turn it starts");
  assert.match(await call("message_status", { id }), /That chat's agent has started working on it\./);
});

test("a send never waits for the other chat: a slow engine leaves the answer `sending`, and the status moves on when the engine takes it", async () => {
  delivery.configureChatDeliveryForTests({ ackWaitMs: 30 });
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const target = liveChat("alice-login", { ack: () => slow });

  const startedAt = Date.now();
  const text = await call("send_to_chat", { session: "alice-login", message: "slow engine" });
  assert.ok(Date.now() - startedAt < 2_000, "answered at the bound, not when the engine did");
  const id = idOf(text);
  assert.match(text, /^Sent msg_\S+ to chat "Fix login bug" \(alice-login\), for its next step\. It is still being handed over: that chat's engine has not taken it yet/, text);
  assert.equal(registry.findChatMessage(id).state, "sending");
  assert.match(await call("message_status", { id }), /It is still being handed over/);

  release({ agentInvoked: true });
  await waitFor(() => registry.findChatMessage(id).state === "accepted", "the delivery to settle");
  assert.equal(target.commands.length, 1);
  assert.match(await call("message_status", { id }), /That chat's agent has started working on it\./);
});

test("an engine that refuses the message is reported in plain words with the delivery id, and the status says the same", async () => {
  liveChat("alice-login", { ack: () => Promise.reject(new Error("The engine fell over\nwith a stack")) });
  const text = await call("send_to_chat", { session: "alice-login", message: "anyone there?" });
  const id = idOf(text);
  assert.equal(text, `Not delivered to chat "Fix login bug" (alice-login): The engine fell over with a stack (delivery id ${id}).`);
  assert.equal(registry.findChatMessage(id).state, "failed");
  assert.match(await call("message_status", { id }), /It was not delivered: The engine fell over with a stack\.$/);
});

test("a chat with no live engine that cannot be started is told to the sender as not delivered, not thrown", async () => {
  // alice-login-2 has a transcript but no engine, and there is no omp binary to start one with.
  const text = await call("send_to_chat", { session: "alice-login-2", message: "wake up" });
  assert.match(text, /^Not delivered to chat "Fix login redirect" \(alice-login-2\): .+ \(delivery id msg_\S+\)\.$/s, text);
  assert.deepEqual(records().map((record) => record.state), ["failed"]);
});

// ---------------------------------------------------------------------------
// Engines that run one turn at a time (the ACP ones)
// ---------------------------------------------------------------------------

test("a one-turn-at-a-time engine that is busy takes a next_step message as a steer, and has no ledger to wait in", async () => {
  const sent = oneTurnChat("alice-login", { busy: true });
  const text = await call("send_to_chat", { session: "alice-login", message: "change of plan" });
  const id = idOf(text);
  assert.match(text, /^Sent msg_\S+ to chat "Fix login bug" \(alice-login\), for its next step\. That chat's agent has read it\./, text);
  assert.deepEqual(sent.map((command) => command.type), ["prompt", "steer"], "the prompt was refused mid-turn, the steer was taken");
  assert.equal(sent[1].clientMessageId, `chat-${id}`);
  assert.ok(sent[1].message.endsWith("\n\nchange of plan"));
  assert.match(await call("message_status", { id }), /That chat's agent has read it\./, "no ledger: accepted means read");
});

test("what an engine that cannot take it says is turned into words for the sender, for both urgencies", async () => {
  const cases = [
    [{ busy: true }, "after_turn", /^Not delivered to chat "Fix login bug" \(alice-login\): That chat's engine runs one turn at a time and is working right now, so it cannot hold a message for later\. Send it again when the turn is over\. \(delivery id msg_\S+\)\.$/],
    [{ busy: true, refuse: { steer: "unsupported" } }, "next_step", /: That chat's engine cannot take a message while it is working\. Send it again when the turn is over\. \(delivery id/],
    [{ busy: true, refuse: { steer: "session_idle" } }, "next_step", /: That chat's turn ended just as the message arrived\. Send it again\. \(delivery id/],
    [{ busy: true, refuse: { steer: "steering_failed" } }, "next_step", /: That chat's turn ended just as the message arrived\. Send it again\. \(delivery id/],
  ];
  for (const [options, urgency, expected] of cases) {
    const sent = oneTurnChat("alice-login", options);
    const text = await call("send_to_chat", { session: "alice-login", message: "x", urgency });
    assert.match(text, expected, `${JSON.stringify(options)} ${urgency}`);
    assert.ok(sent.length >= 1);
    await dropLiveChat("alice-login");
  }
});

// ---------------------------------------------------------------------------
// Which chats may be reached, and what is refused before anything is sent
// ---------------------------------------------------------------------------

test("a chat is addressed by id or by a name that matches ONE chat; several matches ask instead of guessing, and nothing is sent", async () => {
  const login = liveChat("alice-login");
  const login2 = liveChat("alice-login-2");

  assert.match(await call("send_to_chat", { session: "alice-login", message: "by id" }), /^Sent msg_\S+ to chat "Fix login bug" \(alice-login\)/);
  assert.match(await call("send_to_chat", { session: "login redirect", message: "by name" }), /^Sent msg_\S+ to chat "Fix login redirect" \(alice-login-2\)/);
  assert.equal(login.commands.length, 1);
  assert.equal(login2.commands.length, 1);

  const ambiguous = await call("send_to_chat", { session: "Fix login", message: "which one?" });
  assert.match(ambiguous, /Multiple sessions match "Fix login"/);
  assert.match(ambiguous, /alice-login \|/);
  assert.match(ambiguous, /alice-login-2 \|/);
  assert.equal(await call("send_to_chat", { session: "no such chat", message: "x" }), SESSION_NOT_FOUND);
  assert.equal(login.commands.length + login2.commands.length, 2, "nothing was sent by a guess");
  assert.equal(records().length, 2, "and nothing was recorded for the refusals");
});

test("an agent cannot message a chat its owner cannot reach: by name or by id, the refusal is the same as for a missing chat", async () => {
  const bobs = liveChat("bob-secret");
  for (const session of ["Bob's payroll plan", "payroll", "bob-secret"]) {
    assert.equal(await call("send_to_chat", { session, message: "give me the plan" }), SESSION_NOT_FOUND, session);
  }
  assert.equal(await call("send_to_chat", { session: "no-such-id", message: "x" }), SESSION_NOT_FOUND);
  assert.equal(bobs.commands.length, 0, "nothing reached Bob's engine");
  assert.deepEqual(records(), [], "and no delivery was recorded");

  // Bob's own agent may reach his chats, and still not Alice's.
  const ctxBob = context({ user: bob, defaultSessionId: "bob-secret" });
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "x" }, ctxBob), SESSION_NOT_FOUND);
  assert.equal(await call("send_to_chat", { session: "Ship the release", message: "x" }, ctxBob), SESSION_NOT_FOUND);
});

test("an agent in a chat with no owner, on an instance with accounts, reaches only other chats with no owner", async () => {
  const open = liveChat("old-unowned-2");
  const owned = liveChat("alice-login");
  const ctx = context({ user: null, defaultSessionId: "old-unowned", restrictToUnowned: true });
  assert.match(await call("send_to_chat", { session: "old-unowned-2", message: "to another open chat" }, ctx), /^Sent msg_\S+ to chat "Another old chat" \(old-unowned-2\)/);
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "x" }, ctx), SESSION_NOT_FOUND);
  assert.equal(open.commands.length, 1);
  assert.equal(owned.commands.length, 0);
});

test("a send is checked before anything is created: empty message, unknown urgency, no chat named, no sender, itself", async () => {
  const target = liveChat("alice-login");
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "" }), "Pass `message`: what the other chat should read.");
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "  \n " }), "Pass `message`: what the other chat should read.");
  assert.equal(await call("send_to_chat", { session: "alice-login" }), "Pass `message`: what the other chat should read.");
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "x", urgency: "now" }), 'urgency must be "next_step" (read at the chat\'s next step) or "after_turn" (read when its current turn is over).');
  assert.equal(await call("send_to_chat", { message: "x" }), "Pass `session`: the id or title of the chat to message; list_sessions shows them.");
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "x" }, context({ defaultSessionId: null })), "This chat has no id yet, so the other chat could not answer it.");
  assert.equal(await call("send_to_chat", { session: "alice-main", message: "talking to myself" }), "That is this chat. To message it later, use schedule_message.");
  assert.equal(await call("send_to_chat", { session: "Ship the", message: "by name, still myself" }), "That is this chat. To message it later, use schedule_message.");
  assert.equal(target.commands.length, 0);
  assert.deepEqual(records(), []);
});

test("a message may be 32 KB and no more, counted in bytes", async () => {
  const target = liveChat("alice-login");
  assert.equal(CHAT_MESSAGE_LIMITS.maxBytes, 32768);
  const exact = await call("send_to_chat", { session: "alice-login", message: "x".repeat(32768) });
  assert.match(exact, /^Sent msg_/, "32768 bytes is allowed");
  assert.equal(target.commands.length, 1);

  assert.equal(await call("send_to_chat", { session: "alice-login", message: "x".repeat(32769) }), "That message is 33 KB; the limit is 32 KB. Write the long material to a file and send its path.");
  // 17 000 two-byte characters are only 17 000 characters, but 34 000 bytes.
  assert.match(await call("send_to_chat", { session: "alice-login", message: "é".repeat(17_000) }), /^That message is 34 KB; the limit is 32 KB\./);
  assert.equal(target.commands.length, 1, "neither reached the chat");
});

test("one chat may send twenty messages in ten minutes; the twenty-first is refused in words and reaches nobody", async () => {
  const target = liveChat("alice-login");
  for (let sent = 1; sent <= CHAT_MESSAGE_LIMITS.perSender; sent += 1) {
    assert.match(await call("send_to_chat", { session: "alice-login", message: `message ${sent}` }), /^Sent msg_/, `message ${sent}`);
  }
  const refused = await call("send_to_chat", { session: "alice-login", message: "one too many" });
  assert.match(refused, /^This chat has already sent 20 messages in the last 10 minutes, the most it may: two agents answering each other would never stop\. Try again in about 10 min; if a person has to see this, say so in your reply to the user\.$/);
  assert.equal(target.commands.length, 20);
  assert.equal(records().length, 20);

  // Another chat's allowance is its own.
  liveChat("alice-main");
  assert.match(await call("send_to_chat", { session: "alice-main", message: "from another chat" }, context({ defaultSessionId: "alice-login" })), /^Sent msg_/);
});

test("a nearly full disk refuses a message that would start work; one that only steers a turn already running still goes", async () => {
  gate.configureDiskGateForTests({ probe: nearlyFullDisk, now: () => 0 });
  const reason = gate.checkDiskForNewTurn().message;
  assert.match(reason, /almost full/);

  const idle = liveChat("alice-login");
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "start something" }), `Not sent: ${reason}`, "an idle chat would begin a turn");
  assert.equal(await call("send_to_chat", { session: "alice-login", message: "later", urgency: "after_turn" }), `Not sent: ${reason}`);
  assert.equal(idle.commands.length, 0);
  assert.deepEqual(records(), [], "refused before it was recorded");

  const busy = liveChat("alice-login-2", { running: true });
  assert.equal(await call("send_to_chat", { session: "alice-login-2", message: "later", urgency: "after_turn" }), `Not sent: ${reason}`, "a follow-up begins a new turn when the running one ends");
  assert.equal(busy.commands.length, 0);
  assert.match(await call("send_to_chat", { session: "alice-login-2", message: "stop and clean up your scratch files" }), /^Sent msg_/, "redirecting a running turn adds no work, exactly as in the composer");
  assert.equal(busy.commands.length, 1);

  gate.configureDiskGateForTests({ probe: healthyDisk, now: () => 0 });
  assert.match(await call("send_to_chat", { session: "alice-login", message: "room again" }), /^Sent msg_/);
});

// ---------------------------------------------------------------------------
// message_status: what the chat's own ledger says, and whether it answered
// ---------------------------------------------------------------------------

/** A message `alice-main` sent to `alice-login`, accepted, with the target's ledger answering `row`. */
async function statusFor(row, { state = "accepted", error } = {}) {
  const asked = ledgerChat("alice-login", row);
  const record = registry.createChatMessage({ fromSessionId: "alice-main", fromTitle: "Ship the release", toSessionId: "alice-login", urgency: "next_step", preview: "hello" });
  record.state = state;
  if (error) record.error = error;
  const progress = await delivery.chatMessageProgress(record);
  return { record, progress, asked, status: await call("message_status", { id: record.id }) };
}

test("the chat's ledger row becomes the status the agent reads: queued, held, started, delivered, withdrawn, failed", async () => {
  const cases = [
    [{ status: "queued", held: true }, "held", /That chat is in the middle of a turn: Cody holds the message/],
    [{ status: "queued" }, "queued", /That chat's engine has it and the agent reads it at its next step\./],
    [{ status: "queued", held: false }, "queued", /agent reads it at its next step/],
    [{ status: "started" }, "started", /That chat's agent has started working on it\./],
    [{ status: "delivered" }, "delivered", /That chat's agent has read it\./],
    [{ status: "withdrawn" }, "withdrawn", /It was taken back from the chat's queue before the agent read it\./],
    [{ status: "failed", error: "The model refused" }, "failed", /It was not delivered: The model refused\./],
    [{ status: "failed" }, "failed", /It was not delivered: The chat's engine stopped before it read this message\./],
  ];
  for (const [row, phase, sentence] of cases) {
    const { progress, status, asked, record } = await statusFor(row);
    assert.equal(progress.phase, phase, JSON.stringify(row));
    assert.match(status, sentence, JSON.stringify(row));
    assert.deepEqual(asked.at(-1), [`chat-${record.id}`], "the ledger is asked under the id the message was sent with");
    await dropLiveChat("alice-login");
    registry.resetChatMessages();
  }
});

test("what Cody itself knows wins while the engine has not taken the message: `sending` and `failed` never consult the ledger", async () => {
  const sending = await statusFor({ status: "delivered" }, { state: "sending" });
  assert.equal(sending.progress.phase, "sending");
  assert.equal(sending.asked.length, 0);
  await dropLiveChat("alice-login");

  const failed = await statusFor({ status: "delivered" }, { state: "failed", error: "That chat no longer exists." });
  assert.deepEqual(failed.progress, { phase: "failed", error: "That chat no longer exists." });
  assert.match(failed.status, /It was not delivered: That chat no longer exists\./);
  assert.equal(failed.asked.length, 0);
});

test("a ledger row that is gone (the engine restarted, or the row aged out) is settled from the chat's transcript: found is read, absent is lost", async () => {
  const sentAt = Date.now();
  const record = registry.createChatMessage({ fromSessionId: "alice-main", fromTitle: "Ship the release", toSessionId: "alice-login", urgency: "next_step", preview: "hello" }, sentAt);
  record.state = "accepted";
  const lost = registry.createChatMessage({ fromSessionId: "alice-main", fromTitle: "Ship the release", toSessionId: "alice-login", urgency: "next_step", preview: "lost one" }, sentAt);
  lost.state = "accepted";
  const header = chatMessageHeader({ id: "alice-main", title: "Ship the release" }, record.id);
  ledgerChat("alice-login", { status: "unknown" });

  // The transcript has other user messages and this one's header.
  writeChat("alice-login", "Fix login bug", alice, [
    userEntry("an older message of the person's", sentAt - 3_600_000),
    userEntry(`${header}\n\nthe words`, sentAt + 2_000),
    userEntry("a later message of the person's", sentAt + 5_000),
  ]);
  invalidateSessionListCache();
  try {
    assert.deepEqual(await delivery.chatMessageProgress(record), { phase: "delivered" });
    assert.deepEqual(await delivery.chatMessageProgress(lost), { phase: "lost" }, "later user messages exist and none carries this id");
    assert.match(await call("message_status", { id: lost.id }), /It was lost: that chat's engine stopped or restarted before the agent read it\. Send it again\./);

    // The scan never reaches back past the send: a copy of the header from long before is not this message's.
    const older = registry.createChatMessage({ fromSessionId: "alice-main", fromTitle: "t", toSessionId: "alice-login", urgency: "next_step", preview: "p" }, sentAt + 100_000);
    older.state = "accepted";
    writeChat("alice-login", "Fix login bug", alice, [userEntry(`${chatMessageHeader({ id: "alice-main", title: "t" }, older.id)}\n\nbody`, sentAt + 1_000)]);
    invalidateSessionListCache();
    assert.deepEqual(await delivery.chatMessageProgress(older), { phase: "lost" });

    // A chat with no live engine at all is read the same way: from its transcript.
    await dropLiveChat("alice-login");
    writeChat("alice-login", "Fix login bug", alice, [userEntry(`${header}\n\nthe words`, sentAt + 2_000)]);
    invalidateSessionListCache();
    assert.deepEqual(await delivery.chatMessageProgress(record), { phase: "delivered" });

    // No transcript to look in proves nothing against it.
    fs.rmSync(path.join(SESSIONS_DIR, "alice-login.jsonl"));
    invalidateSessionListCache();
    assert.deepEqual(await delivery.chatMessageProgress(record), { phase: "delivered" });
  } finally {
    writeChat("alice-login", "Fix login bug", alice);
    invalidateSessionListCache();
  }
});

test("an engine with no ledger (the ACP ones) takes a message as a turn or a steer, so accepted is read", async () => {
  oneTurnChat("alice-login");
  const record = registry.createChatMessage({ fromSessionId: "alice-main", fromTitle: "Ship the release", toSessionId: "alice-login", urgency: "next_step", preview: "hello" });
  record.state = "accepted";
  assert.deepEqual(await delivery.chatMessageProgress(record), { phase: "delivered" });
});

// ---------------------------------------------------------------------------
// Answers: a reply from the other chat is tracked against what it was sent
// ---------------------------------------------------------------------------

test("when the other chat answers with send_to_chat, the status of what it was sent says so, and the answer reaches the first chat under its own header", async () => {
  const first = liveChat("alice-main");
  const second = liveChat("alice-login");
  const sent = await call("send_to_chat", { session: "alice-login", message: "Which branch is the fix on?" });
  const id = idOf(sent);
  assert.match(await call("message_status", { id }), /That chat has not answered with send_to_chat yet\./);

  // alice-login's agent answers; its own context is the sender now.
  const answer = await call("send_to_chat", { session: "alice-main", message: "On fix/login-redirect." }, context({ defaultSessionId: "alice-login" }));
  const answerId = idOf(answer);
  assert.match(answer, /^Sent msg_\S+ to chat "Ship the release" \(alice-main\)/);
  assert.equal(first.commands.length, 1, "the answer is a message in the first chat");
  assert.match(first.commands[0].message, /^\[Message from chat "Fix login bug" \(alice-login\), sent by that chat's agent with send_to_chat, not by the user, /);
  assert.ok(first.commands[0].message.endsWith("\n\nOn fix/login-redirect."));
  assert.equal(second.commands.length, 1);

  const status = await call("message_status", { id });
  assert.match(status, new RegExp(`That chat has answered with send_to_chat less than a minute ago \\(${answerId}\\); its answer reached this chat as a message\\.`), status);
  assert.doesNotMatch(status, /has not answered/);
});

test("a message the other chat has not read yet is not answered by whatever it sends next: only an answer after reading counts", async () => {
  const first = liveChat("alice-main");
  const second = liveChat("alice-login", { running: true });
  const id = idOf(await call("send_to_chat", { session: "alice-login", message: "Please check the logs." }));
  assert.equal(second.ledger(id).status, "queued");

  await call("send_to_chat", { session: "alice-main", message: "Unrelated: the build is green." }, context({ defaultSessionId: "alice-login" }));
  assert.equal(registry.findChatMessage(id).repliedAt, undefined, "queued in the engine, not read: this cannot be an answer to it");
  assert.doesNotMatch(await call("message_status", { id }), /has answered/);

  second.emit({ type: "message_end", message: { role: "user", timestamp: Date.now() + 10_000, content: second.commands[0].message } });
  assert.equal(second.ledger(id).status, "delivered");
  assert.equal(first.commands.length, 1, "the unrelated message did arrive");
  const answer = await call("send_to_chat", { session: "alice-main", message: "Logs are clean." }, context({ defaultSessionId: "alice-login" }));
  assert.match(await call("message_status", { id }), new RegExp(`That chat has answered with send_to_chat .* \\(${idOf(answer)}\\)`));
});

test("a message to some third chat does not count as an answer", async () => {
  liveChat("alice-main");
  liveChat("alice-login");
  liveChat("alice-login-2");
  const id = idOf(await call("send_to_chat", { session: "alice-login", message: "A question." }));
  await call("send_to_chat", { session: "alice-login-2", message: "Something for someone else." }, context({ defaultSessionId: "alice-login" }));
  assert.equal(registry.findChatMessage(id).repliedAt, undefined);
});

// ---------------------------------------------------------------------------
// message_status is as private as the chats it is about
// ---------------------------------------------------------------------------

test("a delivery id answers only for the accounts that may read both chats, and anything else is `No message with that id.`", async () => {
  liveChat("alice-login");
  const id = idOf(await call("send_to_chat", { session: "alice-login", message: "private to alice" }));

  assert.match(await call("message_status", { id }), new RegExp(`^${id}: `));
  // Another of Alice's chats may ask about it: the account is the boundary, not the chat.
  assert.match(await call("message_status", { id }, context({ defaultSessionId: "alice-login-2" })), new RegExp(`^${id}: `));
  // Bob, and an unowned chat on an instance with accounts, may not, and hear what they would for a made-up id.
  const unknown = await call("message_status", { id: "msg_nonexistent" });
  assert.equal(unknown, "No message with that id.");
  assert.equal(await call("message_status", { id }, context({ user: bob, defaultSessionId: "bob-secret" })), unknown);
  assert.equal(await call("message_status", { id }, context({ user: null, defaultSessionId: "old-unowned", restrictToUnowned: true })), unknown);
  assert.equal(await call("message_status", {}), "Pass the delivery id that send_to_chat returned.");
  assert.equal(await call("message_status", { id: "" }), "Pass the delivery id that send_to_chat returned.");
});
