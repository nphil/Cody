import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

/**
 * "When quota resets" must name the window and the account the composer's ring
 * names, and "usable" must be lib/usage/availability's own verdict. The pure
 * planning and judging are exercised on hand-built snapshots; the chat's model
 * is read from a live session and from a real transcript.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-scheduled-quota-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const quota = await jiti.import("./quota.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-05T23:00:00Z");
const iso = (offset) => new Date(NOW + offset).toISOString();

const window = (overrides = {}) => ({ id: "5h", label: "5-hour window", utilization: 40, resetsAt: iso(2 * HOUR), state: "ok", windowMs: 5 * HOUR, ...overrides });
const account = (id, windows, overrides = {}) => ({ provider: "anthropic", id, identity: null, credentialId: null, label: "Anthropic", planType: null, unlimited: false, windows, ...overrides });
const snapshot = (accounts, overrides = {}) => ({ available: true, accounts, fetchedAt: iso(0), stale: false, ...overrides });

afterEach(() => {
  globalThis.__ompSessions?.clear();
  invalidateSessionListCache();
});

test("the reset is the binding window's — the one that stops the model first, which is the one the ring shows", () => {
  const accounts = [account("a1", [
    window({ id: "7d", label: "weekly", utilization: 90, resetsAt: iso(48 * HOUR), windowMs: 7 * 24 * HOUR }),
    window({ id: "5h", label: "5-hour window", utilization: 40, resetsAt: iso(2 * HOUR) }),
  ])];
  const plan = quota.planQuotaTarget(snapshot(accounts), "anthropic", "claude-opus-4-5", {}, NOW);
  assert.equal(plan.ok, true);
  assert.equal(plan.target.resetsAt, NOW + 2 * HOUR, "the shorter span wins while nothing is spent: that is the window being spent against now");
  assert.equal(plan.target.provider, "anthropic");
  assert.equal(plan.target.modelId, "claude-opus-4-5");
  assert.equal(plan.target.label, "Claude", "the brand, and no position for a provider with one account");

  const spent = [account("a1", [
    window({ id: "7d", label: "weekly", utilization: 100, state: "exhausted", resetsAt: iso(48 * HOUR), windowMs: 7 * 24 * HOUR }),
    window(),
  ])];
  assert.equal(quota.planQuotaTarget(snapshot(spent), "anthropic", "claude-opus-4-5", {}, NOW).target.resetsAt, NOW + 48 * HOUR, "a spent window outranks a shorter one: it is what is blocking");
});

test("with several accounts the label names the account in use by position, never by identity", () => {
  const accounts = [
    account("a1", [window({ utilization: 10, resetsAt: iso(1 * HOUR) })], { identity: "primary@example.com" }),
    account("a2", [window({ utilization: 60, resetsAt: iso(3 * HOUR) })], { identity: "second@example.com" }),
  ];
  const headroom = quota.planQuotaTarget(snapshot(accounts), "anthropic", "claude-opus-4-5", {}, NOW);
  assert.equal(headroom.target.label, "Claude · Primary", "no evidence: omp's own choice, the most headroom");
  assert.equal(headroom.target.resetsAt, NOW + 1 * HOUR);

  const pinned = quota.planQuotaTarget(snapshot(accounts), "anthropic", "claude-opus-4-5", { anthropic: { accountId: "a2", since: null } }, NOW);
  assert.equal(pinned.target.label, "Claude · Secondary", "the account this chat's last reply used");
  assert.equal(pinned.target.resetsAt, NOW + 3 * HOUR);
  assert.doesNotMatch(JSON.stringify(pinned), /@example\.com/, "an email never reaches a label");

  const third = quota.planQuotaTarget(snapshot([...accounts, account("a3", [window({ utilization: 99, resetsAt: iso(4 * HOUR) })])]), "anthropic", "m", { anthropic: { accountId: "a3", since: null } }, NOW);
  assert.equal(third.target.label, "Claude · Account 3");
});

test("no reset time is no refusal: the plan is OK with resetsAt null (nothing known, already past, unreadable, no window); only nothing-to-watch refuses", () => {
  const reads = (accounts, provider = "anthropic", overrides = {}) => quota.planQuotaTarget(snapshot(accounts, overrides), provider, "m", {}, NOW);
  for (const [what, accounts] of [
    ["the provider names none", [account("a1", [window({ resetsAt: null })])]],
    ["a reading that predates its own reset", [account("a1", [window({ resetsAt: iso(-HOUR) })])]],
    ["a reset time nobody can parse", [account("a1", [window({ resetsAt: "soon" })])]],
    ["an account with no window at all", [account("a1", [])]],
  ]) {
    const plan = reads(accounts);
    assert.equal(plan.ok, true, what);
    assert.equal(plan.target.resetsAt, null, what);
    assert.equal(plan.target.provider, "anthropic", what);
    assert.equal(plan.target.modelId, "m", what);
  }
  assert.equal(reads([account("a1", [window({ resetsAt: iso(-HOUR) })])]).target.label, "Claude", "the label still names the provider");
  assert.deepEqual(reads([account("a1", [window()])], null), { ok: false, code: "no_quota_reset" }, "an engine whose provider cannot be mapped: no usage provider to watch");
  assert.deepEqual(reads([account("a1", [window()])], "anthropic", { available: false }), { ok: false, code: "no_quota_reset" }, "an unavailable snapshot: nothing can be watched");
  // Another provider's quota says nothing about this model: there is simply no account to read a reset from, which is an unknown reset, not a refusal.
  const other = reads([account("a1", [window()])], "openai-codex");
  assert.equal(other.ok, true);
  assert.equal(other.target.resetsAt, null);
  assert.equal(other.target.provider, "openai-codex");
});

test("a window scoped to another model tier does not bind this model", () => {
  const accounts = [account("a1", [
    window({ id: "opus", label: "Opus · weekly", tier: "opus", utilization: 100, state: "exhausted", resetsAt: iso(30 * HOUR) }),
    window({ id: "all", label: "5-hour window", resetsAt: iso(2 * HOUR) }),
  ])];
  assert.equal(quota.planQuotaTarget(snapshot(accounts), "anthropic", "claude-sonnet-4-5", {}, NOW).target.resetsAt, NOW + 2 * HOUR, "Sonnet is not stopped by Opus's week");
  assert.equal(quota.planQuotaTarget(snapshot(accounts), "anthropic", "claude-opus-4-5", {}, NOW).target.resetsAt, NOW + 30 * HOUR);
});

test("usable means availability says the serving account can take a request; unknown is usable; an unread snapshot is not", () => {
  const usable = snapshot([account("a1", [window()])]);
  assert.deepEqual(quota.judgeQuota(usable, "anthropic", "m"), { state: "usable" });
  const spent = snapshot([account("a1", [window({ utilization: 100, state: "exhausted", resetsAt: iso(HOUR) })])]);
  assert.deepEqual(quota.judgeQuota(spent, "anthropic", "m"), { state: "exhausted", resetsAt: NOW + HOUR });
  assert.deepEqual(quota.judgeQuota(snapshot([account("a1", [window({ state: "exhausted", resetsAt: null })])]), "anthropic", "m"), { state: "exhausted", resetsAt: null });
  assert.deepEqual(quota.judgeQuota(usable, "openai-codex", "gpt"), { state: "usable" }, "a provider that reports nothing is never waited on");
  assert.deepEqual(quota.judgeQuota(snapshot([], { available: false }), "anthropic", "m"), { state: "unreadable" });
  assert.deepEqual(quota.judgeQuota(null, "anthropic", "m"), { state: "unreadable" });

  // With a healthy sibling the model is usable even though one account is spent: omp rotates onto it.
  const sibling = snapshot([
    account("a1", [window({ utilization: 100, state: "exhausted", resetsAt: iso(HOUR) })]),
    account("a2", [window({ utilization: 30 })]),
  ]);
  assert.deepEqual(quota.judgeQuota(sibling, "anthropic", "m"), { state: "usable" });
});

test("a model reference is read from either spelling an engine or the composer uses, and nothing else", () => {
  assert.deepEqual(quota.readModelRef({ provider: "anthropic", id: "claude-opus-4-5" }), { provider: "anthropic", modelId: "claude-opus-4-5" });
  assert.deepEqual(quota.readModelRef({ provider: " claude ", modelId: " claude-opus-4-5 " }), { provider: "claude", modelId: "claude-opus-4-5" });
  for (const bad of [null, undefined, "anthropic/claude", 7, {}, { provider: "", id: "x" }, { provider: "a", id: "  " }, { provider: 1, id: "x" }]) {
    assert.equal(quota.readModelRef(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// The chat's own model
// ---------------------------------------------------------------------------

function liveSession(id, { state, send } = {}) {
  const session = {
    sessionId: id,
    isAlive: () => true,
    lastKnownState: () => state ?? null,
    send: send ?? (async () => { throw new Error("unexpected"); }),
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return session;
}

function writeTranscript(id, entries) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id, cwd: "/proj", title: "t", created: "2026-01-01", modified: "2026-01-01" })];
  let parentId = null;
  for (const [index, entry] of entries.entries()) {
    const entryId = `${id}-${index}`;
    lines.push(JSON.stringify({ id: entryId, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...entry }));
    parentId = entryId;
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  invalidateSessionListCache();
}

test("a live chat's model is what its session last reported, without asking the engine again", async () => {
  liveSession("live-1", { state: { model: { provider: "anthropic", id: "claude-opus-4-5" } } });
  assert.deepEqual(await quota.resolveChatModel("live-1"), { provider: "anthropic", modelId: "claude-opus-4-5" });
});

test("a live chat with no remembered state is asked once; a wedged one falls back to its transcript", async () => {
  liveSession("live-2", { send: async (command) => ({ model: { provider: "claude", id: "claude-opus-4-5" }, asked: command.type }) });
  assert.deepEqual(await quota.resolveChatModel("live-2"), { provider: "claude", modelId: "claude-opus-4-5" });

  writeTranscript("live-3", [{ type: "model_change", model: "anthropic/claude-sonnet-4-5" }]);
  liveSession("live-3", { send: async () => { throw new Error("child is wedged"); } });
  assert.deepEqual(await quota.resolveChatModel("live-3"), { provider: "anthropic", modelId: "claude-sonnet-4-5" });
});

test("a dormant chat's model is the last one its transcript recorded; with none, nothing is guessed", async () => {
  writeTranscript("dormant-1", [
    { type: "model_change", model: "anthropic/claude-sonnet-4-5" },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "model_change", model: "anthropic/claude-opus-4-5" },
  ]);
  assert.deepEqual(await quota.resolveChatModel("dormant-1"), { provider: "anthropic", modelId: "claude-opus-4-5" });
  writeTranscript("dormant-2", [{ type: "message", message: { role: "user", content: "hi" } }]);
  assert.equal(await quota.resolveChatModel("dormant-2"), null);
  assert.equal(await quota.resolveChatModel("never-existed"), null);
});

// ---------------------------------------------------------------------------
// Which model's quota counts
// ---------------------------------------------------------------------------

const codex = (id, windows, overrides = {}) => account(id, windows, { provider: "openai-codex", label: "Codex", ...overrides });
const spent = (resetsAt) => window({ utilization: 100, state: "exhausted", resetsAt });

test("usable is judged on the CHOSEN model's provider, never the chat's own: either one can be the exhausted one", () => {
  const claudeSpent = snapshot([account("a1", [spent(iso(3 * HOUR))]), codex("c1", [window({ utilization: 10, resetsAt: iso(HOUR) })])]);
  // The chat is on Claude (exhausted), the message goes out on Codex (fine).
  assert.deepEqual(quota.judgeQuota(claudeSpent, "anthropic", "claude-opus-4-8"), { state: "exhausted", resetsAt: NOW + 3 * HOUR });
  assert.deepEqual(quota.judgeQuota(claudeSpent, "openai-codex", "gpt-5"), { state: "usable" }, "the chosen model's provider has headroom");

  const codexSpent = snapshot([account("a1", [window()]), codex("c1", [spent(iso(5 * HOUR))])]);
  // The chat is on Codex (exhausted), the message goes out on Claude (fine), and the other way round.
  assert.deepEqual(quota.judgeQuota(codexSpent, "openai-codex", "gpt-5"), { state: "exhausted", resetsAt: NOW + 5 * HOUR });
  assert.deepEqual(quota.judgeQuota(codexSpent, "anthropic", "claude-opus-4-8"), { state: "usable" });
});

test("planning for a chat follows the model it is given over the chat's own, and reads the chat's own only when none is given", async () => {
  // A fresh, available usage read is preloaded; no `omp usage` is ever spawned.
  const readerStub = path.join(root, "omp-stub");
  fs.writeFileSync(readerStub, "");
  process.env.CODY_OMP_BIN = readerStub;
  const { invalidateOmpCliCache } = await jiti.import("../omp/omp-cli.ts");
  invalidateOmpCliCache();
  const preload = (value) => {
    globalThis.__codyUsageCacheState = { entry: { snapshot: value, storedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }, inFlight: null, generation: 0 };
  };
  try {
    const both = snapshot([
      account("a1", [window({ resetsAt: new Date(Date.now() + 2 * HOUR).toISOString() })]),
      codex("c1", [window({ resetsAt: new Date(Date.now() + 9 * HOUR).toISOString() })]),
    ]);
    preload(both);
    const clock = Date.now();
    liveSession("plan-chat", { state: { model: { provider: "anthropic", id: "claude-sonnet-4-6" } } });

    const own = await quota.planQuotaForChat("plan-chat", "omp", null, clock);
    assert.equal(own.ok, true);
    assert.equal(own.target.provider, "anthropic", "no model given: the chat's own");
    assert.equal(own.target.modelId, "claude-sonnet-4-6");
    assert.equal(own.target.resetsAt, Date.parse(both.accounts[0].windows[0].resetsAt));

    const chosen = await quota.planQuotaForChat("plan-chat", "omp", { provider: "openai-codex", modelId: "gpt-5" }, clock);
    assert.equal(chosen.ok, true);
    assert.equal(chosen.target.provider, "openai-codex", "the model the message goes out on, not the chat's");
    assert.equal(chosen.target.modelId, "gpt-5");
    assert.equal(chosen.target.resetsAt, Date.parse(both.accounts[1].windows[0].resetsAt));

    // A chosen model whose provider has no account in the read: the reset is unknown, which is no refusal.
    const unmetered = await quota.planQuotaForChat("plan-chat", "omp", { provider: "local", modelId: "qwen" }, clock);
    assert.equal(unmetered.ok, true);
    assert.equal(unmetered.target.resetsAt, null);

    // A chat whose model nobody can name, with none supplied: nothing is guessed.
    assert.deepEqual(await quota.planQuotaForChat("no-such-chat", "omp", null, clock), { ok: false, code: "no_model" });
    const unreadable = await quota.planQuotaForChat("no-such-chat", "omp", { provider: "anthropic", modelId: "m" }, clock);
    assert.equal(unreadable.ok, true, "a supplied model needs no chat lookup: creation never touches the engine");

    // An engine with no usage provider for the model, and an unavailable read: nothing to watch.
    assert.deepEqual(await quota.planQuotaForChat("plan-chat", "some-acp", { provider: "other", modelId: "m" }, clock), { ok: false, code: "no_quota_reset" });
    preload(snapshot([], { available: false }));
    assert.deepEqual(await quota.planQuotaForChat("plan-chat", "omp", { provider: "anthropic", modelId: "m" }, clock), { ok: false, code: "no_quota_reset" });
  } finally {
    globalThis.__codyUsageCacheState = undefined;
    delete process.env.CODY_OMP_BIN;
    invalidateOmpCliCache();
  }
});
