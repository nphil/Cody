import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

/**
 * The agent's three tools, through the handlers the omp host-tool path and the
 * ACP bridge both call: what the agent is told, which chats it may reach (the
 * owner's, by id or by name), and that nothing it was refused was stored.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-scheduled-tools-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
// No omp binary: "when quota resets" can read no usage, deterministically, without spawning anything.
process.env.CODY_OMP_BIN = path.join(root, "no-such-omp");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SCHEDULE_TOOLS, SCHEDULE_TOOL_NAMES } = await jiti.import("./tools.ts");
const { SESSION_NOT_FOUND } = await jiti.import("../session-tools.ts");
const { SCHEDULED_LIMITS } = await jiti.import("./types.ts");
const { parseInstant } = await jiti.import("./time.ts");
const store = await jiti.import("./store.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");
const users = await jiti.import("../auth/users.ts");

const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });

function writeChat(id, title, owner) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, cwd: "/proj", title, created: "2026-01-01", modified: "2026-01-01" })}\n`);
  if (owner) setSessionOwner(id, owner.id);
}
writeChat("alice-main", "Ship the release", alice);
writeChat("alice-login", "Fix login bug", alice);
writeChat("alice-login-2", "Fix login redirect", alice);
writeChat("bob-secret", "Bob's payroll plan", bob);
writeChat("old-unowned", "Old chat from before accounts", null);
invalidateSessionListCache();

afterEach(() => fs.writeFileSync(store.scheduledStorePath(), "", { mode: 0o600 }));

const NEW_YORK = "America/New_York";
/** 09:00 wall time, `days` from now, in `zone` — always inside the 30-day window, whenever the suite runs. */
function nineAm(days, zone = NEW_YORK) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
  return `${date}T09:00`;
}
const dayOf = (wall) => wall.slice(0, 10);
const NINE = nineAm(3);
const NINE_INSTANT = parseInstant(NINE, NEW_YORK).at;

const tool = (name) => SCHEDULE_TOOLS.find((entry) => entry.name === name);
const context = (overrides = {}) => ({ user: alice, defaultSessionId: "alice-main", restrictToUnowned: false, timeZone: NEW_YORK, ...overrides });
const call = (name, args, ctx = context()) => tool(name).handler(args, ctx);

test("the agent gets exactly three tools, with the arguments the bridge also declares", () => {
  assert.deepEqual(SCHEDULE_TOOL_NAMES, ["schedule_message", "list_scheduled", "cancel_scheduled"]);
  assert.deepEqual(Object.keys(tool("schedule_message").parameters.properties).sort(), ["at", "message", "session", "whenQuotaResets"]);
  assert.deepEqual(tool("schedule_message").parameters.required, ["message"]);
  assert.deepEqual(tool("cancel_scheduled").parameters.required, ["id"]);
  assert.deepEqual(Object.keys(tool("list_scheduled").parameters.properties), ["session"]);
  for (const entry of SCHEDULE_TOOLS) assert.equal(typeof entry.handler, "function");
  const taught = tool("schedule_message").description;
  assert.ok(taught.includes(String(SCHEDULED_LIMITS.perChat)) && taught.includes(String(SCHEDULED_LIMITS.maxDays)), "the limits the agent is told are the limits that are enforced");
});

test("scheduling for a time answers with the id, the time in the person's zone and how far off it is — and stores it as the agent's", async () => {
  const text = await call("schedule_message", { message: "Run the full suite and report", at: NINE });
  const [item] = store.listItems();
  assert.match(text, new RegExp(`Scheduled ${item.id} for ${dayOf(NINE)} 09:00 E[SD]T \\(in `), text);
  assert.match(text, /this chat/);
  assert.match(text, /"Run the full suite and report"/);
  assert.match(text, new RegExp(`cancel_scheduled id ${item.id}`));
  assert.equal(item.source, "agent");
  assert.equal(item.sessionId, "alice-main");
  assert.equal(item.dueAt, NINE_INSTANT, "9 AM where the user is, not 9 AM UTC");
  assert.equal(item.accountKey, alice.id);
});

test("a time with an explicit offset is taken as written, whatever zone the chat is in", async () => {
  const wall = nineAm(3, "UTC");
  await call("schedule_message", { message: "ping", at: `${wall}:00+09:00` });
  assert.equal(store.listItems()[0].dueAt, Date.parse(`${wall}:00Z`) - 9 * 3_600_000);
});

test("another chat is addressed by id or by a name that matches ONE chat; several matches ask instead of guessing", async () => {
  const own = await call("schedule_message", { message: "check the release", at: NINE, session: "Ship the" });
  assert.match(own, /goes to this chat/, "the chat the name matches happens to be the agent's own");
  const other = await call("schedule_message", { message: "check the bug", at: NINE, session: "login bug" });
  assert.match(other, /goes to chat alice-login /, other);
  const byId = await call("schedule_message", { message: "by id", at: NINE, session: "alice-login-2" });
  assert.match(byId, /goes to chat alice-login-2/);
  assert.deepEqual(store.listItems().map((item) => item.sessionId).sort(), ["alice-login", "alice-login-2", "alice-main"]);

  const ambiguous = await call("schedule_message", { message: "which?", at: NINE, session: "Fix login" });
  assert.match(ambiguous, /Multiple sessions match "Fix login"/);
  assert.match(ambiguous, /alice-login \|/);
  assert.match(ambiguous, /alice-login-2 \|/);
  assert.equal(store.listItems().length, 3, "nothing was scheduled by a guess");
  assert.equal(await call("schedule_message", { message: "x", at: NINE, session: "no such chat" }), SESSION_NOT_FOUND);
});

test("an agent cannot schedule into a chat its owner cannot reach: by name or by id, the refusal is the same as for a missing chat", async () => {
  for (const session of ["Bob's payroll plan", "payroll", "bob-secret"]) {
    assert.equal(await call("schedule_message", { message: "sneak", at: NINE, session }), SESSION_NOT_FOUND, session);
  }
  assert.deepEqual(store.listItems(), [], "nothing was stored in bob's chat");

  // An agent in a chat with no recorded owner (on an instance that has accounts) reaches only other unowned chats.
  const unowned = context({ user: null, defaultSessionId: "old-unowned", restrictToUnowned: true });
  assert.equal(await call("schedule_message", { message: "sneak", at: NINE, session: "alice-main" }, unowned), SESSION_NOT_FOUND);
  assert.equal(await call("schedule_message", { message: "sneak", at: NINE, session: "Ship the release" }, unowned), SESSION_NOT_FOUND);
  assert.match(await call("schedule_message", { message: "mine", at: NINE }, unowned), /Scheduled sch_/);
  assert.deepEqual(store.listItems().map((item) => item.sessionId), ["old-unowned"]);
});

test("a chat with no file yet (its first turn still running) is still the agent's own", async () => {
  const fresh = context({ defaultSessionId: "brand-new-chat" });
  assert.match(await call("schedule_message", { message: "carry on", at: NINE }, fresh), /Scheduled sch_/);
  assert.equal(store.listItems()[0].sessionId, "brand-new-chat");
});

test("refusals come back as plain sentences the agent can act on, never as a throw", async () => {
  assert.match(await call("schedule_message", { at: NINE }), /Write the message/);
  assert.match(await call("schedule_message", { message: "m", at: "tomorrow morning" }), /ISO 8601/);
  assert.match(await call("schedule_message", { message: "m" }), /exactly one of a time and whenQuotaResets/);
  assert.match(await call("schedule_message", { message: "m", at: NINE, whenQuotaResets: true }), /exactly one/);
  assert.match(await call("schedule_message", { message: "m", at: "2020-01-01T09:00" }), /already in the past/);
  assert.match(await call("schedule_message", { message: "m", at: "2999-01-01T09:00" }), new RegExp(`within ${SCHEDULED_LIMITS.maxDays} days`));
  assert.match(await call("schedule_message", { message: "m", whenQuotaResets: true }), /cannot see when this model's quota resets|cannot tell which model/, "no usage reader, no reset to wait for");
  assert.deepEqual(store.listItems(), []);
});

test("20 per chat: the 21st is refused with the number, and cancelling one makes room", async () => {
  const ids = [];
  for (let index = 0; index < SCHEDULED_LIMITS.perChat; index += 1) {
    const text = await call("schedule_message", { message: `m${index}`, at: NINE });
    ids.push(/Scheduled (sch_\S+) /.exec(text)[1]);
  }
  assert.match(await call("schedule_message", { message: "one more", at: NINE }), /already has 20 scheduled messages/);
  assert.match(await call("cancel_scheduled", { id: ids[0] }), /Cancelled/);
  assert.match(await call("schedule_message", { message: "now it fits", at: NINE }), /Scheduled sch_/);
});

test("list shows each message with who scheduled it, its state and a preview, in the chat asked about", async () => {
  assert.match(await call("list_scheduled", {}), /Nothing is scheduled for this chat/);
  await call("schedule_message", { message: "agent made this", at: NINE });
  const { item } = store.insertItem({ sessionId: "alice-main", accountKey: alice.id, message: "the user made this one and it is long ".repeat(8), mode: "at", dueAt: NINE_INSTANT + 86_400_000, source: "user" });
  store.mutateItem(item.id, (current) => ({ ...current, status: "failed", error: "The session stopped responding." }));
  await call("schedule_message", { message: "for the login chat", at: NINE, session: "login bug" });

  const lines = (await call("list_scheduled", {})).split("\n");
  assert.match(lines[0], /^2 scheduled for this chat \(at most 20\):$/);
  assert.match(lines[1], new RegExp(`^sch_\\S+ \\| ${dayOf(NINE)} 09:00 E[SD]T \\(in .*\\) \\| by the agent \\| pending \\| "agent made this"$`));
  assert.match(lines[2], /by the user \| failed: The session stopped responding\. \| "the user made this one/);
  assert.ok(lines[2].length < 300, "a long message is clipped to a preview");
  assert.doesNotMatch(lines.join("\n"), /for the login chat/, "another chat's messages are not in this chat's list");
  assert.match(await call("list_scheduled", { session: "login bug" }), /1 scheduled for chat alice-login/);
  assert.equal(await call("list_scheduled", { session: "payroll" }), SESSION_NOT_FOUND);
});

test("cancel withdraws by id, and an id in a chat the caller cannot reach reads like an id that does not exist", async () => {
  const text = await call("schedule_message", { message: "withdraw me", at: NINE });
  const id = /Scheduled (sch_\S+) /.exec(text)[1];
  const bobs = store.insertItem({ sessionId: "bob-secret", accountKey: bob.id, message: "bob's", mode: "at", dueAt: NINE_INSTANT + 86_400_000, source: "user" }).item;

  assert.equal(await call("cancel_scheduled", { id: bobs.id }), "No scheduled message with that id.");
  assert.equal(await call("cancel_scheduled", { id: "sch_doesnotexist" }), "No scheduled message with that id.");
  assert.ok(store.findItem(bobs.id), "bob's message was not touched");
  assert.match(await call("cancel_scheduled", {}), /Pass the id/);

  assert.match(await call("cancel_scheduled", { id }), new RegExp(`Cancelled ${id} \\("withdraw me"\\), which was due ${dayOf(NINE)} 09:00 E[SD]T`));
  assert.equal(store.findItem(id), null);
  assert.equal(await call("cancel_scheduled", { id }), "No scheduled message with that id.", "a second cancel finds nothing");

  store.mutateItem(bobs.id, (item) => ({ ...item, sessionId: "alice-main" }));
  assert.match(await call("cancel_scheduled", { id: bobs.id }), /Cancelled/, "the same message in a chat the caller owns IS cancellable");
});

test("a message being sent right now cannot be cancelled, and the agent is told so in words", async () => {
  const text = await call("schedule_message", { message: "in flight", at: NINE });
  const id = /Scheduled (sch_\S+) /.exec(text)[1];
  store.mutateItem(id, (item) => ({ ...item, status: "sending" }));
  assert.equal(await call("cancel_scheduled", { id }), "That message is being sent right now.");
  assert.ok(store.findItem(id));
});

test("times are written in the zone of the message being answered, and fall back to the server's, never to raw UTC", async () => {
  const tokyoWall = nineAm(3, "Asia/Tokyo");
  await call("schedule_message", { message: "tokyo", at: tokyoWall }, context({ timeZone: "Asia/Tokyo" }));
  assert.match(await call("list_scheduled", {}, context({ timeZone: "Asia/Tokyo" })), new RegExp(`${dayOf(tokyoWall)} 09:00 UTC\\+09:00`));
  const fallback = await call("list_scheduled", {}, context({ timeZone: undefined }));
  assert.doesNotMatch(fallback, /\d{2}:\d{2}:\d{2}(\.\d+)?Z/, "an ISO string is never what the agent reads");
});
