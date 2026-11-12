import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The ownership sidecar lives in the accounts dir; point it at a scratch dir
// before anything imports it.
const accounts = fs.mkdtempSync(path.join(os.tmpdir(), "cody-stats-accounts-"));
process.env.CODY_ACCOUNTS_DIR = accounts;
process.on("exit", () => fs.rmSync(accounts, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { visibleChats } = await jiti.import("./access.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");

const user = (id, role) => ({ id, username: id, fullName: id, role, tokenVersion: 1, createdAt: "2026-01-01T00:00:00Z" });
const alice = user("u-alice", "member");
const bob = user("u-bob", "member");
const admin = user("u-admin", "admin");

setSessionOwner("chat-alice", alice.id);
setSessionOwner("chat-bob", bob.id);
setSessionOwner("chat-admin", admin.id);

const store = { files: new Map() };
for (const [id, chat] of ["chat-alice", "chat-bob", "chat-admin", "chat-unowned", ""].entries()) {
  store.files.set(id + 1, { id: id + 1, chat });
}

test("an open instance (no account) sees everything, including usage outside any chat", () => {
  const visible = visibleChats(store, null);
  for (const chat of ["chat-alice", "chat-bob", "chat-admin", "chat-unowned", ""]) assert.equal(visible(chat), true, chat);
});

test("a member sees own and unowned chats, not another user's, and not instance-level spend", () => {
  const visible = visibleChats(store, alice);
  assert.equal(visible("chat-alice"), true);
  assert.equal(visible("chat-unowned"), true);
  assert.equal(visible("chat-bob"), false);
  assert.equal(visible("chat-admin"), false);
  assert.equal(visible(""), false);
});

test("an admin also sees instance-level spend, but the chat rule is the same as anyone's", () => {
  const visible = visibleChats(store, admin);
  assert.equal(visible(""), true);
  assert.equal(visible("chat-admin"), true);
  assert.equal(visible("chat-unowned"), true);
  assert.equal(visible("chat-bob"), false);
});
