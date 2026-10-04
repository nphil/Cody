import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The settings store is the one place a person's ntfy address and access token
 * are written, so these pin what it accepts, what it refuses, what a hand-edited
 * file degrades to, and that the token never leaves in the public shape.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-store-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./store.ts");
const catalog = await jiti.import("./catalog.ts");
const users = await jiti.import("../auth/users.ts");
const paths = await jiti.import("../auth/paths.ts");

const file = () => paths.getNotificationsPath();
const reset = () => {
  rmSync(file(), { force: true });
  mkdirSync(join(root, "accounts"), { recursive: true });
};
const saved = () => JSON.parse(readFileSync(file(), "utf8"));

test("nothing saved reads as the defaults, switched off", () => {
  reset();
  const prefs = store.readNotificationPrefs("anyone");
  assert.deepEqual(prefs, catalog.defaultNotificationPrefs());
  assert.equal(prefs.enabled, false);
  assert.equal(store.isConfigured(prefs), false);
});

test("a hand-edited file degrades value by value: unknown keys go, invalid values fall back, valid ones stay", () => {
  reset();
  const defaults = catalog.defaultNotificationPrefs();
  writeFileSync(file(), JSON.stringify({
    version: 1,
    accounts: {
      u1: {
        enabled: "yes",
        server: "ftp://nope",
        topic: "bad topic!",
        token: 5,
        codyUrl: "https://cody.example.net/?x=1",
        answerButtons: 1,
        finishedMinSeconds: -1,
        quotaLowPercent: 100,
        extra: "dropped",
        events: { approval: { enabled: "no", priority: 9 }, bogus: { enabled: true }, error: { priority: 5 } },
      },
      u2: { topic: "ok_topic", finishedMinSeconds: 30, server: "https://ntfy.example.com/", events: { waiting: { enabled: false } } },
      u3: "not a record",
    },
    instance: { topic: "inst" },
  }));
  // Every value in u1 is invalid except one event priority.
  const expectedU1 = { ...defaults, events: { ...defaults.events, error: { ...defaults.events.error, priority: 5 } } };
  assert.deepEqual(store.readNotificationPrefs("u1"), expectedU1);
  const u2 = store.readNotificationPrefs("u2");
  assert.equal(u2.topic, "ok_topic");
  assert.equal(u2.finishedMinSeconds, 30);
  assert.equal(u2.server, "https://ntfy.example.com", "normalized on read too");
  assert.equal(u2.events.waiting.enabled, false);
  assert.equal(u2.events.waiting.priority, defaults.events.waiting.priority);
  assert.deepEqual(store.readNotificationPrefs("u3"), defaults);
  assert.equal(store.readNotificationPrefs("__instance").topic, "inst");
  assert.equal("extra" in store.readNotificationPrefs("u1"), false);
});

test("an unreadable file is the defaults, not an error", () => {
  reset();
  writeFileSync(file(), "{ this is not json");
  assert.deepEqual(store.readNotificationPrefs("u1"), catalog.defaultNotificationPrefs());
  writeFileSync(file(), "[1,2,3]");
  assert.deepEqual(store.readNotificationPrefs("u1"), catalog.defaultNotificationPrefs());
});

const INVALID = [
  [{ server: "ftp://ntfy.example.com" }, /http\(s\)/],
  [{ server: "https://user:pass@ntfy.example.com" }, /username/],
  [{ server: "https://ntfy.example.com/?auth=1" }, /query/],
  [{ server: "https://ntfy.example.com/?" }, /query/],
  [{ server: "https://ntfy.example.com/#frag" }, /fragment/],
  [{ server: "not a url" }, /http\(s\)/],
  [{ server: 5 }, /http\(s\)/],
  [{ codyUrl: "javascript:alert(1)" }, /Cody address/],
  [{ codyUrl: "https://u@cody.example.net" }, /Cody address/],
  [{ topic: "has space" }, /topic/i],
  [{ topic: "x".repeat(65) }, /topic/i],
  [{ topic: "slash/inside" }, /topic/i],
  [{ topic: 7 }, /topic/i],
  [{ finishedMinSeconds: -1 }, /finishedMinSeconds/],
  [{ finishedMinSeconds: 86_401 }, /finishedMinSeconds/],
  [{ finishedMinSeconds: 1.5 }, /finishedMinSeconds/],
  [{ finishedMinSeconds: "60" }, /finishedMinSeconds/],
  [{ quotaLowPercent: 0 }, /quotaLowPercent/],
  [{ quotaLowPercent: 100 }, /quotaLowPercent/],
  [{ quotaLowPercent: 90.5 }, /quotaLowPercent/],
  [{ token: "a".repeat(513) }, /access token/i],
  [{ token: "has a space" }, /access token/i],
  [{ token: "tk_\nnewline" }, /access token/i],
  [{ token: 5 }, /access token/i],
  [{ enabled: "true" }, /enabled/],
  [{ answerButtons: 1 }, /answerButtons/],
  [{ skipWhenViewing: "no" }, /skipWhenViewing/],
  [{ events: [] }, /events/],
  [{ events: { bogus: { enabled: true } } }, /Unknown notification kind/],
  [{ events: { approval: [] } }, /approval/],
  [{ events: { approval: { priority: 0 } } }, /priority/],
  [{ events: { approval: { priority: 6 } } }, /priority/],
  [{ events: { approval: { priority: 3.5 } } }, /priority/],
  [{ events: { approval: { enabled: "yes" } } }, /enabled/],
  [{ events: { approval: { color: "red" } } }, /Unknown setting/],
  [{ nonsense: true }, /Unknown setting/],
  [[], /object/],
  ["settings", /object/],
  [null, /object/],
];

test("every invalid write is refused with the invalid_notification_settings code, and nothing is saved", () => {
  reset();
  store.updateNotificationPrefs("u1", { topic: "baseline" });
  const before = readFileSync(file(), "utf8");
  for (const [patch, message] of INVALID) {
    assert.throws(
      () => store.updateNotificationPrefs("u1", patch),
      (error) => error instanceof store.InvalidNotificationSettingsError && error.code === "invalid_notification_settings" && message.test(error.message),
      `refused: ${JSON.stringify(patch)}`,
    );
  }
  assert.equal(readFileSync(file(), "utf8"), before, "the file is untouched by every refused write");
});

test("a write is validated whole: one bad field saves none of the good ones", () => {
  reset();
  assert.throws(() => store.updateNotificationPrefs("u1", { topic: "fine", quotaLowPercent: 500 }), store.InvalidNotificationSettingsError);
  assert.equal(existsSync(file()), false);
  assert.equal(store.readNotificationPrefs("u1").topic, "");
});

test("addresses are stored normalized: lowercase host, no default port, no trailing slash, a path prefix kept", () => {
  reset();
  const prefs = store.updateNotificationPrefs("u1", {
    server: "  HTTPS://Ntfy.Example.COM:443/  ",
    codyUrl: "http://cody.lan:3000/",
  });
  assert.equal(prefs.server, "https://ntfy.example.com");
  assert.equal(prefs.codyUrl, "http://cody.lan:3000");
  assert.equal(store.updateNotificationPrefs("u1", { server: "https://proxy.example.com/ntfy///" }).server, "https://proxy.example.com/ntfy");
  assert.equal(store.updateNotificationPrefs("u1", { server: "", codyUrl: "" }).server, "", "empty clears");
  assert.equal(store.normalizeBaseUrl("https://x.example.com/a b"), null, "inner whitespace is refused");
});

test("a patch merges: scalars replace, events merge per kind and per field, the token follows its own rule", () => {
  reset();
  const first = store.updateNotificationPrefs("u1", {
    enabled: true,
    server: "https://ntfy.example.com",
    topic: "mytopic",
    token: "tk_secret",
    events: { approval: { priority: 5 }, finished: { enabled: false } },
  });
  assert.equal(first.events.approval.priority, 5);
  assert.equal(first.events.approval.enabled, true, "an unmentioned field of a mentioned kind keeps its value");
  assert.equal(first.events.finished.enabled, false);
  assert.equal(first.events.finished.priority, catalog.defaultNotificationPrefs().events.finished.priority);
  assert.equal(first.events.question.priority, catalog.defaultNotificationPrefs().events.question.priority, "an unmentioned kind is untouched");

  // The token: absent keeps, a string replaces, null clears, "" clears.
  assert.equal(store.updateNotificationPrefs("u1", { topic: "other" }).token, "tk_secret");
  assert.equal(store.updateNotificationPrefs("u1", { token: "tk_new" }).token, "tk_new");
  assert.equal(store.updateNotificationPrefs("u1", { token: null }).token, "");
  assert.equal(store.updateNotificationPrefs("u1", { token: "tk_again" }).token, "tk_again");
  assert.equal(store.updateNotificationPrefs("u1", { token: "" }).token, "");
  assert.equal(store.readNotificationPrefs("u1").topic, "other", "and it is what a later read returns");
});

test("the public shape never carries the token, only whether there is one", () => {
  reset();
  store.updateNotificationPrefs("u1", { token: "tk_super_secret_value", topic: "t" });
  const prefs = store.readNotificationPrefs("u1");
  const publicPrefs = store.toPublicPrefs(prefs);
  assert.equal(publicPrefs.hasToken, true);
  assert.equal("token" in publicPrefs, false);
  assert.equal(JSON.stringify(publicPrefs).includes("tk_super_secret_value"), false);
  assert.equal(store.toPublicPrefs(catalog.defaultNotificationPrefs()).hasToken, false);
  // The public copy shares nothing mutable with the stored record.
  publicPrefs.events.approval.enabled = false;
  assert.equal(prefs.events.approval.enabled, true);
});

test("a client that echoes the whole public shape back is not refused, and hasToken is never stored", () => {
  reset();
  store.updateNotificationPrefs("u1", { token: "tk_keep", topic: "t" });
  const echoed = store.toPublicPrefs(store.readNotificationPrefs("u1"));
  const saved2 = store.updateNotificationPrefs("u1", { ...echoed, quotaLowPercent: 80 });
  assert.equal(saved2.quotaLowPercent, 80);
  assert.equal(saved2.token, "tk_keep", "an echo carries no token, so the stored one is kept");
  assert.equal("hasToken" in saved().accounts.u1, false);
});

test("the open instance has its own record, apart from every account", () => {
  reset();
  store.updateNotificationPrefs(store.INSTANCE_RECIPIENT_KEY, { topic: "instance_topic" });
  store.updateNotificationPrefs("u1", { topic: "account_topic" });
  assert.equal(store.readNotificationPrefs(store.INSTANCE_RECIPIENT_KEY).topic, "instance_topic");
  assert.equal(store.readNotificationPrefs("u1").topic, "account_topic");
  assert.equal(store.recipientKeyFor(null), "__instance");
  assert.equal(store.recipientKeyFor({ id: "abc" }), "abc");
});

test("configured means switched on AND told where to publish", () => {
  const base = catalog.defaultNotificationPrefs();
  assert.equal(store.isConfigured({ ...base, enabled: true, server: "https://n.example.com", topic: "t" }), true);
  assert.equal(store.isConfigured({ ...base, enabled: false, server: "https://n.example.com", topic: "t" }), false);
  assert.equal(store.isConfigured({ ...base, enabled: true, server: "", topic: "t" }), false);
  assert.equal(store.isConfigured({ ...base, enabled: true, server: "https://n.example.com", topic: "" }), false);
});

test("the file is private and written whole: 0600, no temp file left behind", () => {
  reset();
  store.updateNotificationPrefs("u1", { topic: "t", token: "tk_x" });
  assert.equal(statSync(file()).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(root, "accounts")).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(saved().version, 1);
});

test("a deleted account's settings, token included, go with it the next time anyone saves", () => {
  reset();
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
  store.updateNotificationPrefs(alice.id, { token: "tk_alice", topic: "alice_t" });
  store.updateNotificationPrefs(bob.id, { token: "tk_bob", topic: "bob_t" });
  users.deleteUser(bob.id);
  store.updateNotificationPrefs(alice.id, { topic: "alice_t2" });
  const accounts = saved().accounts;
  assert.deepEqual(Object.keys(accounts), [alice.id]);
  assert.equal(readFileSync(file(), "utf8").includes("tk_bob"), false, "the deleted person's token is not left on disk");
});

test("settings are not pruned while the account store reads as empty", () => {
  // An accounts file that was lost must not take every saved setting with it.
  reset();
  rmSync(paths.getAccountsFilePath(), { force: true });
  assert.equal(users.listUsers().length, 0);
  store.updateNotificationPrefs("ghost", { topic: "kept" });
  store.updateNotificationPrefs("__instance", { topic: "also_kept" });
  assert.equal(store.readNotificationPrefs("ghost").topic, "kept");
  assert.equal(store.readNotificationPrefs("__instance").topic, "also_kept");
});
