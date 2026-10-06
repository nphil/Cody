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

test("no reset time is a refusal, not a guess: nothing known, already past, no window, an unmapped engine, or no read", () => {
  const reads = (accounts, provider = "anthropic", overrides = {}) => quota.planQuotaTarget(snapshot(accounts, overrides), provider, "m", {}, NOW);
  assert.deepEqual(reads([account("a1", [window({ resetsAt: null })])]), { ok: false, code: "no_quota_reset" });
  assert.deepEqual(reads([account("a1", [window({ resetsAt: iso(-HOUR) })])]), { ok: false, code: "no_quota_reset" }, "a reading that predates its own reset");
  assert.deepEqual(reads([account("a1", [window({ resetsAt: "soon" })])]), { ok: false, code: "no_quota_reset" });
  assert.deepEqual(reads([account("a1", [])]), { ok: false, code: "no_quota_reset" });
  assert.deepEqual(reads([account("a1", [window()])], "openai-codex"), { ok: false, code: "no_quota_reset" }, "another provider's quota says nothing about this model");
  assert.deepEqual(reads([account("a1", [window()])], null), { ok: false, code: "no_quota_reset" }, "an engine whose provider cannot be mapped");
  assert.deepEqual(reads([account("a1", [window()])], "anthropic", { available: false }), { ok: false, code: "no_quota_reset" });
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
