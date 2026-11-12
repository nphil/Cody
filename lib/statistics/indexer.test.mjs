import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  allRows,
  assistantLine,
  configFor,
  headerLine,
  layout,
  load,
  scratch,
  sessionInitLine,
  sumRows,
  userLine,
  writeArtifact,
  writeChat,
} from "./test-helpers.mjs";

const { runIndexPass } = await load("./indexer.ts");
const { StatsStore } = await load("./store.ts");
const { billingKind } = await load("./billing.ts");
const { appendJobLog, toJobLogEntry, jobLogName } = await load("./joblog.ts");

const ZONE = "UTC";
const T = (clock) => `2026-11-10T${clock}Z`;

function setup(t, zone = ZONE) {
  const dirs = layout(scratch(t));
  return { dirs, store: StatsStore.open(dirs.index, zone), config: configFor(dirs) };
}

const msg = (id, clock, o = {}) => assistantLine(id, T(clock), { input: 10, output: 5, cost: 0.01, ...o });

test("a first pass folds every message, a second pass with no change reads nothing", async (t) => {
  const { dirs, store, config } = setup(t);
  const file = writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00"), userLine("u1", T("01:00:01")), msg("m2", "01:01:00"), msg("m3", "01:02:00")]);
  const first = await runIndexPass(store, config);
  assert.equal(first.files, 1);
  assert.equal(first.records, 3);
  assert.equal(first.bytes, fs.statSync(file).size);
  assert.equal(sumRows(store, "n"), 3);
  const again = await runIndexPass(store, config);
  assert.deepEqual([again.changed, again.bytes, again.records], [0, 0, 0]);
  assert.equal(sumRows(store, "n"), 3);
});

test("appended lines are the only bytes read on the next pass", async (t) => {
  const { dirs, store, config } = setup(t);
  const file = writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00"), msg("m2", "01:01:00")]);
  await runIndexPass(store, config);
  const entry = store.byPath.get(file);
  const offsetBefore = entry.offset;
  assert.equal(offsetBefore, fs.statSync(file).size);
  const extra = msg("m3", "01:02:00") + msg("m4", "01:03:00");
  fs.appendFileSync(file, extra);
  const pass = await runIndexPass(store, config);
  assert.equal(pass.bytes, Buffer.byteLength(extra));
  assert.equal(pass.records, 2);
  assert.equal(entry.offset, offsetBefore + Buffer.byteLength(extra));
  assert.equal(sumRows(store, "n"), 4);
  assert.equal(sumRows(store, "input"), 40);
  assert.ok(Math.abs(sumRows(store, "cost") - 0.04) < 1e-12);
});

test("a trailing partial line is left unread until its newline arrives", async (t) => {
  const { dirs, store, config } = setup(t);
  const file = writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00")]);
  await runIndexPass(store, config);
  const entry = store.byPath.get(file);
  const whole = msg("m2", "01:01:00");
  const cut = Math.floor(whole.length / 2);
  fs.appendFileSync(file, whole.slice(0, cut));
  const offsetBefore = entry.offset;
  const partial = await runIndexPass(store, config);
  assert.equal(partial.records, 0);
  assert.equal(entry.offset, offsetBefore, "offset stays at the end of the last complete line");
  assert.equal(sumRows(store, "n"), 1);
  fs.appendFileSync(file, whole.slice(cut));
  const done = await runIndexPass(store, config);
  assert.equal(done.records, 1);
  assert.equal(entry.offset, fs.statSync(file).size);
  assert.equal(sumRows(store, "n"), 2);
});

test("a truncated transcript is re-read from byte 0 and its stale rows are dropped", async (t) => {
  const { dirs, store, config } = setup(t);
  const file = writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00"), msg("m2", "01:01:00"), msg("m3", "01:02:00")]);
  await runIndexPass(store, config);
  assert.equal(sumRows(store, "n"), 3);
  const inode = fs.statSync(file).ino;
  fs.writeFileSync(file, headerLine("chatA", "/proj/a", T("00:00:00.000")) + msg("n1", "05:00:00", { input: 7 }));
  assert.equal(fs.statSync(file).ino, inode, "a plain rewrite keeps the inode");
  const pass = await runIndexPass(store, config);
  assert.equal(pass.records, 1);
  assert.equal(sumRows(store, "n"), 1, "the old rows are gone, not added to");
  assert.equal(sumRows(store, "input"), 7);
  assert.equal(store.byPath.get(file).offset, fs.statSync(file).size);
});

test("a replaced file (new inode) is re-read from the start even when it is larger", async (t) => {
  const { dirs, store, config } = setup(t);
  const file = writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00")]);
  await runIndexPass(store, config);
  const oldInode = fs.statSync(file).ino;
  const replacement = `${file}.swap`;
  fs.writeFileSync(replacement, headerLine("chatA", "/proj/a", T("00:00:00.000")) + msg("r1", "02:00:00", { input: 100 }) + msg("r2", "02:01:00", { input: 200 }) + msg("r3", "02:02:00", { input: 300 }));
  fs.renameSync(replacement, file);
  assert.notEqual(fs.statSync(file).ino, oldInode);
  const pass = await runIndexPass(store, config);
  assert.equal(pass.records, 3);
  assert.equal(sumRows(store, "n"), 3);
  assert.equal(sumRows(store, "input"), 600, "the old message contributes nothing");
});

test("a deleted transcript keeps its rows and is marked gone", async (t) => {
  const { dirs, store, config } = setup(t);
  const file = writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00")]);
  await runIndexPass(store, config);
  assert.equal(store.byPath.get(file).gone, false);
  fs.rmSync(file);
  const pass = await runIndexPass(store, config);
  assert.equal(pass.files, 0);
  const entry = store.byPath.get(file);
  assert.equal(entry.gone, true);
  assert.equal(sumRows(store, "n"), 1);
});

test("a fork does not count the history it copied from its parent", async (t) => {
  const { dirs, store, config } = setup(t);
  const forkStart = T("12:00:00.000");
  const file = writeChat(
    dirs.sessions,
    "-proj-a",
    "chatFork",
    [
      headerLine("chatFork", "/proj/a", forkStart, { parentSession: "/x/parent.jsonl" }),
      msg("c1", "11:00:00", { input: 1000 }),
      msg("c2", "11:59:59", { input: 1000 }),
      msg("f1", "12:00:05", { input: 7 }),
      msg("f2", "12:01:00", { input: 8 }),
    ],
  );
  await runIndexPass(store, config);
  const entry = store.byPath.get(file);
  assert.equal(entry.forked, true);
  assert.equal(entry.headerTs, Date.parse(forkStart));
  assert.equal(sumRows(store, "n"), 2);
  assert.equal(sumRows(store, "input"), 15);
});

test("a non-fork keeps every message, whatever its timestamp", async (t) => {
  const { dirs, store, config } = setup(t);
  writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("12:00:00.000")), msg("m1", "03:00:00"), msg("m2", "13:00:00")]);
  await runIndexPass(store, config);
  assert.equal(sumRows(store, "n"), 2);
});

test("rows are keyed by day, provider, model, worker and file; repeats merge, others split", async (t) => {
  const { dirs, store, config } = setup(t);
  writeChat(dirs.sessions, "-proj-a", "chatA", [
    headerLine("chatA", "/proj/a", T("00:00:00.000")),
    msg("m1", "01:00:00"),
    msg("m2", "02:00:00"),
    msg("m3", "03:00:00", { model: "claude-y" }),
    msg("m4", "04:00:00", { provider: "openai", model: "claude-x" }),
    assistantLine("m5", "2026-11-11T05:00:00Z", { input: 1, cost: 0.01 }),
    userLine("u1", T("06:00:00")),
    assistantLine("m6", T("07:00:00"), {}),
  ]);
  writeChat(dirs.sessions, "-proj-b", "chatB", [headerLine("chatB", "/proj/b", T("00:00:00.000")), msg("b1", "01:00:00")]);
  await runIndexPass(store, config);
  const rows = allRows(store);
  assert.equal(rows.length, 5, "A: x-same-day merges; y, openai, next day split; B is another file");
  const merged = rows.find((r) => r.model === "claude-x" && r.provider === "anthropic" && r.day === 20261110 && r.n === 2);
  assert.ok(merged, "m1 and m2 share one row");
  assert.equal(new Set(rows.map((r) => r.file)).size, 2);
  assert.equal(sumRows(store, "n"), 6, "the user message and the empty assistant message add nothing");
});

test("the same transcript never counts twice across passes or after the index is reopened", async (t) => {
  const { dirs, store, config } = setup(t);
  writeChat(dirs.sessions, "-proj-a", "chatA", [headerLine("chatA", "/proj/a", T("00:00:00.000")), msg("m1", "01:00:00"), msg("m2", "01:01:00")]);
  await runIndexPass(store, config);
  await runIndexPass(store, config);
  assert.equal(sumRows(store, "n"), 2);
  const reopened = StatsStore.open(dirs.index, "Asia/Tokyo");
  assert.equal(reopened.zone, ZONE, "an existing index keeps its own zone");
  assert.equal(sumRows(reopened, "n"), 2);
  const pass = await runIndexPass(reopened, config);
  assert.equal(pass.records, 0);
  assert.equal(sumRows(reopened, "n"), 2);
});

test("days are bucketed in the store zone, not UTC", async (t) => {
  const { dirs, store, config } = setup(t, "Asia/Tokyo");
  writeChat(dirs.sessions, "-proj-a", "chatA", [
    headerLine("chatA", "/proj/a", "2026-11-10T00:00:00.000Z"),
    assistantLine("a", "2026-11-10T14:30:00Z", { input: 1, cost: 0.01 }),
    assistantLine("b", "2026-11-10T15:30:00Z", { input: 10, cost: 0.01 }),
  ]);
  await runIndexPass(store, config);
  assert.equal(sumRows(store, "input", (r) => r.day === 20261110), 1, "23:30 Tokyo is still the 10th");
  assert.equal(sumRows(store, "input", (r) => r.day === 20261111), 10, "00:30 Tokyo is the 11th though UTC says the 10th");
});

test("workers: main, subagent:<type> (nested too), advisor, sidebar, engine helper, compaction", async (t) => {
  const { dirs, store, config } = setup(t);
  const chat = writeChat(dirs.sessions, "-proj-a", "chatA", [
    headerLine("chatA", "/proj/a", T("00:00:00.000")),
    assistantLine("m1", T("01:00:00"), { input: 1000, output: 1000, costParts: { input: 0.003, output: 0.015, total: 0.018 } }),
    `${JSON.stringify({ type: "model_usage", id: "mu", timestamp: T("01:05:00"), purpose: "memory:extract", provider: "anthropic", model: "claude-haiku", usage: { input: 5, output: 5, cost: { total: 0.001 } } })}\n`,
    `${JSON.stringify({ type: "compaction", id: "cp", timestamp: T("01:10:00"), preserveData: { openaiRemoteCompaction: { provider: "anthropic", usage: { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 100 } } } })}\n`,
  ]);
  writeArtifact(chat, "task1.jsonl", [headerLine("sub-session-1", "/elsewhere", T("00:30:00.000")), sessionInitLine("explore"), msg("s1", "01:20:00", { input: 3 })]);
  writeArtifact(chat, "nest/deeper.jsonl", [sessionInitLine("plan"), msg("s2", "01:21:00", { input: 4 })]);
  writeArtifact(chat, "__advisor.jsonl", [msg("ad", "01:22:00", { input: 5 })]);
  writeChat(dirs.sidebar, "-proj-a", "sideChat", [headerLine("sideChat", "/proj/a", T("00:00:00.000")), msg("sc", "01:30:00", { input: 9 })]);
  await runIndexPass(store, config);

  const byWorker = (worker) => allRows(store).filter((r) => r.worker === worker);
  assert.equal(byWorker("main").length, 1);
  assert.equal(byWorker("subagent:explore")[0].input, 3);
  assert.equal(byWorker("subagent:plan")[0].input, 4);
  assert.equal(byWorker("advisor")[0].input, 5);
  assert.equal(byWorker("sidebar")[0].input, 9);
  assert.equal(byWorker("engine:memory")[0].n, 1, "the purpose tail after ':' is dropped");
  const compaction = byWorker("compaction")[0];
  assert.equal(compaction.model, "claude-x", "attributed to the model that was answering");
  assert.equal(compaction.input, 2000);
  assert.ok(Math.abs(compaction.cost - (2000 * 3e-6 + 100 * 15e-6)) < 1e-9, "priced from the learnt per-token rates");

  const chatOf = new Map([...store.files.values()].map((f) => [path.basename(f.path), f.chat]));
  assert.equal(chatOf.get("task1.jsonl"), "chatA", "a subagent belongs to its parent chat, not its own session id");
  assert.equal(chatOf.get("deeper.jsonl"), "chatA");
  assert.equal(chatOf.get("__advisor.jsonl"), "chatA");
  assert.equal([...store.files.values()].find((f) => f.name === "task1")?.kind, "subagent");
  assert.equal([...store.files.values()].find((f) => f.kind === "sidebar")?.chat, "sideChat");
});

test("a message with no recorded price is unpriced tokens, never zero-cost spend; local models are exempt", async (t) => {
  const { dirs, store, config } = setup(t);
  writeChat(dirs.sessions, "-proj-a", "chatA", [
    headerLine("chatA", "/proj/a", T("00:00:00.000")),
    assistantLine("p", T("01:00:00"), { input: 100, output: 50, cost: 0.5 }),
    assistantLine("n", T("01:01:00"), { provider: "anthropic", model: "claude-nocost", input: 200, output: 20 }),
    assistantLine("z", T("01:02:00"), { provider: "openai", model: "gpt-zero", input: 30, cost: 0 }),
    assistantLine("l", T("01:03:00"), { provider: "ollama", model: "llama", input: 400, output: 40 }),
  ]);
  await runIndexPass(store, config);
  const row = (model) => allRows(store).find((r) => r.model === model);
  assert.equal(row("claude-x").unpriced, 0);
  assert.equal(row("claude-x").cost, 0.5);
  assert.equal(row("claude-nocost").unpriced, 220);
  assert.equal(row("claude-nocost").cost, 0);
  assert.equal(row("gpt-zero").unpriced, 30);
  assert.equal(row("gpt-zero").cost, 0);
  assert.equal(row("llama").unpriced, 0, "a local runtime has no price to be missing");
  assert.equal(row("llama").cost, 0);
  assert.equal(row("llama").input, 400, "but its tokens still count");
});

test("billing kinds", () => {
  assert.equal(billingKind("anthropic"), "subscription");
  assert.equal(billingKind("anthropic-api"), "payg");
  assert.equal(billingKind("ollama"), "local");
  assert.equal(billingKind("some-vendor-nobody-heard-of"), "unknown");
});

test("a recorded background job is filed once under background:<purpose>, with or without a chat", async (t) => {
  const { dirs, store, config } = setup(t);
  const ts = Date.parse("2026-11-10T08:00:00Z");
  const usage = { input: 11, output: 3, cost: { total: 0.02 } };
  const withChat = toJobLogEntry({ purpose: "title", sessionId: "chatA" }, { provider: "anthropic", model: "claude-haiku", usage }, ts);
  const noChat = toJobLogEntry({ purpose: "planner" }, { provider: "anthropic", model: "claude-haiku", usage }, ts + 1000);
  assert.equal(toJobLogEntry({ purpose: "title" }, { provider: "anthropic", model: "m", usage: {} }, ts), null, "no usage, no entry");
  appendJobLog(dirs.logs, withChat);
  appendJobLog(dirs.logs, noChat);
  assert.ok(fs.existsSync(path.join(dirs.logs, jobLogName(ts))));

  const first = await runIndexPass(store, config);
  assert.equal(first.records, 2);
  const titled = allRows(store).find((r) => r.worker === "background:title");
  const planned = allRows(store).find((r) => r.worker === "background:planner");
  assert.equal(titled.n, 1);
  assert.equal(planned.n, 1);
  const chatOfRow = (row) => store.files.get(row.file).chat;
  assert.equal(chatOfRow(titled), "chatA");
  assert.equal(chatOfRow(planned), "");

  const second = await runIndexPass(store, config);
  assert.equal(second.records, 0, "the log offset is remembered");
  const reopened = StatsStore.open(dirs.index, ZONE);
  const third = await runIndexPass(reopened, config);
  assert.equal(third.records, 0, "and survives a restart");
  assert.equal(sumRows(reopened, "n"), 2);

  appendJobLog(dirs.logs, toJobLogEntry({ purpose: "title", sessionId: "chatA" }, { provider: "anthropic", model: "claude-haiku", usage }, ts + 2000));
  const fourth = await runIndexPass(reopened, config);
  assert.equal(fourth.records, 1, "only the new line is read");
  assert.equal(sumRows(reopened, "n"), 3);
});

test("a half-written job log line waits for its newline", async (t) => {
  const { dirs, store, config } = setup(t);
  const ts = Date.parse("2026-11-10T08:00:00Z");
  const line = JSON.stringify({ ts, purpose: "research", chat: "", provider: "anthropic", model: "m", usage: { input: 5, output: 1, cost: { total: 0.01 } } });
  const log = path.join(dirs.logs, jobLogName(ts));
  fs.writeFileSync(log, line.slice(0, 20));
  assert.equal((await runIndexPass(store, config)).records, 0);
  fs.appendFileSync(log, `${line.slice(20)}\n`);
  assert.equal((await runIndexPass(store, config)).records, 1);
  assert.equal(allRows(store)[0].worker, "background:research");
});

test("a symlinked transcript is not followed", async (t) => {
  const { dirs, store, config } = setup(t);
  const outside = path.join(dirs.index, "outside.jsonl");
  fs.writeFileSync(outside, headerLine("evil", "/x", T("00:00:00.000")) + msg("e1", "01:00:00"));
  const slug = path.join(dirs.sessions, "-proj-a");
  fs.mkdirSync(slug, { recursive: true });
  fs.symlinkSync(outside, path.join(slug, "2026-11-10T00-00-00-000Z_evil.jsonl"));
  const pass = await runIndexPass(store, config);
  assert.equal(pass.files, 0);
  assert.equal(sumRows(store, "n"), 0);
});

test("a compaction before the model's first message is filed under the model_change default model", async (t) => {
  const { dirs, store, config } = setup(t);
  const change = (id, clock, o) => `${JSON.stringify({ type: "model_change", id, timestamp: T(clock), ...o })}\n`;
  const compaction = `${JSON.stringify({ type: "compaction", id: "cp", timestamp: T("01:10:00"), preserveData: { openaiRemoteCompaction: { provider: "openai-codex", usage: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 20 } } } })}\n`;
  writeChat(dirs.sessions, "-proj-a", "chatA", [
    headerLine("chatA", "/proj/a", T("00:00:00.000")),
    change("c1", "00:00:01", { model: "openai-codex/gpt-5", role: "default" }),
    change("c2", "00:00:02", { model: "openai-codex/gpt-tiny", role: "tiny" }),
    compaction,
  ]);
  await runIndexPass(store, config);
  const row = allRows(store).find((r) => r.worker === "compaction");
  assert.equal(row.model, "gpt-5", "the default role's model, not the tiny role's");
  assert.equal(row.input, 400);
  assert.equal(row.cacheRead, 100);
});
