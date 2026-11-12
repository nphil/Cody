import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const crash = await jiti.import("./engine-crash.ts");
const log = await jiti.import("./engine-crash-log.ts");
const events = await jiti.import("./engine-crash-events.ts");

const notice = (at, extra = {}) => ({ reason: "out_of_memory", recovery: "automatic", at, detail: null, disk: null, quota: false, code: null, signal: "SIGKILL", ...extra });

async function inAgentDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-crash-log-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a chat keeps its last few crash notices, and a hand-damaged file reads as none", () => inAgentDir(() => {
  const now = Date.now();
  for (let i = 0; i < 7; i += 1) log.recordEngineCrash("chat-a", notice(now - 1000 + i), now);
  assert.equal(log.readEngineCrashes("chat-a").length, 5);
  assert.deepEqual(log.readEngineCrashes("chat-a").map((entry) => entry.at), [now - 998, now - 997, now - 996, now - 995, now - 994]);
  assert.deepEqual(log.readEngineCrashes("other"), []);
  fs.writeFileSync(log.engineCrashLogPath(), "{not json");
  assert.deepEqual(log.readEngineCrashes("chat-a"), []);
  log.recordEngineCrash("chat-a", notice(now), now);
  assert.equal(log.readEngineCrashes("chat-a").length, 1, "writing over a damaged file starts it again");
}));

test("notices older than a month are dropped the next time anything is written", () => inAgentDir(() => {
  const now = Date.now();
  log.recordEngineCrash("old-chat", notice(now - 40 * 24 * 60 * 60 * 1000), now - 40 * 24 * 60 * 60 * 1000);
  log.recordEngineCrash("new-chat", notice(now), now);
  assert.deepEqual(log.readEngineCrashes("old-chat"), []);
  assert.equal(log.readEngineCrashes("new-chat").length, 1);
}));

test("a chat that moves to a new id takes its notices along", () => inAgentDir(() => {
  const now = Date.now();
  log.recordEngineCrash("from", notice(now), now);
  log.copyEngineCrashes("from", "to");
  log.copyEngineCrashes("from", "to");
  assert.equal(log.readEngineCrashes("to").length, 1, "copying twice does not double the line");
  assert.equal(log.readEngineCrashes("from").length, 1);
}));

test("crash lines are laid among the messages by time, with ids kept parallel and no line added twice", () => {
  const messages = [{ role: "user", timestamp: 100 }, { role: "assistant", timestamp: 200 }, { role: "user", timestamp: 400 }, { role: "assistant", timestamp: 500 }];
  const ids = ["a", "b", "c", "d"];
  const merged = crash.withEngineCrashRows(messages, ids, [notice(300), notice(900)], crash.engineCrashRow);
  assert.deepEqual(merged.messages.map((m) => m.role), ["user", "assistant", "custom", "user", "assistant", "custom"]);
  assert.equal(merged.entryIds.length, merged.messages.length);
  assert.deepEqual(merged.entryIds.filter((id) => id.startsWith("cody-crash-")).length, 2);
  assert.equal(merged.entryIds[0], "a");
  assert.equal(merged.entryIds[3], "c");
  const again = crash.withEngineCrashRows(merged.messages, merged.entryIds, [notice(300), notice(900)], crash.engineCrashRow);
  assert.equal(again.messages.length, merged.messages.length);
  const none = crash.withEngineCrashRows(messages, ids, [], crash.engineCrashRow);
  assert.equal(none.messages, messages);
});

test("every listener hears a crash, and one that throws does not silence the rest", () => {
  const heard = [];
  const stopThrower = events.subscribeEngineCrashes(() => { throw new Error("broken listener"); });
  const stopHeard = events.subscribeEngineCrashes((event) => heard.push(event.sessionId));
  try {
    events.publishEngineCrash({ sessionId: "chat-x", title: null, notice: notice(1) });
    assert.deepEqual(heard, ["chat-x"]);
  } finally {
    stopThrower();
    stopHeard();
  }
  events.publishEngineCrash({ sessionId: "chat-y", title: null, notice: notice(2) });
  assert.deepEqual(heard, ["chat-x"], "after unsubscribing nothing is delivered");
});
