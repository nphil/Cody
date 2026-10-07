import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  idsNeedingResumeCheck,
  blockWaiting,
  releaseBlocked,
  OUTBOX_RETRY_MAX_MS,
  applyOutcome,
  backoffDelayMs,
  beginAttempt,
  classifyDeliveryOutcome,
  clearPersistedOutbox,
  createClientMessageId,
  createOutboxEntry,
  deserializeOutboxEntries,
  normalizeOutboxText,
  mutatePersistedOutbox,
  persistOutbox,
  readPersistedOutbox,
  applyServerDelivery,
  reconcileTranscriptDeliveries,
  restoreForEdit,
  retryEntry,
  reviveForResume,
  serializeOutboxEntries,
  shouldGiveUpRetrying,
} = await jiti.import("./outbox.ts");

const entry = (overrides = {}) => createOutboxEntry({
  sessionId: "s1",
  text: "hello",
  behavior: "steer",
  id: "fixed-id",
  now: 1_000_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// retry classification
// ---------------------------------------------------------------------------

test("classifyDeliveryOutcome maps every documented HTTP shape from local://send-contract.md", () => {
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 200, success: true, data: { delivery: "started" }, }),
    { kind: "success", delivery: "started" },
  );
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 200, success: true, data: { delivery: "queued" } }),
    { kind: "success", delivery: "queued" },
  );
  assert.deepEqual(classifyDeliveryOutcome({ status: 200, success: true, data: { delivery: "started", status: "delivered" } }), { kind: "success", delivery: "delivered" });
  // A 200 with no explicit delivery field defaults to "started", never crashes.
  assert.deepEqual(classifyDeliveryOutcome({ status: 200, success: true }), { kind: "success", delivery: "started" });

  assert.deepEqual(classifyDeliveryOutcome({ status: 202, pending: true }), { kind: "pending" });

  assert.deepEqual(
    classifyDeliveryOutcome({ status: 409, code: "session_restarting", error: "restarting" }),
    { kind: "retry", detail: "restarting" },
  );
  // A 409 for any OTHER code is not on the retry list — it is a real conflict.
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 409, code: "session_busy", error: "busy" }),
    { kind: "failed", detail: "busy", origin: "server" },
  );

  assert.deepEqual(classifyDeliveryOutcome({ status: 503, error: "down" }), { kind: "retry", detail: "down" });

  // A network failure never got a status at all.
  assert.deepEqual(classifyDeliveryOutcome({ status: null, error: "Failed to fetch" }), { kind: "retry", detail: "Failed to fetch" });

  // An ACP engine's definitive session_busy (SendServer: "not on your retry
  // list") and any other 4xx/5xx are failures the outbox does not retry.
  assert.deepEqual(classifyDeliveryOutcome({ status: 400, code: "session_busy", error: "busy" }), { kind: "failed", detail: "busy", origin: "server" });
  assert.deepEqual(classifyDeliveryOutcome({ status: 500, error: "boom" }), { kind: "failed", detail: "boom", origin: "server" });
  // No error/code at all still names the HTTP status rather than saying nothing.
  assert.deepEqual(classifyDeliveryOutcome({ status: 500 }), { kind: "failed", detail: "HTTP 500", origin: "server" });
});

// ---------------------------------------------------------------------------
// backoff + give-up
// ---------------------------------------------------------------------------

test("backoff doubles from 1s and caps at the ~2-minute contract ceiling", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(backoffDelayMs),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000],
  );
  assert.equal(backoffDelayMs(20), OUTBOX_RETRY_MAX_MS);
  // Never negative, never below the base delay.
  assert.equal(backoffDelayMs(-3), 1_000);
  assert.equal(OUTBOX_RETRY_MAX_MS, 120_000, "~2 minutes, per the contract");
});

test("an entry gives up once its retry streak has run the full ~2-minute budget", () => {
  const start = entry({ now: 1_000_000 }).retryingSince;
  assert.equal(shouldGiveUpRetrying(entry({ now: start }), start), false);
  assert.equal(shouldGiveUpRetrying(entry({ now: start }), start + OUTBOX_RETRY_MAX_MS - 1), false);
  assert.equal(shouldGiveUpRetrying(entry({ now: start }), start + OUTBOX_RETRY_MAX_MS), true);
});

test("repeated retryable outcomes back off, then give up as failed rather than retrying forever", () => {
  const start = 0;
  let entries = [entry({ now: start })];
  let now = start;
  let attempts = 0;
  while (entries[0].status === "sending" && attempts < 100) {
    entries = beginAttempt(entries, "fixed-id");
    entries = applyOutcome(entries, "fixed-id", { kind: "retry", detail: "down" }, now);
    attempts += 1;
    if (entries[0].nextRetryAt !== null) now = entries[0].nextRetryAt;
  }
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].error, "down");
  // Gives up within a healthy number of attempts — not one, not hundreds.
  assert.ok(attempts >= 5 && attempts <= 15, `expected a healthy retry count, got ${attempts}`);
  // The whole streak fits inside (and reaches close to) the ~2-minute budget.
  assert.ok(now - start >= OUTBOX_RETRY_MAX_MS && now - start < OUTBOX_RETRY_MAX_MS + backoffDelayMs(attempts));
});

test("a 202 pending outcome keeps retrying without a failure detail, and also gives up eventually", () => {
  let entries = [entry({ now: 0 })];
  entries = beginAttempt(entries, "fixed-id");
  entries = applyOutcome(entries, "fixed-id", { kind: "pending" }, 0);
  assert.equal(entries[0].status, "sending");
  assert.equal(entries[0].nextRetryAt, backoffDelayMs(1));

  // Fast-forward past the give-up budget and confirm it does not spin forever.
  entries = beginAttempt(entries, "fixed-id");
  entries = applyOutcome(entries, "fixed-id", { kind: "pending" }, OUTBOX_RETRY_MAX_MS);
  assert.equal(entries[0].status, "failed");
});

test("a definitive failure never schedules a retry, however early in the streak", () => {
  let entries = [entry({ now: 0 })];
  entries = beginAttempt(entries, "fixed-id");
  entries = applyOutcome(entries, "fixed-id", { kind: "failed", detail: "no credentials", origin: "server" }, 0);
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].error, "no credentials");
  assert.equal(entries[0].nextRetryAt, null);
});

test("a chat whose saved model is gone blocks its message: not a retry, not a failure, and it never gives up", () => {
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 400, code: "model_unrestorable", error: "gone", provider: "p", modelId: "m" }),
    { kind: "blocked", detail: "gone" },
  );
  let entries = [entry({ now: 0 })];
  entries = beginAttempt(entries, "fixed-id");
  // Hours later: a retry streak would long since have given up as failed.
  entries = applyOutcome(entries, "fixed-id", { kind: "blocked", detail: "gone" }, OUTBOX_RETRY_MAX_MS * 100);
  assert.equal(entries[0].status, "sending");
  assert.equal(entries[0].blocked, true);
  assert.equal(entries[0].nextRetryAt, null);
  assert.equal(entries[0].text, "hello");
});

test("releaseBlocked frees only the waiting entries, with a fresh budget, and reports their ids", () => {
  let entries = [entry({ id: "waiting", now: 0 }), entry({ id: "queued", now: 0 }), entry({ id: "failed", now: 0 })];
  entries = beginAttempt(entries, "waiting");
  entries = applyOutcome(entries, "waiting", { kind: "blocked", detail: "gone" }, 5_000);
  entries = beginAttempt(entries, "queued");
  entries = applyOutcome(entries, "queued", { kind: "success", delivery: "queued" }, 5_000);
  entries = beginAttempt(entries, "failed");
  entries = applyOutcome(entries, "failed", { kind: "failed", detail: "no", origin: "server" }, 5_000);

  const released = releaseBlocked(entries, 9_000_000);
  assert.deepEqual(released.ids, ["waiting"]);
  const freed = released.entries.find((candidate) => candidate.id === "waiting");
  assert.equal(freed.blocked, undefined);
  assert.equal(freed.attempt, 0);
  assert.equal(freed.retryingSince, 9_000_000);
  assert.equal(freed.error, undefined);
  assert.equal(released.entries.find((candidate) => candidate.id === "queued").status, "queued");
  assert.equal(released.entries.find((candidate) => candidate.id === "failed").status, "failed");
  // The next attempt after release starts from a clean slate and can succeed.
  const again = applyOutcome(beginAttempt(released.entries, "waiting"), "waiting", { kind: "success", delivery: "started" }, 9_000_001);
  assert.equal(again.find((candidate) => candidate.id === "waiting").status, "started");
});

test("a blocked entry survives the browser's storage round trip, but a reload re-arms it instead of leaving it waiting", () => {
  let entries = [entry({ now: 0 })];
  entries = applyOutcome(beginAttempt(entries, "fixed-id"), "fixed-id", { kind: "blocked", detail: "gone" }, 0);
  const restored = deserializeOutboxEntries(serializeOutboxEntries(entries));
  assert.equal(restored[0].blocked, true);
  assert.equal(reviveForResume(restored, 1)[0].blocked, undefined);
});

test("a message still being sent is never settled by its own optimistic bubble (the lost held message)", () => {
  // The composer shows the sent text at once, before the engine has it. The
  // reload recovery matches the on-screen transcript against unsent entries, so
  // without the live-entry guard it declared this message delivered while its
  // request was still out — and a refused one then vanished instead of waiting.
  const sent = entry({ id: "live", now: 1_000, text: "Still there? One word." });
  const optimisticBubble = { role: "user", content: "Still there? One word.", timestamp: 2_000 };
  const unaided = reconcileTranscriptDeliveries([sent], [optimisticBubble], new Set(["live"]));
  assert.equal(unaided[0].status, "delivered", "the bubble does match the text — that is the trap");

  const unknown = ["live"];
  const needing = idsNeedingResumeCheck([sent], unknown, new Set(["live"]));
  assert.deepEqual(needing, []);
  const guarded = reconcileTranscriptDeliveries([sent], [optimisticBubble], new Set(needing));
  assert.equal(guarded[0].status, "sending");

  // A message from before a reload (not live) is still recovered, and so is a
  // live one that has since given up as a client-side guess.
  assert.deepEqual(idsNeedingResumeCheck([sent], unknown, new Set()), ["live"]);
  const gaveUp = { ...sent, status: "failed", failureOrigin: "client" };
  assert.deepEqual(idsNeedingResumeCheck([gaveUp], unknown, new Set(["live"])), ["live"]);
});

test("blockWaiting holds every message still on its way, but leaves ones the engine already has", () => {
  let entries = [entry({ id: "a", now: 0 }), entry({ id: "b", now: 0 }), entry({ id: "c", now: 0 })];
  entries = applyOutcome(beginAttempt(entries, "b"), "b", { kind: "success", delivery: "queued" }, 1);
  entries = applyOutcome(beginAttempt(entries, "c"), "c", { kind: "retry", detail: "down" }, 1);
  assert.notEqual(entries[2].nextRetryAt, null);

  const held = blockWaiting(entries);
  assert.equal(held[0].blocked, true);
  assert.equal(held[1].blocked, undefined);
  assert.equal(held[1].status, "queued");
  // A scheduled retry is cancelled: the wait is for a model pick, not a timer.
  assert.equal(held[2].blocked, true);
  assert.equal(held[2].nextRetryAt, null);
  // Released by the pick, they go out once each.
  assert.deepEqual(releaseBlocked(held).ids, ["a", "c"]);
});

test("success moves an entry to started or queued and clears any error, without touching order", () => {
  let entries = [entry({ id: "a", now: 0, text: "first" }), entry({ id: "b", now: 0, text: "second" })];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "retry", detail: "down" }, 0);
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "success", delivery: "queued" }, 1_000);
  assert.deepEqual(entries.map((e) => [e.id, e.status]), [["a", "queued"], ["b", "sending"]]);
  assert.equal(entries[0].error, undefined);
  assert.equal(entries[0].nextRetryAt, null);
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

test("entries stay in send order through the whole lifecycle — nothing is silently reordered or dropped", () => {
  let entries = [];
  for (const id of ["a", "b", "c"]) entries = [...entries, entry({ id, text: id, now: 0 })];
  assert.deepEqual(entries.map((e) => e.id), ["a", "b", "c"]);

  entries = beginAttempt(entries, "b");
  entries = applyOutcome(entries, "b", { kind: "success", delivery: "started" }, 0);
  // Resolving "b" out of order (it started before "a" or "c" got a response)
  // still leaves every id in its original send position.
  assert.deepEqual(entries.map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(entries.map((e) => e.status), ["sending", "started", "sending"]);
});

test("server delivery updates a specific repeated-text id and a late ack cannot undo it", () => {
  let entries = [entry({ id: "a", text: "repeat", now: 0 }), entry({ id: "b", text: "repeat", now: 0 })];
  entries = applyServerDelivery(entries, "b", "delivered");
  entries = applyOutcome(entries, "b", { kind: "success", delivery: "queued" }, 1);
  assert.deepEqual(entries.map((item) => [item.id, item.status]), [["a", "sending"], ["b", "delivered"]]);
});

test("resume transcript reconciliation maps repeated text in acceptance order and ignores earlier messages", () => {
  const entries = [entry({ id: "a", text: "repeat", now: 10 }), entry({ id: "b", text: "repeat", now: 10 })];
  const result = reconcileTranscriptDeliveries(entries, [
    { role: "user", timestamp: 9, content: "repeat" },
    { role: "user", timestamp: 20, content: "repeat" },
    { role: "user", timestamp: 30, content: "repeat" },
  ]);
  assert.deepEqual(result.map((item) => [item.id, item.status]), [["a", "delivered"], ["b", "delivered"]]);
});

test("transcript reconciliation settles image-only sends by timestamp and image count", () => {
  const sent = createOutboxEntry({
    sessionId: "s1", id: "image-only", text: "", behavior: "steer", now: 10,
    images: [{ data: "AAAA", mimeType: "image/png" }],
  });
  const beforeSend = reconcileTranscriptDeliveries([sent], [
    { role: "user", timestamp: 9, content: [{ type: "image" }] },
  ]);
  assert.equal(beforeSend[0].status, "sending");
  const afterSend = reconcileTranscriptDeliveries([sent], [
    { role: "user", timestamp: 20, content: [{ type: "image" }] },
  ]);
  assert.equal(afterSend[0].status, "delivered");
});

test("transcript reconciliation resolves joined all-mode prompts but only unknown ids", () => {
  const first = { ...entry({ id: "known", text: "first", now: 10 }), status: "delivered" };
  const second = entry({ id: "unknown", text: "second", now: 20 });
  const result = reconcileTranscriptDeliveries([first, second], [
    { role: "user", timestamp: 30, content: "first\n\nsecond" },
  ], new Set(["unknown"]));
  assert.deepEqual(result.map((item) => [item.id, item.status]), [["known", "delivered"], ["unknown", "delivered"]]);
});

test("an expanded slash prompt is matched to its first later user message", () => {
  const slash = entry({ id: "slash", text: "/summarize", now: 10 });
  const result = reconcileTranscriptDeliveries([slash], [
    { role: "user", timestamp: 20, content: "Expanded prompt content" },
  ]);
  assert.equal(result[0].status, "delivered");
});

test("a server delivery proof can settle an entry that gave up as failed", () => {
  let entries = [entry({ id: "a", text: "hello", now: 0 })];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "retry", detail: "timed out" }, OUTBOX_RETRY_MAX_MS);
  assert.equal(entries[0].failureOrigin, "client");
  entries = applyServerDelivery(entries, "a", "delivered");
  assert.equal(entries[0].status, "delivered");
});

test("a late delivery transition cannot move an entry backwards", () => {
  let entries = [entry({ id: "a", text: "hello", now: 0 })];
  entries = applyServerDelivery(entries, "a", "started");
  entries = applyServerDelivery(entries, "a", "queued");
  assert.equal(entries[0].status, "started");
});

test("a server state replaces a client guess; server failure stays final until delivered", () => {
  let entries = [entry({ id: "a", now: 0, text: "hello" })];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "retry", detail: "network timeout" }, OUTBOX_RETRY_MAX_MS);
  assert.equal(entries[0].failureOrigin, "client");
  entries = applyServerDelivery(entries, "a", "queued");
  assert.deepEqual([entries[0].status, entries[0].failureOrigin], ["queued", undefined]);
  entries = applyServerDelivery(entries, "a", "failed", "server rejected delivery");
  entries = applyServerDelivery(entries, "a", "started");
  assert.deepEqual([entries[0].status, entries[0].failureOrigin], ["failed", "server"]);
  entries = applyServerDelivery(entries, "a", "delivered");
  assert.deepEqual([entries[0].status, entries[0].failureOrigin], ["delivered", undefined]);
});
test("normalizeOutboxText ignores incidental leading/trailing whitespace from the round trip", () => {
  assert.equal(normalizeOutboxText("  hi  "), "hi");
  assert.equal(normalizeOutboxText("hi"), normalizeOutboxText(" hi\n"));
});

// ---------------------------------------------------------------------------
// failed -> edit restores
// ---------------------------------------------------------------------------

test("restoreForEdit hands back a failed entry's exact text and images, and removes it", () => {
  let entries = [
    entry({ id: "a", text: "keep me", now: 0 }),
    createOutboxEntry({
      sessionId: "s1", id: "b", text: "fix this", behavior: "followUp", now: 0,
      images: [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }],
    }),
  ];
  entries = beginAttempt(entries, "b");
  entries = applyOutcome(entries, "b", { kind: "failed", detail: "message too large", origin: "server" }, 0);

  const { entry: restored, entries: remaining } = restoreForEdit(entries, "b");
  assert.equal(restored.text, "fix this");
  assert.equal(restored.behavior, "followUp");
  assert.deepEqual(restored.images, [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }]);
  assert.equal(restored.error, "message too large");
  assert.deepEqual(remaining.map((e) => e.id), ["a"]);
});

test("restoreForEdit on an unknown id is a safe no-op", () => {
  const entries = [entry({ id: "a", now: 0 })];
  const { entry: restored, entries: remaining } = restoreForEdit(entries, "missing");
  assert.equal(restored, null);
  assert.deepEqual(remaining, entries);
});

test("retryEntry re-arms a failed entry under a fresh clientMessageId, keeping its content and a full budget", () => {
  let entries = [{ ...entry({ id: "a", now: 0, text: "fix this" }), images: [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }] }];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "failed", detail: "down", origin: "server" }, 0);
  assert.equal(entries[0].status, "failed");

  const retried = retryEntry(entries, "a", 500_000, "b");
  // The engine refused id "a" and the server remembers that refusal, so a
  // retry under "a" would only rejoin it: a manual Retry is a new delivery.
  assert.deepEqual(retried.map((item) => [item.id, item.status]), [["a", "failed"], ["b", "sending"]]);
  assert.equal(retried[0].failureOrigin, "server");
  assert.equal(retried[1].text, "fix this");
  assert.deepEqual(retried[1].images, [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }]);
  assert.equal(retried[1].status, "sending");
  assert.equal(retried[1].attempt, 0);
  assert.equal(retried[1].error, undefined);
  // A retry that immediately fails again gets the FULL budget from `now`,
  // not the original (already-expired) streak.
  assert.equal(shouldGiveUpRetrying(retried[1], 500_000 + OUTBOX_RETRY_MAX_MS - 1), false);
});

// ---------------------------------------------------------------------------
// resume after reload / session-switch-back
// ---------------------------------------------------------------------------

test("reviveForResume drops delivered entries, keeps failed ones failed, and re-arms the rest", () => {
  const entries = [
    entry({ id: "sending", now: 0, text: "a" }),
    { ...entry({ id: "queued", now: 0, text: "b" }), status: "queued" },
    { ...entry({ id: "started", now: 0, text: "c" }), status: "started" },
    { ...entry({ id: "failed", now: 0, text: "d" }), status: "failed", error: "gave up", failureOrigin: "server" },
    { ...entry({ id: "client-failed", now: 0, text: "e" }), status: "failed", error: "network timeout", failureOrigin: "client" },
    { ...entry({ id: "delivered", now: 0, text: "e" }), status: "delivered" },
  ];
  const revived = reviveForResume(entries, 999_000);
  assert.deepEqual(revived.map((e) => e.id), ["sending", "queued", "started", "failed", "client-failed"]);
  const byId = Object.fromEntries(revived.map((e) => [e.id, e]));
  assert.equal(byId.sending.status, "sending");
  assert.equal(byId.queued.status, "sending");
  assert.equal(byId.started.status, "sending");
  assert.equal(byId.failed.status, "failed");
  assert.equal(byId.failed.error, "gave up");
  assert.equal(byId.failed.failureOrigin, "server");
  assert.equal(byId["client-failed"].status, "sending");
  assert.equal(byId["client-failed"].failureOrigin, undefined);
  // Every revived (non-failed) entry gets a fresh streak from the resume
  // moment, not the stale pre-reload clock.
  assert.equal(byId.sending.retryingSince, 999_000);
  assert.equal(byId.queued.retryingSince, 999_000);
  assert.equal(byId.started.retryingSince, 999_000);
});

// ---------------------------------------------------------------------------
// persistence round-trip
// ---------------------------------------------------------------------------

test("serialize/deserialize round-trips an entry losslessly", () => {
  const original = createOutboxEntry({
    sessionId: "s1", id: "a", text: "hello", behavior: "steer", now: 42,
    images: [{ data: "AAAA", mimeType: "image/png" }],
  });
  const roundTripped = deserializeOutboxEntries(serializeOutboxEntries([original]));
  assert.deepEqual(roundTripped, [original]);
});

test("deserialize degrades corrupt or foreign JSON to an empty outbox instead of throwing", () => {
  assert.deepEqual(deserializeOutboxEntries("not json"), []);
  assert.deepEqual(deserializeOutboxEntries("{}"), []);
  assert.deepEqual(deserializeOutboxEntries(JSON.stringify({ steering: [], followUp: [] })), []);
  // One well-formed entry survives alongside a garbage sibling.
  const good = createOutboxEntry({ sessionId: "s1", id: "a", text: "hi", behavior: "steer", now: 0 });
  const mixed = JSON.stringify([good, { not: "an entry" }, null, "garbage"]);
  assert.deepEqual(deserializeOutboxEntries(mixed), [good]);
});

test("createClientMessageId produces distinct, non-empty ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => createClientMessageId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id.length > 0);
});

// sessionStorage-backed persistence needs a browser-like global; Node's test
// runner has none, so a tiny in-memory shim stands in for it here — the same
// shape lib/outbox.ts already treats sessionStorage through.
function installSessionStorageShim() {
  const store = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
  return store;
}

test("persistOutbox/readPersistedOutbox round-trip through sessionStorage and skip delivered entries", () => {
  const store = installSessionStorageShim();
  try {
    const sending = createOutboxEntry({ sessionId: "s1", id: "a", text: "hi", behavior: "steer", now: 0 });
    const delivered = { ...createOutboxEntry({ sessionId: "s1", id: "b", text: "bye", behavior: "steer", now: 0 }), status: "delivered" };
    persistOutbox("s1", [sending, delivered]);
    assert.deepEqual(readPersistedOutbox("s1"), [sending]);

    clearPersistedOutbox("s1");
    assert.deepEqual(readPersistedOutbox("s1"), []);
    assert.equal(store.size, 0);
  } finally {
    delete globalThis.window;
  }
});

test("persistOutbox degrades large image payloads (oldest first) rather than losing the outbox entirely", () => {
  installSessionStorageShim();
  try {
    const big = "A".repeat(3_100_000);
    const small = "B".repeat(20_000);
    const oldWithImage = createOutboxEntry({
      sessionId: "s1", id: "old", text: "first", behavior: "steer", now: 0,
      images: [{ data: big, mimeType: "image/png" }],
    });
    const newWithImage = createOutboxEntry({
      sessionId: "s1", id: "new", text: "second", behavior: "followUp", now: 1,
      images: [{ data: small, mimeType: "image/png" }],
    });
    persistOutbox("s1", [oldWithImage, newWithImage]);
    const persisted = readPersistedOutbox("s1");
    // Both entries survive; only the OLDEST one's image was dropped to fit
    // the bound — the newer, much smaller image needed no trimming at all.
    assert.deepEqual(persisted.map((e) => e.id), ["old", "new"]);
    assert.deepEqual(persisted.find((e) => e.id === "old").images, []);
    assert.deepEqual(persisted.find((e) => e.id === "new").images, [{ data: small, mimeType: "image/png" }]);
  } finally {
    delete globalThis.window;
  }
});

test("mutatePersistedOutbox reads, applies, and persists in one call", () => {
  installSessionStorageShim();
  try {
    const first = createOutboxEntry({ sessionId: "s1", id: "a", text: "hi", behavior: "steer", now: 0 });
    persistOutbox("s1", [first]);

    const result = mutatePersistedOutbox("s1", (entries) => applyOutcome(entries, "a", { kind: "success", delivery: "started" }, 1));
    assert.equal(result[0].status, "started");
    // The mutation actually landed in storage, not just the return value.
    assert.equal(readPersistedOutbox("s1")[0].status, "started");
  } finally {
    delete globalThis.window;
  }
});
