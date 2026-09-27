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
