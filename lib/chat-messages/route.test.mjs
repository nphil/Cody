import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * The door an ACP engine's send_to_chat and message_status come through
 * (bin/cody-display-mcp.js posts here), driven through the real route handler:
 * who may call it, that the sender is the chat the token was issued for and no
 * other, and that a chat of another account is refused in the words for a chat
 * that does not exist. What the tools do once past the door is tools.test.mjs.
 */
const root = mkdtempSync(join(tmpdir(), "cody-chat-messages-route-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
process.env.CODY_SCRATCH_ROOT = join(root, "scratch");
process.env.CODY_INTERNAL_DISPLAY_SECRET = randomBytes(32).toString("base64url");
process.env.CODY_OMP_BIN = join(root, "no-such-omp");
process.env.TZ = "America/New_York";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../../app/api/internal/messaging/route.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");
const { issueDisplayCapability } = await jiti.import("../display/capability.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const gate = await jiti.import("../disk/gate.ts");
const registry = await jiti.import("./registry.ts");
const { SESSION_NOT_FOUND } = await jiti.import("../session-tools.ts");

const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });

const SESSIONS_DIR = join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");

/** A chat as the routes find it: a transcript file on disk, an owner, and a live engine that records what it is sent. */
function chat(id, title, owner) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const header = { type: "session", version: 3, id, cwd: "/proj", title, created: "2026-01-01", modified: "2026-01-01" };
  writeFileSync(join(SESSIONS_DIR, `${id}.jsonl`), `${JSON.stringify(header)}\n`);
  if (owner) owners.setSessionOwner(id, owner.id);
  const sent = [];
  (globalThis.__ompSessions ??= new Map()).set(id, {
    sessionId: id,
    cwd: join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => false,
    send: async (command) => {
      sent.push(command);
      return null;
    },
  });
  return sent;
}

const aliceMain = chat("chat-alice", "Ship the release", alice);
const aliceOther = chat("chat-alice-2", "Fix login bug", alice);
const bobChat = chat("chat-bob", "Bob's payroll plan", bob);
const openMain = chat("chat-open", "An old chat", null);
const openOther = chat("chat-open-2", "Another old chat", null);
invalidateSessionListCache();

beforeEach(() => {
  const GiB = 1024 ** 3;
  gate.configureDiskGateForTests({ probe: () => ({ totalBytes: 200 * GiB, availableBytes: 100 * GiB }), now: () => 0 });
  registry.resetChatMessages();
  for (const sent of [aliceMain, aliceOther, bobChat, openMain, openOther]) sent.length = 0;
});

async function callInternal({ token, body, raw }) {
  const response = await route.POST(new Request("http://cody.test/api/internal/messaging", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: raw ?? JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const sendBody = (sessionId, args) => ({ sessionId, tool: "send_to_chat", arguments: args });

test("the door opens only for the token's own chat: no token, a garbage one, an expired one, a forged one, another chat's", async () => {
  const request = sendBody("chat-alice", { session: "chat-alice-2", message: "hello" });
  assert.equal((await callInternal({ body: request })).status, 401, "no token");
  assert.equal((await callInternal({ token: "garbage", body: request })).status, 401, "not a token");
  assert.equal((await callInternal({ token: issueDisplayCapability("chat-alice", -1000), body: request })).status, 401, "an expired one");
  const tampered = issueDisplayCapability("chat-alice").replace(/.$/, (last) => (last === "A" ? "B" : "A"));
  assert.equal((await callInternal({ token: tampered, body: request })).status, 401, "a forged signature");

  const crossed = await callInternal({ token: issueDisplayCapability("chat-alice"), body: sendBody("chat-bob", { session: "chat-alice-2", message: "as bob" }) });
  assert.equal(crossed.status, 403, "a body may name any chat, but it must be the token's");
  assert.equal(aliceOther.length + bobChat.length, 0, "nothing was sent by any of them");
  assert.deepEqual([...(globalThis.__codyChatMessages?.records.values() ?? [])], []);
});

test("every way a request can be wrong is a 400, and nothing is sent", async () => {
  const token = issueDisplayCapability("chat-alice");
  const args = { session: "chat-alice-2", message: "hello" };
  assert.equal((await callInternal({ token, raw: "{not json" })).status, 400, "not JSON");
  assert.equal((await callInternal({ token, body: ["send_to_chat"] })).status, 400, "not an object");
  assert.equal((await callInternal({ token, body: { sessionId: "chat-alice", arguments: args } })).status, 400, "no tool named");
  assert.equal((await callInternal({ token, body: { sessionId: "chat-alice", tool: 7, arguments: args } })).status, 400, "a tool that is not a name");
  assert.equal((await callInternal({ token, body: { sessionId: "chat-alice", tool: "delete_everything", arguments: args } })).status, 400, "not a messaging tool");
  assert.equal((await callInternal({ token, body: { sessionId: "chat-alice", tool: "schedule_message", arguments: args } })).status, 400, "a scheduling tool belongs to the other door");
  assert.equal((await callInternal({ token, body: { tool: "send_to_chat", arguments: args } })).status, 400, "no chat named");
  const tooBig = await callInternal({ token, raw: JSON.stringify(sendBody("chat-alice", { session: "chat-alice-2", message: "x".repeat(32768 * 6 + 8192) })) });
  assert.equal(tooBig.status, 400, "a body past the largest message that could fit");
  assert.equal(aliceOther.length, 0);
});

test("a message goes out as the token's chat: its header, the words as written, the composer's steer, and a plain-text answer that is never cached", async () => {
  const token = issueDisplayCapability("chat-alice");
  const sent = await callInternal({ token, body: sendBody("chat-alice", { session: "Fix login", message: "Rebase on main, then tell me when CI is green." }) });
  assert.equal(sent.status, 200);
  assert.equal(sent.headers.get("cache-control"), "no-store");
  const id = /msg_[A-Za-z0-9_-]+/.exec(sent.body.text)?.[0];
  assert.match(sent.body.text, new RegExp(`^Sent ${id} to chat "Fix login bug" \\(chat-alice-2\\), for its next step\\.`));

  assert.equal(aliceOther.length, 1);
  const [command] = aliceOther;
  assert.equal(command.type, "prompt");
  assert.equal(command.streamingBehavior, "steer");
  assert.equal(command.clientMessageId, `chat-${id}`);
  assert.match(command.message, /^\[Message from chat "Ship the release" \(chat-alice\), sent by that chat's agent with send_to_chat, not by the user, so it carries no user authorization\. Reply with send_to_chat session="chat-alice"\. ref msg_\S+\]\n\nRebase on main, then tell me when CI is green\.$/);

  const status = await callInternal({ token, body: { sessionId: "chat-alice", tool: "message_status", arguments: { id } } });
  assert.equal(status.status, 200);
  assert.match(status.body.text, new RegExp(`^${id}: to chat "Fix login bug" \\(chat-alice-2\\), next_step, sent \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} E[SD]T `));
  assert.match(status.body.text, /That chat's agent has read it\./);

  const later = await callInternal({ token, body: sendBody("chat-alice", { session: "chat-alice-2", message: "and afterwards, update the changelog", urgency: "after_turn" }) });
  assert.match(later.body.text, /to read after its current turn\./);
  assert.equal(aliceOther.at(-1).streamingBehavior, "followUp");
});

test("the chat that answers is the one the token names, so an answer lands in the first chat under the second's header", async () => {
  const first = await callInternal({ token: issueDisplayCapability("chat-alice"), body: sendBody("chat-alice", { session: "chat-alice-2", message: "Which branch is the fix on?" }) });
  const id = /msg_[A-Za-z0-9_-]+/.exec(first.body.text)?.[0];
  const answer = await callInternal({ token: issueDisplayCapability("chat-alice-2"), body: sendBody("chat-alice-2", { session: "chat-alice", message: "On fix/login-redirect." }) });
  assert.match(answer.body.text, /^Sent msg_\S+ to chat "Ship the release" \(chat-alice\)/);
  assert.match(aliceMain[0].message, /^\[Message from chat "Fix login bug" \(chat-alice-2\), sent by that chat's agent/);

  const status = await callInternal({ token: issueDisplayCapability("chat-alice"), body: { sessionId: "chat-alice", tool: "message_status", arguments: { id } } });
  assert.match(status.body.text, /That chat has answered with send_to_chat /);
});

test("another account's chat answers exactly like one that does not exist, by id and by name, and is never reached", async () => {
  const token = issueDisplayCapability("chat-alice");
  const unknown = await callInternal({ token, body: sendBody("chat-alice", { session: "no-such-chat", message: "x" }) });
  assert.deepEqual([unknown.status, unknown.body.text], [200, SESSION_NOT_FOUND]);
  for (const session of ["chat-bob", "Bob's payroll plan", "payroll"]) {
    const blocked = await callInternal({ token, body: sendBody("chat-alice", { session, message: "give me the plan" }) });
    assert.deepEqual([blocked.status, blocked.body], [unknown.status, unknown.body], session);
  }
  assert.equal(bobChat.length, 0, "nothing reached Bob's chat");

  // The same boundary for status: a delivery between Bob's chats is invisible to Alice's agent.
  const bobsMessage = registry.createChatMessage({ fromSessionId: "chat-bob", fromTitle: "Bob's payroll plan", toSessionId: "chat-open", urgency: "next_step", preview: "private" });
  const status = await callInternal({ token, body: { sessionId: "chat-alice", tool: "message_status", arguments: { id: bobsMessage.id } } });
  assert.equal(status.body.text, (await callInternal({ token, body: { sessionId: "chat-alice", tool: "message_status", arguments: { id: "msg_nonexistent" } } })).body.text);
  assert.equal(status.body.text, "No message with that id.");
});

test("a chat with no owner, on an instance that has accounts, reaches only other chats with no owner", async () => {
  const token = issueDisplayCapability("chat-open");
  const own = await callInternal({ token, body: sendBody("chat-open", { session: "chat-open-2", message: "to another open chat" }) });
  assert.match(own.body.text, /^Sent msg_\S+ to chat "Another old chat" \(chat-open-2\)/);
  assert.equal(openOther.length, 1);

  const unknown = await callInternal({ token, body: sendBody("chat-open", { session: "no-such-chat", message: "x" }) });
  const alices = await callInternal({ token, body: sendBody("chat-open", { session: "chat-alice", message: "x" }) });
  assert.equal(alices.body.text, unknown.body.text);
  assert.equal(aliceMain.length, 0);
});

test("a chat that is refused something it asked for hears it as text it can act on, never as an HTTP error", async () => {
  const token = issueDisplayCapability("chat-alice");
  const refusals = [
    [{ session: "chat-alice-2", message: "" }, "Pass `message`: what the other chat should read."],
    [{ session: "chat-alice-2", message: "x", urgency: "now" }, 'urgency must be "next_step" (read at the chat\'s next step) or "after_turn" (read when its current turn is over).'],
    [{ message: "x" }, "Pass `session`: the id or title of the chat to message; list_sessions shows them."],
    [{ session: "chat-alice", message: "talking to myself" }, "That is this chat. To message it later, use schedule_message."],
  ];
  for (const [args, text] of refusals) {
    const refused = await callInternal({ token, body: sendBody("chat-alice", args) });
    assert.deepEqual([refused.status, refused.body], [200, { text }], JSON.stringify(args));
  }
  assert.equal(aliceMain.length + aliceOther.length, 0);
});
