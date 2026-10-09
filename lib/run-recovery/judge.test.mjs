import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Which tool calls in flight have outlived what they can honestly take. A
 * wrong "yes" kills a call that was still working, so the rules lean toward
 * leniency: only calls whose own deadline is known, and only well past it.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { findOverdueTool, insideOwnDeadline } = await jiti.import("./judge.ts");

const MINUTE = 60_000;
const LIMITS = { toolGraceMs: 15 * MINUTE, quickToolMs: 20 * MINUTE };
const T0 = Date.parse("2026-10-09T06:00:00Z");

const flight = (name, args, extra = {}) => ({ id: `${name}-1`, name, args, startedAt: T0, clockStart: T0, lastUpdateAt: T0, ...extra });
const overdueAt = (call, minutes) => findOverdueTool([call], T0 + minutes * MINUTE, LIMITS);

test("time spent waiting on the person is not a call's own: it is overdue on its own clock but told when it really began", () => {
  const held = flight("edit", {}, { clockStart: T0 + 300 * MINUTE, lastUpdateAt: T0 + 300 * MINUTE });
  assert.equal(findOverdueTool([held], T0 + 319 * MINUTE, LIMITS), null);
  assert.deepEqual(findOverdueTool([held], T0 + 320 * MINUTE, LIMITS), { tool: "edit", startedAt: T0, quietSince: T0 + 300 * MINUTE, sinceMs: 20 * MINUTE });
  const timed = flight("bash", {}, { clockStart: T0 + 300 * MINUTE });
  assert.equal(findOverdueTool([timed], T0 + 319 * MINUTE, LIMITS), null, "its five minutes and the grace count from the end of the wait");
  assert.equal(findOverdueTool([timed], T0 + 320 * MINUTE, LIMITS).startedAt, T0);
});

test("a tool with its own timeout is overdue only a grace after it: bash defaults to 5 minutes, so 20", () => {
  assert.equal(overdueAt(flight("bash", { command: "make" }), 19), null);
  assert.deepEqual(overdueAt(flight("bash", { command: "make" }), 20), { tool: "bash", startedAt: T0, quietSince: T0, sinceMs: 20 * MINUTE });
});

test("the timeout the call asked for replaces the default, as a number or as text", () => {
  assert.equal(overdueAt(flight("bash", { timeout: 3600 }), 74), null);
  assert.equal(overdueAt(flight("bash", { timeout: 3600 }), 75).tool, "bash");
  assert.equal(overdueAt(flight("bash", { timeout: "3600" }), 74), null, "a model that sends the number as text is read the same");
  assert.equal(overdueAt(flight("bash", { timeout: -5 }), 20).tool, "bash", "nonsense falls back to the default");
  assert.equal(overdueAt(flight("bash", { timeout: "soon" }), 20).tool, "bash");
});

test("timeout 0 means no deadline: such a call is never overdue", () => {
  assert.equal(overdueAt(flight("bash", { timeout: 0 }), 24 * 60), null);
});

test("each of omp's timed tools gets its own default", () => {
  const defaults = { eval: 30, browser: 30, computer: 120, ssh: 60, fetch: 20, lsp: 20, debug: 30, ida: 120 };
  for (const [name, seconds] of Object.entries(defaults)) {
    const limit = seconds / 60 + 15;
    assert.equal(overdueAt(flight(name, {}), limit - 0.1), null, `${name} one moment before ${limit} minutes`);
    assert.equal(overdueAt(flight(name, {}), limit)?.tool, name, `${name} at ${limit} minutes`);
  }
});

test("a quick tool is overdue after 20 minutes without a sign of life, measured from its last update", () => {
  assert.equal(overdueAt(flight("edit", {}), 19), null);
  assert.equal(overdueAt(flight("edit", {}), 20).sinceMs, 20 * MINUTE);
  const streaming = flight("write", {}, { lastUpdateAt: T0 + 50 * MINUTE });
  assert.equal(overdueAt(streaming, 69), null, "a watch that posts an update per poll is alive");
  assert.deepEqual(overdueAt(streaming, 70), { tool: "write", startedAt: T0, quietSince: T0 + 50 * MINUTE, sinceMs: 20 * MINUTE });
});

test("every quick tool of the design is judged", () => {
  for (const name of ["read", "edit", "write", "ast_grep", "ast_edit", "glob", "grep", "find", "search", "checkpoint", "rewind", "context_notes", "todo", "memory_edit", "retain", "recall", "reflect", "learn", "manage_skill", "think", "web_search", "github"]) {
    assert.equal(overdueAt(flight(name, {}), 20)?.tool, name, name);
  }
});

test("tools that wait on others by design are never overdue, however long they take", () => {
  for (const name of ["wait", "ask", "task", "yield", "goal"]) {
    assert.equal(overdueAt(flight(name, {}), 24 * 60), null, name);
  }
});

test("a tool nobody knows the deadline of is never judged: MCP tools, Cody's host tools, another engine's names", () => {
  for (const name of ["mcp__github__search", "open_preview", "preview_screenshot", "device_flash", "Bash", "constructor", "toString", "__proto__", ""]) {
    assert.equal(overdueAt(flight(name, {}), 24 * 60), null, JSON.stringify(name));
  }
});

test("when several are overdue the one that has waited longest is named", () => {
  const calls = [flight("edit", {}, { id: "late", startedAt: T0 + 5 * MINUTE, lastUpdateAt: T0 + 5 * MINUTE }), flight("read", {}, { id: "early" })];
  assert.equal(findOverdueTool(calls, T0 + 60 * MINUTE, LIMITS).tool, "read");
});

test("silence is allowed only inside a declared deadline", () => {
  const inside = (call, minutes) => insideOwnDeadline([call], T0 + minutes * MINUTE, LIMITS);
  assert.equal(inside(flight("bash", { timeout: 7200 }), 100), true, "two hours were asked for");
  assert.equal(inside(flight("bash", { timeout: 0 }), 1000), true, "no deadline at all");
  assert.equal(inside(flight("bash", {}), 10), true, "inside the default and its grace");
  assert.equal(inside(flight("bash", {}), 21), false, "past it");
  assert.equal(inside(flight("edit", {}), 1), false, "a quick tool has no declared deadline to be quiet within");
  assert.equal(inside(flight("task", {}), 1), false, "nor does one that waits on others");
});
