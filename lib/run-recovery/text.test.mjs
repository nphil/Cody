import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The words Cody says when it picks a run up again. The agent reads the
 * prompt and acts on it, the owner reads the push on a phone: both are pinned
 * here, with times in the zone of the person they are for.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeCause, describeDuration, noticeBody, recoveryPrompt } = await jiti.import("./text.ts");

const ZONE = "America/New_York";
const at = (iso) => Date.parse(iso);
// 2026-10-09 is daylight time in New York: 06:31 UTC is 02:31 EDT.
const STARTED = at("2026-10-09T06:31:00Z");
const RESTARTED = at("2026-10-09T06:51:00Z");

const toolCause = { kind: "tool", tool: "edit", startedAt: STARTED, quietSince: STARTED, sinceMs: 20 * 60_000 };

test("durations read the way a person says them", () => {
  assert.equal(describeDuration(30_000), "1 minute");
  assert.equal(describeDuration(20 * 60_000), "20 minutes");
  assert.equal(describeDuration(60 * 60_000), "60 minutes");
  assert.equal(describeDuration(89 * 60_000), "89 minutes");
  assert.equal(describeDuration(90 * 60_000), "1.5 hours");
  assert.equal(describeDuration(3_600_000 * 7), "7 hours");
  assert.equal(describeDuration(100 * 60_000), "1.7 hours");
});

test("each cause names what went wrong, and a tool names itself and when it started", () => {
  assert.equal(describeCause(toolCause, ZONE), "`edit` had not answered for 20 minutes (it started at 2026-10-09 02:31 EDT)");
  assert.equal(describeCause({ kind: "engine_silent", quietSince: STARTED, sinceMs: 20 * 60_000 }, ZONE), "the engine had stopped answering for 20 minutes");
  assert.equal(describeCause({ kind: "quiet", quietSince: STARTED, sinceMs: 60 * 60_000 }, ZONE), "nothing had happened for 60 minutes");
  assert.equal(describeCause({ kind: "crash", exitedAt: at("2026-10-09T07:12:00Z") }, ZONE), "the engine process exited unexpectedly at 2026-10-09 03:12 EDT");
  assert.equal(
    describeCause({ kind: "restart", restartedAt: at("2026-10-09T08:41:00Z"), lastActivityAt: at("2026-10-09T08:40:00Z") }, ZONE),
    "Cody's server restarted at 2026-10-09 04:41 EDT while this chat was working (last activity 2026-10-09 04:40 EDT)",
  );
});

test("the recovery prompt says it is automatic, what happened, what was lost and what to do", () => {
  assert.equal(
    recoveryPrompt(toolCause, ZONE, RESTARTED),
    "This is an automatic message from Cody, not from the user. `edit` had not answered for 20 minutes (it started at 2026-10-09 02:31 EDT). "
      + "Cody restarted the engine at 2026-10-09 02:51 EDT. "
      + "Tool calls that were still running have unknown results, and any subagents or background jobs were stopped. "
      + "Check what actually finished (files, git, job output), then carry on with the task you were working on.",
  );
  assert.match(recoveryPrompt({ kind: "quiet", quietSince: STARTED, sinceMs: 60 * 60_000 }, ZONE, RESTARTED), /^This is an automatic message from Cody, not from the user\. Nothing had happened for 60 minutes\. /, "a cause that starts with a lower-case word still opens a sentence");
});

test("a recovery push says when it was stuck, what stuck, and that the agent was asked to carry on", () => {
  const done = "Cody restarted the engine at 2026-10-09 02:51 EDT and asked the agent to carry on.";
  assert.equal(noticeBody({ kind: "recovered", cause: toolCause, at: RESTARTED }, ZONE), `Stuck since 2026-10-09 02:31 EDT: \`edit\` never answered. ${done}`);
  assert.equal(
    noticeBody({ kind: "recovered", cause: { kind: "engine_silent", quietSince: STARTED, sinceMs: 20 * 60_000 }, at: RESTARTED }, ZONE),
    `Stuck since 2026-10-09 02:31 EDT: the engine stopped answering. ${done}`,
  );
  assert.equal(
    noticeBody({ kind: "recovered", cause: { kind: "quiet", quietSince: STARTED, sinceMs: 60 * 60_000 }, at: RESTARTED }, ZONE),
    `Stuck since 2026-10-09 02:31 EDT: nothing happened for 60 minutes. ${done}`,
  );
  assert.equal(
    noticeBody({ kind: "recovered", cause: { kind: "crash", exitedAt: at("2026-10-09T06:50:00Z") }, at: RESTARTED }, ZONE),
    `The engine exited unexpectedly at 2026-10-09 02:50 EDT. ${done}`,
  );
  assert.equal(
    noticeBody({ kind: "recovered", cause: { kind: "restart", restartedAt: at("2026-10-09T08:41:00Z"), lastActivityAt: at("2026-10-09T08:40:00Z") }, at: RESTARTED }, ZONE),
    "Cody restarted at 2026-10-09 04:41 EDT while this chat was working; it asked the agent to carry on.",
  );
});

test("giving up and not resuming each say why, and tell the person what to do", () => {
  assert.equal(
    noticeBody({ kind: "gave_up", count: 3 }, ZONE),
    "Cody restarted this chat's engine 3 times in 12 hours and stopped trying. Open the chat to continue.",
  );
  assert.equal(
    noticeBody({ kind: "not_resumed", lastActivityAt: STARTED, at: STARTED + 7 * 3_600_000 }, ZONE),
    "Not resumed: Cody restarted 7 hours after this chat last did anything (2026-10-09 02:31 EDT).",
  );
});

test("a time in a zone with no abbreviation is still spelled with its offset, never a bare UTC string", () => {
  assert.match(describeCause({ kind: "crash", exitedAt: at("2026-10-09T07:12:00Z") }, "Asia/Tokyo"), /at 2026-10-09 16:12 (JST|UTC\+09:00)$/);
});
