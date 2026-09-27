import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// jiti (not a plain import) because session-control-scope.ts now delegates
// classifyFallbackReason to lib/error-text.ts, a relative import a plain
// node --experimental-strip-types run can't resolve without an extension;
// hooks/fallback-reason.test.mjs already loads this same module through
// jiti for the same reason.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  fallbackAttributionForSubagent,
  isFastModeUnavailableError,
  pendingModelSwitchApplied,
  queueModelSwitch,
  releaseModelSwitchAtBoundary,
  resolveThinkingSelector,
  sameSessionControlScope,
  sessionControlScope,
} = await jiti.import("./session-control-scope.ts");

test("session controls reject replies from another session or model", () => {
  const origin = sessionControlScope("session-a", { provider: "anthropic", modelId: "claude" });

  assert.equal(sameSessionControlScope(origin, sessionControlScope("session-a", { provider: "anthropic", modelId: "claude" })), true);
  assert.equal(sameSessionControlScope(origin, sessionControlScope("session-b", { provider: "anthropic", modelId: "claude" })), false);
  assert.equal(sameSessionControlScope(origin, sessionControlScope("session-a", { provider: "anthropic", modelId: "other" })), false);
});

// omp's Auto is reported as {thinkingLevel: <effective>, configured: "auto"}
// on the event and as the bare effective level on every later snapshot.
test("the reasoning selector keeps Auto across effective-level snapshots until an explicit level is reported", () => {
  const auto = resolveThinkingSelector("high", "auto", false);
  assert.deepEqual(auto, { display: "auto", rememberedAuto: true });
  // A get_state snapshot carries only the effective level: still Auto.
  assert.deepEqual(resolveThinkingSelector("high", undefined, auto.rememberedAuto), { display: "auto", rememberedAuto: true });
  // An explicit pick's echo names the level and carries no configured field.
  const explicit = resolveThinkingSelector("high", undefined, false);
  assert.deepEqual(explicit, { display: "high", rememberedAuto: false });
  // The engine can also report an explicit configured level.
  assert.deepEqual(resolveThinkingSelector("medium", "medium", true), { display: "medium", rememberedAuto: false });
  // "inherit" and an absent level are Auto, as before.
  assert.equal(resolveThinkingSelector("inherit", undefined, false).display, "auto");
  assert.equal(resolveThinkingSelector(undefined, undefined, false).display, "auto");
});

test("only explicit Fast capability rejections disable Fast", () => {
  assert.equal(isFastModeUnavailableError(new Error("Fast mode is unavailable for the current model")), true);
  assert.equal(isFastModeUnavailableError({ code: "unsupported" }), true);
  assert.equal(isFastModeUnavailableError({ code: "unsupported", message: "unsupported command" }), true);
  assert.equal(isFastModeUnavailableError(new TypeError("Failed to fetch")), false);
  assert.equal(isFastModeUnavailableError(new Error("HTTP 503 upstream timed out")), false);
  assert.equal(isFastModeUnavailableError(new Error("unsupported command")), false);
});

test("a live model switch waits for a safe boundary before it sends", () => {
  const scope = sessionControlScope("session-a", { provider: "provider-a", modelId: "current" });
  const queued = queueModelSwitch(scope, { provider: "provider-b", modelId: "next", name: "Next" });

  const midStream = releaseModelSwitchAtBoundary(queued, scope, false);
  assert.equal(midStream.command, null, "no set_model command is released mid-stream");
  assert.equal(midStream.pending?.phase, "waiting");

  const atBoundary = releaseModelSwitchAtBoundary(midStream.pending, scope, true);
  assert.deepEqual(
    atBoundary.command && { provider: atBoundary.command.provider, modelId: atBoundary.command.modelId },
    { provider: "provider-b", modelId: "next" },
  );
  assert.equal(atBoundary.pending?.phase, "applying");
});

test("a newer live model pick replaces an older queued pick", () => {
  const scope = sessionControlScope("session-a", { provider: "provider-a", modelId: "current" });
  const older = queueModelSwitch(scope, { provider: "provider-b", modelId: "older", name: "Older" });
  const newer = queueModelSwitch(scope, { provider: "provider-c", modelId: "newer", name: "Newer" });

  assert.notEqual(newer.modelId, older.modelId);
  const released = releaseModelSwitchAtBoundary(newer, scope, true);
  assert.equal(released.command?.modelId, "newer");
  assert.equal(released.command?.provider, "provider-c");
});

test("a stale model reply is ignored after the user changes sessions", () => {
  const scope = sessionControlScope("session-a", { provider: "provider-a", modelId: "current" });
  const applying = releaseModelSwitchAtBoundary(
    queueModelSwitch(scope, { provider: "provider-b", modelId: "next", name: "Next" }),
    scope,
    true,
  ).pending;

  assert.equal(pendingModelSwitchApplied(applying, "session-b", { provider: "provider-b", modelId: "next" }), false);
  assert.equal(pendingModelSwitchApplied(applying, "session-a", { provider: "provider-a", modelId: "current" }), false);
  assert.equal(pendingModelSwitchApplied(applying, "session-a", { provider: "provider-b", modelId: "next" }), true);
});

test("a child's fallback is attributed to that subagent, not the main conversation", () => {
  const attribution = fallbackAttributionForSubagent("Scout", "default", [{ id: "Scout", agent: "task" }]);

  assert.deepEqual(attribution, {
    role: "default",
    job: {
      kind: "subagent",
      subagentId: "Scout",
      agent: "task",
      roleLabelKey: "agentSession.job.subagent",
    },
  });
});
