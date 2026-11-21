import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * omp 19.1.0 runtime changes, replayed from frames and session files recorded
 * off a real 19.1.0 rpc-ui child (lib/fixtures/omp-19.1.0-*.json):
 *   - approval requests and outcomes now land in the session file;
 *   - a background bash job that redirects its output to a file;
 *   - the retry saga (failed attempts stamped `retryRecovery`) and the silent
 *     transport retry;
 *   - the first `wait` call.
 * Each test says what Cody does with the new shape, not what omp does.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { aggregateModelUsage, aggregateMessageUsage } = await jiti.import("./session-usage.ts");
const { slimToolUpdateFrame, partialResultText, asyncStateOf } = await jiti.import("./live-tool-output.ts");
const { parseTrail } = await jiti.import("./run-recovery/burn-trail.ts");
const { findOverdueTool } = await jiti.import("./run-recovery/judge.ts");

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/omp-19.1.0-${name}.json`, import.meta.url), "utf8"));
const messagesOf = (entries) => buildSessionContext(entries).messages;

test("approval records: omp writes request and outcome entries, and the transcript reader draws neither", () => {
  const { allow, deny } = fixture("approval-records");
  const requested = allow.entries.find((e) => e.customType === "tool_approval_requested");
  assert.equal(requested.type, "custom");
  assert.deepEqual(Object.keys(requested.data).sort(), ["approvalMode", "requestedAt", "toolCallId", "toolName"]);
  const resolved = deny.entries.find((e) => e.customType === "tool_approval_resolved");
  assert.equal(resolved.data.approved, false);
  assert.equal(resolved.data.reason, "denied by user");
  for (const run of [allow, deny]) {
    const roles = messagesOf(run.entries).map((m) => `${m.role}:${m.customType ?? ""}`);
    assert.ok(!roles.some((r) => r.includes("tool_approval")), roles.join(","));
  }
});

test("approval prompt: the request frame Cody already tracks is unchanged and the request was on disk while it was open", () => {
  const { allow } = fixture("approval-records");
  const prompt = allow.frames.find((f) => f.type === "extension_ui_request" && f.method === "select");
  assert.match(prompt.title, /^Allow tool: bash\n/);
  assert.deepEqual(prompt.options, ["Approve", "Approve bash for this session", "Deny"]);
  const whileWaiting = allow.probes.find((p) => p.phase === "while-waiting");
  assert.ok(whileWaiting.approvalEntries.some((e) => e.customType === "tool_approval_requested"));
});

test("redirected job: the output goes to the file, so every running frame carries an empty tail and the job state", () => {
  const { run } = fixture("redirect-job");
  const updates = run.frames.filter((f) => f.type === "tool_execution_update");
  const running = updates.filter((f) => asyncStateOf(f.partialResult)?.state === "running");
  assert.ok(running.length > 0);
  const texts = running.map((f) => partialResultText(f.partialResult));
  assert.ok(texts.includes(""), "while the redirected loop runs, the tail is empty");
  assert.ok(texts.every((text) => text === "" || text.startsWith("REDIR-DONE")), "only the command's own terminal output ever shows");
  for (const frame of running) {
    const slim = slimToolUpdateFrame(frame);
    assert.equal(slim.partialResult.content[0].text, partialResultText(frame.partialResult));
    assert.equal(slim.partialResult.details.async.jobId, "bg_1");
  }
  const last = updates.at(-1);
  assert.equal(asyncStateOf(last.partialResult).state, "completed");
  assert.match(partialResultText(last.partialResult), /^REDIR-DONE/, "only what the command printed to the terminal shows, never the file's bytes");
});

test("retry saga: the new frame fields are present, and the failed attempts leave the rebuilt transcript", () => {
  const { saga } = fixture("retry");
  const starts = saga.frames.filter((f) => f.type === "auto_retry_start");
  assert.equal(starts.length, 3);
  assert.ok(starts.every((f) => typeof f.errorId === "number" && f.maxAttempts === 3));
  const end = saga.frames.find((f) => f.type === "auto_retry_end");
  assert.equal(end.success, false);
  assert.ok(Array.isArray(end.retryErrors));

  const stamped = saga.entries.filter((e) => e.type === "message" && e.message.retryRecovery);
  assert.equal(stamped.length, 3);
  assert.ok(stamped.every((e) => e.message.retryRecovery.kind === "auto-retry" && e.message.retryRecovery.status === "superseded"));
  const shown = messagesOf(saga.entries).filter((m) => m.role === "assistant");
  assert.equal(shown.length, 1, "only the attempt that ended the turn is left");
  assert.match(shown[0].errorMessage, /^Retry budget exhausted after 3 retries/);
});

test("retry saga: a failed attempt that cost something stays in the transcript, so the cost total is unchanged", () => {
  const { saga } = fixture("retry");
  const entries = structuredClone(saga.entries);
  const first = entries.find((e) => e.type === "message" && e.message.retryRecovery);
  first.message.usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
  const messages = messagesOf(entries);
  assert.equal(messages.filter((m) => m.role === "assistant").length, 2);
  assert.equal(aggregateMessageUsage(messages).cost, 0.01);
});

test("retry saga: the burn guard still sees every request, and the file keeps what the engine billed", () => {
  const { transient } = fixture("retry");
  const lines = transient.entries.filter((e) => e.type === "message").map((e) => JSON.stringify(e));
  const requests = parseTrail(lines.join("\n")).filter((e) => e.kind === "request");
  // two failed attempts that streamed something and the reply that finished: three paid requests.
  assert.equal(requests.length, 3);
  assert.equal(aggregateModelUsage(transient.entries).cost, 0);
  assert.ok(aggregateMessageUsage(messagesOf(transient.entries)).cost > 0);
});

test("silent transport retry: no auto_retry frames, a non-terminal agent_end between attempts, one terminal at the end", () => {
  const { transient } = fixture("retry");
  assert.equal(transient.frames.some((f) => f.type.startsWith("auto_retry")), false);
  const ends = transient.frames.filter((f) => f.type === "agent_end");
  assert.equal(ends.length, 3);
  assert.deepEqual(ends.map((f) => f.isTerminal === true), [false, false, true]);
});

test("wait: the first call on rpc-ui returns after five seconds, and a wait is never judged overdue", () => {
  const { run } = fixture("wait");
  const waits = run.frames.filter((f) => f.toolName === "wait");
  const first = waits.find((f) => f.type === "tool_execution_end");
  assert.match(first.result.content[0].text, /No job finished within 5\.0s/);
  const start = waits.find((f) => f.type === "tool_execution_start");
  assert.ok(first.__t - start.__t < 10_000);

  const limits = { toolGraceMs: 15 * 60_000, quickToolMs: 20 * 60_000 };
  const T0 = Date.parse("2026-11-21T00:00:00Z");
  for (const minutes of [4, 30, 24 * 60]) {
    const flight = { id: "w", name: "wait", args: {}, startedAt: T0, clockStart: T0, lastUpdateAt: T0 };
    assert.equal(findOverdueTool([flight], T0 + minutes * 60_000, limits), null, `${minutes} min`);
  }
});
