import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Who hears about a chat. The owner stamp is written after a session spawns and
 * a chat can have none at all, so the rule has to cover: an owner, no owner on an
 * instance with accounts, and no owner on an open instance.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-recipients-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const recipients = await jiti.import("./recipients.ts");
const store = await jiti.import("./store.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");

const keys = (list) => list.map((recipient) => recipient.key).sort();

test("on an open instance (no accounts) every chat belongs to the instance record", () => {
  store.updateNotificationPrefs(store.INSTANCE_RECIPIENT_KEY, { topic: "instance_topic" });
  const [only, ...rest] = recipients.recipientsForSession("any-chat");
  assert.deepEqual(rest, []);
  assert.equal(only.key, "__instance");
  assert.equal(only.user, null);
  assert.equal(only.prefs.topic, "instance_topic");
  assert.deepEqual(keys(recipients.recipientsForAccountEvent()), ["__instance"], "account-wide events too");
});

test("a chat with a live owner goes to that account alone, with that account's own settings", () => {
  const admin = users.createUser({ username: "admin1", fullName: "Admin One", passwordHash: "x", role: "admin" });
  const member = users.createUser({ username: "member1", fullName: "Member One", passwordHash: "x", role: "member" });
  store.updateNotificationPrefs(admin.id, { topic: "admin_topic" });
  store.updateNotificationPrefs(member.id, { topic: "member_topic" });
  owners.setSessionOwner("chat-of-member", member.id);

  const got = recipients.recipientsForSession("chat-of-member");
  assert.deepEqual(keys(got), [member.id]);
  assert.equal(got[0].prefs.topic, "member_topic");
  assert.equal(got[0].user.id, member.id);
});

test("an unowned chat on an instance with accounts goes to every ADMINISTRATOR and no member", () => {
  const second = users.createUser({ username: "admin2", fullName: "Admin Two", passwordHash: "x", role: "admin" });
  const all = users.listUsers();
  const admins = all.filter((user) => user.role === "admin").map((user) => user.id).sort();
  assert.equal(admins.length, 2);
  assert.ok(admins.includes(second.id));
  assert.deepEqual(keys(recipients.recipientsForSession("unowned-chat")), admins);
  assert.ok(!keys(recipients.recipientsForSession("unowned-chat")).includes("__instance"));
});

test("an owner stamp that no longer names an account reads as unowned", () => {
  const gone = users.createUser({ username: "gone", fullName: "Gone", passwordHash: "x", role: "member" });
  owners.setSessionOwner("orphan-chat", gone.id);
  users.deleteUser(gone.id);
  const admins = users.listUsers().filter((user) => user.role === "admin").map((user) => user.id).sort();
  assert.deepEqual(keys(recipients.recipientsForSession("orphan-chat")), admins);
});

test("the owner is read when the notification is sent, not when the session started", () => {
  const [admin] = users.listUsers().filter((user) => user.role === "admin");
  const late = users.findUserByUsername("member1");
  assert.deepEqual(keys(recipients.recipientsForSession("stamped-late")), users.listUsers().filter((u) => u.role === "admin").map((u) => u.id).sort());
  owners.setSessionOwner("stamped-late", late.id);
  assert.deepEqual(keys(recipients.recipientsForSession("stamped-late")), [late.id]);
  assert.ok(admin);
});

test("account-wide events go to every account, members included, on an instance with accounts", () => {
  assert.deepEqual(keys(recipients.recipientsForAccountEvent()), users.listUsers().map((user) => user.id).sort());
});

test("a button's recipient is only valid while it is still one of the chat's recipients", () => {
  const member = users.findUserByUsername("member1");
  const admin = users.findUserByUsername("admin1");
  assert.equal(recipients.recipientForSession("chat-of-member", member.id)?.key, member.id);
  assert.equal(recipients.recipientForSession("chat-of-member", admin.id), null, "an admin is not a recipient of someone else's chat");
  assert.equal(recipients.recipientForSession("chat-of-member", "__instance"), null, "nor is the instance record, once accounts exist");
  assert.equal(recipients.recipientForSession("unowned-chat", admin.id)?.key, admin.id, "an unowned chat's admins are");
  assert.equal(recipients.recipientForSession("unowned-chat", member.id), null, "its members are not");

  // Handing the chat to someone else revokes the first person's buttons.
  owners.setSessionOwner("chat-of-member", admin.id);
  assert.equal(recipients.recipientForSession("chat-of-member", member.id), null);
  assert.equal(recipients.recipientForSession("chat-of-member", admin.id)?.key, admin.id);
});
