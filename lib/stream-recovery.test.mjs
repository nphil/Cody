import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  EVENT_SOURCE_OPEN,
  RECONNECT_GIVE_UP_MS,
  RECONNECT_MAX_DELAY_MS,
  STREAM_DEGRADED_AFTER_MS,
  evaluateStreamHealth,
  reconnectDelayMs,
  shouldClearLostTurn,
  shouldGiveUpReconnecting,
} = await jiti.import("./stream-recovery.ts");

// ---------------------------------------------------------------------------
// connected-frame reconciliation
// ---------------------------------------------------------------------------

test("a client waiting on an acknowledged turn clears it when the server reports idle", () => {
  // The wedge: the engine died mid-turn, the stream reconnected onto a freshly
  // resumed (idle) engine, and no agent_end will ever arrive for the dead turn.
  assert.equal(shouldClearLostTurn(true, { type: "connected", sessionId: "s", running: false }), true);
});

test("a still-running turn is left alone", () => {
  assert.equal(shouldClearLostTurn(true, { type: "connected", sessionId: "s", running: true }), false);
});

test("an idle client never clears anything", () => {
  // Includes the send path: handleSend opens the stream BEFORE posting the
  // prompt, so that connection's frame honestly says idle. Treating it as a
  // loss would cancel every send.
  assert.equal(shouldClearLostTurn(false, { type: "connected", sessionId: "s", running: false }), false);
});

test("a connected frame without the field is never read as idle", () => {
  // A server predating this contract must not be able to cancel live turns.
  assert.equal(shouldClearLostTurn(true, { type: "connected", sessionId: "s" }), false);
  assert.equal(shouldClearLostTurn(true, { type: "connected", running: undefined }), false);
  assert.equal(shouldClearLostTurn(true, { type: "connected", running: null }), false);
  assert.equal(shouldClearLostTurn(true, { type: "connected", running: 0 }), false);
  assert.equal(shouldClearLostTurn(true, { type: "connected", running: "false" }), false);
  assert.equal(shouldClearLostTurn(true, null), false);
  assert.equal(shouldClearLostTurn(true, "connected"), false);
});

// ---------------------------------------------------------------------------
// reconnect backoff
// ---------------------------------------------------------------------------

test("manual reconnects back off exponentially and cap", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs),
    [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000],
  );
  assert.equal(reconnectDelayMs(50), RECONNECT_MAX_DELAY_MS);
  // Never negative, never below the base delay — a hot retry loop is the bug
  // this replaced.
  assert.equal(reconnectDelayMs(-3), 1_000);
});

test("the retry loop stops after the consecutive-failure budget", () => {
  const start = 1_000_000;
  assert.equal(shouldGiveUpReconnecting(null, start), false, "no failure streak yet");
  assert.equal(shouldGiveUpReconnecting(start, start), false, "first failure keeps retrying");
  assert.equal(shouldGiveUpReconnecting(start, start + RECONNECT_GIVE_UP_MS - 1), false);
  assert.equal(shouldGiveUpReconnecting(start, start + RECONNECT_GIVE_UP_MS), true);
  assert.equal(RECONNECT_GIVE_UP_MS, 120_000, "~2 minutes of consecutive failures");
});

test("the capped backoff fits ~11 attempts inside the give-up budget", () => {
  // Guards against a cap so large that the UI gives up after one or two tries.
  let elapsed = 0;
  let attempts = 0;
  while (!shouldGiveUpReconnecting(0, elapsed)) {
    elapsed += reconnectDelayMs(attempts);
    attempts += 1;
  }
  assert.ok(attempts >= 8 && attempts <= 14, `expected a healthy retry count, got ${attempts}`);
});

// ---------------------------------------------------------------------------
// stream watchdog
// ---------------------------------------------------------------------------

const healthy = { agentRunning: true, readyState: EVENT_SOURCE_OPEN, framesSeen: 3, unhealthySince: null, now: 0 };

test("an open stream that has delivered frames is healthy", () => {
  assert.deepEqual(evaluateStreamHealth(healthy), { unhealthySince: null, degraded: false });
});

test("a long silent tool call on an open stream never trips the watchdog", () => {
  // The server's 30s heartbeat is an SSE comment onmessage never sees, so
  // "no frame recently" must NOT be the rule — only "no frame at all".
  const later = evaluateStreamHealth({ ...healthy, now: 10 * 60_000 });
  assert.equal(later.degraded, false);
  assert.equal(later.unhealthySince, null);
});

test("a stream that never delivered a frame is degraded once the grace elapses", () => {
  // Half-open connections sit in OPEN forever, which is why frame delivery —
  // not readyState alone — is the liveness signal.
  const opened = evaluateStreamHealth({ ...healthy, framesSeen: 0, now: 1_000 });
  assert.equal(opened.unhealthySince, 1_000);
  assert.equal(opened.degraded, false, "inside the grace period");

  const waiting = evaluateStreamHealth({
    ...healthy,
    framesSeen: 0,
    unhealthySince: 1_000,
    now: 1_000 + STREAM_DEGRADED_AFTER_MS - 1,
  });
  assert.equal(waiting.degraded, false);

  const degraded = evaluateStreamHealth({
    ...healthy,
    framesSeen: 0,
    unhealthySince: 1_000,
    now: 1_000 + STREAM_DEGRADED_AFTER_MS,
  });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.unhealthySince, 1_000, "the clock keeps running");
  assert.equal(STREAM_DEGRADED_AFTER_MS, 20_000);
});

test("a closed stream, or none at all, is unhealthy from the first tick", () => {
  for (const readyState of [0, 2, null]) {
    const first = evaluateStreamHealth({ ...healthy, readyState, now: 500 });
    assert.equal(first.unhealthySince, 500);
    const later = evaluateStreamHealth({
      ...healthy,
      readyState,
      unhealthySince: 500,
      now: 500 + STREAM_DEGRADED_AFTER_MS,
    });
    assert.equal(later.degraded, true, `readyState ${readyState} must degrade`);
  }
});

test("recovery clears the unhealthy clock so a flap cannot accumulate", () => {
  const recovered = evaluateStreamHealth({ ...healthy, unhealthySince: 1_000, now: 1_000_000 });
  assert.deepEqual(recovered, { unhealthySince: null, degraded: false });
});

test("no believed-running turn means nothing to warn about", () => {
  const idle = evaluateStreamHealth({
    ...healthy,
    agentRunning: false,
    readyState: null,
    framesSeen: 0,
    unhealthySince: 1_000,
    now: 1_000 + STREAM_DEGRADED_AFTER_MS * 10,
  });
  assert.equal(idle.degraded, false);
});
