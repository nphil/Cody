import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const live = await jiti.import("./live-tool-output.ts");
const {
  LIVE_TAIL_LINES, LIVE_LINE_CHARS, LIVE_SLIM_TEXT_CHARS, LIVE_MAX_ENTRIES,
  tailLines, capTextTail, slimToolUpdateFrame, ToolUpdateThrottle, LiveToolOutputStore,
  helperToolElapsedMs, formatToolElapsed, asyncStateOf,
} = live;

/** An omp `tool_execution_update` frame as the real 19.0.0 engine sends it. */
const frame = (text, extra = {}, id = "toolu_1", name = "bash") => ({
  type: "tool_execution_update",
  toolCallId: id,
  toolName: name,
  args: { command: "cargo build" },
  partialResult: { content: [{ type: "text", text }], details: { trace: "x".repeat(2000), ...extra } },
});

test("tailLines keeps the newest lines, drops blanks, colors and redrawn progress", () => {
  const text = "\u001b[32m   Compiling\u001b[0m a v1\n\n[1/9] building\r[2/9] building\r[3/9] building\n  Finished\t\u0007ok\n";
  assert.deepEqual(tailLines(text), ["   Compiling a v1", "[3/9] building", "  Finished  ok"]);
  assert.deepEqual(tailLines(""), []);
  const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const rows = tailLines(many);
  assert.equal(rows.length, LIVE_TAIL_LINES);
  assert.equal(rows.at(-1), "line 99");
  assert.equal(rows[0], `line ${100 - LIVE_TAIL_LINES}`);
  assert.deepEqual(tailLines(many, 3), ["line 97", "line 98", "line 99"]);
});

test("tailLines clamps a very long line and never scans an enormous text", () => {
  const rows = tailLines(`${"x".repeat(5000)}\nshort`);
  assert.equal(rows[0].length, LIVE_LINE_CHARS);
  assert.ok(rows[0].endsWith("…"));
  assert.equal(rows[1], "short");
  const huge = `${"noise\n".repeat(400_000)}the end`;
  assert.equal(tailLines(huge).at(-1), "the end");
});

test("capTextTail cuts on a line boundary and leaves short text alone", () => {
  assert.equal(capTextTail("abc\ndef", 100), "abc\ndef");
  const text = `${"a".repeat(30)}\n${"b".repeat(30)}\nlast line`;
  const cut = capTextTail(text, 40);
  assert.ok(cut.length <= 40);
  assert.ok(cut.endsWith("last line"));
  assert.ok(!cut.startsWith("a"), "never starts mid-line inside the first row");
  assert.equal(capTextTail("x".repeat(100), 10), "x".repeat(10), "one huge line is cut where it stands");
});

test("slimToolUpdateFrame forwards the newest text and the async state, nothing else", () => {
  const big = `${"old\n".repeat(50_000)}newest line`;
  const slim = slimToolUpdateFrame(frame(big, { async: { state: "running", jobId: "bg_1", type: "bash" }, wallTimeMs: 4 }));
  assert.equal(slim.type, "tool_execution_update");
  assert.equal(slim.toolCallId, "toolu_1");
  assert.equal(slim.toolName, "bash");
  assert.equal("args" in slim, false, "the command is already in tool_execution_start");
  assert.ok(slim.partialResult.content[0].text.length <= LIVE_SLIM_TEXT_CHARS);
  assert.ok(slim.partialResult.content[0].text.endsWith("newest line"));
  assert.deepEqual(slim.partialResult.details, { async: { state: "running", jobId: "bg_1" } });
  assert.ok(JSON.stringify(slim).length < LIVE_SLIM_TEXT_CHARS * 2 + 600, "newlines double in JSON; still ~10 KB, not 600 KB");
  const plain = slimToolUpdateFrame(frame("one"));
  assert.equal(plain.partialResult.details, undefined);
  const empty = slimToolUpdateFrame({ type: "tool_execution_update", toolCallId: "a", partialResult: {} });
  assert.equal(empty.partialResult.content[0].text, "");
});

test("ToolUpdateThrottle: first frame at once, the burst collapses to the newest, a finished job is never held", async () => {
  let clock = 1000;
  const sent = [];
  const throttle = new ToolUpdateThrottle((f) => sent.push(f), 60, () => clock);
  throttle.push(frame("one"));
  assert.equal(sent.length, 1);
  clock += 10;
  throttle.push(frame("two"));
  clock += 10;
  throttle.push(frame("three"));
  assert.equal(sent.length, 1, "inside the interval nothing more goes");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].partialResult.content[0].text, "three", "the waiting frame is the newest one");
  // another call is independent
  throttle.push(frame("other", {}, "toolu_2"));
  assert.equal(sent.length, 3);
  // a finished background job goes at once, even inside the interval
  clock += 5;
  throttle.push(frame("running", { async: { state: "running" } }, "toolu_3"));
  throttle.push(frame("done", { async: { state: "completed" } }, "toolu_3"));
  assert.equal(sent.at(-1).partialResult.details.async.state, "completed");
  throttle.dispose();
});

test("ToolUpdateThrottle.settle drops the waiting frame and dispose leaves no timer", async () => {
  let clock = 0;
  const sent = [];
  const throttle = new ToolUpdateThrottle((f) => sent.push(f), 50, () => clock);
  throttle.push(frame("a"));
  clock += 5;
  throttle.push(frame("b"));
  throttle.settle("toolu_1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sent.length, 1, "the call ended: the waiting frame is dropped");
  throttle.push(frame("c"));
  throttle.push(frame("d"));
  throttle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sent.length, 2, "disposed: the waiting frame is not sent");
});

/** A store on a fake clock whose timers the test fires by hand. */
function storeHarness() {
  const fired = [];
  let clock = 5000;
  const store = new LiveToolOutputStore(() => clock, 40, 100);
  return { store, fired, advance: (ms) => { clock += ms; }, listen: (id) => store.subscribe(id, () => fired.push(id)) };
}
const text = (lines) => ({ content: [{ type: "text", text: lines.join("\n") }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a bash call shows nothing until it has run past the threshold, then its tail", async () => {
  const { store, fired, listen } = storeHarness();
  listen("t1");
  store.begin("t1", "bash", Date.now());
  store.update("t1", "bash", text(["Compiling a", "Compiling b"]));
  assert.equal(store.get("t1").shown, false, "a quick call never flashes a box");
  assert.deepEqual(store.get("t1").lines, ["Compiling a", "Compiling b"]);
  await sleep(150);
  assert.equal(store.get("t1").shown, true);
  assert.ok(fired.length >= 2, "the reveal notifies the card");
});

test("notifications are throttled: a burst is one leading call and one trailing batch", async () => {
  const { store, fired, listen } = storeHarness();
  listen("t1");
  store.begin("t1", "bash", 0);
  const before = fired.length;
  for (let i = 0; i < 30; i += 1) store.update("t1", "bash", text([`line ${i}`]));
  assert.equal(fired.length - before, 1, "only the leading edge fired synchronously");
  await sleep(120);
  assert.equal(fired.length - before, 2, "one trailing batch for the other 29");
  assert.deepEqual(store.get("t1").lines, ["line 29"]);
});

test("non-bash tools lead with their own status line (headline) and keep the rest as lines", () => {
  const { store } = storeHarness();
  store.begin("w1", "write", 0);
  store.update("w1", "write", text(["Running on worker: 1m 04s", "cargo build", "Compiling x"]));
  const entry = store.get("w1");
  assert.equal(entry.headline, "Running on worker: 1m 04s");
  assert.deepEqual(entry.lines, ["cargo build", "Compiling x"]);
});

test("a foreground call's entry goes at end, and a stray late frame does not bring it back", () => {
  const { store } = storeHarness();
  store.begin("t1", "bash", 0);
  store.update("t1", "bash", text(["x"]));
  store.end("t1");
  assert.equal(store.get("t1"), undefined);
  store.update("t1", "bash", text(["late"]));
  assert.equal(store.get("t1"), undefined);
  assert.equal(store.size, 0);
});

test("a background job keeps streaming after its call returned, and keeps its last lines when it finishes", () => {
  const { store } = storeHarness();
  store.begin("bg", "bash", 0);
  store.end("bg"); // omp ends the call at once with "Backgrounded as job bg_1"
  assert.equal(store.get("bg"), undefined);
  store.update("bg", "bash", { content: [{ type: "text", text: "[1/20] Compiling" }], details: { async: { state: "running", jobId: "bg_1" } } });
  assert.equal(store.get("bg").shown, true, "a job's tail is shown at once");
  assert.deepEqual(store.get("bg").lines, ["[1/20] Compiling"]);
  assert.equal(store.get("bg").endedAt, undefined);
  store.endRun();
  assert.ok(store.get("bg"), "the turn ending does not drop a running job");
  store.update("bg", "bash", { content: [{ type: "text", text: "[20/20] Finished" }], details: { async: { state: "completed", jobId: "bg_1" } } });
  const done = store.get("bg");
  assert.equal(done.async.state, "completed");
  assert.ok(done.endedAt !== undefined);
  assert.deepEqual(done.lines, ["[20/20] Finished"]);
});

test("endRun drops every foreground call; clear drops everything and tells the listeners", () => {
  const { store, fired, listen } = storeHarness();
  listen("a");
  store.begin("a", "bash", 0);
  store.begin("b", "bash", 0);
  store.update("a", "bash", text(["x"]));
  store.endRun();
  assert.equal(store.size, 0);
  store.begin("c", "bash", 0);
  const before = fired.length;
  listen("c");
  store.clear();
  assert.equal(store.size, 0);
  assert.ok(fired.length > before, "a card mounted on a cleared entry hears about it");
});

test("the store holds at most LIVE_MAX_ENTRIES entries and bounds each one", () => {
  const { store } = storeHarness();
  for (let i = 0; i < LIVE_MAX_ENTRIES + 8; i += 1) {
    store.update(`bg${i}`, "bash", { content: [{ type: "text", text: Array.from({ length: 500 }, (_, n) => `l${n}`).join("\n") }], details: { async: { state: i % 2 ? "completed" : "running" } } });
  }
  assert.equal(store.size, LIVE_MAX_ENTRIES);
  assert.equal(store.get(`bg${LIVE_MAX_ENTRIES + 7}`).lines.length, LIVE_TAIL_LINES);
});

test("an unchanged frame does not notify", async () => {
  const { store, fired, listen } = storeHarness();
  listen("t1");
  store.begin("t1", "bash", 0);
  store.update("t1", "bash", text(["same"]));
  await sleep(80);
  const before = fired.length;
  store.update("t1", "bash", text(["same"]));
  await sleep(80);
  assert.equal(fired.length, before);
});

test("helperToolElapsedMs trusts the engine's stamp only when the clocks agree plausibly", () => {
  assert.equal(helperToolElapsedMs(10_000, 10_200, 15_200), 5200, "first seen right after it started: the engine stamp");
  assert.equal(helperToolElapsedMs(10_000, 70_000, 75_000), 65_000, "adopted a minute in: the stamp still counts");
  assert.equal(helperToolElapsedMs(100_000, 10_000, 14_000), 4000, "a stamp in the future (clock skew): counted from first sight");
  assert.equal(helperToolElapsedMs(undefined, 10_000, 12_000), 2000);
  assert.equal(helperToolElapsedMs(1, 10_000_000_000, 10_000_001_000), 1000, "an absurd stamp is ignored");
  assert.equal(helperToolElapsedMs(10_000, 10_000, 9_000), 0, "never negative");
});

test("formatToolElapsed and asyncStateOf", () => {
  assert.equal(formatToolElapsed(7_900), "7s");
  assert.equal(formatToolElapsed(65_000), "1m 05s");
  assert.equal(formatToolElapsed(3_900_000), "1h 5m");
  assert.deepEqual(asyncStateOf({ details: { async: { state: "running", jobId: "bg_1", type: "bash" } } }), { state: "running", jobId: "bg_1" });
  assert.equal(asyncStateOf({ details: {} }), undefined);
  assert.equal(asyncStateOf(undefined), undefined);
});

test("a finished background job keeps its last lines for a moment, then its tail goes", async () => {
  const store = new LiveToolOutputStore(Date.now, 20, 50, 60);
  let heard = 0;
  store.subscribe("bg", () => { heard += 1; });
  store.update("bg", "bash", { content: [{ type: "text", text: "last line" }], details: { async: { state: "completed", jobId: "bg_1" } } });
  assert.deepEqual(store.get("bg").lines, ["last line"]);
  await sleep(120);
  assert.equal(store.get("bg"), undefined, "the finished job's tail lingers, then goes");
  assert.ok(heard >= 2, "the card is told when it goes");
});
