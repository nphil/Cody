import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The HTTP surface of Settings › System › Disk, through the real route handler:
 * who may read, clean and change the settings, what a bad number looks like,
 * which chat titles each person is allowed to see on the "largest scratch
 * folders" list, and that a manual clean really deletes an idle folder and
 * says how much it freed. The janitor, the scratch index and the settings file
 * have their own tests.
 *
 * Everything the janitor sweeps (the temp dir, the home dir, the scratch root,
 * the data dir) is pointed into one private directory first, so a run can
 * never touch the real machine.
 */
const root = mkdtempSync(join(tmpdir(), "cody-disk-route-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
process.env.TMPDIR = join(root, "tmp");
process.env.HOME = join(root, "home");
process.env.CODY_SCRATCH_ROOT = join(root, "tmp", "cs");
mkdirSync(process.env.TMPDIR, { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.OMP_WEB_REQUIRE_ACCOUNTS;

after(() => rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../../app/api/disk/route.ts");
const scratch = await jiti.import("./scratch.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");
const engineSessions = await jiti.import("../harness/engine-sessions.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");

let admin;
let alice;

const cookieFor = (user) => (user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {});

/** `user` omitted: the administrator (once accounts exist); `null`: nobody signed in. */
async function call(method, { user = admin, body } = {}) {
  const handler = route[method];
  const response = await handler(new Request("http://cody.test/api/disk", {
    method,
    headers: { "Content-Type": "application/json", ...cookieFor(user) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json() };
}

/** Make a scratch folder holding exactly `bytes` bytes for a session. */
function scratchWith(sessionId, bytes) {
  const dir = scratch.ensureSessionScratch(sessionId);
  assert.ok(dir, "scratch folder created");
  writeFileSync(join(dir, "blob"), Buffer.alloc(bytes));
  return dir;
}

test("on an instance with no accounts anyone can read, clean and change settings", async () => {
  const read = await call("GET");
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, true);
  assert.equal(read.body.running, false);
  assert.ok(Array.isArray(read.body.areas));
  assert.equal(read.body.settings.scratchIdleDays, 3);
  assert.equal(read.body.lastRun, null);

  const saved = await call("PUT", { body: { scratchIdleDays: 9 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.scratchIdleDays, 9);
  assert.equal((await call("GET")).body.settings.scratchIdleDays, 9);
  await call("PUT", { body: { scratchIdleDays: 3 } });

  // Accounts appear only after the open-instance checks, which need none to exist.
  admin = users.createUser({ username: "admin", fullName: "Admin", passwordHash: "x", role: "admin" });
  alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
});

test("a number outside its range is refused, names the field, and changes nothing", async () => {
  const refused = await call("PUT", { body: { scratchIdleDays: 0 } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "invalid_disk_settings");
  assert.equal(refused.body.field, "scratchIdleDays");

  const mixed = await call("PUT", { body: { tmpIdleHours: 48, budgetPercent: 5 } });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.field, "budgetPercent");
  assert.equal((await call("GET")).body.settings.tmpIdleHours, 24);
});

test("a request that is not a clean order or a settings object is refused", async () => {
  assert.equal((await call("POST", { body: { action: "format" } })).status, 400);
  assert.equal((await call("POST", { body: [] })).status, 400);
  assert.equal((await call("PUT", { body: [1] })).status, 400);
});

test("a manual clean removes an idle scratch folder, reports what it freed, and a recent one is kept", async () => {
  await call("PUT", { body: { budgetPercent: 95 } });
  const idle = scratchWith("idle-chat", 4096);

  // Right now nothing is idle: the folder is seconds old.
  const early = await call("POST", { body: { action: "clean" } });
  assert.equal(early.status, 200);
  assert.equal(early.body.lastRun.trigger, "manual");
  assert.equal(existsSync(idle), true);

  // Four days later (the limit is three) the same request deletes it. The clock moves instead of the
  // folder's file dates, which keeps the test independent of how the janitor reads them; sign-in
  // cookies last thirty days and survive the jump.
  const realNow = Date.now;
  Date.now = () => realNow() + 4 * 24 * 3600 * 1000;
  let cleaned;
  try {
    cleaned = await call("POST", { body: { action: "clean" } });
  } finally {
    Date.now = realNow;
  }
  assert.equal(cleaned.status, 200);
  assert.ok(cleaned.body.freedBytes >= 4096, "the idle folder's bytes are counted");
  assert.equal(cleaned.body.freedBytes, cleaned.body.lastRun.freedBytes);
  assert.ok(cleaned.body.lastRun.removedCount >= 1);
  assert.ok(cleaned.body.lastRun.removed.length <= 50);
  assert.equal(existsSync(idle), false);

  // The same numbers are what a later page load shows.
  const reloaded = await call("GET");
  assert.equal(reloaded.body.lastRun.finishedAt, cleaned.body.lastRun.finishedAt);
  assert.equal(reloaded.body.freedBytes, undefined);
});

test("the largest scratch folders are the five biggest, with titles only for chats the reader may open", async () => {
  engineSessions.upsertEngineSession("chat-shared", { engine: "claude", title: "Fix the login page" });
  engineSessions.upsertEngineSession("chat-private", { engine: "claude", title: "Admin only plans" });
  owners.setSessionOwner("chat-private", admin.id);
  scratchWith("chat-shared", 9000);
  scratchWith("chat-private", 8000);
  scratchWith("chat-deleted", 7000);
  for (const [index, size] of [100, 200, 300, 400].entries()) scratchWith(`filler-${index}`, size);

  const asAdmin = await call("POST", { user: admin, body: { action: "clean" } });
  assert.equal(asAdmin.status, 200);
  const folders = asAdmin.body.largestScratch;
  assert.equal(folders.length, 5);
  assert.deepEqual(folders.slice(0, 3).map((folder) => folder.title), ["Fix the login page", "Admin only plans", "Deleted chat"]);
  assert.ok(folders.every((folder, index) => index === 0 || folder.bytes <= folders[index - 1].bytes), "biggest first");

  const asAlice = await call("GET", { user: alice });
  assert.equal(asAlice.status, 200);
  assert.deepEqual(asAlice.body.largestScratch.slice(0, 3).map((folder) => folder.title), ["Fix the login page", "Unknown chat", "Deleted chat"]);
});

test("a member can read but not clean or change settings; a visitor with no sign-in cannot read", async () => {
  const member = await call("GET", { user: alice });
  assert.equal(member.status, 200);
  assert.equal(member.body.canEdit, false);
  assert.deepEqual(member.body.lastRun.removed, [], "paths of removed files stay with administrators");

  assert.equal((await call("POST", { user: alice, body: { action: "clean" } })).status, 403);
  assert.equal((await call("PUT", { user: alice, body: { scratchIdleDays: 5 } })).status, 403);
  assert.equal((await call("GET", { user: admin })).body.canEdit, true);

  assert.equal((await call("GET", { user: null })).status, 401);
  assert.equal((await call("POST", { user: null, body: { action: "clean" } })).status, 401);
  assert.equal((await call("PUT", { user: null, body: { scratchIdleDays: 5 } })).status, 401);
});
