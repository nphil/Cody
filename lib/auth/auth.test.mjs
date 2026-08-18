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
const tokens = await jiti.import("./tokens.ts");

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

test("first human account is admin even after the env account materialized", async () => {
  // Fresh store: the env-managed bootstrap account must not use up the
  // first-admin slot — on a Docker install (CODY_PASSWORD always set) the
  // first person signing up still has to end up an administrator.
  const previousDir = process.env.CODY_ACCOUNTS_DIR;
  process.env.CODY_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "cody-accounts-human-"));
  process.env.CODY_PASSWORD = "hunter22";
  try {
    assert.equal(users.hasAnyUser(), true, "env account materializes");
    assert.equal(users.hasAnyHumanUser(), false, "env account is not a human account");
    const human = users.createUser({
      username: "firsthuman",
      fullName: "First Human",
      passwordHash: await password.hashPassword("first-human-pass"),
      role: users.hasAnyHumanUser() ? "member" : "admin",
    });
    assert.equal(human.role, "admin");
    assert.equal(users.hasAnyHumanUser(), true);
  } finally {
    process.env.CODY_ACCOUNTS_DIR = previousDir;
    delete process.env.CODY_PASSWORD;
  }
});

test("ownership follows a session identity rename", async () => {
  const owners = await jiti.import("./session-owners.ts");
  owners.setSessionOwner("engine-old-id", "user-1");
  owners.renameSessionOwner("engine-old-id", "engine-new-id");
  assert.equal(owners.getSessionOwner("engine-old-id"), null);
  assert.equal(owners.getSessionOwner("engine-new-id"), "user-1");
  // Renaming an unowned session must not invent an owner.
  owners.renameSessionOwner("never-owned", "still-never-owned");
  assert.equal(owners.getSessionOwner("still-never-owned"), null);
  owners.forgetSession("engine-new-id");
});

test("CODY_REQUIRE_ACCOUNTS forces auth on a zero-account instance", () => {
  const previousDir = process.env.CODY_ACCOUNTS_DIR;
  // The Cody container entrypoint exports CODY_REQUIRE_ACCOUNTS=1; clear the
  // ambient value so the bare-instance baseline is actually bare.
  const previousRequire = process.env.CODY_REQUIRE_ACCOUNTS;
  delete process.env.CODY_REQUIRE_ACCOUNTS;
  process.env.CODY_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "cody-accounts-lock-"));
  try {
    assert.equal(guard.isAuthRequired(), false, "bare dev instance stays open");
    process.env.CODY_REQUIRE_ACCOUNTS = "1";
    assert.equal(guard.isAuthRequired(), true, "container lock closes the zero-account window");
  } finally {
    if (previousRequire === undefined) delete process.env.CODY_REQUIRE_ACCOUNTS;
    else process.env.CODY_REQUIRE_ACCOUNTS = previousRequire;
    process.env.CODY_ACCOUNTS_DIR = previousDir;
  }
});

test("access tokens issue, verify, and reveal the secret exactly once", async () => {
  const user = users.createUser({
    username: "tokenuser",
    fullName: "Token User",
    passwordHash: await password.hashPassword("long enough"),
    role: "member",
  });

  const { secret, token } = tokens.issueAccessToken(user, "Pixel tablet");
  assert.match(secret, /^cody_pat_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.verifyAccessToken(secret)?.id, user.id);

  // Stored form is the self-describing digest, never the secret itself.
  assert.match(token.hash, /^sha256\$[A-Za-z0-9+/=]+$/);
  const storePath = join(process.env.CODY_ACCOUNTS_DIR, "access-tokens.json");
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  assert.equal(readFileSync(storePath, "utf8").includes(secret), false);

  // Nothing a client can see carries the secret or its digest.
  const listed = tokens.listAccessTokens(user.id).map(tokens.toPublicAccessToken);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["createdAt", "id", "lastUsedAt", "name", "preview"]);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal(listed[0].preview, secret.slice("cody_pat_".length, "cody_pat_".length + 6));

  // A near-miss secret is not a match, and neither is a truncated one.
  assert.equal(tokens.verifyAccessToken(`${secret}x`), null);
  assert.equal(tokens.verifyAccessToken(secret.slice(0, -1)), null);
  assert.equal(tokens.verifyAccessToken("cody_pat_nonsense"), null);
  assert.equal(tokens.verifyAccessToken(null), null);
});

test("revoking a token kills it; other tokens on the account survive", async () => {
  const user = users.findUserByUsername("tokenuser");
  const keep = tokens.issueAccessToken(user, "Keep me");
  const drop = tokens.issueAccessToken(user, "Drop me");
  assert.equal(tokens.verifyAccessToken(drop.secret)?.id, user.id);

  assert.equal(tokens.revokeAccessToken(user.id, drop.token.id), true);
  assert.equal(tokens.verifyAccessToken(drop.secret), null);
  assert.equal(tokens.verifyAccessToken(keep.secret)?.id, user.id);

  // Revoking twice, or revoking someone else's id, reports failure rather than
  // confirming the id exists.
  assert.equal(tokens.revokeAccessToken(user.id, drop.token.id), false);
  const other = users.findUserByUsername("nitin");
  assert.equal(tokens.revokeAccessToken(other.id, keep.token.id), false);
  assert.equal(tokens.verifyAccessToken(keep.secret)?.id, user.id);
});

test("a tokenVersion bump revokes access tokens, exactly like session cookies", async () => {
  const user = users.findUserByUsername("tokenuser");
  const { secret } = tokens.issueAccessToken(user, "Bumped");
  assert.equal(tokens.verifyAccessToken(secret)?.id, user.id);

  // This is what a password change does — every credential issued before it dies.
  users.updateUser(user.id, (record) => { record.tokenVersion += 1; });
  assert.equal(tokens.verifyAccessToken(secret), null);
});

test("a token whose account is gone fails, and is pruned on the next write", async () => {
  const doomed = users.createUser({
    username: "doomed",
    fullName: "Doomed",
    passwordHash: await password.hashPassword("long enough"),
    role: "member",
  });
  const orphan = tokens.issueAccessToken(doomed, "Orphan");
  users.deleteUser(doomed.id);
  assert.equal(tokens.verifyAccessToken(orphan.secret), null, "deleted account cannot authenticate");

  // The store self-heals: the next write drops records with no live account, so
  // deleting an account needs no extra cleanup callsite.
  const survivor = users.findUserByUsername("tokenuser");
  tokens.issueAccessToken(survivor, "Triggers a write");
  const stored = readFileSync(join(process.env.CODY_ACCOUNTS_DIR, "access-tokens.json"), "utf8");
  assert.equal(stored.includes(orphan.token.id), false);
});

test("token names are validated and the per-account count is capped", async () => {
  assert.notEqual(tokens.validateTokenName(""), null);
  assert.notEqual(tokens.validateTokenName("x".repeat(tokens.MAX_TOKEN_NAME_LENGTH + 1)), null);
  assert.notEqual(tokens.validateTokenName("bad\nname"), null);
  assert.equal(tokens.validateTokenName("Pixel tablet"), null);

  const capped = users.createUser({
    username: "capped",
    fullName: "Capped",
    passwordHash: await password.hashPassword("long enough"),
    role: "member",
  });
  for (let index = 0; index < tokens.MAX_TOKENS_PER_USER; index += 1) {
    tokens.issueAccessToken(capped, `Token ${index}`);
  }
  assert.equal(tokens.listAccessTokens(capped.id).length, tokens.MAX_TOKENS_PER_USER);
  assert.throws(() => tokens.issueAccessToken(capped, "One too many"), /revoke one first/);
  users.deleteUser(capped.id);
});

test("Authorization: Bearer is parsed strictly and resolves through the guard", () => {
  const user = users.findUserByUsername("tokenuser");
  const { secret } = tokens.issueAccessToken(user, "Header parsing");

  assert.equal(tokens.bearerTokenFromAuthorizationHeader(`Bearer ${secret}`), secret);
  assert.equal(tokens.bearerTokenFromAuthorizationHeader(`bearer ${secret}`), secret, "scheme is case-insensitive");
  // Anything that is not one of our tokens looks exactly like no credential.
  assert.equal(tokens.bearerTokenFromAuthorizationHeader(`Basic ${secret}`), null);
  assert.equal(tokens.bearerTokenFromAuthorizationHeader("Bearer some.other.jwt"), null);
  assert.equal(tokens.bearerTokenFromAuthorizationHeader(`Bearer cody_pat_${"x".repeat(400)}`), null);
  assert.equal(tokens.bearerTokenFromAuthorizationHeader(null), null);

  // The guard is the single "who is this" answer: the bearer joins the cookie
  // and Basic there, and reports which credential arrived.
  assert.equal(guard.getUserForCredentials(null, `Bearer ${secret}`)?.id, user.id);
  assert.equal(guard.resolveCredentials(null, `Bearer ${secret}`)?.kind, "bearer");

  // A cookie still wins when both are present, and still works alone.
  const cookieUser = users.findUserByUsername("nitin");
  const cookie = `${session.SESSION_COOKIE_NAME}=${session.issueSessionToken(cookieUser)}`;
  assert.equal(guard.resolveCredentials(cookie, null)?.kind, "cookie");
  const both = guard.resolveCredentials(cookie, `Bearer ${secret}`);
  assert.equal(both?.kind, "cookie");
  assert.equal(both?.user.id, cookieUser.id);
});

test("perimeter: bearer passes, missing credentials 401 the API and redirect HTML", async () => {
  // next/server has no ESM export condition Node can resolve on its own; jiti
  // applies the same resolution the app gets.
  const { NextRequest } = await jiti.import("next/server");
  const { proxy } = await jiti.import("../../proxy.ts");
  const user = users.findUserByUsername("tokenuser");
  const { secret, token } = tokens.issueAccessToken(user, "Perimeter");
  const authorized = { headers: { authorization: `Bearer ${secret}` } };

  assert.equal(guard.isAuthRequired(), true, "accounts exist, so the perimeter is armed");

  // A bearer request is let through untouched — no redirect, no 401.
  const allowed = proxy(new NextRequest("http://localhost:3000/api/info", authorized));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("location"), null);

  // No credential: API routes answer 401 JSON, and deliberately no
  // WWW-Authenticate, which would summon the browser's Basic dialog.
  const denied = proxy(new NextRequest("http://localhost:3000/api/info"));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("www-authenticate"), null);
  assert.deepEqual(await denied.json(), { error: "Authentication required", code: "auth_required" });

  // HTML keeps redirecting to the login screen with a next= hint.
  const redirected = proxy(new NextRequest("http://localhost:3000/settings"));
  assert.equal(redirected.status, 307);
  const location = new URL(redirected.headers.get("location"));
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/settings");

  // Revocation reaches the perimeter, not just the token store.
  assert.equal(tokens.revokeAccessToken(user.id, token.id), true);
  assert.equal(proxy(new NextRequest("http://localhost:3000/api/info", authorized)).status, 401);

  // The login screen itself stays reachable unauthenticated, or a locked
  // instance would have no way in.
  assert.equal(proxy(new NextRequest("http://localhost:3000/login")).status, 200);
});
