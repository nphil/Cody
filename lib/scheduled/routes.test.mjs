import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The HTTP surface of scheduled messages, driven through the real route
 * handlers: who may touch which chat's messages, what each refusal looks like,
 * and that "send now" really goes through the chat's own session. The
 * scheduler, the service and the tools have their own files; this one is about
 * the doors.
 */
const root = mkdtempSync(join(tmpdir(), "cody-scheduled-routes-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
process.env.CODY_INTERNAL_DISPLAY_SECRET = randomBytes(32).toString("base64url");
process.env.TZ = "America/New_York";
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const collection = await jiti.import("../../app/api/sessions/[id]/scheduled/route.ts");
const itemRoute = await jiti.import("../../app/api/sessions/[id]/scheduled/[itemId]/route.ts");
const sendNowRoute = await jiti.import("../../app/api/sessions/[id]/scheduled/[itemId]/send-now/route.ts");
const internalRoute = await jiti.import("../../app/api/internal/scheduled/route.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");
const { issueDisplayCapability } = await jiti.import("../display/capability.ts");
const store = await jiti.import("./store.ts");
const { SCHEDULED_LIMITS } = await jiti.import("./types.ts");

const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });

/** A live chat the routes find in the registry. It records what it was sent; `fail` makes it refuse. */
function liveChat(id, owner, { fail } = {}) {
  const sent = [];
  const session = {
    sessionId: id,
    cwd: join(root, "no-such-workspace"),
    isAlive: () => true,
    isRunning: () => false,
    send: async (command) => {
      if (fail) throw fail;
      sent.push(command);
      return null;
    },
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  if (owner) owners.setSessionOwner(id, owner.id);
  return sent;
}

const aliceChat = liveChat("chat-alice", alice);
const bobChat = liveChat("chat-bob", bob);
liveChat("chat-open", null);

const clear = () => store.transact(() => ({ items: [], result: null }));
const cookieFor = (user) => (user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {});
const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function call(handler, { user, id, itemId, method = "POST", body, raw } = {}) {
  const response = await handler(
    new Request(`http://cody.test/api/sessions/${id}/scheduled`, {
      method,
      headers: { "Content-Type": "application/json", ...cookieFor(user) },
      ...(method === "GET" || (body === undefined && raw === undefined) ? {} : { body: raw ?? JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id, itemId }) },
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const create = (user, id, body) => call(collection.POST, { user, id, body });
const list = (user, id) => call(collection.GET, { user, id, method: "GET" });

test("an account schedules into its own chat and sees the row; the answers are never cached", async () => {
  clear();
  const created = await create(alice, "chat-alice", { message: "run the suite", at: inHours(2) });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.source, "user");
  assert.equal(created.body.item.sessionId, "chat-alice");
  assert.equal(created.body.item.status, "pending");
  assert.equal(created.headers.get("cache-control"), "no-store");

  const listed = await list(alice, "chat-alice");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((item) => item.id), [created.body.item.id]);
  assert.deepEqual(listed.body.limits, SCHEDULED_LIMITS);
  assert.equal(listed.headers.get("cache-control"), "no-store");
});

test("another account's chat answers exactly like one that does not exist, for every verb, and nothing is stored", async () => {
  clear();
  const created = await create(alice, "chat-alice", { message: "mine", at: inHours(2) });
  const itemId = created.body.item.id;

  const missing = await list(bob, "no-such-chat");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "session_not_found");
  for (const [handler, method] of [[collection.GET, "GET"], [collection.POST, "POST"]]) {
    const blocked = await call(handler, { user: bob, id: "chat-alice", method, body: { message: "sneak", at: inHours(1) } });
    assert.deepEqual([blocked.status, blocked.body], [missing.status, missing.body], `${method} on someone else's chat`);
  }
  for (const [handler, method] of [[itemRoute.PATCH, "PATCH"], [itemRoute.DELETE, "DELETE"], [sendNowRoute.POST, "POST"]]) {
    const blocked = await call(handler, { user: bob, id: "chat-alice", itemId, method, body: { message: "hijack" } });
    assert.deepEqual([blocked.status, blocked.body], [missing.status, missing.body], `${method} on someone else's item`);
  }
  assert.deepEqual(store.listItems().map((item) => [item.id, item.message]), [[itemId, "mine"]], "untouched, and nothing of bob's was added");
  assert.equal(aliceChat.length, 0, "and nothing was sent to the chat");
});

test("an item id is only ever good in its own chat: guessing it under another chat of your own finds nothing", async () => {
  clear();
  const created = await create(alice, "chat-alice", { message: "mine", at: inHours(2) });
  const itemId = created.body.item.id;
  // Open (unowned) chats are everyone's: bob may use them, but not reach into alice's chat through them.
  for (const [handler, method] of [[itemRoute.PATCH, "PATCH"], [itemRoute.DELETE, "DELETE"], [sendNowRoute.POST, "POST"]]) {
    const wrong = await call(handler, { user: bob, id: "chat-open", itemId, method, body: { message: "other" } });
    assert.equal(wrong.status, 404, method);
    assert.equal(wrong.body.code, "item_not_found", method);
  }
  assert.equal(store.findItem(itemId)?.message, "mine");
});

test("a request without credentials is refused outright while accounts exist", async () => {
  clear();
  for (const [handler, method] of [[collection.GET, "GET"], [collection.POST, "POST"]]) {
    const refused = await call(handler, { id: "chat-open", method, body: { message: "anon", at: inHours(1) } });
    assert.equal(refused.status, 401, method);
    assert.equal(refused.body.code, "auth_required");
  }
  assert.deepEqual(store.listItems(), []);
});

test("every way a request can be wrong has its own status and stable code", async () => {
  clear();
  const day = 24 * 3_600_000;
  const cases = [
    ["no message", { at: inHours(1) }, 400, "message_required"],
    ["a blank message", { message: "   ", at: inHours(1) }, 400, "message_required"],
    ["a message past 64 KB", { message: "é".repeat(SCHEDULED_LIMITS.maxMessageBytes / 2 + 1), at: inHours(1) }, 400, "message_too_long"],
    ["neither a time nor the quota", { message: "m" }, 400, "choose_one_time"],
    ["both a time and the quota", { message: "m", at: inHours(1), whenQuotaResets: true }, 400, "choose_one_time"],
    ["a time that is not a time", { message: "m", at: "tomorrow morning" }, 400, "invalid_time"],
    ["a time with no offset (a browser always sends one)", { message: "m", at: "2026-10-07T09:00" }, 400, "invalid_time"],
    ["a time in the past", { message: "m", at: new Date(Date.now() - 2 * 3_600_000).toISOString() }, 400, "time_in_past"],
    ["a time beyond 30 days", { message: "m", at: new Date(Date.now() + 31 * day).toISOString() }, 400, "time_too_far"],
    ["the quota of a chat whose model nobody can name", { message: "m", whenQuotaResets: true }, 400, "no_model"],
  ];
  for (const [what, body, status, code] of cases) {
    const answer = await create(alice, "chat-alice", body);
    assert.deepEqual([answer.status, answer.body.code], [status, code], what);
    assert.equal(typeof answer.body.error, "string", `${what}: a sentence to show`);
  }
  const notJson = await call(collection.POST, { user: alice, id: "chat-alice", raw: "{nope" });
  assert.deepEqual([notJson.status, notJson.body.code], [400, "invalid_json"]);
  const notAnObject = await call(collection.POST, { user: alice, id: "chat-alice", body: ["m"] });
  assert.deepEqual([notAnObject.status, notAnObject.body.code], [400, "invalid_body"]);
  assert.deepEqual(store.listItems(), [], "not one of them stored anything");

  const exactlyThirtyDays = await create(alice, "chat-alice", { message: "edge", at: new Date(Date.now() + 30 * day - 1000).toISOString() });
  assert.equal(exactlyThirtyDays.status, 201, "the edge of the window is inside it");
});

test("the 21st message in a chat is refused with 409 and its own code, and a cancel makes room", async () => {
  clear();
  const made = [];
  for (let n = 0; n < SCHEDULED_LIMITS.perChat; n += 1) {
    const answer = await create(alice, "chat-alice", { message: `m${n}`, at: inHours(1 + n) });
    assert.equal(answer.status, 201, `message ${n + 1}`);
    made.push(answer.body.item.id);
  }
  const over = await create(alice, "chat-alice", { message: "one too many", at: inHours(30) });
  assert.deepEqual([over.status, over.body.code], [409, "too_many_for_chat"]);
  assert.equal(store.listItemsForSession("chat-alice").length, SCHEDULED_LIMITS.perChat);
  assert.equal((await call(itemRoute.DELETE, { user: alice, id: "chat-alice", itemId: made[0], method: "DELETE" })).status, 200);
  assert.equal((await create(alice, "chat-alice", { message: "now it fits", at: inHours(31) })).status, 201);
});

test("editing moves the time and changes the words; cancelling removes it; an unknown id is a 404", async () => {
  clear();
  const created = await create(alice, "chat-alice", { message: "first words", at: inHours(2) });
  const itemId = created.body.item.id;
  const later = inHours(5);

  const edited = await call(itemRoute.PATCH, { user: alice, id: "chat-alice", itemId, method: "PATCH", body: { message: "second words", at: later } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.message, "second words");
  assert.equal(Date.parse(edited.body.item.at), Date.parse(later));
  assert.equal(edited.body.item.id, itemId, "the same row, not a new one");

  const empty = await call(itemRoute.PATCH, { user: alice, id: "chat-alice", itemId, method: "PATCH", body: {} });
  assert.deepEqual([empty.status, empty.body.code], [400, "invalid_body"], "an edit that changes nothing is a mistake, not a success");
  const blank = await call(itemRoute.PATCH, { user: alice, id: "chat-alice", itemId, method: "PATCH", body: { message: " " } });
  assert.deepEqual([blank.status, blank.body.code], [400, "message_required"]);

  const cancelled = await call(itemRoute.DELETE, { user: alice, id: "chat-alice", itemId, method: "DELETE" });
  assert.deepEqual([cancelled.status, cancelled.body], [200, { ok: true }]);
  assert.deepEqual(store.listItems(), []);
  for (const [handler, method] of [[itemRoute.PATCH, "PATCH"], [itemRoute.DELETE, "DELETE"], [sendNowRoute.POST, "POST"]]) {
    const gone = await call(handler, { user: alice, id: "chat-alice", itemId, method, body: { message: "x" } });
    assert.deepEqual([gone.status, gone.body.code], [404, "item_not_found"], `${method} after it is gone`);
  }
});

test("send now goes through the chat's own session: one prompt held as a follow-up under the row's stable id, and the row is gone", async () => {
  clear();
  aliceChat.length = 0;
  const created = await create(alice, "chat-alice", { message: "do it now please", at: inHours(20) });
  const itemId = created.body.item.id;

  const sent = await call(sendNowRoute.POST, { user: alice, id: "chat-alice", itemId, method: "POST" });
  assert.deepEqual([sent.status, sent.body], [200, { ok: true, delivered: true }]);
  assert.equal(aliceChat.length, 1, "exactly one delivery");
  assert.equal(aliceChat[0].type, "prompt");
  assert.equal(aliceChat[0].message, "do it now please");
  assert.equal(aliceChat[0].streamingBehavior, "followUp", "never collides with a turn that is running");
  assert.equal(aliceChat[0].clientMessageId, `sched-${itemId}`, "the id the chat's ledger dedupes a retry on");
  assert.match(aliceChat[0].timeZone, /^[A-Za-z_]+\/[A-Za-z_]+$/, "in the owner's zone, never the server's raw clock");
  assert.deepEqual(store.listItems(), []);

  const again = await call(sendNowRoute.POST, { user: alice, id: "chat-alice", itemId, method: "POST" });
  assert.equal(again.status, 404, "a second press finds nothing to send");
  assert.equal(aliceChat.length, 1, "so nothing is sent twice");
});

test("send now that the chat refuses leaves a failed row with the reason, and Retry is the same call", async () => {
  clear();
  const refusal = Object.assign(new Error("The agent is not accepting messages."), { name: "RpcCommandError" });
  const sent = liveChat("chat-refuses", alice, { fail: refusal });
  const created = await create(alice, "chat-refuses", { message: "will be refused", at: inHours(3) });
  const itemId = created.body.item.id;

  const first = await call(sendNowRoute.POST, { user: alice, id: "chat-refuses", itemId, method: "POST" });
  assert.equal(first.status, 200);
  assert.equal(first.body.delivered, false);
  assert.equal(first.body.item.status, "failed");
  assert.equal(first.body.item.error, "The agent is not accepting messages.");
  assert.deepEqual(sent, []);

  // The chat comes back: Retry goes through under a NEW delivery identity (the first was refused for good).
  liveChat("chat-refuses", alice);
  const retried = await call(sendNowRoute.POST, { user: alice, id: "chat-refuses", itemId, method: "POST" });
  assert.deepEqual([retried.status, retried.body], [200, { ok: true, delivered: true }]);
  assert.deepEqual(store.listItems(), []);
});

// ---------------------------------------------------------------------------
// The agent's door: /api/internal/scheduled
// ---------------------------------------------------------------------------

async function callInternal({ token, body }) {
  const response = await internalRoute.POST(new Request("http://cody.test/api/internal/scheduled", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("the internal route answers only to a valid capability, and only about the chat that capability names", async () => {
  clear();
  const request = { sessionId: "chat-alice", tool: "list_scheduled", arguments: {} };
  assert.equal((await callInternal({ body: request })).status, 401, "no token");
  assert.equal((await callInternal({ token: "garbage", body: request })).status, 401, "not a token");
  assert.equal((await callInternal({ token: issueDisplayCapability("chat-alice", -1000), body: request })).status, 401, "an expired one");
  const tampered = issueDisplayCapability("chat-alice").replace(/.$/, (last) => (last === "A" ? "B" : "A"));
  assert.equal((await callInternal({ token: tampered, body: request })).status, 401, "a forged signature");

  const token = issueDisplayCapability("chat-alice");
  const crossed = await callInternal({ token, body: { ...request, sessionId: "chat-bob" } });
  assert.equal(crossed.status, 403, "a body may name any chat, but it must be the token's");
  assert.equal(store.listItems().length, 0);
  assert.equal((await callInternal({ token, body: { sessionId: "chat-alice" } })).status, 400, "no tool named");
  assert.equal((await callInternal({ token, body: { ...request, tool: "delete_everything" } })).status, 400, "not a scheduling tool");
  assert.equal((await callInternal({ token, body: { tool: "list_scheduled" } })).status, 400, "no chat named");

  const ok = await callInternal({ token, body: request });
  assert.deepEqual([ok.status, ok.body], [200, { text: "Nothing is scheduled for this chat." }]);
});

test("a chat's agent schedules for its own chat as the agent, and cannot reach a chat its owner cannot", async () => {
  clear();
  const token = issueDisplayCapability("chat-alice");
  const scheduled = await callInternal({ token, body: { sessionId: "chat-alice", tool: "schedule_message", arguments: { message: "check CI", at: inHours(4) } } });
  assert.equal(scheduled.status, 200);
  assert.match(scheduled.body.text, /^Scheduled sch_\S+ for \d{4}-\d{2}-\d{2} \d{2}:\d{2} E[DS]T \(in 4 h\)\./);
  const [stored] = store.listItemsForSession("chat-alice");
  assert.deepEqual([stored.message, stored.source, stored.accountKey], ["check CI", "agent", alice.id]);

  // Alice's agent asking for Bob's chat, by id: the same words as a chat that does not exist.
  const unknown = await callInternal({ token, body: { sessionId: "chat-alice", tool: "schedule_message", arguments: { message: "x", at: inHours(1), session: "no-such-chat" } } });
  const bobs = await callInternal({ token, body: { sessionId: "chat-alice", tool: "schedule_message", arguments: { message: "x", at: inHours(1), session: "chat-bob" } } });
  assert.equal(bobs.status, 200);
  assert.equal(bobs.body.text, unknown.body.text);
  assert.deepEqual(store.listItemsForSession("chat-bob"), [], "nothing reached Bob's chat");

  // Nor may it withdraw Bob's message by guessing its id.
  const bobsItem = store.insertItem({ sessionId: "chat-bob", accountKey: bob.id, message: "bob's own", mode: "at", dueAt: Date.now() + 3_600_000, source: "user" });
  const cancelled = await callInternal({ token, body: { sessionId: "chat-alice", tool: "cancel_scheduled", arguments: { id: bobsItem.item.id } } });
  assert.equal(cancelled.body.text, "No scheduled message with that id.");
  assert.equal(store.findItem(bobsItem.item.id)?.message, "bob's own");
});

test("an unowned chat's agent is limited to other unowned chats once accounts exist", async () => {
  clear();
  const token = issueDisplayCapability("chat-open");
  const own = await callInternal({ token, body: { sessionId: "chat-open", tool: "schedule_message", arguments: { message: "from an open chat", at: inHours(2) } } });
  assert.match(own.body.text, /^Scheduled sch_/);
  const alices = await callInternal({ token, body: { sessionId: "chat-open", tool: "schedule_message", arguments: { message: "x", at: inHours(1), session: "chat-alice" } } });
  const unknown = await callInternal({ token, body: { sessionId: "chat-open", tool: "schedule_message", arguments: { message: "x", at: inHours(1), session: "no-such-chat" } } });
  assert.equal(alices.body.text, unknown.body.text);
  assert.deepEqual(store.listItemsForSession("chat-alice"), []);
});
