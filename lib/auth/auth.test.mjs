import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// Point the account store at a fresh temp dir before the modules load, and
// make sure no ambient password turns the env-managed account on mid-test.
process.env.CODY_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "cody-accounts-test-"));
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const password = await jiti.import("./password.ts");
const users = await jiti.import("./users.ts");
const session = await jiti.import("./session.ts");
const guard = await jiti.import("./guard.ts");

test("hashes verify, reject wrong passwords, and are self-describing", async () => {
  const stored = await password.hashPassword("correct horse battery");
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await password.verifyPassword("correct horse battery", stored), true);
  assert.equal(await password.verifyPassword("wrong", stored), false);
  assert.equal(await password.verifyPassword("anything", "not-a-hash"), false);
  assert.equal(password.needsRehash(stored), false);
  // Absurd cost parameters in a tampered record must fail, not allocate.
  assert.equal(await password.verifyPassword("x", "scrypt$1073741824$8$1$AAAA$AAAA"), false);
});

test("password strength bounds", () => {
  assert.notEqual(password.validatePasswordStrength("short"), null);
  assert.equal(password.validatePasswordStrength("long enough"), null);
  assert.notEqual(password.validatePasswordStrength("x".repeat(300)), null);
});

test("user store round-trips records with 0600 and unique usernames", async () => {
  assert.equal(users.hasAnyUser(), false);
  const hash = await password.hashPassword("long enough");
  const created = users.createUser({ username: "Nitin", fullName: "  Nitin Philip  ", passwordHash: hash, role: "admin" });
  assert.equal(created.username, "nitin"); // normalized
  assert.equal(created.fullName, "Nitin Philip");
  assert.equal(users.hasAnyUser(), true);
  assert.throws(() => users.createUser({ username: "nitin", fullName: "Dup", passwordHash: hash, role: "member" }), /taken/);
  assert.throws(() => users.createUser({ username: "!!", fullName: "Bad", passwordHash: hash, role: "member" }), /Usernames/);

  const storePath = join(process.env.CODY_ACCOUNTS_DIR, "accounts.json");
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  assert.equal(readFileSync(storePath, "utf8").includes("long enough"), false);

  const fetched = users.findUserByUsername("NITIN");
  assert.equal(fetched?.id, created.id);
});

test("last admin cannot be deleted", async () => {
  const hash = await password.hashPassword("long enough");
  const member = users.createUser({ username: "guest", fullName: "Guest", passwordHash: hash, role: "member" });
  const admin = users.findUserByUsername("nitin");
  assert.throws(() => users.deleteUser(admin.id), /last administrator/);
  users.deleteUser(member.id);
  assert.equal(users.findUserByUsername("guest"), null);
});

test("session tokens verify, expire, and die on tokenVersion bump", () => {
  const user = users.findUserByUsername("nitin");
  const token = session.issueSessionToken(user);
  assert.equal(session.verifySessionToken(token)?.id, user.id);
  assert.equal(session.verifySessionToken(token, Date.now() + 31 * 24 * 60 * 60 * 1000), null);
  assert.equal(session.verifySessionToken(`${token}x`), null);
  assert.equal(session.verifySessionToken("v1.junk.junk"), null);

  users.updateUser(user.id, (record) => { record.tokenVersion += 1; });
  assert.equal(session.verifySessionToken(token), null);
});

test("cookie header parsing finds the session token among others", () => {
  const user = users.findUserByUsername("nitin");
  users.updateUser(user.id, (record) => { record.tokenVersion += 1; });
  const fresh = users.findUserByUsername("nitin");
  const token = session.issueSessionToken(fresh);
  const header = `theme=dark; ${session.SESSION_COOKIE_NAME}=${token}; other=1`;
  assert.equal(session.sessionTokenFromCookieHeader(header), token);
  assert.equal(session.sessionTokenFromCookieHeader("theme=dark"), null);
  assert.equal(guard.getUserForCredentials(header, null)?.id, fresh.id);
});

test("env-managed account materializes when CODY_PASSWORD is set and resists deletion", () => {
  process.env.CODY_PASSWORD = "hunter22";
  try {
    const envUser = users.findUserByUsername("cody");
    assert.equal(envUser?.envManaged, true);
    assert.equal(envUser?.role, "admin");
    assert.equal(envUser?.passwordHash, undefined);
    assert.throws(() => users.deleteUser(envUser.id), /environment-managed/);

    const header = `Basic ${Buffer.from("cody:hunter22").toString("base64")}`;
    assert.equal(guard.getUserForCredentials(null, header)?.id, envUser.id);
    assert.equal(guard.getUserForCredentials(null, `Basic ${Buffer.from("cody:wrong").toString("base64")}`), null);
    assert.equal(guard.isAuthRequired(), true);
  } finally {
    delete process.env.CODY_PASSWORD;
  }
});

test("signup policy env flag", () => {
  assert.equal(users.isSignupAllowed(), true);
  process.env.CODY_ALLOW_SIGNUP = "0";
  assert.equal(users.isSignupAllowed(), false);
  process.env.CODY_ALLOW_SIGNUP = "true";
  assert.equal(users.isSignupAllowed(), true);
  delete process.env.CODY_ALLOW_SIGNUP;
});

test("session ownership: owned is private, unowned is shared, delete forgets", async () => {
  const owners = await jiti.import("./session-owners.ts");
  const hash = await password.hashPassword("long enough");
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: hash, role: "member" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: hash, role: "member" });

  owners.setSessionOwner("sess-alice", alice.id);
  assert.equal(owners.canAccessSession("sess-alice", alice), true);
  assert.equal(owners.canAccessSession("sess-alice", bob), false);
  assert.equal(owners.canAccessSession("sess-unowned", bob), true);
  assert.equal(owners.canAccessSession("sess-alice", null), true); // auth off sees all

  const list = [{ id: "sess-alice" }, { id: "sess-unowned" }];
  assert.deepEqual(owners.filterSessionsForUser(list, bob).map((s) => s.id), ["sess-unowned"]);
  assert.deepEqual(owners.filterSessionsForUser(list, alice).map((s) => s.id), ["sess-alice", "sess-unowned"]);
  assert.deepEqual(owners.filterSessionsForUser(list, null).map((s) => s.id), ["sess-alice", "sess-unowned"]);

  owners.forgetSession("sess-alice");
  assert.equal(owners.canAccessSession("sess-alice", bob), true);
  users.deleteUser(alice.id);
  users.deleteUser(bob.id);
});
