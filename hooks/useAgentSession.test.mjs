import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Self-healing chat turn state, pinned at the seam.
 *
 * The decisions themselves are pure and tested in lib/stream-recovery.test.mjs;
 * what cannot be unit-tested without a DOM is the WIRING inside this hook — and
 * the wiring is where the wedge lived. These are source-contract tests (the
 * house style of lib/rpc-manager.test.mjs) covering the three paths that must
 * never silently wait forever again.
 */

const hook = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [
    name,
    JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8")),
  ])),
);

test("a connected frame reporting an idle engine settles the believed-running turn", () => {
  assert.match(hook, /shouldClearLostTurn\(agentRunningRef\.current && runConfirmedRef\.current, event\)/);
  assert.match(hook, /lostTurnRecoveryRef\.current\?\.\(sid\)/);
  // The recovery settles the run through the same path a missed agent_end takes
  // and raises a banner — it does not merely flip a flag.
  const recovery = hook.slice(
    hook.indexOf("lostTurnRecoveryRef.current = (sid: string)"),
    hook.indexOf("const waitForPromptSettlement"),
  );
  assert.match(recovery, /setStreamAlert\(\{ kind: "turn_lost" \}\)/);
  assert.match(recovery, /finishPromptWithoutStream\(sid, promptRunIdRef\.current\)/);
});

test("a lost turn is never auto-resent", () => {
  // Re-sending a mutating instruction the user cannot see is worse than losing
  // it: the recovery path must not reach for the prompt command.
  const recovery = hook.slice(
    hook.indexOf("lostTurnRecoveryRef.current = (sid: string)"),
    hook.indexOf("const waitForPromptSettlement"),
  );
  assert.doesNotMatch(recovery, /sendAgentCommand/);
  assert.doesNotMatch(recovery, /type: "prompt"/);
});

test("an optimistic send cannot be mistaken for a lost turn", () => {
  // handleSend flips agentRunning BEFORE opening the stream and posting the
  // prompt, so that connection's connected frame honestly reports idle. Only a
  // server-acknowledged run may be declared lost.
  const send = hook.slice(hook.indexOf("const handleSend = useCallback"), hook.indexOf("const handleAbort"));
  assert.match(send, /runConfirmedRef\.current = false/);
  const agentStart = hook.slice(hook.indexOf('case "agent_start":'), hook.indexOf('case "agent_end":'));
  assert.match(agentStart, /runConfirmedRef\.current = true/);
  // A page load onto an already-streaming session counts as acknowledged too.
  assert.equal(hook.match(/runConfirmedRef\.current = true/g).length, 2);
});

test("the fatal-error reconnect backs off and gives up instead of looping", () => {
  const onerror = hook.slice(hook.indexOf("es.onerror = () => {"), hook.indexOf("const respondToExtensionUi"));
  assert.match(onerror, /shouldGiveUpReconnecting\(reconnectFailingSinceRef\.current, now\)/);
  assert.match(onerror, /setStreamAlert\(\{ kind: "stream_lost" \}\)/);
  assert.match(onerror, /reconnectDelayMs\(reconnectAttemptRef\.current\)/);
  assert.match(onerror, /reconnectAttemptRef\.current \+= 1/);
  assert.match(onerror, /\}, retryDelay\)/);
  // The old fixed 1000ms retry is gone.
  assert.doesNotMatch(onerror, /\}, 1000\)/);
  // A successful connection ends the streak, so a flapping-but-recovering
  // stream never exhausts the budget.
  assert.match(hook, /reconnectAttemptRef\.current = 0;\s*\n\s*reconnectFailingSinceRef\.current = null;/);
});

test("the watchdog runs off believed-running state and per-connection liveness", () => {
  const watchdog = hook.slice(
    hook.indexOf("const tick = () => {"),
    hook.indexOf("}, [agentRunning]);", hook.indexOf("const tick = () => {")),
  );
  assert.match(watchdog, /evaluateStreamHealth\(\{/);
  assert.match(watchdog, /readyState: eventSourceRef\.current\?\.readyState \?\? null/);
  assert.match(watchdog, /framesSeen: streamFramesRef\.current/);
  assert.match(watchdog, /setStreamDegraded\(health\.degraded\)/);
  // Frame counting is per connection: connectEvents resets it, onmessage bumps
  // it before parsing so even an unparseable frame proves liveness.
  const connect = hook.slice(hook.indexOf("const connectEvents = useCallback"), hook.indexOf("es.onerror = () => {"));
  assert.match(connect, /streamFramesRef\.current = 0/);
  assert.match(connect, /streamFramesRef\.current \+= 1;\s*\n\s*try \{/);
});

test("the degraded and lost states reach the UI with a retry affordance", () => {
  assert.match(hook, /streamDegraded, streamAlert, dismissStreamAlert, retryEventStream,/);
  const retry = hook.slice(hook.indexOf("const retryEventStream = useCallback"), hook.indexOf("const dismissStreamAlert"));
  assert.match(retry, /reconnectAttemptRef\.current = 0/);
  assert.match(retry, /reconnectFailingSinceRef\.current = null/);
  assert.match(retry, /connectEvents\(sid\)/);
  // Re-register what lived on the old connection, and re-check the run: the
  // stream may have been down across a turn that already ended.
  assert.match(retry, /reconnectActionsRef\.current\?\.\(sid\)/);
  assert.match(retry, /reconcileAgentState\(sid\)/);

  // The plain "Waiting for model…" label must not survive a degraded stream,
  // and an exhausted retry loop must not keep claiming to be reconnecting.
  assert.match(chatWindow, /streamAlert\?\.kind === "stream_lost"\s*\n\s*\? t\("agentStream\.disconnected"\)\s*\n\s*: streamDegraded\s*\n\s*\? t\("agentStream\.reconnecting"\)\s*\n\s*: phaseLabel\(agentPhase\)/);
  assert.match(chatWindow, /<StreamAlertBanner/);
  assert.match(chatWindow, /onRetry=\{retryEventStream\}/);
  assert.match(chatWindow, /onDismiss=\{dismissStreamAlert\}/);
});

test("a send that never lands clears the turn and raises a banner", () => {
  // The wedge: the prompt POST hung (an oversized frame was chunked toward an
  // omp that cannot reassemble), nothing ever answered, and the composer sat on
  // "Waiting for model…". The POST is an ack — cap it, and treat any failure as
  // "this turn never started".
  const send = hook.slice(hook.indexOf("const handleSend = useCallback"), hook.indexOf("const handleInterruptAndReply"));
  assert.match(send, /timeoutMs: PROMPT_SEND_TIMEOUT_MS/);
  assert.equal(send.match(/timeoutMs: PROMPT_SEND_TIMEOUT_MS/g).length, 2, "both prompt POSTs are capped");
  assert.match(hook, /const PROMPT_SEND_TIMEOUT_MS = 30_000;/);

  const failure = send.slice(send.indexOf("} catch (e) {"));
  assert.match(failure, /setStreamAlert\(\{ kind: "send_failed", detail \}\)/);
  assert.match(failure, /agentRunningRef\.current = false/);
  assert.match(failure, /setAgentRunning\(false\)/);
  assert.match(failure, /setAgentPhase\(null\)/);
  assert.match(failure, /dispatch\(\{ type: "end" \}\)/);
  // Never silently repeat a mutating instruction the user cannot see.
  assert.doesNotMatch(failure, /sendAgentCommand/);

  // The interrupt-and-reply path posts the same kind of ack and fails the same way.
  const interrupt = hook.slice(hook.indexOf("const handleInterruptAndReply = useCallback"), hook.indexOf("const executeBash = useCallback"));
  assert.match(interrupt, /timeoutMs: PROMPT_SEND_TIMEOUT_MS/);
  assert.match(interrupt, /setStreamAlert\(\{ kind: "send_failed", detail \}\)/);
});

test("the send-failure banner shows why, and offers no retry button", () => {
  assert.match(hook, /\| \{ kind: "send_failed"; detail\?: string \}/);
  assert.match(chatWindow, /alert\.kind === "send_failed"/);
  assert.match(chatWindow, /t\("agentStream\.sendFailed"\)/);
  // The reason (a named too-large attachment, a timeout) is the actionable half.
  assert.match(chatWindow, /alert\.detail/);
  // Only a lost stream gets the reconnect action; a refused send has nothing to retry.
  assert.match(chatWindow, /alert\.kind === "stream_lost" && \(/);
});

test("a send failure the transport refused arrives with a localized reason", async () => {
  // The transport rejects an oversized frame with RpcCommandError(code
  // frame_too_large); the route maps any RpcCommandError to 400 + code, and the
  // client renders errors.<code> from the dictionary.
  const process = await readFile(new URL("../lib/omp/rpc-process.ts", import.meta.url), "utf8");
  assert.match(process, /new RpcCommandError\(frame\.type, error\.message, "frame_too_large"\)/);
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /error instanceof RpcCommandError[\s\S]*code: error\.code \?\? "rpc_command_failed"[\s\S]*status: 400/);
  const client = await readFile(new URL("../lib/agent-client.ts", import.meta.url), "utf8");
  assert.match(client, /formatApiError\(body\)/);
  assert.match(client, /controller\?\.signal\.aborted/);
  for (const [name, dictionary] of Object.entries(locales)) {
    assert.equal(typeof dictionary["errors.frame_too_large"], "string", `${name} cannot explain frame_too_large`);
  }
});

test("the new stream copy is translated in all three locales", () => {
  const keys = [
    "agentStream.disconnected",
    "agentStream.dismiss",
    "agentStream.reconnecting",
    "agentStream.retry",
    "agentStream.sendFailed",
    "agentStream.streamLost",
    "agentStream.turnLost",
    "chatInput.attachmentsTooLarge",
    "chatInput.attachmentsTooLargeNamed",
    "chatInput.imagePreparing",
    "chatInput.imageReadFailed",
    "chatInput.imageUndecodable",
    "chatInput.messageTooLarge",
    "errors.frame_too_large",
    "errors.request_timed_out",
  ];
  for (const key of keys) {
    for (const [name, dictionary] of Object.entries(locales)) {
      assert.equal(typeof dictionary[key], "string", `${name} is missing ${key}`);
      assert.ok(dictionary[key].trim().length > 0, `${name}:${key} is empty`);
    }
    // Real translations, not English copied across.
    assert.notEqual(locales.ja[key], locales.en[key], `ja:${key} was not translated`);
    assert.notEqual(locales["zh-CN"][key], locales.en[key], `zh-CN:${key} was not translated`);
  }
});

test("long tool calls surface streamed progress and an elapsed clock", () => {
  // omp's gh run_watch (often invoked through `write xd://github`) blocks for
  // an entire CI run while streaming per-poll snapshots. Dropping those
  // frames made the watch indistinguishable from a hang — pin the wiring.
  assert.match(hook, /case "tool_execution_update":/, "the update frame must be handled, not ignored");
  assert.match(hook, /toolUpdateStatusText\(event\.partialResult\)/, "status text comes from the frame's partialResult");
  assert.match(hook, /startedAt: Date\.now\(\)/, "tool_execution_start must stamp a start time");
  assert.match(chatWindow, /phaseElapsed\(agentPhase, toolClockNow\)/, "the elapsed clock renders against the ticking clock");
  assert.match(chatWindow, /LONG_TOOL_THRESHOLD_MS/, "elapsed shows only past the long-call threshold");
  assert.match(chatWindow, /formatToolElapsed/, "elapsed is rendered, not just tracked");
  // The tick must NOT ride through the crossfade: a per-second text change
  // there re-animates the entire status line (user-visible flicker).
  assert.doesNotMatch(chatWindow, /phaseLabel\(agentPhase, toolClockNow\)/, "the crossfaded label must not contain the ticking clock");
});
