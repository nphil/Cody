/**
 * A minimal ACP agent, for tests.
 *
 * The unit tests around translateSessionUpdate exercise a pure function and
 * were all passing while the real transport delivered nothing at all: the SDK
 * hands notification handlers a context object, and reading the payload off
 * the wrong one silently dropped every frame. Only a real agent on the other
 * end of a real pipe catches that class of bug, so this is one.
 *
 * Speaks JSON-RPC 2.0 over newline-delimited JSON on stdio, by hand — using
 * the SDK here would test the SDK against itself and hide exactly the wiring
 * mistake this exists to catch.
 *
 * Env knobs: ACP_STUB_DELAY_MS (how long a turn takes), ACP_STUB_SILENT (end
 * the turn with no content), ACP_STUB_STOP_REASON.
 */

const DELAY_MS = Number(process.env.ACP_STUB_DELAY_MS ?? "0");
const SILENT = process.env.ACP_STUB_SILENT === "1";
const STOP_REASON = process.env.ACP_STUB_STOP_REASON ?? "end_turn";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(id, sessionId) {
  if (!SILENT) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    });
    for (const text of ["Hello", " world"]) {
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }
  }
  if (DELAY_MS > 0) await sleep(DELAY_MS);
  reply(id, { stopReason: STOP_REASON });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // a notification; nothing to answer

    switch (message.method) {
      case "initialize":
        reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: false } });
        break;
      case "session/new":
        reply(message.id, { sessionId: "stub-session-1" });
        break;
      case "session/prompt":
        void runTurn(message.id, message.params?.sessionId);
        break;
      default:
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
