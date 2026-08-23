import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Every frame of the running-sessions stream names the active engine.
 *
 * An engine switch is instance-wide, but only the browser that clicked Switch
 * reloads. A second surface — a tablet, a phone over Tailscale, another tab —
 * went on rendering the PREVIOUS engine's model roles, settings tabs and chat
 * affordances indefinitely, because the client reads capabilities exactly once
 * per page load. Its sidebar meanwhile swapped to the new engine's sessions,
 * so the two halves of one page disagreed about which engine was running.
 *
 * This stream is the one live connection every loaded page already holds, so
 * it is what tells the others. The heartbeat carries the engine too, which is
 * the only thing bounding how long an idle tab can stay wrong.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-running-events-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const runningEvents = await jiti.import("../app/api/agent/running/events/route.ts");

function selectEngine(id) {
  fs.writeFileSync(
    path.join(agentDir, "cody-engine.json"),
    JSON.stringify({ version: 1, activeEngine: id, onboarded: true, updatedAt: new Date().toISOString() }),
  );
}

/** Read the first SSE data frame, then drop the connection. */
async function firstFrame() {
  const controller = new AbortController();
  const response = await runningEvents.GET(new Request("http://cody.test/api/agent/running/events", {
    signal: controller.signal,
  }));
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const line = text.split("\n").find((entry) => entry.startsWith("data: "));
    assert.ok(line, `no data frame in: ${JSON.stringify(text)}`);
    return JSON.parse(line.slice("data: ".length));
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

test("the initial snapshot names the engine the instance is actually running", async () => {
  selectEngine("hermes");
  const frame = await firstFrame();
  assert.equal(frame.type, "running");
  assert.equal(frame.engine, "hermes");
  assert.ok(Array.isArray(frame.runningSessionIds));
});

test("the frame follows the switch, which is what lets another tab notice", async () => {
  // The client compares this against the engine its page booted with. If the
  // stream kept answering with a stale id there would be nothing to compare,
  // and the second surface would stay wrong until someone reloaded it by hand.
  selectEngine("omp");
  assert.equal((await firstFrame()).engine, "omp");
  selectEngine("pi");
  assert.equal((await firstFrame()).engine, "pi");
});
