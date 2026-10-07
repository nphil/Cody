import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { forkChat, isForkUnsupported, resetForkSupport, subscribeForkSupport } = await jiti.import("./fork-session.ts");
const { AgentCommandError } = await jiti.import("./agent-client.ts");

test("forking asks for omp's own fork — at a reply, or the whole chat — and hands back the new chat", async () => {
  resetForkSupport();
  const sent = [];
  const send = async (sessionId, command) => { sent.push([sessionId, command]); return { cancelled: false, newSessionId: "copy-1" }; };
  assert.deepEqual(await forkChat("chat-1", "reply-7", send), { status: "forked", sessionId: "copy-1" });
  assert.deepEqual(await forkChat("chat-1", undefined, send), { status: "forked", sessionId: "copy-1" });
  assert.deepEqual(sent, [
    ["chat-1", { type: "fork_session", entryId: "reply-7" }],
    ["chat-1", { type: "fork_session" }],
  ]);
  assert.deepEqual(await forkChat("chat-1", "reply-7", async () => ({ cancelled: true })), { status: "cancelled" });
});

test("a busy chat is only busy, an omp without fork hides the controls for the page, and any other failure keeps its words", async () => {
  resetForkSupport();
  let told = 0;
  const unsubscribe = subscribeForkSupport(() => { told += 1; });
  try {
    const failWith = (error) => async () => { throw error; };
    assert.deepEqual(await forkChat("c", "e", failWith(new AgentCommandError("Wait for the current run to finish before forking this chat.", "session_busy"))), { status: "busy" });
    assert.equal(isForkUnsupported(), false, "busy is a moment, not a verdict");

    assert.deepEqual(await forkChat("c", "e", failWith(new AgentCommandError("Invalid entry ID for forking: e", "rpc_command_failed"))), { status: "failed", message: "Invalid entry ID for forking: e" });
    assert.equal(isForkUnsupported(), false);

    assert.deepEqual(await forkChat("c", "e", failWith(new AgentCommandError("Unknown command: fork", "rpc_command_failed"))), { status: "unsupported" });
    assert.equal(isForkUnsupported(), true);
    assert.deepEqual(await forkChat("c", undefined, failWith(new AgentCommandError("fork_session is not supported by this engine's RPC protocol", "unsupported"))), { status: "unsupported" });
    assert.equal(told, 1, "every control is told once, however many refusals follow");
  } finally {
    unsubscribe();
    resetForkSupport();
  }
});
