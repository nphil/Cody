import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_TRUST_NOTE, DEVICE_OPERATION_TOOLS } = await jiti.import("../lib/devices/operation-tools.ts");
const { SCHEDULE_TOOLS } = await jiti.import("../lib/scheduled/tools.ts");
const { CHAT_MESSAGE_TOOLS } = await jiti.import("../lib/chat-messages/tools.ts");
const { MODEL_SWITCH_TOOLS } = await jiti.import("../lib/model-switch/tool.ts");
const { RUN_ON_WORKER_TOOL } = await jiti.import("../lib/workers/tool.ts");

/**
 * Engines launched through displayMcpAcpServer() / claudeDisplayMcpConfig() do
 * not get the host tool definitions Cody's own engine gets: they get this
 * script's hard-coded list. The bridge is run for real over stdio against a
 * stand-in for Cody's device endpoint, so what an engine can discover and what
 * reaches the server is observed rather than read from source.
 */
async function withBridge(run, { scheduled = true, messaging = true, modelSwitch = true, workers = true } = {}) {
  const calls = [];
  const events = [];
  const paths = [];
  const endpoint = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      calls.push({ authorization: request.headers.authorization, body });
      paths.push(request.url);
      const command = body.arguments?.command;
      if (request.url === "/workers" && command === "stream") {
        // The real route's shape: progress lines, a heartbeat, a line that is not JSON, then the result.
        response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
        response.write(`${JSON.stringify({ type: "progress", text: "Running on proxmox - 1 s\nbuilding" })}\n`);
        response.write(`${JSON.stringify({ type: "heartbeat" })}\nnot json\n`);
        response.write(JSON.stringify({ type: "progress", text: "Running on proxmox - 2 s\ndone building" }).slice(0, 20));
        setTimeout(() => {
          response.write(`${JSON.stringify({ type: "progress", text: "Running on proxmox - 2 s\ndone building" }).slice(20)}\n`);
          response.end(`${JSON.stringify({ type: "result", text: "exit 2 on proxmox", isError: true })}\n`);
        }, 20);
        return;
      }
      if (request.url === "/workers" && command === "hang") {
        // A job that never ends: all that matters is whether the bridge hangs up when the call is cancelled.
        response.setHeader("content-type", "application/x-ndjson");
        response.write(`${JSON.stringify({ type: "progress", text: "Running on proxmox - 1 s" })}\n`);
        response.on("close", () => events.push("hung up"));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: `server accepted ${body.tool}` }));
    });
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const { port } = endpoint.address();
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./cody-display-mcp.js", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      CODY_DISPLAY_ENDPOINT: `http://127.0.0.1:${port}/display`,
      CODY_DEVICES_ENDPOINT: `http://127.0.0.1:${port}/devices`,
      ...(scheduled ? { CODY_SCHEDULED_ENDPOINT: `http://127.0.0.1:${port}/scheduled` } : {}),
      ...(messaging ? { CODY_MESSAGING_ENDPOINT: `http://127.0.0.1:${port}/messaging` } : {}),
      ...(modelSwitch ? { CODY_MODEL_SWITCH_ENDPOINT: `http://127.0.0.1:${port}/model-switch` } : {}),
      ...(workers ? { CODY_WORKERS_ENDPOINT: `http://127.0.0.1:${port}/workers` } : {}),
      CODY_DISPLAY_CAPABILITY: "capability-token",
      CODY_DISPLAY_SESSION_ID: "session-1",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await run({ client, calls, paths, events });
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((resolve) => endpoint.close(resolve));
  }
}

test("every device operation tool the host defines can be discovered through the MCP bridge with the same arguments", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    for (const hosted of DEVICE_OPERATION_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
      assert.deepEqual(
        Object.keys(exposed.inputSchema.properties ?? {}).sort(),
        Object.keys(hosted.parameters.properties).sort(),
        `${hosted.name} takes different arguments through the bridge`,
      );
      if (hosted.parameters.properties.protocol?.enum) {
        assert.deepEqual(exposed.inputSchema.properties.protocol.enum, hosted.parameters.properties.protocol.enum, `${hosted.name} offers different protocols through the bridge`);
      }
    }
    // An engine is never told to expect an approval, a typed override or a shell grant: the user's one trust answer replaced them.
    for (const hosted of DEVICE_OPERATION_TOOLS) {
      assert.doesNotMatch(bridge.get(hosted.name).description, /typed|confirmation|shell grant|shell access|Devices panel to approve/i, `${hosted.name} still describes an approval step through the bridge`);
    }
  });
});

test("the device-trust note is the same words through the bridge as for the host, on the same tools", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    for (const hosted of DEVICE_OPERATION_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.equal(
        exposed.description.includes(DEVICE_TRUST_NOTE),
        hosted.description.includes(DEVICE_TRUST_NOTE),
        `${hosted.name}: the bridge and the host disagree about whether the tool documents the trust the user gives`,
      );
    }
    assert.ok(bridge.get("device_exec").description.includes(DEVICE_TRUST_NOTE), "an engine reached over MCP is told about the one-time trust");
    assert.ok(!bridge.get("device_detect").description.includes(DEVICE_TRUST_NOTE), "read-only detection is not gated, so it is not described as gated");
    assert.match(bridge.get("device_exec").inputSchema.properties.options.description, /sendDelaySeconds/);
  });
});

test("device_install called through the MCP bridge reaches the device endpoint with the session capability and every argument intact", async () => {
  await withBridge(async ({ client, calls }) => {
    const args = { device: "usb-1", protocol: "adb", fileId: "apk-1", sha256: "a".repeat(64), interfaceNumber: 2, alternateSetting: 1, options: { replace: true, grantPermissions: true } };
    const result = await client.callTool({ name: "device_install", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted device_install" }]);
    assert.deepEqual(calls, [{ authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "device_install", arguments: args } }]);

    // A malformed digest never leaves the bridge.
    const refused = await client.callTool({ name: "device_install", arguments: { ...args, sha256: "not-a-digest" } }).then((value) => value, (error) => error);
    assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses a bad digest");
    assert.equal(calls.length, 1);
  });
});

test("the backup name an operation can be given has the same type and limit through the MCP bridge as for the host, on every tool that starts one", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    // The tools that start an operation are the ones with a protocol to run; the saving tools have a set of their own.
    const starting = DEVICE_OPERATION_TOOLS.filter((hosted) => hosted.parameters.properties.protocol && hosted.parameters.properties.set);
    assert.equal(starting.length, 10, "device_detect, flash, dump, exec, push, pull, sideload, install, verify and monitor");
    for (const hosted of starting) {
      const exposed = bridge.get(hosted.name).inputSchema.properties.set;
      assert.equal(exposed.type, "string", `${hosted.name}: set is text through the bridge`);
      assert.equal(exposed.maxLength, 80, `${hosted.name}: and no longer than the host allows`);
    }
  });
});

test("a backup name goes through the MCP bridge to the device endpoint with the call, and one that is too long never leaves the bridge", async () => {
  await withBridge(async ({ client, calls }) => {
    const args = { device: "usb-1", protocol: "edl", command: "backup", set: "Cronos tablet 2026-10-07", options: { partitions: ["boot_a", "persist"] } };
    const result = await client.callTool({ name: "device_exec", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "device_exec", arguments: args } }]);

    const refused = await client.callTool({ name: "device_exec", arguments: { ...args, set: "x".repeat(81) } }).then((value) => value, (error) => error);
    assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses a name that is too long");
    assert.equal(calls.length, 1);
  });
});

test("every scheduling tool the host defines is offered through the MCP bridge with the same arguments and the same words", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    for (const hosted of SCHEDULE_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
      const hostedProperties = hosted.parameters.properties ?? {};
      assert.deepEqual(Object.keys(exposed.inputSchema.properties ?? {}).sort(), Object.keys(hostedProperties).sort(), `${hosted.name} takes different arguments through the bridge`);
      assert.deepEqual([...(exposed.inputSchema.required ?? [])].sort(), [...(hosted.parameters.required ?? [])].sort(), `${hosted.name} requires different arguments through the bridge`);
      assert.equal(exposed.description, hosted.description, `${hosted.name} teaches a different purpose through the bridge`);
      for (const [name, spec] of Object.entries(hostedProperties)) {
        assert.equal(exposed.inputSchema.properties[name].type, spec.type, `${hosted.name}.${name} has a different type through the bridge`);
        assert.equal(exposed.inputSchema.properties[name].description, spec.description, `${hosted.name}.${name} is described differently through the bridge`);
      }
    }
  });
});

test("a scheduling call through the MCP bridge reaches the scheduling endpoint with the session capability, and the server's words come back", async () => {
  await withBridge(async ({ client, calls, paths }) => {
    const args = { message: "carry on with the migration", at: "2026-10-07T09:00", session: "Release work" };
    const result = await client.callTool({ name: "schedule_message", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted schedule_message" }]);
    await client.callTool({ name: "list_scheduled", arguments: {} });
    await client.callTool({ name: "cancel_scheduled", arguments: { id: "sch_abc" } });
    assert.deepEqual(paths, ["/scheduled", "/scheduled", "/scheduled"], "scheduling never goes to the display or device endpoints");
    assert.deepEqual(calls, [
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "schedule_message", arguments: args } },
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "list_scheduled", arguments: {} } },
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "cancel_scheduled", arguments: { id: "sch_abc" } } },
    ]);

    // A call missing its required argument never leaves the bridge.
    const refused = await client.callTool({ name: "cancel_scheduled", arguments: {} }).then((value) => value, (error) => error);
    assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses a cancel without an id");
    assert.equal(calls.length, 3);
  });
});

test("an engine started without a scheduling endpoint is told so plainly instead of hanging", async () => {
  await withBridge(async ({ client, calls }) => {
    const result = await client.callTool({ name: "schedule_message", arguments: { message: "later", whenQuotaResets: true } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /scheduling capability is unavailable/);
    assert.equal(calls.length, 0);
  }, { scheduled: false });
});

test("send_to_chat and message_status are offered through the MCP bridge with the same arguments and the same words as for the host", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(CHAT_MESSAGE_TOOLS.map((tool) => tool.name), ["send_to_chat", "message_status"]);
    for (const hosted of CHAT_MESSAGE_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
      const hostedProperties = hosted.parameters.properties ?? {};
      assert.deepEqual(Object.keys(exposed.inputSchema.properties ?? {}).sort(), Object.keys(hostedProperties).sort(), `${hosted.name} takes different arguments through the bridge`);
      assert.deepEqual([...(exposed.inputSchema.required ?? [])].sort(), [...(hosted.parameters.required ?? [])].sort(), `${hosted.name} requires different arguments through the bridge`);
      assert.equal(exposed.description, hosted.description, `${hosted.name} teaches a different purpose through the bridge`);
      for (const [name, spec] of Object.entries(hostedProperties)) {
        assert.equal(exposed.inputSchema.properties[name].type, spec.type, `${hosted.name}.${name} has a different type through the bridge`);
        assert.equal(exposed.inputSchema.properties[name].description, spec.description, `${hosted.name}.${name} is described differently through the bridge`);
        if (spec.enum) assert.deepEqual(exposed.inputSchema.properties[name].enum, spec.enum, `${hosted.name}.${name} offers different values through the bridge`);
      }
    }
  });
});

test("a messaging call through the MCP bridge reaches the messaging endpoint with the session capability, and the server's words come back", async () => {
  await withBridge(async ({ client, calls, paths }) => {
    const args = { session: "Release work", message: "the migration is done, rebase on main", urgency: "after_turn" };
    const result = await client.callTool({ name: "send_to_chat", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted send_to_chat" }]);
    await client.callTool({ name: "message_status", arguments: { id: "msg_abc" } });
    assert.deepEqual(paths, ["/messaging", "/messaging"], "messaging never goes to the display, scheduling or device endpoints");
    assert.deepEqual(calls, [
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "send_to_chat", arguments: args } },
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "message_status", arguments: { id: "msg_abc" } } },
    ]);

    // Calls the schema refuses never leave the bridge: no chat named, an urgency that does not exist, no id.
    for (const bad of [
      { name: "send_to_chat", arguments: { message: "hello" } },
      { name: "send_to_chat", arguments: { session: "x", message: "hello", urgency: "now" } },
      { name: "message_status", arguments: {} },
    ]) {
      const refused = await client.callTool(bad).then((value) => value, (error) => error);
      assert.ok(refused instanceof Error || refused.isError === true, `the schema refuses ${JSON.stringify(bad.arguments)}`);
    }
    assert.equal(calls.length, 2);
  });
});

test("an engine started without a messaging endpoint is told so plainly instead of hanging", async () => {
  await withBridge(async ({ client, calls }) => {
    const result = await client.callTool({ name: "send_to_chat", arguments: { session: "other", message: "hi" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /messaging capability is unavailable/);
    assert.equal(calls.length, 0);
  }, { messaging: false });
});

test("switch_model is offered through the MCP bridge with the same arguments and the same words as for the host", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(MODEL_SWITCH_TOOLS.map((tool) => tool.name), ["switch_model"]);
    for (const hosted of MODEL_SWITCH_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
      const hostedProperties = hosted.parameters.properties ?? {};
      assert.deepEqual(Object.keys(exposed.inputSchema.properties ?? {}).sort(), Object.keys(hostedProperties).sort(), `${hosted.name} takes different arguments through the bridge`);
      assert.deepEqual([...(exposed.inputSchema.required ?? [])].sort(), [...(hosted.parameters.required ?? [])].sort(), `${hosted.name} requires different arguments through the bridge`);
      assert.equal(exposed.description, hosted.description, `${hosted.name} teaches a different purpose through the bridge`);
      for (const [name, spec] of Object.entries(hostedProperties)) {
        assert.equal(exposed.inputSchema.properties[name].type, spec.type, `${hosted.name}.${name} has a different type through the bridge`);
        assert.equal(exposed.inputSchema.properties[name].description, spec.description, `${hosted.name}.${name} is described differently through the bridge`);
        if (spec.enum) assert.deepEqual(exposed.inputSchema.properties[name].enum, spec.enum, `${hosted.name}.${name} offers different values through the bridge`);
      }
    }
  });
});

test("a model switch through the MCP bridge reaches the model-switch endpoint with the session capability, and the server's words come back", async () => {
  await withBridge(async ({ client, calls, paths }) => {
    const args = { model: "opus 4.8", reasoning: "high" };
    const result = await client.callTool({ name: "switch_model", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted switch_model" }]);
    await client.callTool({ name: "switch_model", arguments: {} });
    assert.deepEqual(paths, ["/model-switch", "/model-switch"], "a model switch never goes to the display, scheduling, messaging or device endpoints");
    assert.deepEqual(calls, [
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "switch_model", arguments: args } },
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "switch_model", arguments: {} } },
    ]);

    // A scope the tool does not have never leaves the bridge.
    const refused = await client.callTool({ name: "switch_model", arguments: { model: "x", scope: "planet" } }).then((value) => value, (error) => error);
    assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses a scope that does not exist");
    assert.equal(calls.length, 2);
  });
});

test("an engine started without a model-switch endpoint is told so plainly instead of hanging", async () => {
  await withBridge(async ({ client, calls }) => {
    const result = await client.callTool({ name: "switch_model", arguments: { model: "opus" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /model switching capability is unavailable/);
    assert.equal(calls.length, 0);
  }, { modelSwitch: false });
});

test("run_on_worker is offered through the MCP bridge with the same arguments and the same words as for the host", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const hosted = RUN_ON_WORKER_TOOL;
    const exposed = tools.find((tool) => tool.name === hosted.name);
    assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
    const hostedProperties = hosted.parameters.properties ?? {};
    assert.deepEqual(Object.keys(exposed.inputSchema.properties ?? {}).sort(), Object.keys(hostedProperties).sort(), `${hosted.name} takes different arguments through the bridge`);
    assert.deepEqual([...(exposed.inputSchema.required ?? [])].sort(), [...(hosted.parameters.required ?? [])].sort(), `${hosted.name} requires different arguments through the bridge`);
    assert.equal(exposed.description, hosted.description, `${hosted.name} teaches a different purpose through the bridge`);
    for (const [name, spec] of Object.entries(hostedProperties)) {
      const property = exposed.inputSchema.properties[name];
      assert.equal(property.type, spec.type, `${hosted.name}.${name} has a different type through the bridge`);
      assert.equal(property.description, spec.description, `${hosted.name}.${name} is described differently through the bridge`);
      if (spec.enum) assert.deepEqual(property.enum, spec.enum, `${hosted.name}.${name} offers different values through the bridge`);
      if (spec.items) assert.equal(property.items?.type, spec.items.type, `${hosted.name}.${name} lists a different kind of item through the bridge`);
    }
  });
});

test("a worker call through the MCP bridge reaches the workers endpoint with the session capability, and a plain JSON answer comes back as the result", async () => {
  await withBridge(async ({ client, calls, paths }) => {
    const args = { command: "cargo build --release", results: ["target/release/app"], arch: "x86_64", tools: ["rust"], timeoutSeconds: 600, fallbackLocal: false };
    const result = await client.callTool({ name: "run_on_worker", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted run_on_worker" }]);
    assert.deepEqual(paths, ["/workers"], "a worker job never goes to the display, scheduling, messaging or device endpoints");
    assert.deepEqual(calls, [{ authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "run_on_worker", arguments: args } }]);

    // A command is required and an architecture the tool does not know never leaves the bridge.
    for (const bad of [{}, { command: "ls", arch: "riscv" }]) {
      const refused = await client.callTool({ name: "run_on_worker", arguments: bad }).then((value) => value, (error) => error);
      assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses it");
    }
    assert.equal(calls.length, 1);
  });
});

test("a streamed worker answer through the MCP bridge becomes progress notifications and a final result with its error flag", async () => {
  await withBridge(async ({ client }) => {
    const progress = [];
    const result = await client.callTool(
      { name: "run_on_worker", arguments: { command: "stream" } },
      undefined,
      { onprogress: (update) => progress.push(update) },
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "exit 2 on proxmox" }]);
    assert.deepEqual(progress.map((update) => update.message), ["Running on proxmox - 1 s\nbuilding", "Running on proxmox - 2 s\ndone building"], "a line split across two chunks arrives whole; heartbeats and noise are ignored");
    assert.deepEqual(progress.map((update) => update.progress), [1, 2]);

    // The same call without a progress listener still returns the result.
    const quiet = await client.callTool({ name: "run_on_worker", arguments: { command: "stream" } });
    assert.equal(quiet.isError, true);
    assert.deepEqual(quiet.content, [{ type: "text", text: "exit 2 on proxmox" }]);
  });
});

test("cancelling a worker call through the MCP bridge hangs up on the server so the job is stopped", async () => {
  await withBridge(async ({ client, calls, events }) => {
    const cancel = new AbortController();
    const pending = client.callTool({ name: "run_on_worker", arguments: { command: "hang" } }, undefined, { signal: cancel.signal }).then((value) => value, (error) => error);
    for (let waited = 0; waited < 100 && calls.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.length, 1, "the job started");
    cancel.abort();
    await pending;
    for (let waited = 0; waited < 100 && events.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ["hung up"]);
  });
});

test("an engine started without a workers endpoint is told so plainly instead of hanging", async () => {
  await withBridge(async ({ client, calls }) => {
    const result = await client.callTool({ name: "run_on_worker", arguments: { command: "ls" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /worker capability is unavailable/);
    assert.equal(calls.length, 0);
  }, { workers: false });
});
