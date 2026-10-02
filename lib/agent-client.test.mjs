import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentCommandError, sendAgentCommand, sendPromptDelivery, getPromptDeliveryLedger } = await jiti.import("./agent-client.ts");

test("preserves an engine rejection code for command-specific handling", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "Fast mode is unavailable for the current model",
    code: "unsupported",
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      sendAgentCommand("session", { type: "set_fast_mode", enabled: true }),
      (error) => error instanceof AgentCommandError
        && error.code === "unsupported"
        && error.message === "Fast mode is unavailable for the current model",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prompt delivery preserves an acknowledgement that already has delivery proof", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init?.body ?? "{}");
    return new Response(JSON.stringify({ success: true, data: { delivery: "started", clientMessageId: "m1", status: "delivered" } }), { status: 200 });
  };
  try {
    const result = await sendPromptDelivery("session", { type: "prompt", message: "hello", streamingBehavior: "steer", clientMessageId: "m1" });
    assert.equal(result.data?.status, "delivered");
    assert.equal(requestBody.clientMessageId, "m1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("reads every requested server ledger status without collapsing repeated IDs", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify({ deliveries: [
      { clientMessageId: "one", status: "delivered" },
      { clientMessageId: "two", status: "unknown" },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const deliveries = await getPromptDeliveryLedger("session/id", ["one", "two"]);
    const url = new URL(requestedUrl, "http://localhost");
    assert.equal(url.pathname, "/api/agent/session%2Fid");
    assert.deepEqual(url.searchParams.getAll("clientMessageId"), ["one", "two"]);
    assert.deepEqual(deliveries.map(({ clientMessageId, status }) => [clientMessageId, status]), [
      ["one", "delivered"], ["two", "unknown"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not turn an unavailable delivery ledger into unknown IDs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unavailable", code: "session_dead" }), { status: 503 });
  try {
    await assert.rejects(getPromptDeliveryLedger("session", ["one"]), (error) =>
      error instanceof AgentCommandError && error.code === "session_dead");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** Run `body` while the process — standing in for the browser — is in `zone`. */
async function withDeviceZone(zone, body) {
  const original = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** A fetch that records every request body it is given. */
function recordBodies() {
  const bodies = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
  };
  return bodies;
}

test("every message command carries the zone of the device sending it, read when it is sent", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = recordBodies();
  try {
    for (const type of ["prompt", "steer", "follow_up", "abort_and_prompt"]) {
      const command = { type, message: "hello" };
      await withDeviceZone("Asia/Tokyo", () => sendAgentCommand("session", command));
      // The same command sent again — an outbox retry minutes later, from
      // wherever the tablet is by then.
      await withDeviceZone("America/New_York", () => sendAgentCommand("session", command));
      assert.deepEqual(bodies.splice(0).map((body) => body.timeZone), ["Asia/Tokyo", "America/New_York"], type);
      assert.equal("timeZone" in command, false, `${type}: the caller's command must not be rewritten`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("commands that are not messages never carry a zone", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = recordBodies();
  try {
    await withDeviceZone("Asia/Tokyo", async () => {
      for (const command of [{ type: "get_state" }, { type: "set_model", provider: "p", modelId: "m" }, { type: "bash", command: "date" }, { type: "steer_subagent", subagentId: "a", message: "hi" }]) {
        await sendAgentCommand("session", command);
      }
    });
    assert.equal(bodies.length, 4);
    for (const body of bodies) assert.equal("timeZone" in body, false, body.type);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("each prompt delivery attempt carries the zone it is sent from, not the one it was written in", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = recordBodies();
  try {
    const command = { type: "prompt", message: "hello", streamingBehavior: "followUp", clientMessageId: "m9" };
    await withDeviceZone("Asia/Tokyo", () => sendPromptDelivery("session", command));
    await withDeviceZone("America/New_York", () => sendPromptDelivery("session", command));
    assert.deepEqual(bodies.map((body) => [body.clientMessageId, body.timeZone]), [["m9", "Asia/Tokyo"], ["m9", "America/New_York"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
