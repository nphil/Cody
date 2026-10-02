import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Word completion fires per typing pause. It must never be the reason an
 * engine process starts: with no live session the answer is "no suggestion",
 * and the route says so without touching the spawn path.
 *
 * The agent dir is redirected before anything imports it, so nothing here
 * reads or writes the developer's real omp state. A session that did not
 * exist and a spawn that did happen would both be visible in the registry.
 */
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-predict-route-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/agent/[id]/route.ts");

function post(id, body) {
  return route.POST(
    new Request(`http://cody.test/api/agent/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

test("predict_word with no live session answers no suggestion and starts nothing", async () => {
  const res = await post("no-such-session", { type: "predict_word", text: "hello wor", cursor: 9 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, data: { suffix: null } });
  assert.equal(globalThis.__ompSessions?.has("no-such-session") ?? false, false);
});

test("predict_word_feedback with no live session succeeds and starts nothing", async () => {
  const res = await post("no-such-session", {
    type: "predict_word_feedback", text: "hello wor", cursor: 9, suggestion: "ld", accepted: true,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(globalThis.__ompSessions?.has("no-such-session") ?? false, false);
});

test("a dead session is treated as no session", async () => {
  (globalThis.__ompSessions ??= new Map()).set("dead", { isAlive: () => false, send: async () => assert.fail("must not send") });
  const res = await post("dead", { type: "predict_word", text: "hello wor", cursor: 9 });
  assert.deepEqual(await res.json(), { success: true, data: { suffix: null } });
  globalThis.__ompSessions.delete("dead");
});

test("a live session gets the command verbatim and its answer comes back unchanged", async () => {
  const sent = [];
  (globalThis.__ompSessions ??= new Map()).set("live", {
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => false,
    send: async (command) => { sent.push(command); return { suffix: "ld" }; },
  });
  const command = { type: "predict_word", text: "hello wor", cursor: 9 };
  const res = await post("live", command);
  assert.deepEqual(await res.json(), { success: true, data: { suffix: "ld" } });
  assert.deepEqual(sent, [command]);
  globalThis.__ompSessions.delete("live");
});
