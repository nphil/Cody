import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  adoptGoal, continuationModesOf, formatGoalDuration, goalAgeMs, goalAutoContinues, goalControls, goalElapsedSeconds, goalErrorKey,
  goalFromPersistedMode, goalTokenFraction, nextContinuationModes, parseGoalCommand, parseGoalModeState, parseTokenBudget,
  readGoalUpdate,
} = await jiti.import("./goal-state.ts");

/** The shape omp 18.7 answered in a live probe, trimmed to what matters. */
function engineGoal(overrides = {}) {
  return {
    id: "159c2320c4e1aca2",
    objective: "ship the thing",
    status: "active",
    tokenBudget: 5000,
    tokensUsed: 250,
    timeUsedSeconds: 3,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function engineState(goalOverrides = {}, stateOverrides = {}) {
  return { enabled: true, mode: "active", goal: engineGoal(goalOverrides), ...stateOverrides };
}

function view(state, receivedAt = 10_000, ageMs = 0) {
  return { state: parseGoalModeState(state), receivedAt, ageMs };
}

test("reads what the engine reports and refuses what it cannot trust", () => {
  const parsed = parseGoalModeState(engineState());
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.goal.objective, "ship the thing");
  assert.equal(parsed.goal.tokenBudget, 5000);

  assert.equal(parseGoalModeState(null), null);
  assert.equal(parseGoalModeState({ enabled: true, goal: { ...engineGoal(), id: undefined } }), null);
  assert.equal(parseGoalModeState(engineState({ status: "constructor" })), null, "a status the engine never sends is not a goal");
  // A budget that is not a positive whole number is no budget, not a bar stuck at 0%.
  assert.equal(parseGoalModeState(engineState({ tokenBudget: 0 })).goal.tokenBudget, undefined);
  assert.equal(parseGoalModeState(engineState({ tokenBudget: 1.5 })).goal.tokenBudget, undefined);
  assert.equal(parseGoalModeState(engineState({ tokensUsed: -4 })).goal.tokensUsed, 0);
});

test("a goal_updated frame is read from its state, or from its goal alone", () => {
  assert.equal(readGoalUpdate({ goal: engineGoal(), state: engineState() }).goal.id, "159c2320c4e1aca2");
  const goalOnly = readGoalUpdate({ goal: engineGoal({ status: "paused" }) });
  assert.deepEqual([goalOnly.enabled, goalOnly.goal.status], [false, "paused"]);
  const completed = readGoalUpdate({ goal: engineGoal({ status: "complete" }) });
  assert.deepEqual([completed.enabled, completed.mode], [false, "exiting"]);
  assert.equal(readGoalUpdate({ goal: null }), null, "the engine says there is no goal");
  assert.equal(readGoalUpdate({ goal: "nonsense" }), undefined, "an unreadable frame changes nothing");
});

test("a finished goal's card survives the engine clearing its state, everything else does not", () => {
  const finished = adoptGoal(null, { state: parseGoalModeState(engineState({ status: "complete" }, { enabled: false, mode: "exiting", reason: "completed" })), now: 5 });
  assert.equal(finished.state.goal.status, "complete");
  // The engine drops its state at the end of the turn without an event: get_state then says null.
  assert.equal(adoptGoal(finished, { state: null, now: 6 }), finished);
  assert.equal(adoptGoal(view(engineState()), { state: null, now: 6 }), null);
  assert.equal(adoptGoal(view(engineState()), { state: parseGoalModeState(engineState({ status: "dropped" }, { enabled: false })), now: 6 }), null);
  // A new goal replaces the finished card.
  const next = adoptGoal(finished, { state: parseGoalModeState(engineState({ id: "another", updatedAt: 9_000 })), now: 7 });
  assert.equal(next.state.goal.id, "another");
});

test("reports that arrive out of order never move a goal backwards", () => {
  const current = view(engineState({ updatedAt: 5_000, tokensUsed: 750 }));
  const older = parseGoalModeState(engineState({ updatedAt: 4_000, tokensUsed: 500 }));
  assert.equal(adoptGoal(current, { state: older, now: 20_000 }), current);
  const sameStampFewerTokens = parseGoalModeState(engineState({ updatedAt: 5_000, tokensUsed: 500 }));
  assert.equal(adoptGoal(current, { state: sameStampFewerTokens, now: 20_000 }), current);
  const newer = parseGoalModeState(engineState({ updatedAt: 6_000, tokensUsed: 1_000 }));
  assert.equal(adoptGoal(current, { state: newer, now: 20_000 }).state.goal.tokensUsed, 1_000);
  // The engine can stamp "active" and "complete" in the same millisecond; the late poll must not undo completion.
  const complete = view(engineState({ status: "complete", updatedAt: 5_000 }, { enabled: false, mode: "exiting" }));
  assert.equal(adoptGoal(complete, { state: parseGoalModeState(engineState({ updatedAt: 5_000 })), now: 20_000 }), complete);
});

test("time keeps ticking between the engine's flushes, but only while the goal is being worked", () => {
  const active = view(engineState({ timeUsedSeconds: 40 }), 10_000, 2_500);
  assert.equal(goalElapsedSeconds(active, 10_000), 42, "the idle gap before this snapshot counts");
  assert.equal(goalElapsedSeconds(active, 15_100), 47);
  assert.equal(goalElapsedSeconds(active, 9_000), 42, "a clock that stepped back never shows less than the engine said");

  const limited = view(engineState({ status: "budget-limited", timeUsedSeconds: 10 }), 0, 0);
  assert.equal(goalElapsedSeconds(limited, 3_000), 13, "a goal over budget is still being timed");

  const paused = view(engineState({ status: "paused", timeUsedSeconds: 10 }, { enabled: false }), 0, 0);
  assert.equal(goalElapsedSeconds(paused, 60_000), 10);
  const finished = view(engineState({ status: "complete", timeUsedSeconds: 10 }, { enabled: false, mode: "exiting" }), 0, 0);
  assert.equal(goalElapsedSeconds(finished, 60_000), 10);
});

test("the server reports how long the engine has been waiting to count a goal's time", () => {
  const state = parseGoalModeState(engineState({ updatedAt: 100_000 }));
  assert.equal(goalAgeMs(state, 107_500), 7_500);
  assert.equal(goalAgeMs(state, 90_000), 0);
  assert.equal(goalAgeMs(parseGoalModeState(engineState({ status: "paused", updatedAt: 100_000 }, { enabled: false })), 107_500), 0);
  assert.equal(goalAgeMs(null, 107_500), 0);
});

test("durations read at a glance", () => {
  assert.deepEqual([0, 7, 59, 60, 307, 3_599, 3_600, 3_900, 90_000].map(formatGoalDuration), ["0s", "7s", "59s", "1m 00s", "5m 07s", "59m 59s", "1h 00m", "1h 05m", "25h 00m"]);
  assert.equal(formatGoalDuration(-5), "0s");
});

test("the budget bar fills to 100% and no further, and only exists with a budget", () => {
  assert.equal(goalTokenFraction(parseGoalModeState(engineState({ tokensUsed: 1250, tokenBudget: 5000 })).goal), 0.25);
  assert.equal(goalTokenFraction(parseGoalModeState(engineState({ tokensUsed: 9000, tokenBudget: 5000 })).goal), 1);
  assert.equal(goalTokenFraction(parseGoalModeState(engineState({ tokenBudget: undefined })).goal), null);
});

test("each status offers exactly the buttons that do something", () => {
  assert.deepEqual(goalControls("active"), { pause: true, resume: false, drop: true, dismiss: false });
  assert.deepEqual(goalControls("paused"), { pause: false, resume: true, drop: true, dismiss: false });
  // Resume leaves a budget-limited goal untouched and the budget cannot be raised over RPC.
  assert.deepEqual(goalControls("budget-limited"), { pause: false, resume: false, drop: true, dismiss: false });
  assert.deepEqual(goalControls("complete"), { pause: false, resume: false, drop: false, dismiss: true });
  assert.deepEqual(goalControls("dropped"), { pause: false, resume: false, drop: false, dismiss: false });
});

test("/goal takes an optional leading budget and treats the rest as the objective", () => {
  assert.deepEqual(parseGoalCommand("  ship the export  "), { ok: true, value: { objective: "ship the export" } });
  assert.deepEqual(parseGoalCommand("--budget 200k ship it"), { ok: true, value: { objective: "ship it", tokenBudget: 200_000 } });
  assert.deepEqual(parseGoalCommand("--budget=1.5m  fix\nthe build"), { ok: true, value: { objective: "fix\nthe build", tokenBudget: 1_500_000 } });
  assert.deepEqual(parseGoalCommand("--budget 200,000 ship it"), { ok: true, value: { objective: "ship it", tokenBudget: 200_000 } });
  assert.deepEqual(parseGoalCommand("--budget 5000 a --budget 7 b"), { ok: true, value: { objective: "a --budget 7 b", tokenBudget: 5000 } });
  // Only a leading flag is a flag; a word that merely starts with it is part of the objective.
  assert.deepEqual(parseGoalCommand("--budgets are tight"), { ok: true, value: { objective: "--budgets are tight" } });
  assert.deepEqual(parseGoalCommand("ship it --budget 5"), { ok: true, value: { objective: "ship it --budget 5" } });

  assert.deepEqual(parseGoalCommand("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseGoalCommand("--budget 200k"), { ok: false, reason: "empty" });
  for (const bad of ["--budget", "--budget 0 x", "--budget 1.5 x", "--budget -5 x", "--budget lots x", "--budget 1e9 x"]) {
    assert.deepEqual(parseGoalCommand(bad), { ok: false, reason: "budget" }, bad);
  }
});

test("a token budget must come out as a whole number above zero", () => {
  assert.equal(parseTokenBudget("200k"), 200_000);
  assert.equal(parseTokenBudget("2M"), 2_000_000);
  assert.equal(parseTokenBudget("0.0005m"), 500);
  assert.equal(parseTokenBudget("0.0004k"), null, "a fraction of a token is not a budget");
  assert.equal(parseTokenBudget("0k"), null);
  assert.equal(parseTokenBudget("99999999999999999999"), null);
});

test("Keep working automatically adds or removes only the rpc mode", () => {
  // Absent means omp's own default: ["interactive"].
  assert.deepEqual(continuationModesOf(undefined), ["interactive"]);
  assert.deepEqual(continuationModesOf(["interactive", 4]), ["interactive"], "a malformed value reads as the default");
  assert.equal(goalAutoContinues(undefined), false);
  assert.equal(goalAutoContinues(["interactive", "rpc"]), true);

  assert.deepEqual(nextContinuationModes(undefined, true), ["interactive", "rpc"]);
  assert.deepEqual(nextContinuationModes(["interactive", "other"], true), ["interactive", "other", "rpc"]);
  assert.equal(nextContinuationModes(["interactive", "rpc"], true), undefined, "already on: nothing to write");
  assert.equal(nextContinuationModes(undefined, false), undefined, "already off: nothing to write");
  // Back to omp's default means removing the key, not writing a copy of the default.
  assert.equal(nextContinuationModes(["interactive", "rpc"], false), null);
  assert.deepEqual(nextContinuationModes(["rpc"], false), [], "someone who had turned the terminal mode off keeps it off");
  assert.deepEqual(nextContinuationModes(["interactive", "rpc", "other"], false), ["interactive", "other"]);
});

test("a chat nobody is running shows the goal its file left, as omp would reopen it", () => {
  const goal = engineGoal({ updatedAt: 3_000 });
  const active = goalFromPersistedMode("goal", { goal });
  assert.deepEqual([active.enabled, active.goal.status], [false, "paused"], "omp pauses an active goal when it opens the file");
  assert.deepEqual([goalFromPersistedMode("goal_paused", { goal: { ...goal, status: "paused" } }).goal.status], ["paused"]);
  const limited = goalFromPersistedMode("goal", { goal: { ...goal, status: "budget-limited" } });
  assert.deepEqual([limited.enabled, limited.goal.status], [true, "budget-limited"]);
  assert.equal(goalFromPersistedMode("none", undefined), null);
  assert.equal(goalFromPersistedMode("plan", { goal }), null);
  assert.equal(goalFromPersistedMode("goal", { goal: { ...goal, status: "complete" } }), null);
  assert.equal(goalFromPersistedMode("goal", { goal: { objective: "no id" } }), null);
});

test("the refusals worth translating are told apart from the ones shown as the engine said them", () => {
  // The strings omp 18.7 answered in a live probe.
  assert.equal(goalErrorKey("Goal mode is disabled (goal.enabled)."), "goal.disabled");
  assert.equal(goalErrorKey("A goal is already active. Drop it before creating another."), "goal.alreadyActive");
  assert.equal(goalErrorKey("Resume or drop the paused goal before creating another."), "goal.alreadyActive");
  assert.equal(goalErrorKey("Exit plan mode before starting a goal."), null);
  assert.equal(goalErrorKey("No paused goal to resume."), null);
});
