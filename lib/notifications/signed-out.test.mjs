import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * "Account signed out": a provider login that ended is pushed to the phone,
 * once. The incident it exists for: Anthropic refused to renew a Claude login
 * for good, omp disabled the credential and wrote why, and the owner saw a red
 * "Disabled" chip, took it for quota and waited two days.
 *
 * The pure part first (which stored accounts count, and what each message
 * says), then the watcher end to end with injected collaborators: once per
 * credential, retried when delivery failed, forgotten when the login is no
 * longer ended — and never forgotten because the store could not be read.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-signed-out-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const signedOut = await jiti.import("./signed-out.ts");
const quota = await jiti.import("./quota-watch.ts");
const catalog = await jiti.import("./catalog.ts");
const store = await jiti.import("./store.ts");
const paths = await jiti.import("../auth/paths.ts");

/** What omp wrote into `disabled_cause` in the real incident of 2026-11-10, verbatim. */
const INCIDENT_CAUSE = 'oauth refresh failed: OAuthError: anthropic token refresh failed: 400 {"type":"error","error":{"type":"invalid_grant","message":"Refresh token expired"}}';

const NOW = Date.parse("2026-11-12T09:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
const RESET = NOW + 3 * HOUR + 7 * MINUTE;

/** One stored credential row, as omp's credential store lists it. */
const cred = (id, provider, disabledCause = null, extra = {}) => ({
  id,
  provider,
  type: "oauth",
  identity: `person${id}@private.example.com`,
  planType: "max",
  disabledCause,
  blockedUntil: null,
  pinHash: null,
  ...extra,
});

const describeFor = (rows, credentialId) =>
  signedOut.describeSignedOut(signedOut.evaluateSignedOut(rows).find((alert) => alert.credentialId === credentialId));

// ---------------------------------------------------------------------------
// Which accounts count
// ---------------------------------------------------------------------------

test("the real incident's cause is an ended login; a healthy row and a deliberate logout are not", () => {
  const alerts = signedOut.evaluateSignedOut([
    cred(1, "anthropic", INCIDENT_CAUSE),
    cred(2, "anthropic", null),
    cred(3, "openai-codex", "logged out by user"),
    cred(4, "github-copilot", null),
  ]);
  assert.deepEqual(alerts.map((alert) => [alert.provider, alert.credentialId]), [["anthropic", 1]]);
});

test("whatever the credential's type, the cause is what says its login is over", () => {
  const alerts = signedOut.evaluateSignedOut([cred(5, "openai", "invalid_token", { type: "api_key" })]);
  assert.deepEqual(alerts.map((alert) => alert.credentialId), [5]);
});

test("position is the place among the provider's stored rows — disabled ones too — and starts over for each provider", () => {
  const alerts = signedOut.evaluateSignedOut([
    cred(1, "anthropic", "logged out by user"), // not an ended login, but still the first of Claude's three
    cred(2, "openai-codex", null),
    cred(3, "anthropic", INCIDENT_CAUSE),
    cred(4, "anthropic", null),
    cred(5, "openai-codex", INCIDENT_CAUSE),
  ]);
  assert.deepEqual(
    alerts.map((alert) => [alert.credentialId, alert.position, alert.providerAccounts]),
    [[3, 1, 3], [5, 1, 2]],
  );
});

test("another account of the same provider is a way out only if it is not disabled itself", () => {
  const usable = (rows) => signedOut.evaluateSignedOut(rows).map((alert) => alert.otherUsable);
  assert.deepEqual(usable([cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "anthropic", null)]), [true]);
  assert.deepEqual(usable([cred(1, "anthropic", INCIDENT_CAUSE)]), [false], "alone");
  assert.deepEqual(usable([cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "anthropic", INCIDENT_CAUSE)]), [false, false], "every account lost its login");
  assert.deepEqual(usable([cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "anthropic", "logged out by user")]), [false], "a logged-out sibling is no way out either");
  assert.deepEqual(usable([cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "openai-codex", null)]), [false], "another provider's account does not stand in");
});

test("the cause is kept only as a hash: it can carry provider detail", () => {
  const [alert] = signedOut.evaluateSignedOut([cred(7, "anthropic", INCIDENT_CAUSE)]);
  assert.equal(alert.causeFingerprint, createHash("sha256").update(INCIDENT_CAUSE).digest("hex"));
  const text = JSON.stringify(alert);
  assert.equal(text.includes("Refresh token expired"), false);
  assert.equal(text.includes("private.example.com"), false, "nor who the account was");
  assert.notEqual(signedOut.evaluateSignedOut([cred(7, "anthropic", "invalid_grant")])[0].causeFingerprint, alert.causeFingerprint);
});

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

test("with another account to carry on with, the message names the account and says Cody is using the others", () => {
  assert.deepEqual(describeFor([cred(1, "anthropic", null), cred(2, "anthropic", INCIDENT_CAUSE)], 2), {
    title: "Claude · Secondary was signed out",
    body: "Its login expired, so Cody is using your other accounts. Sign in again: Settings › Providers.",
  });
});

test("with no account left, the message says Cody cannot use it; a provider with one account is named alone", () => {
  assert.deepEqual(describeFor([cred(1, "anthropic", INCIDENT_CAUSE)], 1), {
    title: "Claude was signed out",
    body: "Its login expired, so Cody cannot use it. Sign in again: Settings › Providers.",
  });
  const both = [cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "anthropic", INCIDENT_CAUSE)];
  assert.deepEqual(describeFor(both, 1), {
    title: "Claude · Primary was signed out",
    body: "Its login expired, so Cody cannot use it. Sign in again: Settings › Providers.",
  });
});

test("accounts are Primary, Secondary, Account 3 …: by place, never by email or id", () => {
  const rows = [4242, 4243, 4244, 4245].map((id) => cred(id, "anthropic", INCIDENT_CAUSE));
  const said = signedOut.evaluateSignedOut(rows).map((alert) => signedOut.describeSignedOut(alert));
  assert.deepEqual(said.map((entry) => entry.title), [
    "Claude · Primary was signed out",
    "Claude · Secondary was signed out",
    "Claude · Account 3 was signed out",
    "Claude · Account 4 was signed out",
  ]);
  const text = JSON.stringify(said);
  for (const private_ of ["private.example.com", "person4242", "4242", "invalid_grant", "Refresh token expired"]) {
    assert.equal(text.includes(private_), false, `no "${private_}"`);
  }
});

test("a provider is named as the owner knows it, or by a tidy version of its id", () => {
  const titleFor = (provider) => describeFor([cred(1, provider, INCIDENT_CAUSE)], 1).title;
  assert.equal(titleFor("anthropic"), "Claude was signed out");
  assert.equal(titleFor("openai-codex"), "Codex was signed out");
  assert.equal(titleFor("github-copilot"), "Copilot was signed out");
  assert.equal(titleFor("my-custom_provider"), "My Custom Provider was signed out");
});

test("a signed-out account's fingerprint is hashed, stable, and moves with the credential, the provider or the cause", () => {
  const fingerprint = (rows) => signedOut.signedOutFingerprint(signedOut.evaluateSignedOut(rows)[0]);
  const base = fingerprint([cred(7, "anthropic", INCIDENT_CAUSE)]);
  assert.match(base, /^so-[0-9a-f]{24}$/);
  assert.equal(base.includes("anthropic"), false);
  assert.equal(fingerprint([cred(7, "anthropic", INCIDENT_CAUSE, { identity: "someone.else@example.org" })]), base, "who it was does not matter");
  assert.equal(fingerprint([cred(6, "anthropic", null), cred(7, "anthropic", INCIDENT_CAUSE), cred(8, "anthropic", null)]), base, "nor do its siblings, nor its place among them");
  assert.notEqual(fingerprint([cred(8, "anthropic", INCIDENT_CAUSE)]), base, "another credential");
  assert.notEqual(fingerprint([cred(7, "openai-codex", INCIDENT_CAUSE)]), base, "another provider");
  assert.notEqual(fingerprint([cred(7, "anthropic", "invalid_grant")]), base, "another cause");
});

// ---------------------------------------------------------------------------
// Reading and announcing
// ---------------------------------------------------------------------------

const prefs = (patch = {}) => {
  const base = catalog.defaultNotificationPrefs();
  return { ...base, enabled: true, server: "https://ntfy.test", topic: "t", codyUrl: "https://cody.test", ...patch, events: { ...base.events, ...patch.events } };
};
const recipient = (key, patch) => ({ key, user: null, prefs: prefs(patch) });

const emptyUsage = { available: true, accounts: [], fetchedAt: iso(NOW), stale: false };
const lowUsage = {
  available: true,
  accounts: [{
    provider: "anthropic",
    id: "a1",
    identity: "a1@private.example.com",
    credentialId: null,
    label: "anthropic (a1@private.example.com)",
    planType: null,
    unlimited: false,
    windows: [{ id: "5h", label: "5-hour window", utilization: 95, resetsAt: iso(RESET), state: "ok" }],
  }],
  fetchedAt: iso(NOW),
  stale: false,
};
const QUOTA_OFF = { quotaLow: { enabled: false, priority: 3 }, quotaOut: { enabled: false, priority: 4 } };

/** A watcher whose world is `r.world`: change it between checks to play out what happens to the accounts. */
function rig({ credentials = [], usage = emptyUsage, recipients = [recipient("u1")], publishResult = () => ({ ok: true }), installed = true } = {}) {
  const published = [];
  const reads = { credentials: 0, usage: 0 };
  const world = { now: NOW, available: true, credentials, usage };
  const deps = {
    now: () => world.now,
    readerInstalled: () => installed,
    readUsage: async () => { reads.usage += 1; return world.usage; },
    listCredentials: async () => { reads.credentials += 1; return { available: world.available, credentials: world.credentials }; },
    recipients: () => recipients,
    publish: async (target, message) => {
      published.push({ target, message });
      return publishResult(published.length);
    },
  };
  return { deps, published, reads, world };
}

const statePath = () => paths.getNotificationsStatePath();
const resetMemory = () => rmSync(statePath(), { force: true });
/** What the watcher remembers, per recipient; nothing at all before it has remembered anything. */
const memory = () => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")).recipients : {});

async function warnings(body) {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    await body();
  } finally {
    console.warn = warn;
  }
  return lines;
}

test("an ended login is announced once, with the priority, tag and link the owner configured", async () => {
  resetMemory();
  const r = rig({
    credentials: [cred(1, "anthropic", null), cred(2, "anthropic", INCIDENT_CAUSE)],
    recipients: [recipient("announce", { events: { accountSignedOut: { enabled: true, priority: 5 } } })],
  });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.equal(r.published.length, 1);
  const { target, message } = r.published[0];
  assert.deepEqual(target, { server: "https://ntfy.test", topic: "t", token: "" });
  assert.equal(message.title, "Claude · Secondary was signed out");
  assert.equal(message.message, "Its login expired, so Cody is using your other accounts. Sign in again: Settings › Providers.");
  assert.equal(message.priority, 5);
  assert.deepEqual(message.tags, ["key"]);
  assert.equal(message.click, "https://cody.test/?settings=providers");
  assert.equal(message.sequenceId, undefined);

  assert.equal(await quota.runQuotaCheck(r.deps), 0, "the next check has nothing new to say");
  assert.equal(r.published.length, 1);
});

test("every ended login gets its own message; a deliberate logout gets none", async () => {
  resetMemory();
  const r = rig({
    credentials: [
      cred(1, "anthropic", INCIDENT_CAUSE),
      cred(2, "anthropic", INCIDENT_CAUSE),
      cred(3, "openai-codex", "invalid_grant"),
      cred(4, "github-copilot", "logged out by user"),
    ],
    recipients: [recipient("several")],
  });
  assert.equal(await quota.runQuotaCheck(r.deps), 3);
  assert.deepEqual(r.published.map((entry) => entry.message.title), [
    "Claude · Primary was signed out",
    "Claude · Secondary was signed out",
    "Codex was signed out",
  ]);
  assert.equal(Object.keys(memory().several).length, 3);
});

test("a person with no Cody address gets the message without a link", async () => {
  resetMemory();
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("no-link", { codyUrl: "" })] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.equal("click" in r.published[0].message, false);
});

test("what was announced is remembered as a private hash that does not expire", async () => {
  resetMemory();
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("remembered")] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  const text = readFileSync(statePath(), "utf8");
  assert.equal(statSync(statePath()).mode & 0o777, 0o600);
  for (const secret of ["private.example.com", "Refresh token expired", "invalid_grant", "anthropic"]) {
    assert.equal(text.includes(secret), false, `no "${secret}" on disk`);
  }
  const entries = Object.entries(memory().remembered);
  assert.equal(entries.length, 1);
  assert.match(entries[0][0], /^so-[0-9a-f]{24}$/);
  assert.equal(entries[0][1], Number.MAX_SAFE_INTEGER);

  // A year on, the same login is the same old news: the ordinary expiry pruning leaves it alone.
  r.world.now = NOW + 365 * 24 * HOUR;
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(Object.keys(memory().remembered).length, 1);
});

test("a message that could not be delivered is not remembered, so the next check tries again", async () => {
  resetMemory();
  const r = rig({
    credentials: [cred(1, "anthropic", INCIDENT_CAUSE)],
    recipients: [recipient("signed-out-retry")],
    publishResult: (attempt) => (attempt === 1 ? { ok: false, error: "forbidden", status: 403 } : { ok: true }),
  });
  const lines = await warnings(async () => {
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
    assert.equal(memory()["signed-out-retry"], undefined);
    assert.equal(await quota.runQuotaCheck(r.deps), 1, "the second check delivers it");
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
  });
  assert.equal(r.published.length, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /publish failed for ntfy\.test: forbidden \(HTTP 403\)/);
});

test("a login that is no longer ended is forgotten — but never because the store could not be read", async () => {
  resetMemory();
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "anthropic", null)], recipients: [recipient("prune")] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.equal(Object.keys(memory().prune).length, 1);

  // The store cannot be read: it lists nothing, and that says nothing about who is signed out.
  r.world.available = false;
  r.world.credentials = [];
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(Object.keys(memory().prune).length, 1, "nothing was forgotten");

  // Readable again, and the same login is still ended: not news.
  r.world.available = true;
  r.world.credentials = [cred(1, "anthropic", INCIDENT_CAUSE), cred(2, "anthropic", null)];
  assert.equal(await quota.runQuotaCheck(r.deps), 0, "no repeat after the outage");
  assert.equal(r.published.length, 1);

  // The owner signed in again: omp removes the stale row, and the memory of it goes with it.
  r.world.credentials = [cred(2, "anthropic", null)];
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(memory().prune, undefined, "forgotten, and so is a person left with nothing");
});

test("a later expiry is news again: a new credential, or a row that ended for another reason, or one re-enabled and ended again", async () => {
  resetMemory();
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("again")] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);

  // Signed in again (a new row), and a month later that one ends too.
  r.world.credentials = [cred(2, "anthropic", INCIDENT_CAUSE)];
  assert.equal(await quota.runQuotaCheck(r.deps), 1, "a new credential id is a new login");
  assert.equal(Object.keys(memory().again).length, 1, "the old one is forgotten on the way");

  r.world.credentials = [cred(2, "anthropic", "invalid_grant")];
  assert.equal(await quota.runQuotaCheck(r.deps), 1, "the same row ended for another reason");
  assert.equal(Object.keys(memory().again).length, 1);

  r.world.credentials = [cred(2, "anthropic", null)];
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(memory().again, undefined, "re-enabled: nothing is ended, nothing is remembered");
  r.world.credentials = [cred(2, "anthropic", "invalid_grant")];
  assert.equal(await quota.runQuotaCheck(r.deps), 1, "and ended again");
  assert.equal(r.published.length, 4);
});

test("each person is remembered separately; one who switched the kind off hears nothing, and nothing old when it goes back on", async () => {
  resetMemory();
  const alice = recipient("alice", { topic: "alice_t" });
  const bob = recipient("bob", { topic: "bob_t", events: { accountSignedOut: { enabled: false, priority: 4 } } });
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [alice, bob] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.deepEqual(r.published.map((entry) => entry.target.topic), ["alice_t"]);

  bob.prefs.events.accountSignedOut.enabled = true;
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.deepEqual(r.published.map((entry) => entry.target.topic), ["alice_t", "bob_t"]);

  bob.prefs.events.accountSignedOut.enabled = false;
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(Object.keys(memory().bob).length, 1, "switching the kind off forgets nothing: the login is still ended");
  bob.prefs.events.accountSignedOut.enabled = true;
  assert.equal(await quota.runQuotaCheck(r.deps), 0, "switching it back on is no reason to say it again");
});

test("one person's failed delivery does not stop the next, and only theirs is tried again", async () => {
  resetMemory();
  const carol = recipient("carol", { topic: "carol_t" });
  const dave = recipient("dave", { topic: "dave_t" });
  const r = rig({
    credentials: [cred(1, "anthropic", INCIDENT_CAUSE)],
    recipients: [carol, dave],
    publishResult: (attempt) => (attempt === 1 ? { ok: false, error: "forbidden", status: 403 } : { ok: true }),
  });
  await warnings(async () => {
    assert.equal(await quota.runQuotaCheck(r.deps), 1, "Dave heard it although Carol's server refused");
    assert.deepEqual(r.published.map((entry) => entry.target.topic), ["carol_t", "dave_t"]);
    assert.equal(await quota.runQuotaCheck(r.deps), 1);
    assert.deepEqual(r.published.map((entry) => entry.target.topic), ["carol_t", "dave_t", "carol_t"], "only Carol is tried again");
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
  });
});

test("an ended login is announced even when every quota notification is off, and no usage is read for it", async () => {
  resetMemory();
  const r = rig({
    credentials: [cred(1, "anthropic", INCIDENT_CAUSE)],
    usage: lowUsage,
    recipients: [recipient("quota-off", { events: QUOTA_OFF })],
  });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.deepEqual(r.published.map((entry) => entry.message.title), ["Claude was signed out"]);
  assert.equal(r.reads.usage, 0);
});

test("nothing is read unless omp is installed AND someone wants to hear about an ended login", async () => {
  resetMemory();
  const noOmp = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], installed: false });
  assert.equal(await quota.runQuotaCheck(noOmp.deps), 0);
  assert.equal(noOmp.reads.credentials, 0, "no omp, no credential read");

  for (const unwanted of [
    recipient("off", { enabled: false }),
    recipient("no-topic", { topic: "" }),
    recipient("no-server", { server: "" }),
    recipient("kind-off", { events: { accountSignedOut: { enabled: false, priority: 4 } } }),
  ]) {
    const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [unwanted] });
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
    assert.equal(r.reads.credentials, 0, `${unwanted.key}: nobody wants it, so the credential store is not read`);
    assert.equal(r.published.length, 0);
  }
  assert.deepEqual(memory(), {}, "and nothing was remembered");
});

test("a quota window's memory and an ended login's live side by side; neither pass prunes the other's", async () => {
  resetMemory();
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], usage: lowUsage, recipients: [recipient("both")] });
  assert.equal(await quota.runQuotaCheck(r.deps), 2);
  assert.deepEqual(r.published.map((entry) => entry.message.title), ["Claude was signed out", "Quota running low · Claude"], "logins first");
  const entries = Object.entries(memory().both);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.filter(([key]) => !key.startsWith("so-")).map(([, until]) => until), [RESET], "the window is remembered until it resets");

  // The window resets and the next reading no longer has it; the account is still signed out.
  r.world.now = RESET + MINUTE;
  r.world.usage = emptyUsage;
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.deepEqual(Object.keys(memory().both).map((key) => key.startsWith("so-")), [true], "the window's memory went with its reset; the account's stayed");

  // Signed in again: nothing of either is left.
  r.world.credentials = [];
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(memory().both, undefined);
});

test("each stage answers for its own failure, and a check never raises", async () => {
  resetMemory();
  const sentTitles = (r) => r.published.map((entry) => entry.message.title);

  const brokenLogins = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], usage: lowUsage, recipients: [recipient("stage-a")] });
  brokenLogins.deps.listCredentials = async () => { throw new Error("helper exploded"); };
  let sent;
  let lines = await warnings(async () => { sent = await quota.runQuotaCheck(brokenLogins.deps); });
  assert.equal(sent, 1, "quota still went out");
  assert.deepEqual(sentTitles(brokenLogins), ["Quota running low · Claude"]);
  assert.deepEqual(lines, ["[notifications] signed-out check failed: helper exploded"]);

  const brokenUsage = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], usage: lowUsage, recipients: [recipient("stage-b")] });
  brokenUsage.deps.readUsage = async () => { throw new Error("spawn exploded"); };
  lines = await warnings(async () => { sent = await quota.runQuotaCheck(brokenUsage.deps); });
  assert.equal(sent, 1, "the login announced before usage failed still counts");
  assert.deepEqual(sentTitles(brokenUsage), ["Claude was signed out"]);
  assert.deepEqual(lines, ["[notifications] quota check failed: spawn exploded"]);
  assert.equal(Object.keys(memory()["stage-b"]).length, 1, "and it is remembered");

  const brokenBoth = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], usage: lowUsage, recipients: [recipient("stage-ab")] });
  brokenBoth.deps.listCredentials = async () => { throw new Error("one"); };
  brokenBoth.deps.readUsage = async () => { throw new Error("two"); };
  lines = await warnings(async () => { sent = await quota.runQuotaCheck(brokenBoth.deps); });
  assert.equal(sent, 0);
  assert.deepEqual(lines, ["[notifications] signed-out check failed: one", "[notifications] quota check failed: two"]);
});

test("two checks asked for at once are one", async () => {
  resetMemory();
  const r = rig({ credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("single-flight")] });
  const [a, b] = await Promise.all([quota.runQuotaCheck(r.deps), quota.runQuotaCheck(r.deps)]);
  assert.equal(r.reads.credentials, 1);
  assert.equal(r.published.length, 1);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// When it looks
// ---------------------------------------------------------------------------

function timedRig(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  quota.stopQuotaWatch();
  globalThis.__codyQuotaWatch.lastReadAt = 0;
  resetMemory();
  return rig(options);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Hold the credential read until `release()`, so a check can be caught half-way. */
function holdCredentials(r) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = r.deps.listCredentials;
  r.deps.listCredentials = async () => { await gate; return read(); };
  return release;
}

test("shortly after start the watcher looks at logins once — and reads no usage", async (t) => {
  const r = timedRig(t, { credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("boot")] });
  quota.startQuotaWatch(r.deps);
  quota.startQuotaWatch(r.deps);
  t.mock.timers.tick(quota.SIGNED_OUT_BOOT_DELAY_MS - 1);
  await flush();
  assert.equal(r.reads.credentials, 0, "not at once: starting is busy");
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(r.published.map((entry) => entry.message.title), ["Claude was signed out"]);
  assert.equal(r.reads.usage, 0, "quota is read after a chat's run, not at start");

  t.mock.timers.tick(5 * MINUTE);
  await flush();
  assert.equal(r.reads.credentials, 1, "one check, not a schedule");
  quota.stopQuotaWatch();
});

test("stopping the watcher before the delay is over cancels the check", async (t) => {
  const r = timedRig(t, { credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("boot-stopped")] });
  quota.startQuotaWatch(r.deps);
  quota.stopQuotaWatch();
  t.mock.timers.tick(10 * MINUTE);
  await flush();
  assert.equal(r.reads.credentials, 0);
  assert.equal(r.published.length, 0);
  assert.equal(globalThis.__codyQuotaWatch.boot, undefined);
});

test("a full check asked for while the start-up check is under way waits for it, then reads usage as asked", async (t) => {
  const r = timedRig(t, { recipients: [recipient("queued")] });
  const release = holdCredentials(r);
  quota.startQuotaWatch(r.deps);
  t.mock.timers.tick(quota.SIGNED_OUT_BOOT_DELAY_MS);
  await flush();
  const full = quota.runQuotaCheck(r.deps);
  await flush();
  assert.equal(r.reads.usage, 0, "the start-up check is still looking at logins; the full check queues behind it");
  release();
  await full;
  assert.equal(r.reads.usage, 1, "then it reads usage, as it was asked to");
  quota.stopQuotaWatch();
});

test("the start-up check joins a full check already running instead of repeating it", async (t) => {
  const r = timedRig(t, { credentials: [cred(1, "anthropic", INCIDENT_CAUSE)], recipients: [recipient("joined")] });
  const release = holdCredentials(r);
  const full = quota.runQuotaCheck(r.deps);
  quota.startQuotaWatch(r.deps);
  t.mock.timers.tick(quota.SIGNED_OUT_BOOT_DELAY_MS);
  await flush();
  release();
  await full;
  await flush();
  assert.equal(r.reads.credentials, 1);
  assert.equal(r.published.length, 1);
  quota.stopQuotaWatch();
});

// ---------------------------------------------------------------------------
// The kind itself
// ---------------------------------------------------------------------------

test("the kind is in the catalog beside the quota kinds: instance-wide, under Problems, on by default at high priority", () => {
  const spec = catalog.NOTIFICATION_EVENTS.find((entry) => entry.id === "accountSignedOut");
  assert.ok(spec, "a row for the Notifications panel to render");
  assert.deepEqual([spec.label, spec.group, spec.scope, spec.defaultEnabled, spec.defaultPriority], ["Account signed out", "problems", "account", true, 4]);
  const ids = catalog.NOTIFICATION_EVENT_IDS;
  assert.equal(ids.indexOf("accountSignedOut"), ids.indexOf("quotaOut") + 1, "shown right after the quota kinds");
  assert.deepEqual(catalog.defaultNotificationPrefs().events.accountSignedOut, { enabled: true, priority: 4 });
});

test("settings saved before the kind existed read it as switched on; it can be switched and kept like any other", () => {
  const file = paths.getNotificationsPath();
  rmSync(file, { force: true });
  mkdirSync(join(root, "accounts"), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    accounts: { u1: { enabled: true, server: "https://ntfy.example.com", topic: "mytopic", events: { quotaOut: { enabled: false, priority: 2 } } } },
  }));
  const before = store.readNotificationPrefs("u1");
  assert.deepEqual(before.events.accountSignedOut, { enabled: true, priority: 4 });
  assert.deepEqual(before.events.quotaOut, { enabled: false, priority: 2 });

  const saved = store.updateNotificationPrefs("u1", { events: { accountSignedOut: { enabled: false, priority: 5 } } });
  assert.deepEqual(saved.events.accountSignedOut, { enabled: false, priority: 5 });
  const after = store.readNotificationPrefs("u1");
  assert.deepEqual(after.events.accountSignedOut, { enabled: false, priority: 5 }, "what a later read returns");
  assert.deepEqual(after.events.quotaOut, { enabled: false, priority: 2 }, "the other kinds are untouched");
  assert.throws(() => store.updateNotificationPrefs("u1", { events: { accountSignedOut: { priority: 9 } } }), store.InvalidNotificationSettingsError);
});
