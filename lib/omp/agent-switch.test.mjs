import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Moving a running helper to another model (lib/omp/agent-switch.ts) and the
 * extension that makes the restart land on it (lib/omp/extensions/cody-agent-switch.ts).
 * The two share a file; every case that touches it runs the server's writer
 * and the extension's reader against each other, so the format cannot drift.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const sw = await jiti.import("./agent-switch.ts");
const extension = await jiti.import("./extensions/cody-agent-switch.ts");
const crash = await jiti.import("../engine-crash.ts");

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-switch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = 1_700_000_000_000;
const entry = (over = {}) => ({ id: "a-1", agent: "deep-task", helper: "DbHealth", model: "@slow", note: "Moved by you to the slow role", expiresAt: NOW + sw.SWITCH_TTL_MS, ...over });

test("the note the main agent gets says who sent it, what happened and what to do", () => {
  const note = sw.switchNote({ helperId: "DbHealth", agent: "deep-task", target: "the slow role (anthropic/claude-opus-5-5)", alsoFuture: false, transcriptPath: "/s/DbHealth.jsonl" });
  assert.match(note, /^This is an automatic message from Cody, not from the user\./);
  assert.match(note, /The user moved your helper `DbHealth` \(agent `deep-task`\) to the slow role \(anthropic\/claude-opus-5-5\)/);
  assert.match(note, /Start that job again now with agent `deep-task`: it will start on the slow role \(anthropic\/claude-opus-5-5\) \(this once\)\./);
  assert.match(note, /Do not ask for another model and do not move it back\./);
  assert.match(note, /transcript so far is at \/s\/DbHealth\.jsonl/);
  assert.doesNotMatch(note, /every later helper/);
  const always = sw.switchNote({ helperId: "x", agent: "deep-task", target: "a/b", alsoFuture: true });
  assert.match(always, /and so will every later helper of that kind/);
  assert.match(always, /Tell the new helper what is already done/, "no transcript known");
  assert.doesNotMatch(always, /\n/, "one paragraph");
});

test("a choice reads as a role with its model, or as the exact model", () => {
  const roleModel = (role) => ({ slow: "anthropic/claude-opus-5-5" })[role];
  assert.equal(sw.describeSwitchTarget("@slow", roleModel), "the slow role (anthropic/claude-opus-5-5)");
  assert.equal(sw.describeSwitchTarget("@task", roleModel), "the task role");
  assert.equal(sw.describeSwitchTarget("mock/model-b", roleModel), "mock/model-b");
});

test("waiting restarts: kept newest-few, expired ones dropped, removable one by one", (t) => {
  const dir = scratch(t);
  assert.deepEqual(sw.pendingSwitches(dir, NOW), []);
  sw.addPendingSwitch(dir, entry({ id: "old", expiresAt: NOW + 10 }), NOW);
  sw.addPendingSwitch(dir, entry({ id: "b" }), NOW);
  assert.deepEqual(sw.pendingSwitches(dir, NOW).map((e) => e.id), ["old", "b"]);
  assert.deepEqual(sw.pendingSwitches(dir, NOW + 11).map((e) => e.id), ["b"], "expired entries are not shown");
  sw.addPendingSwitch(dir, entry({ id: "c" }), NOW + 11);
  assert.deepEqual(sw.pendingSwitches(dir, NOW + 11).map((e) => e.id), ["b", "c"], "and are pruned on the next write");
  sw.removePendingSwitch(dir, "b", NOW + 11);
  sw.removePendingSwitch(dir, "never-there", NOW + 11);
  assert.deepEqual(sw.pendingSwitches(dir, NOW + 11).map((e) => e.id), ["c"]);
  for (let index = 0; index < 30; index += 1) sw.addPendingSwitch(dir, entry({ id: `n${index}` }), NOW);
  assert.equal(sw.pendingSwitches(dir, NOW).length, 20, "the newest twenty");
  assert.equal(sw.pendingSwitches(dir, NOW).at(-1).id, "n29");
  assert.deepEqual(fs.readdirSync(dir), [sw.SWITCH_FILE], "no temporary file is left behind");
  fs.writeFileSync(path.join(dir, sw.SWITCH_FILE), "{not json");
  assert.deepEqual(sw.pendingSwitches(dir, NOW), [], "a damaged file is an empty one");
});

test("the extension reads what the server writes, and nothing it cannot trust", (t) => {
  const dir = scratch(t);
  sw.addPendingSwitch(dir, entry({ id: "ok" }), NOW);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, sw.SWITCH_FILE), "utf8"));
  assert.deepEqual(extension.readSwitches(raw), sw.pendingSwitches(dir, NOW));
  assert.deepEqual(extension.readSwitches({ switches: [null, 4, {}, { ...entry(), model: "  " }, { ...entry(), expiresAt: "soon" }, { ...entry(), helper: 7 }, entry({ id: "fine" })] }).map((e) => e.id), ["fine"]);
  for (const nothing of [undefined, null, "x", [], { switches: "no" }]) assert.deepEqual(extension.readSwitches(nothing), []);
});

test("the next helper of the moved kind gets the choice: its own name first, otherwise the oldest", () => {
  const take = extension.takeSwitch;
  const entries = [entry({ id: "first", helper: "Alpha" }), entry({ id: "second", helper: "DbHealth-2" }), entry({ id: "other-kind", agent: "task", helper: "DbHealth" })];
  assert.equal(take(entries, { agent: "deep-task", spawnKey: "DbHealth" }, NOW).chosen.id, "second", "a restart that reuses the helper's name (omp numbers repeats)");
  assert.equal(take(entries, { agent: "deep-task", spawnKey: "parent.DbHealth-3" }, NOW).chosen.id, "second", "a helper's own helper carries its parent's prefix");
  assert.equal(take(entries, { agent: "deep-task", spawnKey: "Unrelated" }, NOW).chosen.id, "first", "otherwise the oldest of that kind");
  assert.equal(take(entries, { agent: "deep-task" }, NOW).chosen.id, "first");
  assert.equal(take(entries, { agent: "task" }, NOW).chosen.id, "other-kind");
  assert.equal(take(entries, { agent: "reviewer", spawnKey: "DbHealth" }, NOW).chosen, null, "another kind of helper never takes it");
  assert.deepEqual(take(entries, { agent: "deep-task", spawnKey: "DbHealth" }, NOW).rest.map((e) => e.id), ["first", "other-kind"]);
  const expired = take([entry({ id: "late", expiresAt: NOW })], { agent: "deep-task" }, NOW);
  assert.equal(expired.chosen, null, "an entry is dead at its expiry time");
  assert.deepEqual(expired.rest, []);
});

/** Register an extension over a fake omp and hand back what it subscribed to and its handler. */
function load(factory) {
  const subscribed = [];
  let handler;
  factory({ on: (event, fn) => { subscribed.push(event); handler = fn; } });
  return { subscribed, spawn: (event) => handler(event) };
}

test("the extension answers one helper once, listens to nothing else and never stops a helper starting", () => {
  let file = { switches: [entry({ id: "one" })] };
  const writes = [];
  const { subscribed, spawn } = load(extension.createAgentSwitch({ read: () => file, write: (entries) => { writes.push(entries); file = { switches: entries }; }, now: () => NOW }));
  assert.deepEqual(subscribed, ["before_subagent_spawn"], "a tool_call/tool_result handler would switch off omp's speculative launch");
  assert.deepEqual(spawn({ agent: "reviewer", spawnKey: "R" }), undefined, "another kind of helper");
  assert.deepEqual(writes, []);
  assert.deepEqual(spawn({ agent: "deep-task", spawnKey: "DbHealth" }), { model: "@slow", note: "Moved by you to the slow role" });
  assert.deepEqual(spawn({ agent: "deep-task", spawnKey: "DbHealth" }), undefined, "once");
  assert.deepEqual(writes, [[]]);

  file = { switches: [entry()] };
  const failing = load(extension.createAgentSwitch({ read: () => file, write: () => { throw new Error("disk full"); }, now: () => NOW }));
  assert.deepEqual(failing.spawn({ agent: "deep-task" }), { model: "@slow", note: "Moved by you to the slow role" }, "a failed clean-up does not cost the helper its model");
  const unreadable = load(extension.createAgentSwitch({ read: () => { throw new Error("EACCES"); }, write: () => {}, now: () => NOW }));
  assert.equal(unreadable.spawn({ agent: "deep-task" }), undefined);
});

test("the shipped extension reads the chat's scratch folder: written by the server, taken by the extension", (t) => {
  const dir = scratch(t);
  const previous = process.env.CODY_SCRATCH;
  t.after(() => {
    if (previous === undefined) delete process.env.CODY_SCRATCH;
    else process.env.CODY_SCRATCH = previous;
  });
  process.env.CODY_SCRATCH = dir;
  const { spawn } = load(extension.default);
  assert.equal(spawn({ agent: "deep-task" }), undefined, "no file yet");
  sw.addPendingSwitch(dir, entry({ expiresAt: Date.now() + 60_000 }), Date.now());
  assert.deepEqual(spawn({ agent: "deep-task", spawnKey: "DbHealth" }), { model: "@slow", note: "Moved by you to the slow role" });
  assert.deepEqual(sw.pendingSwitches(dir, Date.now()), [], "taken from the file");
  assert.deepEqual(fs.readdirSync(dir), [sw.SWITCH_FILE], "no temporary file is left behind");
  delete process.env.CODY_SCRATCH;
  assert.equal(spawn({ agent: "deep-task" }), undefined, "no scratch folder (a terminal run): nothing to do");
});

/** A chat that answers the way omp does, and notes everything it was asked. */
function chat(t, { cancel = { cancelled: true }, steer = "ok", scratchDir = scratch(t) } = {}) {
  const log = { sent: [], announced: [], at: {} };
  const session = {
    sessionId: "chat-1",
    scratchDir,
    send: async (command) => {
      log.sent.push(command);
      if (command.type === "cancel_subagent") {
        log.at.pendingWhenCancelled = scratchDir ? sw.pendingSwitches(scratchDir, NOW).map((e) => e.id) : null;
        if (cancel instanceof Error) throw cancel;
        return cancel;
      }
      if (steer instanceof Error) throw steer;
      return steer;
    },
    announce: (event) => log.announced.push(event),
  };
  return { session, log, scratchDir };
}

function deps(over = {}) {
  const calls = { overrides: [], records: [] };
  return {
    calls,
    deps: {
      now: () => NOW,
      zoneFor: () => "Europe/London",
      roleModel: (role) => ({ slow: "anthropic/claude-opus-5-5" })[role],
      setOverride: (agent, selector) => calls.overrides.push([agent, selector]),
      record: (sessionId, notice, at) => calls.records.push({ sessionId, notice, at }),
      sendBoundMs: 1_000,
      canSwitchOnce: true,
      ...over,
    },
  };
}

const request = (over = {}) => ({ subagentId: "DbHealth", agent: "deep-task", selector: "@slow", alsoFuture: false, transcriptPath: "/s/DbHealth.jsonl", ...over });

test("moving a helper once: the choice is waiting before it stops, the main agent is told, the chat says so", async (t) => {
  const { session, log, scratchDir } = chat(t);
  const { deps: d, calls } = deps();
  const outcome = await sw.switchHelper(session, request(), d);
  assert.deepEqual(outcome, { ok: true, how: "once", told: true });
  assert.deepEqual(log.at.pendingWhenCancelled, [`DbHealth-${NOW}`], "the restart can never beat the choice to the extension");
  assert.deepEqual(log.sent.map((c) => c.type), ["cancel_subagent", "prompt"]);
  assert.deepEqual(log.sent[0], { type: "cancel_subagent", subagentId: "DbHealth" });
  const steer = log.sent[1];
  assert.equal(steer.streamingBehavior, "steer", "arrives even in the middle of a turn");
  assert.equal(steer.clientMessageId, `agentswitch-chat-1-${NOW}`);
  assert.equal(steer.timeZone, "Europe/London");
  assert.equal(steer.message, sw.switchNote({ helperId: "DbHealth", agent: "deep-task", target: "the slow role (anthropic/claude-opus-5-5)", alsoFuture: false, transcriptPath: "/s/DbHealth.jsonl" }));
  assert.deepEqual(calls.overrides, [], "no permanent setting");
  const [waiting] = sw.pendingSwitches(scratchDir, NOW);
  assert.deepEqual({ agent: waiting.agent, helper: waiting.helper, model: waiting.model }, { agent: "deep-task", helper: "DbHealth", model: "@slow" });
  // The line in the chat: filed, and announced in the open page.
  assert.equal(calls.records.length, 1);
  const [{ sessionId, notice }] = calls.records;
  assert.equal(sessionId, "chat-1");
  assert.deepEqual(notice, { reason: "helper_switched", detail: "DbHealth → the slow role (anthropic/claude-opus-5-5)", disk: null, quota: false, code: null, signal: null, recovery: "automatic", at: NOW });
  assert.deepEqual(crash.readEngineCrashNotice(notice), notice, "what is filed reads back");
  assert.equal(log.announced.length, 1);
  assert.equal(log.announced[0].reason, "helper_switched");
  assert.equal(log.announced[0].level, "info");
  assert.equal(log.announced[0].message, crash.engineCrashSentence(notice));
  assert.deepEqual(log.announced[0].crash, notice);
});

test("moving a helper and keeping the choice: the setting is saved first and no one-time entry is left", async (t) => {
  const { session, log, scratchDir } = chat(t);
  const { deps: d, calls } = deps({ canSwitchOnce: false });
  const outcome = await sw.switchHelper(session, request({ alsoFuture: true, selector: "mock/model-b" }), d);
  assert.deepEqual(outcome, { ok: true, how: "setting", told: true });
  assert.deepEqual(calls.overrides, [["deep-task", "mock/model-b"]]);
  assert.deepEqual(sw.pendingSwitches(scratchDir, NOW), [], "the setting does the job on any omp");
  assert.match(log.sent[1].message, /to mock\/model-b, so Cody stopped it/);
  assert.match(log.sent[1].message, /and so will every later helper of that kind/);
});

test("a helper that had already finished: nothing is told or recorded, and a one-time choice is taken back", async (t) => {
  const once = chat(t, { cancel: { cancelled: false } });
  const first = deps();
  assert.deepEqual(await sw.switchHelper(once.session, request(), first.deps), { ok: false, code: "already_finished", settingSaved: false });
  assert.deepEqual(once.log.sent.map((c) => c.type), ["cancel_subagent"]);
  assert.deepEqual(sw.pendingSwitches(once.scratchDir, NOW), []);
  assert.deepEqual(first.calls.records, []);
  assert.deepEqual(once.log.announced, []);

  const kept = chat(t, { cancel: { cancelled: false } });
  const second = deps();
  assert.deepEqual(await sw.switchHelper(kept.session, request({ alsoFuture: true }), second.deps), { ok: false, code: "already_finished", settingSaved: true }, "the setting the person asked for stays");
  assert.deepEqual(second.calls.overrides, [["deep-task", "@slow"]]);
  assert.deepEqual(kept.log.sent.map((c) => c.type), ["cancel_subagent"]);
});

test("an engine that fails to stop the helper leaves nothing behind", async (t) => {
  const failing = chat(t, { cancel: new Error("Unknown command: cancel_subagent") });
  const { deps: d, calls } = deps();
  await assert.rejects(() => sw.switchHelper(failing.session, request(), d), /Unknown command/);
  assert.deepEqual(sw.pendingSwitches(failing.scratchDir, NOW), []);
  assert.deepEqual(failing.log.sent.map((c) => c.type), ["cancel_subagent"]);
  assert.deepEqual(calls.records, []);

  const silent = chat(t);
  silent.session.send = () => new Promise(() => {});
  await assert.rejects(() => sw.switchHelper(silent.session, request(), deps({ sendBoundMs: 20 }).deps), /timed out stopping the helper/);
  assert.deepEqual(sw.pendingSwitches(silent.scratchDir, NOW), [], "a timeout takes the choice back too");
});

test("without a one-time switch, the choice must be kept as the setting", async (t) => {
  const old = chat(t);
  const first = deps({ canSwitchOnce: false });
  assert.deepEqual(await sw.switchHelper(old.session, request(), first.deps), { ok: false, code: "needs_setting", settingSaved: false });
  assert.deepEqual(old.log.sent, [], "nothing is stopped");
  const bare = chat(t, { scratchDir: null });
  assert.deepEqual(await sw.switchHelper(bare.session, request(), deps().deps), { ok: false, code: "no_scratch", settingSaved: false });
  assert.deepEqual(bare.log.sent, []);
  const kept = await sw.switchHelper(bare.session, request({ alsoFuture: true }), deps().deps);
  assert.equal(kept.ok, true, "the setting needs no scratch folder");
});

test("the helper is stopped even if the chat cannot be told, and the person is told that", async (t) => {
  const { session, log } = chat(t, { steer: new Error("engine busy") });
  const { deps: d, calls } = deps();
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const outcome = await sw.switchHelper(session, request(), d);
  assert.deepEqual(outcome, { ok: true, how: "once", told: false });
  assert.equal(calls.records.length, 1, "the line is still filed");
  assert.equal(log.announced.length, 1);
});
