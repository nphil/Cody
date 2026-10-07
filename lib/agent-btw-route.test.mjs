import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Cancelling a side question only makes sense in a live engine. With no live
 * session there is nothing to cancel, and asking must never be the reason an
 * engine process starts.
 *
 * The agent dir is redirected before anything imports it, so nothing here
 * reads or writes the developer's real omp state.
 */
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-btw-route-"));

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

test("btw_cancel with no live session answers nothing was cancelled and starts nothing", async () => {
  const res = await post("no-such-session", { type: "btw_cancel" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, data: { cancelled: false } });
  assert.equal(globalThis.__ompSessions?.has("no-such-session") ?? false, false);
});

test("a dead session is treated as no session for btw_cancel", async () => {
  (globalThis.__ompSessions ??= new Map()).set("dead", { isAlive: () => false, send: async () => assert.fail("must not send") });
  try {
    const res = await post("dead", { type: "btw_cancel", recordId: "abc" });
    assert.deepEqual(await res.json(), { success: true, data: { cancelled: false } });
  } finally {
    globalThis.__ompSessions.delete("dead");
  }
});

test("a live session gets btw_cancel as sent and its answer comes back unchanged", async () => {
  const sent = [];
  (globalThis.__ompSessions ??= new Map()).set("live", {
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => true,
    send: async (command) => { sent.push(command); return { cancelled: true }; },
  });
  try {
    const command = { type: "btw_cancel", recordId: "159c283649af351e" };
    const res = await post("live", command);
    assert.deepEqual(await res.json(), { success: true, data: { cancelled: true } });
    assert.deepEqual(sent, [command]);
  } finally {
    globalThis.__ompSessions.delete("live");
  }
});
