import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The quota watcher: what counts as "running low" and "used up", that each
 * window is announced once, and that nothing reads usage unless somebody asked
 * to hear about it — and then no more often than the rules allow.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-quota-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const quota = await jiti.import("./quota-watch.ts");
const catalog = await jiti.import("./catalog.ts");
const paths = await jiti.import("../auth/paths.ts");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
/** 7 minutes into a 15-minute reset bucket, so a minute of jitter stays in it. */
const RESET = NOW + 3 * HOUR + 7 * MINUTE;

const win = (fields = {}) => ({ id: "5h", label: "5-hour window", utilization: 50, resetsAt: iso(RESET), state: "ok", ...fields });
const acct = (provider, id, windows, extra = {}) => ({
  provider,
  id,
  identity: `${id}@private.example.com`,
  credentialId: null,
  label: `${provider} (${id}@private.example.com)`,
  planType: null,
  unlimited: false,
  windows,
  ...extra,
});
const snapshot = (accounts, extra = {}) => ({ available: true, accounts, fetchedAt: iso(NOW), stale: false, ...extra });

const prefs = (patch = {}) => {
  const base = catalog.defaultNotificationPrefs();
  return { ...base, enabled: true, server: "https://ntfy.test", topic: "t", codyUrl: "https://cody.test", ...patch, events: { ...base.events, ...patch.events } };
};
const recipient = (key, patch) => ({ key, user: null, prefs: prefs(patch) });

// ---------------------------------------------------------------------------
// What counts
// ---------------------------------------------------------------------------

test("a window at or past the owner's threshold is 'running low'; the threshold is theirs", () => {
  const accounts = [acct("anthropic", "a1", [win({ utilization: 92 }), win({ id: "7d", label: "weekly", utilization: 75 })])];
  const at90 = quota.evaluateQuota(snapshot(accounts), prefs({ quotaLowPercent: 90 }), NOW);
  assert.deepEqual(at90.map((alert) => [alert.event, alert.window, alert.utilization]), [["quotaLow", "5-hour window", 92]]);
  const at70 = quota.evaluateQuota(snapshot(accounts), prefs({ quotaLowPercent: 70 }), NOW);
  assert.deepEqual(at70.map((alert) => alert.window), ["5-hour window", "weekly"]);
  const exactly = quota.evaluateQuota(snapshot([acct("anthropic", "a1", [win({ utilization: 90 })])]), prefs({ quotaLowPercent: 90 }), NOW);
  assert.equal(exactly.length, 1, "at the threshold counts");
  assert.deepEqual(quota.evaluateQuota(snapshot([acct("anthropic", "a1", [win({ utilization: 89 })])]), prefs({ quotaLowPercent: 90 }), NOW), []);
});

test("a window that is spent is 'used up' — measured, at 100%, or blocked by the provider — and never also 'low'", () => {
  const alerts = quota.evaluateQuota(snapshot([
    acct("anthropic", "a1", [
      win({ id: "a", label: "measured", utilization: 40, state: "exhausted" }),
      win({ id: "b", label: "full", utilization: 100 }),
      win({ id: "c", label: "rate-limit block", utilization: 100, state: "exhausted", source: "block" }),
      win({ id: "d", label: "high", utilization: 95 }),
    ]),
  ]), prefs(), NOW);
  assert.deepEqual(alerts.map((alert) => [alert.window, alert.event, alert.blocked]), [
    ["measured", "quotaOut", false],
    ["full", "quotaOut", false],
    ["rate-limit block", "quotaOut", true],
    ["high", "quotaLow", false],
  ]);
});

test("unlimited and disabled accounts, and windows that already reset, are never announced", () => {
  const alerts = quota.evaluateQuota(snapshot([
    acct("anthropic", "unl", [win({ utilization: 99 })], { unlimited: true }),
    acct("anthropic", "off", [win({ utilization: 99 })], { disabled: { cause: "auth failure" } }),
    acct("openai-codex", "stale", [win({ utilization: 100, state: "exhausted", resetsAt: iso(NOW - MINUTE) })]),
    acct("openai-codex", "live", [win({ utilization: 100, state: "exhausted" })]),
  ]), prefs(), NOW);
  assert.deepEqual(alerts.map((alert) => alert.provider), ["Codex"], "only the live one");
});

test("a kind the owner switched off is not announced, and the other still is", () => {
  const accounts = [acct("anthropic", "a1", [win({ utilization: 95 }), win({ id: "x", label: "spent", utilization: 100, state: "exhausted" })])];
  const noLow = quota.evaluateQuota(snapshot(accounts), prefs({ events: { quotaLow: { enabled: false, priority: 3 } } }), NOW);
  assert.deepEqual(noLow.map((alert) => alert.event), ["quotaOut"]);
  const noOut = quota.evaluateQuota(snapshot(accounts), prefs({ events: { quotaOut: { enabled: false, priority: 4 } } }), NOW);
  assert.deepEqual(noOut.map((alert) => alert.event), ["quotaLow"]);
});

test("accounts are numbered by their place among the provider's accounts, and nobody's email is ever used", () => {
  const alerts = quota.evaluateQuota(snapshot([
    acct("anthropic", "first", [win({ utilization: 10 })]),
    acct("openai-codex", "solo", [win({ utilization: 95 })]),
    acct("anthropic", "second", [win({ utilization: 96 })]),
  ]), prefs(), NOW);
  assert.deepEqual(alerts.map((alert) => [alert.provider, alert.position, alert.accountCount]), [["Codex", 1, 1], ["Claude", 2, 2]]);
  for (const alert of alerts) {
    const text = JSON.stringify(alert) + quota.describeQuotaAlert(alert, "UTC").title + quota.describeQuotaAlert(alert, "UTC").body;
    assert.equal(text.includes("private.example.com"), false);
    assert.equal(text.includes("first") || text.includes("second") || text.includes("solo"), false, "not even the account id");
  }
});

test("a provider is named as the owner knows it, or by a tidy version of its id", () => {
  const named = (provider) => quota.evaluateQuota(snapshot([acct(provider, "x", [win({ utilization: 99 })])]), prefs(), NOW)[0].provider;
  assert.equal(named("anthropic"), "Claude");
  assert.equal(named("openai-codex"), "Codex");
  assert.equal(named("github-copilot"), "Copilot");
  assert.equal(named("my-custom_provider"), "My Custom Provider");
});

test("an alert's fingerprint is hashed, stable, and moves when the window really changes", () => {
  const base = acct("anthropic", "a1", [win({ utilization: 95 })]);
  const [alert] = quota.evaluateQuota(snapshot([base]), prefs(), NOW);
  assert.match(alert.fingerprint, /^[0-9a-f]{24}$/);
  assert.equal(alert.fingerprint.includes("a1"), false);
  assert.equal(quota.evaluateQuota(snapshot([base]), prefs(), NOW + 5 * MINUTE)[0].fingerprint, alert.fingerprint, "stable over time");

  const fp = (account) => quota.evaluateQuota(snapshot([account]), prefs(), NOW)[0].fingerprint;
  assert.equal(fp(acct("anthropic", "a1", [win({ utilization: 95, resetsAt: iso(RESET + MINUTE) })])), alert.fingerprint, "a minute's drift in the reported reset time is the same window");
  assert.equal(fp(acct("anthropic", "a1", [win({ utilization: 99 })])), alert.fingerprint, "and so is a higher percentage");
  assert.notEqual(fp(acct("anthropic", "a1", [win({ utilization: 95, resetsAt: iso(RESET + 5 * HOUR) })])), alert.fingerprint, "the next window is a new one");
  assert.notEqual(fp(acct("anthropic", "a2", [win({ utilization: 95 })])), alert.fingerprint, "another account");
  assert.notEqual(fp(acct("anthropic", "a1", [win({ id: "7d", utilization: 95 })])), alert.fingerprint, "another window");
  assert.notEqual(fp(acct("openai-codex", "a1", [win({ utilization: 95 })])), alert.fingerprint, "another provider");
  assert.notEqual(fp(acct("anthropic", "a1", [win({ utilization: 100, state: "exhausted" })])), alert.fingerprint, "'used up' is not 'running low'");
});

test("a window with no reset time is remembered for eight days; one with a reset time until it resets", () => {
  const [open] = quota.evaluateQuota(snapshot([acct("anthropic", "a1", [win({ utilization: 95, resetsAt: null })])]), prefs(), NOW);
  assert.equal(open.resetsAt, null);
  assert.equal(open.expiresAt, NOW + 8 * 24 * HOUR);
  const [timed] = quota.evaluateQuota(snapshot([acct("anthropic", "a1", [win({ utilization: 95 })])]), prefs(), NOW);
  assert.equal(timed.expiresAt, RESET);
});

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

const alertFor = (windowFields, accountFields = {}, others = []) =>
  quota.evaluateQuota(snapshot([acct("anthropic", "a1", [win(windowFields)], accountFields), ...others]), prefs(), NOW)[0];

test("the message names the provider, the account's place, the window and when it resets — in the reader's own zone", () => {
  const low = alertFor({ utilization: 92.4 }, {}, [acct("anthropic", "a2", [])]);
  const tokyo = quota.describeQuotaAlert(low, "Asia/Tokyo");
  assert.equal(tokyo.title, "Quota running low · Claude");
  assert.equal(tokyo.body, "Account 1/2: 5-hour window is at 92% of its limit. Resets 2026-10-04 00:07 UTC+09:00.");
  const newYork = quota.describeQuotaAlert(low, "America/New_York");
  assert.notEqual(tokyo.body, newYork.body, "the same moment reads differently in another zone");
  assert.match(tokyo.body, /2026-10-04 00:07/, "15:07 UTC is 00:07 the next day in Tokyo");
  assert.match(newYork.body, /2026-10-03 11:07 EDT/, "and 11:07 in New York");

  const out = quota.describeQuotaAlert(alertFor({ utilization: 100, state: "exhausted", label: "weekly" }), "UTC");
  assert.equal(out.title, "Quota used up · Claude");
  assert.match(out.body, /^weekly is used up\. Resets 2026-10-03 15:07 UTC\.$/, "a single account has no position to state");

  const blocked = quota.describeQuotaAlert(alertFor({ utilization: 100, state: "exhausted", source: "block", label: "rate-limit block" }), "UTC");
  assert.match(blocked.body, /^The provider blocked this account \(rate-limit block\)\. Expected back 2026-10-03 15:07 UTC\.$/);

  const noReset = quota.describeQuotaAlert(alertFor({ utilization: 99, resetsAt: null }), "UTC");
  assert.equal(noReset.body, "5-hour window is at 99% of its limit.");
});

// ---------------------------------------------------------------------------
// Reading and announcing
// ---------------------------------------------------------------------------

function rig({ snapshotFor = () => snapshot([acct("anthropic", "a1", [win({ utilization: 95 })])]), recipients = [recipient("u1")], publishResult = () => ({ ok: true }), installed = true } = {}) {
  const published = [];
  const reads = [];
  let now = NOW;
  const deps = {
    now: () => now,
    readerInstalled: () => installed,
    readUsage: async () => { reads.push(now); return snapshotFor(now); },
    recipients: () => recipients,
    publish: async (target, message) => {
      published.push({ target, message });
      return publishResult(published.length);
    },
  };
  return { deps, published, reads, setNow: (value) => { now = value; } };
}

const stateFile = () => JSON.parse(readFileSync(paths.getNotificationsStatePath(), "utf8"));

test("a window past its threshold is announced once, with the message the owner configured", async () => {
  const r = rig({ recipients: [recipient("u1", { events: { quotaLow: { enabled: true, priority: 5 } } })] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.equal(r.published.length, 1);
  const { target, message } = r.published[0];
  assert.deepEqual(target, { server: "https://ntfy.test", topic: "t", token: "" });
  assert.equal(message.title, "Quota running low · Claude");
  assert.equal(message.priority, 5);
  assert.deepEqual(message.tags, ["warning"]);
  assert.equal(message.click, "https://cody.test");
  assert.equal(message.sequenceId, undefined);
  assert.match(message.message, /5-hour window is at 95% of its limit\. Resets /);

  assert.equal(await quota.runQuotaCheck(r.deps), 0, "the next read announces nothing new");
  assert.equal(r.published.length, 1);
  assert.equal(r.reads.length, 2);
});

test("what was announced is remembered in a private file, as hashes only", async () => {
  const text = readFileSync(paths.getNotificationsStatePath(), "utf8");
  assert.equal(statSync(paths.getNotificationsStatePath()).mode & 0o777, 0o600);
  assert.equal(text.includes("a1"), false, "no account id");
  assert.equal(text.includes("private.example.com"), false, "no email");
  const entry = stateFile().recipients.u1;
  assert.equal(Object.keys(entry).length, 1);
  assert.match(Object.keys(entry)[0], /^[0-9a-f]{24}$/);
  assert.equal(Object.values(entry)[0], RESET, "remembered until the window resets");
});

test("a window that is already past its threshold the first time the watcher looks is announced — once", async () => {
  const fresh = rig({ recipients: [recipient("first-run")] });
  assert.equal(await quota.runQuotaCheck(fresh.deps), 1);
  assert.equal(await quota.runQuotaCheck(fresh.deps), 0);
});

test("when the window resets and fills again it is news again, and the old memory is pruned", async () => {
  const r = rig({ recipients: [recipient("cycle")] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.equal(Object.keys(stateFile().recipients.cycle).length, 1);

  // Past the reset: the window is gone from the next reading (it started over), and the memory goes with it.
  r.setNow(RESET + MINUTE);
  r.deps.readUsage = async () => snapshot([acct("anthropic", "a1", [win({ utilization: 5, resetsAt: iso(RESET + 5 * HOUR) })])]);
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
  assert.equal(stateFile().recipients.cycle, undefined, "expired entries are pruned, and so is a person left with none");

  // The next window fills.
  r.deps.readUsage = async () => snapshot([acct("anthropic", "a1", [win({ utilization: 97, resetsAt: iso(RESET + 5 * HOUR) })])]);
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.equal(r.published.length, 2);
});

test("a message that could not be delivered is not remembered, so the next read tries again", async () => {
  const r = rig({ recipients: [recipient("retry")], publishResult: (attempt) => (attempt === 1 ? { ok: false, error: "forbidden", status: 403 } : { ok: true }) });
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
    assert.equal(stateFile().recipients.retry, undefined);
    assert.equal(await quota.runQuotaCheck(r.deps), 1, "the second read delivers it");
    assert.equal(r.published.length, 2);
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /publish failed for ntfy\.test: forbidden \(HTTP 403\)/);
});

test("each person is remembered separately: another recipient still hears about the same window", async () => {
  const alice = recipient("alice", { topic: "alice_t" });
  const bob = recipient("bob", { topic: "bob_t", quotaLowPercent: 99 });
  const r = rig({ recipients: [alice, bob] });
  assert.equal(await quota.runQuotaCheck(r.deps), 1, "Bob's threshold is 99: 95% is not news to him");
  assert.deepEqual(r.published.map((p) => p.target.topic), ["alice_t"]);
  bob.prefs.quotaLowPercent = 90;
  assert.equal(await quota.runQuotaCheck(r.deps), 1);
  assert.deepEqual(r.published.map((p) => p.target.topic), ["alice_t", "bob_t"]);
  assert.equal(await quota.runQuotaCheck(r.deps), 0);
});

test("nothing is read unless the usage reader exists AND someone wants a quota notification", async () => {
  const none = rig({ installed: false });
  assert.equal(await quota.runQuotaCheck(none.deps), 0);
  assert.equal(none.reads.length, 0, "no omp, no spawn");

  for (const unwanted of [
    recipient("off", { enabled: false }),
    recipient("no-topic", { topic: "" }),
    recipient("no-server", { server: "" }),
    recipient("kinds-off", { events: { quotaLow: { enabled: false, priority: 3 }, quotaOut: { enabled: false, priority: 4 } } }),
  ]) {
    const r = rig({ recipients: [unwanted] });
    assert.equal(await quota.runQuotaCheck(r.deps), 0);
    assert.equal(r.reads.length, 0, `${unwanted.key}: nobody wants one, so usage is not read`);
  }
  const one = rig({ recipients: [recipient("only-out", { events: { quotaLow: { enabled: false, priority: 3 } } })] });
  await quota.runQuotaCheck(one.deps);
  assert.equal(one.reads.length, 1, "either kind is reason enough");
});

test("an unavailable reading announces nothing; a reader that throws is logged, not raised", async () => {
  const down = rig({ snapshotFor: () => ({ available: false, accounts: [], fetchedAt: iso(NOW), stale: false, reason: "omp usage timed out" }) });
  assert.equal(await quota.runQuotaCheck(down.deps), 0);
  assert.equal(down.published.length, 0);

  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    const boom = rig();
    boom.deps.readUsage = async () => { throw new Error("spawn exploded"); };
    assert.equal(await quota.runQuotaCheck(boom.deps), 0);
  } finally {
    console.warn = warn;
  }
  assert.match(lines[0], /quota check failed: spawn exploded/);
});

test("two reads asked for at once are one read", async () => {
  const r = rig({ recipients: [recipient("single-flight")] });
  const [a, b] = await Promise.all([quota.runQuotaCheck(r.deps), quota.runQuotaCheck(r.deps)]);
  assert.equal(r.reads.length, 1);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// When it reads
// ---------------------------------------------------------------------------

function timedRig(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  quota.stopQuotaWatch();
  globalThis.__codyQuotaWatch.lastReadAt = 0;
  const r = rig({ recipients: [recipient("timed")], snapshotFor: () => snapshot([]) });
  return r;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a run ending asks for a read a minute later — once, however many runs end — and nothing before the watcher starts", async (t) => {
  const r = timedRig(t);
  quota.noteTerminalTurn();
  assert.equal(globalThis.__codyQuotaWatch.pending, undefined, "not started: nothing is scheduled");

  quota.startQuotaWatch(r.deps);
  quota.noteTerminalTurn();
  t.mock.timers.tick(30_000);
  quota.noteTerminalTurn();
  quota.noteTerminalTurn();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(r.reads.length, 0, "not yet");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(r.reads.length, 1, "a minute after the first run ended, one read for all three");
  quota.stopQuotaWatch();
});

test("reads are at least three minutes apart: a run ending soon after one waits out the rest", async (t) => {
  const r = timedRig(t);
  quota.startQuotaWatch(r.deps);
  quota.noteTerminalTurn();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(r.reads.length, 1);

  t.mock.timers.tick(10_000);
  quota.noteTerminalTurn();
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(r.reads.length, 1, "70 s after the last read is too soon, even though a minute has passed since this run ended");
  t.mock.timers.tick(70_000);
  await flush();
  assert.equal(r.reads.length, 2, "three minutes after the last read");
  quota.stopQuotaWatch();
});

test("every ten minutes it reads — but only while some chat is live", async (t) => {
  const r = timedRig(t);
  quota.startQuotaWatch(r.deps);
  quota.startQuotaWatch(r.deps);
  const registry = (globalThis.__ompSessions ??= new Map());
  registry.clear();
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(r.reads.length, 0, "no live chat, no read");

  registry.set("live", { isAlive: () => false });
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(r.reads.length, 0, "a dead session is not live");

  registry.set("really-live", { isAlive: () => true });
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(r.reads.length, 1, "one read, however many times it was started");
  registry.clear();
  quota.stopQuotaWatch();
});

test("stopping ends both the interval and a read already waiting", async (t) => {
  const r = timedRig(t);
  quota.startQuotaWatch(r.deps);
  (globalThis.__ompSessions ??= new Map()).set("live", { isAlive: () => true });
  quota.noteTerminalTurn();
  quota.stopQuotaWatch();
  t.mock.timers.tick(30 * 60_000);
  await flush();
  assert.equal(r.reads.length, 0);
  assert.equal(globalThis.__codyQuotaWatch.started, false);
  globalThis.__ompSessions.clear();
  quota.noteTerminalTurn();
  assert.equal(globalThis.__codyQuotaWatch.pending, undefined, "and a stopped watcher schedules nothing");
});
