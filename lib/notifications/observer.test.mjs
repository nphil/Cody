import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The per-chat state machine, fed the frames a session really emits and the
 * clock it really runs on. It knows nothing about ntfy: what is pinned is which
 * notifications it asks for, and when it takes them back.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-observer-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const observerModule = await jiti.import("./observer.ts");
const { createSessionObserver, observeSessionForNotifications, FALLBACK_COALESCE_MS } = observerModule;

const T0 = 1_000_000;

function harness(overrides = {}) {
  const sent = [];
  const cleared = [];
  const turnEnds = [];
  let clock = T0;
  const session = { sessionId: "sess-1", sessionFile: "", cwd: "/work/my-project" };
  const observer = createSessionObserver(session, {
    now: () => clock,
    send: (draft) => {
      sent.push(draft);
      return { clear: () => cleared.push(draft.requestKey ?? `(${draft.event})`) };
    },
    noteTurnEnd: () => turnEnds.push(clock),
    describe: (_session, live) => ({ chatTitle: live ?? "Fix login", project: "my-project" }),
    ...overrides,
  });
  return {
    observer,
    session,
    sent,
    cleared,
    turnEnds,
    emit: (...frames) => frames.forEach((frame) => observer.handle(frame)),
    advance: (ms) => { clock += ms; },
  };
}

const request = (fields) => ({ type: "extension_ui_request", id: "r1", ...fields });
const toolApproval = (id = "r1") => request({ id, method: "confirm", title: "Allow tool: bash", message: "npm test" });
const assistant = (text, stopReason = "stop", extra = {}) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra },
});
const agentStart = { type: "agent_start" };
const agentEnd = (extra = {}) => ({ type: "agent_end", messages: [], ...extra });
const events = (sent) => sent.map((draft) => draft.event);

// ---------------------------------------------------------------------------
// Needs you: dialogs, approvals
// ---------------------------------------------------------------------------

test("a tool approval becomes an approval notification with Allow and Deny", () => {
  const h = harness();
  h.emit(agentStart, toolApproval());
  assert.equal(h.sent.length, 1);
  const [draft] = h.sent;
  assert.equal(draft.event, "approval");
  assert.equal(draft.title, "Approval needed · Fix login");
  assert.equal(draft.body, "Tool: bash\nnpm test");
  assert.equal(draft.sessionId, "sess-1");
  assert.equal(draft.requestKey, "r1");
  assert.deepEqual(draft.tags, ["my-project"]);
  assert.deepEqual(draft.offer.choices.map((c) => c.label), ["Allow", "Deny"]);
});

test("a select of three gets buttons; a select of four is a question with none", () => {
  const h = harness();
  h.emit(request({ id: "s3", method: "select", title: "Pick", options: ["a", "b", "c"] }));
  h.emit(request({ id: "s4", method: "select", title: "Pick more", options: ["a", "b", "c", "d"] }));
  assert.deepEqual(events(h.sent), ["question", "question"]);
  assert.equal(h.sent[0].offer.choices.length, 3);
  assert.equal(h.sent[1].offer, undefined);
  assert.equal(h.sent[1].body, "Pick more\n1. a\n2. b\n3. c\n4. d", "but it still says what was asked");
});

test("only a single-question, single-answer ask gets buttons", () => {
  const h = harness();
  const q = (fields = {}) => ({ id: "q", question: "Which?", options: [{ label: "A" }, { label: "B" }], ...fields });
  h.emit(request({ id: "ask1", method: "ask", questions: [q()] }));
  h.emit(request({ id: "ask2", method: "ask", questions: [q({ multi: true })] }));
  h.emit(request({ id: "ask3", method: "ask", questions: [q(), q({ id: "q2" })] }));
  assert.deepEqual(h.sent.map((d) => d.offer?.choices.length), [2, undefined, undefined]);
});

test("input, editor and link dialogs are questions without buttons", () => {
  const h = harness();
  h.emit(request({ id: "i", method: "input", title: "Name?" }), request({ id: "e", method: "editor", title: "Edit" }), request({ id: "u", method: "open_url", title: "Sign in", url: "https://x.example/secret" }));
  assert.deepEqual(events(h.sent), ["question", "question", "question"]);
  assert.ok(h.sent.every((d) => d.offer === undefined));
  assert.ok(!h.sent[2].body.includes("secret"));
});

test("frames that are not questions are ignored", () => {
  const h = harness();
  h.emit(request({ method: "notify", message: "hi" }), request({ method: "setStatus", statusKey: "k" }), request({ method: "setWidget" }), request({ method: "mystery" }));
  h.emit({ type: "message_update", delta: "x" }, { type: "tool_execution_start" }, { type: "cache_warming_start" }, { type: "thinking", delta: "hm" });
  assert.deepEqual(h.sent, []);
});

test("a request is notified once, however many times its frame arrives", () => {
  const h = harness();
  h.emit(toolApproval(), toolApproval(), toolApproval());
  assert.equal(h.sent.length, 1);
});

test("an ACP approval offers the agent's one-shot options and never its always options", () => {
  const h = harness();
  h.emit({
    type: "permission_request",
    requestId: "perm-1",
    toolCall: { title: "Write src/index.ts" },
    options: [
      { optionId: "y", name: "Allow", kind: "allow_once" },
      { optionId: "a", name: "Always", kind: "allow_always" },
      { optionId: "n", name: "Deny", kind: "reject_once" },
    ],
  });
  const [draft] = h.sent;
  assert.equal(draft.event, "approval");
  assert.equal(draft.body, "Write src/index.ts");
  assert.equal(draft.requestKey, "perm-1");
  assert.deepEqual(draft.offer.choices.map((c) => c.answer), [{ optionId: "y" }, { optionId: "n" }]);
});

test("an approval with nothing clickable is not announced (the browser does not show it either)", () => {
  const h = harness();
  h.emit({ type: "permission_request", requestId: "perm-2", toolCall: {}, options: [] });
  h.emit({ type: "permission_request", requestId: "perm-3", toolCall: {}, options: [{ optionId: "x" }] });
  assert.deepEqual(h.sent, []);
});

test("an approval whose only options are lasting ones is announced with no buttons", () => {
  const h = harness();
  h.emit({ type: "permission_request", requestId: "perm-4", toolCall: { title: "Delete" }, options: [{ optionId: "a", name: "Always", kind: "allow_always" }] });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].offer, undefined);
});

test("a refusal question is a question that links to the chat and offers no buttons", () => {
  const h = harness();
  h.emit({ type: "cody_refusal_decision", decision: { id: "d1", fromModel: "p/primary", toModel: "p/fallback", canContinue: true, createdAt: 1 } });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].event, "question");
  assert.equal(h.sent[0].offer, undefined);
  assert.match(h.sent[0].body, /p\/primary declined this request\. Open the chat to choose how to continue/);
  assert.equal(h.sent[0].requestKey, "refusal:d1");
  h.emit({ type: "cody_refusal_decision", decision: null });
  assert.deepEqual(h.cleared, ["refusal:d1"], "answering it (or moving on) takes the notification down");
});

// ---------------------------------------------------------------------------
// Taking notifications down
// ---------------------------------------------------------------------------

test("a request leaves the phone when it is cancelled, answered, resolved or expires", () => {
  const cases = [
    ["omp cancel frame", request({ method: "cancel", id: "c", targetId: "r1" })],
    ["answered, expired or replaced (the wrapper's own signal)", { type: "cody_ui_request_resolved", id: "r1" }],
  ];
  for (const [name, frame] of cases) {
    const h = harness();
    h.emit(toolApproval(), frame);
    assert.deepEqual(h.cleared, ["r1"], name);
    h.emit(frame);
    assert.deepEqual(h.cleared, ["r1"], `${name}: a second signal clears nothing more`);
  }
  const h = harness();
  h.emit({ type: "permission_request", requestId: "perm-1", toolCall: {}, options: [{ optionId: "y", name: "Allow", kind: "allow_once" }] });
  h.emit({ type: "permission_resolved", requestId: "perm-1", outcome: "selected" });
  assert.deepEqual(h.cleared, ["perm-1"]);
});

test("a signal about some other request clears nothing", () => {
  const h = harness();
  h.emit(toolApproval("r1"));
  h.emit({ type: "cody_ui_request_resolved", id: "other" }, request({ method: "cancel", id: "c", targetId: "other" }), { type: "permission_resolved", requestId: "other" });
  h.emit({ type: "cody_ui_request_resolved" }, { type: "permission_resolved" });
  assert.deepEqual(h.cleared, []);
});

test("a restart or wipe that drops every dialog takes every notification down", () => {
  const h = harness();
  h.emit(toolApproval("r1"), request({ id: "r2", method: "select", title: "Pick", options: ["a"] }));
  h.emit({ type: "cody_ui_requests_cleared" });
  assert.deepEqual(h.cleared.sort(), ["r1", "r2"]);
});

test("closing the session takes down everything still waiting, and ends the observer", () => {
  const h = harness();
  h.emit(toolApproval("r1"), toolApproval("r2"));
  h.observer.close();
  assert.deepEqual(h.cleared.sort(), ["r1", "r2"], "their dialogs died with the child");
  h.observer.close();
  h.emit(toolApproval("r3"));
  assert.equal(h.sent.length, 2, "nothing is sent after close");
  assert.deepEqual(h.cleared.sort(), ["r1", "r2"], "and closing twice clears nothing twice");
});

test("a request that was answered can be asked again under the same id", () => {
  const h = harness();
  h.emit(toolApproval("r1"), { type: "cody_ui_request_resolved", id: "r1" }, toolApproval("r1"));
  assert.equal(h.sent.length, 2);
});

test("a request nobody was notified about (every recipient off, or viewing) is still one request, with nothing to clear", () => {
  const h = harness({ send: (draft) => { h.sent.push(draft); return null; } });
  h.emit(toolApproval("r1"), toolApproval("r1"));
  assert.equal(h.sent.length, 1, "a repeated frame is not a second request");
  h.emit({ type: "cody_ui_request_resolved", id: "r1" });
  assert.deepEqual(h.cleared, [], "no handle, so nothing to take down");
  h.emit(toolApproval("r1"));
  assert.equal(h.sent.length, 2, "once resolved, the id is free to be asked again");
});

test("a runaway of unanswered requests is capped: the oldest notification is taken down", () => {
  const h = harness();
  for (let index = 0; index < 51; index += 1) h.emit(toolApproval(`r${index}`));
  assert.equal(h.sent.length, 51);
  assert.deepEqual(h.cleared, ["r0"]);
});

// ---------------------------------------------------------------------------
// How a run ends
// ---------------------------------------------------------------------------

test("a finished run is a finished notification carrying how long it took and what was said", () => {
  const h = harness();
  h.emit(agentStart);
  h.advance(125_000);
  h.emit(assistant("All done.\n\nTests pass."), agentEnd());
  assert.equal(h.sent.length, 1);
  const [draft] = h.sent;
  assert.equal(draft.event, "finished");
  assert.equal(draft.title, "Reply finished · Fix login");
  assert.equal(draft.body, "All done.\nTests pass.");
  assert.equal(draft.runMs, 125_000, "each recipient applies their own minimum to this");
  assert.equal(draft.fallback, undefined);
  assert.equal(draft.requestKey, undefined, "not clearable: nothing waits on it");
});

test("a reply that asks the user something is waiting — quoting the question — and falls back to finished", () => {
  const h = harness();
  h.emit(agentStart);
  h.advance(40_000);
  h.emit(assistant("I made the change.\nThe tests all pass.\nWhich file should I update next?"), agentEnd());
  assert.equal(h.sent.length, 1);
  const [draft] = h.sent;
  assert.equal(draft.event, "waiting");
  assert.equal(draft.title, "Waiting for your reply · Fix login");
  assert.equal(draft.body, "… Which file should I update next?");
  assert.equal(draft.fallback.event, "finished", "for a recipient who turned waiting off");
  assert.equal(draft.fallback.runMs, 40_000);
  assert.match(draft.fallback.body, /I made the change/);
});

test("a run the user stopped is not news, however it was stopped", () => {
  // omp: the reply was cut off.
  let h = harness();
  h.emit(agentStart, assistant("Working on it…", "aborted"), agentEnd());
  assert.deepEqual(h.sent, []);

  // omp: Stop during a tool call leaves the last reply as a finished tool-use message.
  h = harness();
  h.emit(agentStart, assistant("Running the build.", "toolUse"), { type: "cody_run_stopped" }, agentEnd());
  assert.deepEqual(h.sent, [], "the user's own Stop is recognised even when no message says aborted");

  // ACP: cancelled.
  h = harness();
  h.emit(agentStart, { type: "message_end", content: [{ type: "text", text: "partial" }] }, agentEnd({ stopReason: "cancelled" }));
  assert.deepEqual(h.sent, []);

  // The Stop marker concerns the run in flight only: the next run is announced.
  h = harness();
  h.emit(agentStart, { type: "cody_run_stopped" }, agentEnd());
  h.advance(1_000);
  h.emit(agentStart, assistant("Second try done."), agentEnd());
  assert.deepEqual(events(h.sent), ["finished"]);
  assert.equal(h.sent[0].body, "Second try done.");
});

test("a Stop while no run is going leaves nothing behind to swallow the next run", () => {
  const h = harness();
  h.emit({ type: "cody_run_stopped" });
  h.emit(agentStart, assistant("Done."), agentEnd());
  assert.deepEqual(events(h.sent), ["finished"]);
});

test("a run that failed is an error carrying the model's reason — not 'finished'", () => {
  const h = harness();
  h.emit(agentStart);
  h.advance(90_000);
  h.emit(
    assistant("", "error", { errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited, please slow down"}}' }),
    agentEnd(),
  );
  assert.deepEqual(events(h.sent), ["error"]);
  assert.equal(h.sent[0].title, "Error · Fix login");
  assert.equal(h.sent[0].body, "Rate limited, please slow down");
});

test("an error that is really a user abort is not announced", () => {
  const h = harness();
  h.emit(agentStart, assistant("", "error", { errorMessage: "Request was aborted" }), agentEnd());
  assert.deepEqual(h.sent, []);
});

test("an error that omp then retried past is not an error: the run finished", () => {
  const h = harness();
  h.emit(agentStart);
  h.advance(30_000);
  h.emit(
    assistant("", "error", { errorMessage: "overloaded_error: The server is overloaded" }),
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3 },
    assistant("Recovered and done."),
    agentEnd(),
  );
  assert.deepEqual(events(h.sent), ["finished"]);
});

test("a refusal already put to the owner as a question is not announced a second time as an error", () => {
  const h = harness();
  h.emit(agentStart);
  h.emit({ type: "cody_refusal_decision", decision: { id: "d1", fromModel: "p/m", toModel: null, canContinue: false, createdAt: 1 } });
  h.emit(assistant("", "error", { errorMessage: "Refusal (policy): content policy violation" }), agentEnd());
  assert.deepEqual(events(h.sent), ["question"]);
});

test("a refusal with no question put to the owner is an error", () => {
  const h = harness();
  h.emit(agentStart, assistant("", "error", { errorMessage: "Refusal (policy): content policy violation" }), agentEnd());
  assert.deepEqual(events(h.sent), ["error"]);
});

test("a non-terminal agent_end is a pause inside the run, not its end", () => {
  const h = harness();
  h.emit(agentStart, assistant("First part."));
  h.advance(20_000);
  h.emit(agentEnd({ isTerminal: false }));
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.turnEnds, [], "and the quota watcher is not told a turn ended");
  h.advance(5_000);
  h.emit(agentStart, assistant("Second part."));
  h.advance(60_000);
  h.emit(agentEnd());
  assert.equal(h.sent.length, 1, "one notification for the whole run");
  assert.equal(h.sent[0].runMs, 85_000, "timed from the FIRST start");
  assert.equal(h.sent[0].body, "Second part.");
});

test("the waiting notice the todo pause emits announces waiting once, and the aborted end that follows adds nothing", () => {
  const h = harness();
  h.emit(agentStart);
  h.advance(50_000);
  h.emit(assistant("Step one is in.\nShould I continue with step two?"));
  h.emit({ type: "notice", level: "info", reason: "awaiting_reply", message: "Waiting for your reply — the agent's task list is on hold." });
  assert.deepEqual(events(h.sent), ["waiting"]);
  assert.equal(h.sent[0].body, "… Should I continue with step two?");
  assert.equal(h.sent[0].fallback.runMs, 50_000);
  h.emit(assistant("", "aborted"), agentEnd());
  assert.deepEqual(events(h.sent), ["waiting"], "no second message, and not 'finished'");
});

test("the notice is trusted even when the observer's own copy of the reply no longer shows the question", () => {
  const h = harness();
  h.emit(agentStart, assistant("Done with that part."));
  h.emit({ type: "notice", level: "info", reason: "awaiting_reply", message: "Waiting for your reply" });
  assert.deepEqual(events(h.sent), ["waiting"], "omp's wrapper decided it asked something");
  h.emit(agentEnd());
  assert.equal(h.sent.length, 1);
});

test("a late waiting notice, after the run already ended asking, is not a second waiting", () => {
  const h = harness();
  h.emit(agentStart, assistant("Which one?"), agentEnd());
  assert.deepEqual(events(h.sent), ["waiting"]);
  h.emit({ type: "notice", level: "info", reason: "awaiting_reply", message: "Waiting for your reply" });
  assert.deepEqual(events(h.sent), ["waiting"]);
});

test("a crash is one error, and the terminal end the wrapper synthesises after it adds nothing", () => {
  const h = harness();
  h.emit(agentStart, assistant("Working…", "toolUse"));
  h.emit({ type: "notice", level: "error", reason: "engine_exit", message: "The omp process for this session exited unexpectedly: killed" });
  h.emit(agentEnd({ isTerminal: true }));
  assert.deepEqual(events(h.sent), ["error"]);
  assert.equal(h.sent[0].body, "The engine for this chat stopped unexpectedly.");
});

test("a crash while idle is still an error", () => {
  const h = harness();
  h.emit({ type: "notice", level: "error", reason: "engine_exit", message: "exited" });
  assert.deepEqual(events(h.sent), ["error"]);
});

test("other notices are not announced", () => {
  const h = harness();
  h.emit(agentStart);
  h.emit({ type: "notice", level: "warning", message: "A tool result was too large" }, { type: "notice", level: "info", message: "hello" }, { type: "notice", level: "error", message: "an error notice alone" });
  assert.deepEqual(h.sent, []);
});

test("a duplicate terminal end, or one for a run never seen begin, announces nothing", () => {
  const h = harness();
  h.emit(agentEnd());
  assert.deepEqual(h.sent, []);
  h.emit(agentStart, assistant("Done."), agentEnd(), agentEnd({ isTerminal: true }));
  assert.equal(h.sent.length, 1);
});

test("the quota watcher is told once per run that really ended, including a stopped or failed one", () => {
  const h = harness();
  h.emit(agentStart, assistant("a"), agentEnd());
  h.emit(agentStart, assistant("b", "aborted"), agentEnd());
  h.emit(agentStart, assistant("", "error", { errorMessage: "boom" }), agentEnd());
  h.emit(agentEnd({ isTerminal: false }), agentEnd());
  assert.equal(h.turnEnds.length, 3);
});

// ---------------------------------------------------------------------------
// ACP: no role on a message, a stop reason on the end
// ---------------------------------------------------------------------------

const acpReply = (text) => ({ type: "message_end", content: [{ type: "text", text }] });

test("an ACP turn finishes, or waits, by the text of its message", () => {
  const h = harness();
  h.emit(agentStart, { type: "turn_start" }, acpReply("Refactored the module."), { type: "turn_end" }, agentEnd({ stopReason: "end_turn" }));
  h.emit(agentStart, acpReply("Ready when you are. Should I run the tests?"), agentEnd({ stopReason: "end_turn" }));
  assert.deepEqual(events(h.sent), ["finished", "waiting"]);
  assert.equal(h.sent[0].body, "Refactored the module.");
});

test("an ACP turn that failed is an error in the engine's own words; one that was cancelled is nothing", () => {
  const h = harness();
  h.emit(agentStart, { type: "notice", level: "error", message: "Claude Code: Error: connection reset" }, agentEnd({ stopReason: "error" }));
  assert.deepEqual(events(h.sent), ["error"]);
  assert.match(h.sent[0].body, /connection reset/);

  h.emit(agentStart, agentEnd({ stopReason: "cancelled" }));
  assert.deepEqual(events(h.sent), ["error"], "cancelled adds nothing");

  h.emit(agentStart, agentEnd({ stopReason: "refusal" }));
  assert.deepEqual(events(h.sent), ["error", "error"]);
  assert.match(h.sent[1].body, /declined/);

  h.emit(agentStart, agentEnd({ stopReason: "error" }));
  assert.equal(h.sent[2].body, "The agent stopped with an error.", "no notice this run: the generic sentence, not last run's");
});

// ---------------------------------------------------------------------------
// Fallback, subagents, titles, identity
// ---------------------------------------------------------------------------

test("a model fallback is announced, at most once every two minutes per chat", () => {
  const h = harness();
  const fallback = (from, to) => ({ type: "retry_fallback_applied", from, to, role: "default", reason: "rate limit" });
  h.emit(fallback("a/one", "b/two"));
  h.advance(FALLBACK_COALESCE_MS - 1);
  h.emit(fallback("b/two", "c/three"));
  assert.equal(h.sent.length, 1, "the second, a moment later, is part of the same story");
  assert.equal(h.sent[0].event, "fallback");
  assert.equal(h.sent[0].body, "Switched from a/one to b/two.\nReason: rate limit");
  h.advance(1);
  h.emit(fallback("b/two", "c/three"));
  assert.equal(h.sent.length, 2, "two minutes on, it is news again");
  assert.match(h.sent[1].body, /Switched from b\/two to c\/three/);
});

test("a finished subagent is announced once, with how it ended; one still running is not", () => {
  const h = harness();
  const lifecycle = (status, extra = {}) => ({ type: "subagent_lifecycle", payload: { id: "sub-1", agent: "reviewer", description: "Review the diff\nand report", status, ...extra } });
  h.emit(lifecycle("started"), lifecycle("completed"), lifecycle("completed"));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].event, "subagent");
  assert.equal(h.sent[0].title, "Subagent finished · Fix login");
  assert.equal(h.sent[0].body, "reviewer finished.\nReview the diff and report");
  h.emit(lifecycle("failed", { id: "sub-2" }), lifecycle("aborted", { id: "sub-3", agent: undefined, description: undefined }));
  assert.equal(h.sent[1].body.split("\n")[0], "reviewer failed.");
  assert.equal(h.sent[2].body, "A subagent was stopped.");
});

test("the chat's live title is the one a notification carries", () => {
  const h = harness();
  h.emit(toolApproval("r1"));
  assert.equal(h.sent[0].title, "Approval needed · Fix login");
  h.emit({ type: "session_info_update", title: "Renamed chat" });
  h.emit(toolApproval("r2"));
  assert.equal(h.sent[1].title, "Approval needed · Renamed chat");
});

test("the session id is read when each notification is made, so a fork or a move is followed", () => {
  const h = harness();
  h.emit(toolApproval("r1"));
  h.session.sessionId = "sess-forked";
  h.emit(toolApproval("r2"));
  assert.deepEqual(h.sent.map((d) => d.sessionId), ["sess-1", "sess-forked"]);
  h.emit({ type: "cody_ui_request_resolved", id: "r1" });
  assert.deepEqual(h.cleared, ["r1"], "and a request is found by its own id, not by the session id it was sent under");
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function fakeSession() {
  const calls = { observe: 0, unsubscribe: 0, closeListeners: [] };
  const session = {
    sessionId: "fake-1",
    sessionFile: "",
    cwd: "/work/x",
    observeEvents: () => {
      calls.observe += 1;
      return () => { calls.unsubscribe += 1; };
    },
    onClose: (listener) => { calls.closeListeners.push(listener); return () => {}; },
  };
  return { session, calls };
}

test("a chat is observed, and the observer is removed when it closes", () => {
  const { session, calls } = fakeSession();
  observeSessionForNotifications(session, {});
  assert.equal(calls.observe, 1);
  assert.equal(calls.closeListeners.length, 1);
  calls.closeListeners[0]();
  assert.equal(calls.unsubscribe, 1);
});

test("a sidebar chat is never observed, and neither is one whose engine has no observer channel", () => {
  const sidebar = fakeSession();
  observeSessionForNotifications(sidebar.session, { kind: "sidebar" });
  assert.equal(sidebar.calls.observe, 0);
  assert.equal(sidebar.calls.closeListeners.length, 0);

  const bare = fakeSession();
  delete bare.session.observeEvents;
  observeSessionForNotifications(bare.session, {});
  assert.equal(bare.calls.closeListeners.length, 0);
});
